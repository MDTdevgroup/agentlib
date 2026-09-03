import {
    getDefaultMaxToolCalls,
    getDefaultToolConcurrency,
    getDefaultModel,
} from "../config.js";
import { getModelContextLimit } from "../providers/registry.js";
import { ToolLoader } from "../loaders/tool-loader.js";
import { randomUUID } from 'node:crypto';
import EventEmitter from 'events';
import { DomainObservability } from "../services/observability.js";
import { Context } from "../memory/context.js";
import { asyncSettleAll } from "../util/async.js";
import {
    isToolCall,
    isTextMessage,
    isReasoning,
    toolCallName,
    toolCallId,
    toolCallArgs,
    messageText,
    makeTextMessage,
    makeToolCall,
    makeToolResult,
    makeReasoning,
} from "../memory/message.js";
import {
    WindowCompactor,
    SummarizerCompactor,
    ProvenceCompactor,
    truncateToBudget,
    estimateTokens,
} from "../memory/compactors/index.js";

/**
 * Represents an LLM-based agent capable of tool calling.
 */
export class Agent {
    /**
     * @param {object} llmService - The LLM service instance used for communication with the LLM provider.
     * @param {object} [options] - Configuration options for the agent.
     * @param {string} [options.name='agent'] - The name of the agent (for logging purposes).
     * @param {EventEmitter} [options.eventEmitter] - Optional event emitter for observability and tracing events (e.g., 'agent:start', 'tool:start').
     * @param {string} [options.model] - The specific model identifier to use (defaults to provider-specific default).
     * @param {ToolLoader} [options.toolLoader=null] - Optional ToolLoader instance.
     * @param {Array<object>} [options.tools=[]] - Array of native tool objects available to the agent.
     * @param {zod.ZodType|null} [options.outputSchema=null] - Zod schema for validating/structuring the expected final output.
     * @param {boolean} [options.enableMCP=false] - Whether to enable MCP (Model Context Protocol) support for remote tools.
     * @param {number} [options.toolConcurrency=5] - Maximum concurrency limit for parallel tool executions in a single turn.
     * @param {'feedback'|'throw'} [options.onToolError='feedback'] - Policy for handling tool errors (feed back to LLM vs throw immediately).
     * @param {number} [options.maxToolCalls=15] - Maximum allowable tool calling iterations before terminating.
     * @param {string|object|null} [options.pruningStrategy=null] - Strategy ('window' | 'summarizer' | 'provence' | BaseCompactor instance) to compact wire context.
     * @param {object} [options.pruningOptions={}] - Configuration options for the compactor strategy.
     * @param {number|null} [options.maxRunTokens=null] - Maximum cumulative tokens budget across the run before terminating.
     * @param {number} [options.maxContextTokens] - Token threshold triggering compaction (defaults to 75% of model context limit).
     * @param {number} [options.truncateToTokens] - Target token budget when compacting (defaults to 50% of model context limit).
     * @param {...*} [options] - Additional options passed directly to the LLM service configuration.
     */
    constructor(llmService, {
        name = 'agent',
        eventEmitter,
        logmode = 'none', // 'none', 'file', 'otel', 'console', or array of them.
        model = llmService?.provider ? getDefaultModel(llmService.provider) : undefined,
        toolLoader = null,
        outputSchema = null,
        enableMCP = false,
        toolConcurrency = getDefaultToolConcurrency(),
        onToolError = 'feedback',
        maxToolCalls = getDefaultMaxToolCalls(),
        pruningStrategy = null,
        pruningOptions = {},
        maxRunTokens = null,
        maxContextTokens,
        truncateToTokens,
        ...options } = {}) {

        this.name = name;
        this.sessionId = randomUUID();
        this.llmService = llmService;
        this.events = eventEmitter || new EventEmitter();
        if (this.llmService && !this.llmService.events) {
            if (typeof this.llmService.setEventEmitter === 'function') {
                this.llmService.setEventEmitter(this.events);
            } else {
                this.llmService.events = this.events;
            }
        }
        this.model = model;
        this.toolLoader = toolLoader || new ToolLoader(enableMCP, { eventEmitter: this.events });
        if (this.toolLoader && typeof this.toolLoader.setEventEmitter === 'function' && !this.toolLoader.events) {
            this.toolLoader.setEventEmitter(this.events);
        }
        this.outputSchema = outputSchema;
        this.toolConcurrency = toolConcurrency;
        this.onToolError = onToolError;
        this.maxToolCalls = maxToolCalls;
        this.pruningStrategy = pruningStrategy;
        this.pruningOptions = pruningOptions;
        this.maxRunTokens = maxRunTokens || options.budget || null;

        // Dynamically resolve context limit from model specifications if not explicitly provided
        const resolvedLimit = getModelContextLimit(this.llmService?.provider, this.model);
        this.maxContextTokens = maxContextTokens !== undefined
            ? maxContextTokens
            : Math.floor(resolvedLimit * 0.75);
        this.truncateToTokens = truncateToTokens !== undefined
            ? truncateToTokens
            : Math.floor(resolvedLimit * 0.50);

        if (options.tools) {
            this.toolLoader.addTools(options.tools);
            delete options.tools;
        }

        this.additionalOptions = options;
        this.signal = options.signal || null;
        this.context = new Context();

        if (typeof pruningStrategy === 'string') {
            const compactorOpts = {
                maxTokens: this.maxContextTokens,
                truncateToTokens: this.truncateToTokens,
                eventEmitter: this.events,
                ...pruningOptions,
            };
            if (pruningStrategy === 'window') {
                this.compactor = new WindowCompactor(compactorOpts);
            } else if (pruningStrategy === 'summarizer') {
                this.compactor = new SummarizerCompactor({
                    llmService: this.llmService,
                    model: this.model,
                    ...compactorOpts,
                });
            } else if (pruningStrategy === 'provence') {
                this.compactor = new ProvenceCompactor(compactorOpts);
            } else {
                throw new Error(`Unknown pruning strategy: ${pruningStrategy}`);
            }
        } else if (pruningStrategy && typeof pruningStrategy.compact === 'function') {
            this.compactor = pruningStrategy;
        } else {
            this.compactor = null;
        }

        if (logmode !== 'none') {
            new DomainObservability(this.events, { mode: logmode });
        }
    }

