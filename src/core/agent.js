import { defaultOpenaiModel, defaultGeminiModel, defaultMaxToolCalls } from "../config.js";
import { ToolLoader } from "../loaders/tool-loader.js";
import { v4 as uuidv4 } from 'uuid';
import EventEmitter from 'events';
import { DomainObservability } from "../services/observability.js";
import { Context } from "../memory/context.js";

/**
 * Represents an LLM-based agent capable of tool calling.
 */
export class Agent {
    /**
     * @param {object} llmService - The LLM service instance used for communication with the LLM provider.
     * @param {object} [options] - Configuration options for the agent.
     * @param {string} [options.name='agent'] - The name of the agent (for logging purposes).
     * @param {EventEmitter} [options.eventEmitter] - Optional event emitter for observability and tracing events (e.g., 'agent:start', 'tool:start').
     * @param {string} [options.model=defaultModel] - The specific model identifier to use (defaults to provider-specific default).
     * @param {ToolLoader} [options.toolLoader=null] - Optional ToolLoader instance.
     * @param {Array<object>} [options.tools=[]] - Array of native tool objects available to the agent.
     * @param {zod.ZodType|null} [options.outputSchema=null] - Zod schema for validating/structuring the expected final output.
     * @param {boolean} [options.enableMCP=false] - Whether to enable MCP (Model Context Protocol) support for remote tools.
     * @param {boolean} [options.redundantToolInfo=true] - Whether to explicitly inject tool descriptions into the system prompt (useful for some models).
     * @param {...*} [options] - Additional options passed directly to the LLM service configuration.
     */
    constructor(llmService, {
        name = 'agent',
        eventEmitter,
        logmode = 'none', // 'none', 'file', 'otel', 'console', or array of them.
        model = llmService.provider == 'openai' ? defaultOpenaiModel : defaultGeminiModel,
        toolLoader = null,
        outputSchema = null,
        enableMCP = false,
        ...options } = {}) {

        this.name = name;
        this.sessionId = uuidv4();
        this.llmService = llmService;
        this.events = eventEmitter || new EventEmitter();
        this.model = model;
        this.toolLoader = toolLoader || new ToolLoader(enableMCP);
        this.outputSchema = outputSchema;
        this.additionalOptions = options;
        this.context = new Context();

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
     * Emits a tracing event if an event emitter is configured.
     * 
     * @param {string} eventName - The name of the event (e.g., 'agent:start', 'llm:start').
     * @param {object} details - The details of the trace event.
     * @param {string} details.traceId - A unique UUID for the entire execution trace.
     * @param {string} details.spanId - A unique UUID for this specific span/operation.
     * @param {string} [details.parentSpanId] - The UUID of the parent span (if this is a child operation).
     * @param {string} details.name - A human-readable name for the operation (e.g., "agent_run").
     * @param {object} [details.attributes] - specific metadata about the operation (e.g., model name, tool count).
     */
    _emitTrace(eventName, { traceId, spanId, parentSpanId, name, attributes }) {
        if (this.events) {
            this.events.emit(eventName, {
                traceId,
                spanId,
                parentSpanId,
                name,
                attributes,
                sessionId: this.sessionId
            });
        }
    }

    /**
     * Starts the agent for a single conversational turn, including tool use if necessary.
     * This method initializes the multi-step reasoning: LLM -> Tool Execution -> LLM Final Response.
     * It returns the first turn state object in Continuation-Passing Style (CPS).
     */
    async start(externalContext = null) {
        let activeContext = externalContext || this.context;
        if (externalContext && !(externalContext instanceof Context)) {
            const msgArray = Array.isArray(externalContext) ? externalContext : [externalContext];
            activeContext = new Context(msgArray);
        }

        // Generate a new trace ID and root span ID
        const traceId = this.name + "-" + uuidv4();
        const rootSpanId = this.name + "-" + uuidv4();
        const allTools = this.toolLoader.getTools() || [];

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
                mcp_enabled: this.mcpManager ? this.mcpManager.isEnabled() : false,
                mcp_servers: this.mcpManager ? this.mcpManager.getServerInfo() : {}
            }
        });

        const isExternalContextNull = externalContext === null;
        return this._executeTurn(1, activeContext, [], traceId, rootSpanId, isExternalContextNull);
    }

    /**
     * Runs the agent for a single conversational turn, driving the CPS loop to completion automatically.
     * @returns {Promise<object>} The final response object from the LLM, including execution details.
     */
    async run(externalContext = null) {
        try {
            let history = [];
            let currentTurn = await this.start(externalContext);
            history.push(currentTurn);

            while (!currentTurn.isDone) {
                currentTurn = await currentTurn.next();
                history.push(currentTurn);
            }

            return history;
        } catch (error) {
            console.error('Error running agent:', error);
            throw error;
        }
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
            branchHistory.push(currentTurn)
        }

        return branchHistory;
    }

    /**
     * Executes a single step of the agent's inner loop (LLM Call -> Tool Execution).
     */
    async _executeTurn(stepNumber, currentContext, executedTools, traceId, rootSpanId, updateInternalContext) {
        const MAX_TOOL_CALLS = defaultMaxToolCalls;
        if (stepNumber > MAX_TOOL_CALLS) {
            throw new Error(`Agent exceeded maximum tool call limit of ${MAX_TOOL_CALLS}`);
        }

        const allTools = this.toolLoader.getTools() || [];

        // 2. EMIT: LLM Call
        const llmSpanId = "llm_call_" + stepNumber + "-" + uuidv4();
        this._emitTrace('llm:start', {
            traceId,
            spanId: llmSpanId,
            parentSpanId: rootSpanId,
            name: "llm_call_" + stepNumber,
            attributes: {
                llm_provider: this.llmService.provider,
                model: this.model,
                input: currentContext.getMessages(),
                input_length: currentContext.getMessages().length,
                tools_available: allTools.map(t => t.name),
                tool_count: allTools.length,
                step: stepNumber
            }
        });

        let response = await this.llmService.chat(currentContext.getMessages(), {
            model: this.model,
            pruningOptions: { enabled: true },
            outputSchema: this.outputSchema,
            tools: allTools,
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
        let nextContext = currentContext;

        rawResponse.output.forEach(item => {
            if (item.type === "function_call") {
                const { parsed_arguments, ...rest } = item;
                const args = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments);
                const cleanedItem = { ...rest, arguments: args };
                nextContext = nextContext.addInput(cleanedItem);
            } else if (item.type === "message") {
                const textBlocks = item.content.filter(block => block.type === 'output_text');
                const otherBlocks = item.content.filter(block => block.type !== 'output_text');

                let newContent = [...otherBlocks];

                if (textBlocks.length > 0) {
                    const combinedText = textBlocks.map(b => b.text).join('\n');
                    const mergedTextBlock = {
                        ...textBlocks[0],
                        text: `[${this.name}]: ${combinedText}`
                    };
                    newContent = [mergedTextBlock, ...otherBlocks];
                }

                const messageToAdd = {
                    ...item,
                    content: newContent
                };

                nextContext = nextContext.addInput(messageToAdd);
            }
        });

        const functionCalls = rawResponse.output.filter(item => item.type === "function_call");
        const isDone = functionCalls.length === 0;

        let newExecutedTools = [...executedTools];

        if (!isDone) {
            for (const call of functionCalls) {
                let args;
                args = JSON.parse(call.arguments);
                call.arguments = args;
                newExecutedTools.push({ name: call.name, args: args });

                const tool = this.toolLoader.findTool(call.name);
                if (!tool || !tool.func) {
                    throw new Error(`Tool ${call.name} not found or missing implementation.`);
                }

                // 4. EMIT: Tool Start
                const toolSpanId = "tool_call:" + call.name + "-" + uuidv4();
                this._emitTrace('tool:start', {
                    traceId,
                    spanId: toolSpanId,
                    parentSpanId: rootSpanId,
                    name: `tool_exec:${call.name}`,
                    attributes: {
                        tool_name: call.name,
                        arguments: args,
                    }
                });

                const result = await tool.func(args);

                // 5. EMIT: Tool Complete
                this._emitTrace('tool:complete', {
                    traceId,
                    spanId: toolSpanId,
                    parentSpanId: rootSpanId,
                    name: `tool_exec:${call.name}`,
                    attributes: {
                        tool_name: call.name,
                        arguments: args,
                        result_preview: JSON.stringify(result).slice(0, 100)
                    }
                });

                const functionMessage = {
                    name: call.name,       // Required for Gemini translation
                    call_id: call.call_id, // Required for OpenAI translation
                    type: "function_call_output",
                    output: JSON.stringify(result),
                };
                nextContext = nextContext.addInput(functionMessage);
            }

            // Return CPS object to continue to the next turn
            return {
                isDone: false,
                output: output,
                rawResponse: rawResponse,
                executedTools: newExecutedTools,
                context: nextContext,
                next: async (overrideContext = null, options = {}) => {
                    const stateToPass = overrideContext || nextContext;
                    return this._executeTurn(stepNumber + 1, stateToPass, newExecutedTools, traceId, rootSpanId, updateInternalContext);
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
                    total_tools_executed: newExecutedTools.length
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