    /**
     * Adds user instruction or assistant response to the current conversation history.
     * @param {object} input - The message object to add.
     */
    addInput(input) {
        this.context = this.context.addInput(input);
    }

    /**
     * Adds one or more native tools to the agent's tool loader.
     * @param {object|Array<object>} toolOrTools - A single tool object or an array of tool objects.
     */
    addTool(toolOrTools) {
        if (Array.isArray(toolOrTools)) {
            this.toolLoader.addTools(toolOrTools);
        } else {
            this.toolLoader.addTool(toolOrTools);
        }
    }

    /**
     * Adds an MCP server connection to this agent.
     * @param {string} serverName - Identifier for the MCP server.
     * @param {Object} config - Configuration object for the MCP server.
     */
    async addMCPServer(serverName, config) {
        if (!this.toolLoader) {
            throw new Error("ToolLoader is not initialized.");
        }
        return await this.toolLoader.addMCPServer(serverName, config);
    }

    /**
     * Cleans up all MCP servers and agent resources.
     */
    async cleanup() {
        if (this.toolLoader) {
            await this.toolLoader.cleanup();
        }
    }

    /**
     * Format traces and emit them through the agent's EventEmitter.
     */
    _emitTrace(eventName, payload) {
        if (!this.events) return;
        this.events.emit(eventName, {
            ...payload,
            timestamp: Date.now(),
            agent_name: this.name,
            session_id: this.sessionId,
        });
    }

    /**
     * Executes a single tool call, handling errors, missing tools, and telemetry.
     */
    async _executeSingleTool(call, traceId, rootSpanId, signal = null) {
        signal?.throwIfAborted?.();
        const name = toolCallName(call);
        const callId = toolCallId(call);
        const toolSpanId = "tool_call:" + name + "-" + randomUUID();

        let args;
        try {
            args = toolCallArgs(call);
            if (args === undefined) {
                args = {};
            }
        } catch (parseErr) {
            this._emitTrace('tool:error', {
                traceId,
                spanId: toolSpanId,
                parentSpanId: rootSpanId,
                name: `tool_exec:${name || 'unknown'}`,
                attributes: {
                    tool_name: name,
                    error: `Failed to parse tool arguments: ${parseErr.message}`,
                }
            });
            if (this.onToolError === 'throw') throw parseErr;
            return {
                callId,
                name,
                args: {},
                result: { error: `Failed to parse tool arguments: ${parseErr.message}` },
            };
        }

        const tool = this.toolLoader.findTool(name);
        if (!tool || typeof tool.func !== 'function') {
            const err = new Error(`Tool "${name}" not found or missing implementation.`);
            this._emitTrace('tool:error', {
                traceId,
                spanId: toolSpanId,
                parentSpanId: rootSpanId,
                name: `tool_exec:${name}`,
                attributes: {
                    tool_name: name,
                    arguments: args,
                    error: err.message,
                }
            });
            if (this.onToolError === 'throw') throw err;
            return {
                callId,
                name,
                args,
                result: { error: `Tool "${name}" not found.` },
            };
        }

        this._emitTrace('tool:start', {
            traceId,
            spanId: toolSpanId,
            parentSpanId: rootSpanId,
            name: `tool_exec:${name}`,
            attributes: {
                tool_name: name,
                arguments: args,
            }
        });

        try {
            const result = await tool.func(args, { signal });
            this._emitTrace('tool:complete', {
                traceId,
                spanId: toolSpanId,
                parentSpanId: rootSpanId,
                name: `tool_exec:${name}`,
                attributes: {
                    tool_name: name,
                    arguments: args,
                    result_preview: JSON.stringify(result)?.slice(0, 100),
                }
            });
            return {
                callId,
                name,
                args,
                result,
            };
        } catch (execErr) {
            this._emitTrace('tool:error', {
                traceId,
                spanId: toolSpanId,
                parentSpanId: rootSpanId,
                name: `tool_exec:${name}`,
                attributes: {
                    tool_name: name,
                    arguments: args,
                    error: execErr.message,
                }
            });
            if (this.onToolError === 'throw') throw execErr;
            return {
                callId,
                name,
                args,
                result: { error: `Tool "${name}" execution failed: ${execErr.message}` },
            };
        }
    }

    /**
     * Starts the conversation loop and pauses after the first turn.
     * @param {Context|null} [externalContext=null] - Optional external context to execute turn against.
     * @returns {Promise<object>} The first turn object in CPS format.
     */
    async start(externalContext = null, options = {}) {
        let activeContext;
        if (externalContext !== null) {
            activeContext = externalContext;
        } else {
            activeContext = this.context;
        }
        if (externalContext && !(externalContext instanceof Context)) {
            const msgArray = Array.isArray(externalContext) ? externalContext : [externalContext];
            activeContext = new Context(msgArray);
        }

        // Generate a new trace ID and root span ID
        const traceId = this.name + "-" + randomUUID();
        const rootSpanId = this.name + "-" + randomUUID();
        const allTools = this.toolLoader.getTools() || [];
        const mcpInfo = this.toolLoader.getMCPInfo();

        // 1. EMIT: Agent start
        this._emitTrace('agent:start', {
            traceId,
            spanId: rootSpanId,
            name: "agent_run",
            attributes: {
                llm_provider: this.llmService.provider,
                input: activeContext.getMessages(),
                input_length: activeContext.getMessages().length,
                model: this.model,
                tools_available: allTools.map(t => t.name),
                tool_count: allTools.length,
                mcp_enabled: mcpInfo.enabled !== false,
                mcp_servers: mcpInfo.servers || mcpInfo
            }
        });

        const isExternalContextNull = externalContext === null;
        return this._executeTurn(1, activeContext, [], traceId, rootSpanId, isExternalContextNull, 0, options);
    }

    /**
     * Runs the agent for a single conversational turn, driving the CPS loop to completion automatically.
     * @param {Context|Array<object>} [externalContext=null] - Optional external context to execute turn against.
     * @param {object} [options={}] - Execution options, including { signal }.
     * @returns {Promise<Array<object>>} The list of turn objects representing the execution history.
     */
    async run(externalContext = null, options = {}) {
        let history = [];
        let currentTurn = await this.start(externalContext, options);
        history.push(currentTurn);

        while (!currentTurn.isDone) {
            currentTurn = await currentTurn.next(null, options);
            history.push(currentTurn);
        }

        return history;
    }

    /**
     * Time Travel: Branches an agent's reasoning from a historical inner turn 
     * with a modified context, and automatically runs the new branch to completion.
     * @param {object} turn - The intermediate turn object to branch from.
     * @param {Context} [overrideContext] - The new context to inject into the branch.
     * @returns {Promise<object>} The list of turn objects representing the new branch.
     */
    async branch(turn, overrideContext = null) {
        let branchHistory = [turn];
        let currentTurn = await turn.next(overrideContext);
        branchHistory.push(currentTurn);

        while (!currentTurn.isDone) {
            currentTurn = await currentTurn.next();
            branchHistory.push(currentTurn);
        }

        return branchHistory;
    }

    /**
     * Executes a single step of the agent's inner loop (LLM Call -> Tool Execution).
     */
    async _executeTurn(stepNumber, currentContext, executedTools, traceId, rootSpanId, updateInternalContext, totalRunTokens = 0, options = {}) {
        const signal = options.signal || this.signal;
        signal?.throwIfAborted?.();

        if (stepNumber > this.maxToolCalls) {
            // Emit agent complete with step limit stop reason
            this._emitTrace('agent:complete', {
                traceId,
                spanId: rootSpanId,
                name: "agent_run",
                attributes: {
                    success: false,
                    stop_reason: 'step_limit',
                    total_tools_executed: executedTools.length,
                    total_run_tokens: totalRunTokens,
                }
            });

            if (updateInternalContext) {
                this.context = currentContext;
            }

            return {
                output: '',
                rawResponse: null,
                executedTools,
                context: currentContext,
                isDone: true,
                stopReason: 'step_limit',
            };
        }

        if (this.maxRunTokens !== null && totalRunTokens >= this.maxRunTokens) {
            // Emit agent complete with budget exhausted stop reason
            this._emitTrace('agent:complete', {
                traceId,
                spanId: rootSpanId,
                name: "agent_run",
                attributes: {
                    success: false,
                    stop_reason: 'budget_exhausted',
                    total_run_tokens: totalRunTokens,
                    max_run_tokens: this.maxRunTokens,
                    total_tools_executed: executedTools.length,
                }
            });

            if (updateInternalContext) {
                this.context = currentContext;
            }

            return {
                output: '',
                rawResponse: null,
                executedTools,
                context: currentContext,
                isDone: true,
                stopReason: 'budget_exhausted',
            };
        }

        const allTools = this.toolLoader.getTools() || [];

        // Apply compactor strategy to wire messages if configured
        let messagesToSend = currentContext.getMessages();
        let compactionTokens = 0;
        if (this.compactor) {
            try {
                messagesToSend = await this.compactor.compact(messagesToSend);
                if (this.compactor.lastCompactionTokens) {
                    compactionTokens = this.compactor.lastCompactionTokens;
                    this.compactor.lastCompactionTokens = 0;
                }
            } catch (compactorErr) {
                this._emitTrace('compactor:error', {
                    traceId,
                    spanId: rootSpanId,
                    name: "compactor_error",
                    attributes: {
                        error: compactorErr.message,
                    }
                });
                messagesToSend = truncateToBudget(messagesToSend, this.truncateToTokens);
            }
        }

        // 2. EMIT: LLM Call
        const llmSpanId = "llm_call_" + stepNumber + "-" + randomUUID();
        this._emitTrace('llm:start', {
            traceId,
            spanId: llmSpanId,
            parentSpanId: rootSpanId,
            name: "llm_call_" + stepNumber,
            attributes: {
                llm_provider: this.llmService.provider,
                model: this.model,
                input: messagesToSend,
                input_length: messagesToSend.length,
                tools_available: allTools.map(t => t.name),
                tool_count: allTools.length,
                step: stepNumber
            }
        });

        let response = await this.llmService.chat(messagesToSend, {
            model: this.model,
            outputSchema: this.outputSchema,
            tools: allTools,
            signal,
            ...this.additionalOptions
        });

        // 3. EMIT: LLM Call Complete
        this._emitTrace('llm:complete', {
            traceId,
            spanId: llmSpanId,
            parentSpanId: rootSpanId,
            name: "llm_call_" + stepNumber,
            attributes: {
                model: this.model,
                usage: response.rawResponse?.usage,
                response: response
            }
        });

        const { output, rawResponse } = response;
        const usageTokens = response.rawResponse?.usage?.total_tokens
            ?? response.rawResponse?.usage?.totalTokens
            ?? (estimateTokens(messagesToSend) + (output ? estimateTokens(output) : 10));
        const updatedRunTokens = totalRunTokens + usageTokens + compactionTokens;

        let nextContext = currentContext;
        const rawItems = typeof this.llmService?.fromProvider === 'function'
            ? this.llmService.fromProvider(rawResponse)
            : (Array.isArray(rawResponse?.output) ? rawResponse.output : []);

        rawItems.forEach(item => {
            if (isToolCall(item)) {
                const call = makeToolCall({
                    name: toolCallName(item),
                    args: item.arguments,
                    callId: toolCallId(item),
                });
                nextContext = nextContext.addInput(call);
            } else if (isReasoning(item)) {
                const reasoning = makeReasoning({
                    summary: item.summary,
                    details: item.content,
                });
                nextContext = nextContext.addInput(reasoning);
            } else if (isTextMessage(item)) {
                const text = messageText(item);
                const msg = makeTextMessage({
                    role: item.role || 'assistant',
                    text,
                    speaker: this.name,
                    id: item.id,
                });
                nextContext = nextContext.addInput(msg);
            } else {
                nextContext = nextContext.addInput(item);
            }
        });

        const functionCalls = rawItems.filter(isToolCall);
        const isDone = functionCalls.length === 0;

        let newExecutedTools = [...executedTools];

        if (!isDone) {
            const thunks = functionCalls.map(call => () => this._executeSingleTool(call, traceId, rootSpanId, signal));
            const toolSettled = await asyncSettleAll(thunks, this.toolConcurrency, 0);

            for (let i = 0; i < toolSettled.length; i++) {
                const settled = toolSettled[i];
                if (settled.status === 'fulfilled') {
                    const { callId, name, args, result } = settled.value;
                    newExecutedTools.push({ name, args });
                    const functionMessage = makeToolResult({
                        callId,
                        name,
                        value: result,
                    });
                    nextContext = nextContext.addInput(functionMessage);
                } else {
                    const originalCall = functionCalls[i];
                    const name = toolCallName(originalCall);
                    const callId = toolCallId(originalCall);
                    const error = settled.reason;
                    if (this.onToolError === 'throw') {
                        throw error;
                    }
                    newExecutedTools.push({ name, args: {} });
                    const functionMessage = makeToolResult({
                        callId,
                        name,
                        value: { error: error.message },
                    });
                    nextContext = nextContext.addInput(functionMessage);
                }
            }

            // Return CPS object to continue to the next turn
            return {
                isDone: false,
                output: output,
                rawResponse: rawResponse,
                executedTools: newExecutedTools,
                context: nextContext,
                next: async (overrideContext = null, nextOptions = {}) => {
                    const stateToPass = overrideContext || nextContext;
                    const mergedOpts = { ...options, ...nextOptions };
                    return this._executeTurn(stepNumber + 1, stateToPass, newExecutedTools, traceId, rootSpanId, updateInternalContext, updatedRunTokens, mergedOpts);
                }
            };
        } else {
            // 6. EMIT: Agent Complete
            this._emitTrace('agent:complete', {
                traceId,
                spanId: rootSpanId,
                name: "agent_run",
                attributes: {
                    success: true,
                    total_tools_executed: newExecutedTools.length,
                    total_run_tokens: updatedRunTokens,
                }
            });

            if (updateInternalContext) {
                this.context = nextContext;
            }

            return {
                output: output,
                rawResponse: rawResponse,
                executedTools: newExecutedTools,
                context: nextContext,
                isDone: true
            };
        }
    }
}