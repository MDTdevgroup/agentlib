import {
    getDefaultMaxToolCalls,
    getDefaultToolConcurrency,
    getDefaultToolExposure,
    getDefaultMaxToolResultTokens,
} from "../config.js";
import { getModelContextLimit, getDefaultModel } from "../providers/registry.js";
import { ToolLoader, RESERVED_META_TOOL_NAMES } from "../loaders/tool-loader.js";
import { resolveExposurePolicy } from "../tools/exposure.js";
import { createSandbox, assertSandbox } from "../tools/sandbox/index.js";
import { generateToolStubs } from "../tools/stubs.js";
import { normalizeDecision } from "../security/policy.js";
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
     * @param {string|Function} [options.toolExposure] - Tool exposure policy ('all' | 'progressive' | 'auto' | custom function).
     * @param {object} [options.toolExposureOptions={}] - Configuration options for tool exposure policy (mode, thresholdRatio, rank).
     * @param {boolean|object} [options.codeMode=false] - Whether to enable programmatic tool calling via run_tool_script, or sandbox options.
     * @param {Function} [options.approveToolCall=null] - Optional hook `({ name, args, callId, origin, signal }) => boolean | void` to authorize direct or sandboxed tool calls.
     * @param {object} [options.sandbox=null] - Custom sandbox conforming to the Sandbox contract.
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
        toolExposure = getDefaultToolExposure(),
        toolExposureOptions = {},
        codeMode = false,
        policy = null,
        approveToolCall = null,
        maxToolResultTokens = getDefaultMaxToolResultTokens(),
        sandbox = null,
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
        this.policy = policy;
        this.maxToolResultTokens = maxToolResultTokens;
        this.toolLoader = toolLoader || new ToolLoader(enableMCP, {
            eventEmitter: this.events,
            policy: this.policy,
        });
        if (this.toolLoader && typeof this.toolLoader.setEventEmitter === 'function' && !this.toolLoader.events) {
            this.toolLoader.setEventEmitter(this.events);
        }
        if (this.toolLoader && typeof this.toolLoader.setPolicy === 'function' && this.policy && !this.toolLoader.policy) {
            this.toolLoader.setPolicy(this.policy);
        }
        this.outputSchema = outputSchema;
        this.toolConcurrency = toolConcurrency;
        this.onToolError = onToolError;
        this.maxToolCalls = maxToolCalls;
        this.pruningStrategy = pruningStrategy;
        this.pruningOptions = pruningOptions;
        this.maxRunTokens = maxRunTokens || options.budget || null;
        this.codeMode = codeMode;
        this.approveToolCall = approveToolCall;

        if (sandbox) {
            assertSandbox(sandbox);
            this.sandbox = sandbox;
        } else if (codeMode && typeof codeMode === 'object' && typeof codeMode.run === 'function') {
            assertSandbox(codeMode);
            this.sandbox = codeMode;
        } else if (codeMode && typeof codeMode === 'object' && codeMode.sandbox) {
            assertSandbox(codeMode.sandbox);
            this.sandbox = codeMode.sandbox;
        } else if (codeMode) {
            const sandboxOpts = typeof codeMode === 'object' ? codeMode : {};
            this.sandbox = createSandbox(sandboxOpts);
        } else {
            this.sandbox = null;
        }

        this.toolExposure = toolExposure;
        this.toolExposureOptions = {
            ...toolExposureOptions,
            codeMode: Boolean(codeMode),
            ...(this.policy ? { policy: this.policy } : {}),
        };
        this.exposurePolicy = resolveExposurePolicy(toolExposure, this.toolExposureOptions);

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
        if (Array.isArray(options.sources)) {
            for (const source of options.sources) {
                this.toolLoader.addSource(source);
            }
            delete options.sources;
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
     * Registers a ToolSource (such as createA2ASource or MCPToolSource) with the agent.
     * @param {object} source - ToolSource instance.
     */
    addSource(source) {
        if (!this.toolLoader) {
            throw new Error("ToolLoader is not initialized.");
        }
        return this.toolLoader.addSource(source);
    }

    /**
     * Returns the full tool catalog across all registered sources, independent of progressive exposure state.
     * @returns {Promise<Array<object>>}
     */
    async getCatalog() {
        if (!this.toolLoader) return [];
        if (typeof this.toolLoader.getCatalog === 'function') {
            return await this.toolLoader.getCatalog();
        }
        return this.toolLoader.getToolDeclarations();
    }

    /**
     * Synchronously returns the full tool catalog across all active sources.
     * @returns {Array<object>}
     */
    getFullCatalog() {
        if (!this.toolLoader) return [];
        if (typeof this.toolLoader.getFullCatalog === 'function') {
            return this.toolLoader.getFullCatalog();
        }
        return this.toolLoader.getToolDeclarations();
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
     * Connects and indexes an A2A remote peer agent into the tool catalog.
     * @param {string} serverName - Identifier for the A2A peer.
     * @param {string|object} urlOrOptions - Remote agent URL or options.
     * @param {object} [options={}]
     */
    async addA2AServer(serverName, urlOrOptions, options = {}) {
        if (!this.toolLoader) {
            throw new Error("ToolLoader is not initialized.");
        }
        return await this.toolLoader.addA2AServer(serverName, urlOrOptions, options);
    }

    /**
     * Lazily registers an A2A remote peer agent without connecting immediately.
     * @param {string} serverName - Identifier for the A2A peer.
     * @param {string|object} urlOrOptions - Remote agent URL or options.
     * @param {object} [options={}]
     */
    registerA2AServer(serverName, urlOrOptions, options = {}) {
        if (!this.toolLoader) {
            throw new Error("ToolLoader is not initialized.");
        }
        return this.toolLoader.registerA2AServer(serverName, urlOrOptions, options);
    }

    /**
     * Lazily registers an MCP server configuration without connecting immediately.
     * Connection and tool discovery occur mid-run when requested by the model or explicitly.
     * @param {string} serverName - Identifier for the MCP server.
     * @param {Object} config - Configuration object for the MCP server.
     * @param {Object} [options={}] - Optional registration parameters.
     * @param {string} [options.description=''] - Server description used for discovery search.
     * @param {boolean} [options.prefixToolNames=false] - Whether to prefix tool names.
     */
    registerMCPServer(serverName, config, options = {}) {
        if (!this.toolLoader) {
            throw new Error("ToolLoader is not initialized.");
        }
        return this.toolLoader.registerMCPServer(serverName, config, options);
    }

    /**
     * Programmatically enables a lazily registered MCP or A2A server.
     * @param {string} serverName - Identifier of the server to connect and enable.
     */
    async enableMCPServer(serverName) {
        if (!this.toolLoader) {
            throw new Error("ToolLoader is not initialized.");
        }
        return await this.toolLoader.enableMCPServer(serverName);
    }

    /**
     * Programmatically disables an active MCP or A2A server.
     * @param {string} serverName - Identifier of the server to disable.
     * @param {Object} [options={}] - Options for disabling.
     * @param {boolean} [options.disconnect=false] - Whether to disconnect the underlying transport.
     */
    async disableMCPServer(serverName, options = {}) {
        if (!this.toolLoader) {
            throw new Error("ToolLoader is not initialized.");
        }
        return await this.toolLoader.disableMCPServer(serverName, options);
    }

    /**
     * Resolves an active sandbox instance for executing scripts.
     * @param {object} [turnOptions={}]
     * @returns {object}
     */
    _resolveSandbox(turnOptions = {}) {
        if (turnOptions.sandbox) {
            assertSandbox(turnOptions.sandbox);
            return turnOptions.sandbox;
        }
        if (this.sandbox) {
            return this.sandbox;
        }
        const mode = turnOptions.codeMode !== undefined ? turnOptions.codeMode : this.codeMode;
        if (mode) {
            if (typeof mode === 'object' && typeof mode.run === 'function') {
                assertSandbox(mode);
                return mode;
            }
            if (typeof mode === 'object' && mode.sandbox) {
                assertSandbox(mode.sandbox);
                return mode.sandbox;
            }
            const sandboxOpts = typeof mode === 'object' ? mode : {};
            return createSandbox(sandboxOpts);
        }
        return createSandbox();
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
     * Caps a tool result to `this.maxToolResultTokens` using `estimateTokens` and `truncateToBudget`.
     */
    _capResultToBudget(value, maxTokens = this.maxToolResultTokens) {
        if (!maxTokens || maxTokens <= 0 || value === undefined || value === null) {
            return value;
        }

        const isString = typeof value === 'string';
        let serialized;
        try {
            serialized = isString ? value : JSON.stringify(value);
        } catch {
            return value;
        }
        if (typeof serialized !== 'string') {
            return value;
        }

        const tokenCount = estimateTokens(serialized);
        if (tokenCount <= maxTokens) {
            return value;
        }

        const maxChars = maxTokens * 4;
        const chunkSize = Math.max(64, Math.floor(maxChars / 4));
        const segments = [];
        for (let i = 0; i < serialized.length; i += chunkSize) {
            segments.push({ role: 'user', content: serialized.slice(i, i + chunkSize) });
        }

        const keptText = truncateToBudget(segments, maxTokens).map(s => s.content).join('');
        const truncatedText = (keptText.length === 0 || estimateTokens(keptText) > maxTokens)
            ? serialized.slice(0, maxChars)
            : keptText;

        const suffix = `\n...[truncated to ${maxTokens} token budget]`;
        const finalString = truncatedText.slice(0, Math.max(0, maxChars - suffix.length)) + suffix;

        return isString ? finalString : { truncated: true, maxTokens, content: finalString };
    }

    /**
     * Caps an arbitrary payload (arguments or result) before emitting to telemetry sinks.
     */
    _capForTelemetry(value, maxChars = 512) {
        if (value === undefined || value === null) return value;
        const capped = this._capResultToBudget(value, Math.max(32, Math.ceil(maxChars / 4)));
        if (typeof capped === 'string') {
            return capped.length > maxChars ? `${capped.slice(0, maxChars)}...[truncated]` : capped;
        }
        try {
            const json = JSON.stringify(capped);
            return typeof json === 'string' && json.length > maxChars
                ? `${json.slice(0, maxChars)}...[truncated]`
                : capped;
        } catch {
            return '[Unserializable]';
        }
    }

    /**
     * Passes a tool result through `policy.inspectResult(result, call)` and caps its size
     * with `estimateTokens` and `truncateToBudget` before it enters context or telemetry.
     */
    async _finalizeToolResult(rawResult, callDescriptor) {
        let current = this._capResultToBudget(rawResult);
        if (typeof this.policy?.inspectResult === 'function') {
            const inspected = await this.policy.inspectResult(current, callDescriptor);
            if (inspected !== undefined) {
                current = (inspected && typeof inspected === 'object' && inspected.allow === false && !('error' in inspected))
                    ? { error: inspected.reason || `Tool result from "${callDescriptor.name}" was rejected by security policy.` }
                    : inspected;
            }
        }
        return this._capResultToBudget(current);
    }

    _failToolCall(err, ctx, { errorMessage, extraResult, extraAttributes, nextExposureState } = {}) {
        this._emitTrace('tool:error', {
            traceId: ctx.traceId,
            spanId: ctx.toolSpanId,
            parentSpanId: ctx.rootSpanId,
            name: `tool_exec:${ctx.name || 'unknown'}`,
            attributes: {
                tool_name: ctx.name,
                ...(ctx.telemetryArgs !== undefined ? { arguments: ctx.telemetryArgs } : {}),
                origin: ctx.origin,
                error: errorMessage && !ctx.telemetryArgs ? errorMessage : err.message,
                ...extraAttributes,
            },
        });
        if (this.onToolError === 'throw') throw err;
        return {
            callId: ctx.callId,
            name: ctx.name,
            args: ctx.args,
            source: ctx.source,
            result: { error: errorMessage || err.message, ...extraResult },
            ...(nextExposureState !== undefined ? { nextExposureState } : {}),
        };
    }

    _completeToolCall(result, ctx, nextExposureState) {
        this._emitTrace('tool:complete', {
            traceId: ctx.traceId,
            spanId: ctx.toolSpanId,
            parentSpanId: ctx.rootSpanId,
            name: `tool_exec:${ctx.name}`,
            attributes: {
                tool_name: ctx.name,
                arguments: ctx.telemetryArgs,
                origin: ctx.origin,
                result_preview: JSON.stringify(this._capForTelemetry(result))?.slice(0, 100),
            },
        });
        return {
            callId: ctx.callId,
            name: ctx.name,
            args: ctx.args,
            source: ctx.source,
            result,
            ...(nextExposureState !== undefined ? { nextExposureState } : {}),
        };
    }

    /**
     * Executes a single tool call, handling errors, missing tools, and telemetry.
     */
    async _executeSingleTool(call, traceId, rootSpanId, signal = null, resolveMeta = null, { origin = 'model' } = {}) {
        signal?.throwIfAborted?.();
        const name = toolCallName(call);
        const callId = toolCallId(call);
        const toolSpanId = "tool_call:" + name + "-" + randomUUID();
        const isMetaTool = RESERVED_META_TOOL_NAMES.has(name);
        const registeredTool = !isMetaTool && this.toolLoader ? this.toolLoader.findTool(name) : null;
        const source = registeredTool?.source
            ? { ...registeredTool.source }
            : (isMetaTool ? { kind: 'meta' } : { kind: 'local' });

        let args;
        try {
            args = toolCallArgs(call) ?? {};
        } catch (parseErr) {
            return this._failToolCall(
                parseErr,
                { callId, name, args: {}, source, origin, traceId, toolSpanId, rootSpanId },
                { errorMessage: `Failed to parse tool arguments: ${parseErr.message}` }
            );
        }

        const callDescriptor = {
            name,
            args,
            callId,
            source,
            origin,
            signal,
            ...(registeredTool?.annotations ? { annotations: { ...registeredTool.annotations } } : {}),
            ...(registeredTool?.sensitive !== undefined ? { sensitive: Boolean(registeredTool.sensitive) } : {}),
        };
        const telemetryArgs = this._capForTelemetry(args);
        const traceCtx = { callId, name, args, source, origin, traceId, toolSpanId, rootSpanId, telemetryArgs };

        const emitToolStart = () => this._emitTrace('tool:start', {
            traceId,
            spanId: toolSpanId,
            parentSpanId: rootSpanId,
            name: `tool_exec:${name}`,
            attributes: { tool_name: name, arguments: telemetryArgs, origin },
        });

        // 1. Check security policy and legacy approveToolCall hooks if provided
        const approvalHooks = [
            typeof this.policy?.approveToolCall === 'function'
                ? [this.policy.approveToolCall.bind(this.policy), `Tool call "${name}" denied by security policy.`]
                : null,
            typeof this.approveToolCall === 'function'
                ? [this.approveToolCall.bind(this), `Tool call "${name}" rejected by approveToolCall hook.`]
                : null,
        ].filter(Boolean);

        for (const [hook, defaultReason] of approvalHooks) {
            try {
                const decision = normalizeDecision(await hook(callDescriptor), defaultReason);
                if (!decision.allow) {
                    return this._failToolCall(new Error(decision.reason), traceCtx);
                }
            } catch (approvalErr) {
                return this._failToolCall(approvalErr, traceCtx);
            }
        }

        // 2. Check if this tool is a meta-tool handled by exposure policy
        if (typeof resolveMeta === 'function' && RESERVED_META_TOOL_NAMES.has(name) && name !== 'run_tool_script') {
            emitToolStart();
            try {
                const metaResolution = await resolveMeta(name, args, {
                    signal,
                    toolLoader: this.toolLoader,
                    policy: this.policy,
                    origin,
                });
                if (metaResolution && metaResolution.handled) {
                    const finalMetaResult = await this._finalizeToolResult(metaResolution.result, callDescriptor);
                    return this._completeToolCall(finalMetaResult, traceCtx, metaResolution.nextState);
                }
            } catch (metaErr) {
                return this._failToolCall(metaErr, traceCtx, {
                    errorMessage: `Meta-tool "${name}" execution failed: ${metaErr.message}`,
                });
            }
        }

        // 3. Programmatic tool calling handler
        if (name === 'run_tool_script') {
            emitToolStart();
            const code = typeof args?.code === 'string' ? args.code : '';
            if (!code) {
                return this._failToolCall(new Error("run_tool_script requires a non-empty 'code' string argument."), traceCtx);
            }

            const activeSandbox = this._resolveSandbox();
            const requestedTools = Array.isArray(args.tools) && args.tools.length > 0 ? new Set(args.tools) : null;
            const allDeclarations = this.toolLoader ? this.toolLoader.getToolDeclarations() : [];
            const targetDeclarations = allDeclarations.filter(d => {
                const declName = d.name || d.type;
                return declName !== 'run_tool_script' && (requestedTools ? requestedTools.has(declName) : true);
            });
            const stubs = generateToolStubs(targetDeclarations);

            let accumulatedNextState = null;
            const onToolCall = async (toolName, toolArgs) => {
                const innerCall = makeToolCall({
                    name: toolName,
                    args: toolArgs,
                    callId: `sandboxed_${randomUUID()}`,
                });
                const execution = await this._executeSingleTool(
                    innerCall,
                    traceId,
                    toolSpanId,
                    signal,
                    resolveMeta,
                    { origin: 'sandbox' }
                );
                if (execution.nextExposureState) {
                    accumulatedNextState = { ...accumulatedNextState, ...execution.nextExposureState };
                }
                if (execution.result && typeof execution.result === 'object' && execution.result.error) {
                    throw new Error(execution.result.error);
                }
                return execution.result;
            };

            try {
                const { result, logs, error } = await activeSandbox.run(code, { stubs, signal, onToolCall });
                if (error) {
                    return this._failToolCall(error, traceCtx, {
                        extraResult: { logs: logs || undefined },
                        extraAttributes: { logs },
                        nextExposureState: accumulatedNextState || undefined,
                    });
                }

                const scriptResult = {
                    ...(result !== undefined ? { result } : (!logs ? { result: null } : {})),
                    ...(logs ? { logs } : {}),
                };
                const finalScriptResult = await this._finalizeToolResult(scriptResult, callDescriptor);
                return this._completeToolCall(finalScriptResult, traceCtx, accumulatedNextState || undefined);
            } catch (execErr) {
                return this._failToolCall(execErr, traceCtx, {
                    errorMessage: `run_tool_script failed: ${execErr.message}`,
                    nextExposureState: accumulatedNextState || undefined,
                });
            }
        }

        // 4. Standard tool execution
        const tool = registeredTool || this.toolLoader.findTool(name);
        if (!tool || typeof tool.func !== 'function') {
            return this._failToolCall(
                new Error(`Tool "${name}" not found or missing implementation.`),
                traceCtx,
                { errorMessage: `Tool "${name}" not found.` }
            );
        }

        emitToolStart();
        try {
            const rawResult = await tool.func(args, { signal });
            const result = await this._finalizeToolResult(rawResult, callDescriptor);
            return this._completeToolCall(result, traceCtx);
        } catch (execErr) {
            return this._failToolCall(execErr, traceCtx, {
                errorMessage: `Tool "${name}" execution failed: ${execErr.message}`,
            });
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
        const allTools = this.toolLoader.getToolDeclarations() || [];
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
                tools_available: allTools.map(t => t.name || t.type),
                tool_count: allTools.length,
                mcp_enabled: mcpInfo.enabled !== false,
                mcp_servers: mcpInfo.servers || mcpInfo
            }
        });

        const isExternalContextNull = externalContext === null;
        const initialFrame = {
            stepNumber: 1,
            executedTools: [],
            totalRunTokens: 0,
            exposureState: options.exposureState || {},
        };
        return this._executeTurn(activeContext, initialFrame, traceId, rootSpanId, isExternalContextNull, options);
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
    async _executeTurn(currentContext, frame = {}, traceId, rootSpanId, updateInternalContext, options = {}) {
        const stepNumber = frame.stepNumber ?? 1;
        const executedTools = frame.executedTools ?? [];
        const totalRunTokens = frame.totalRunTokens ?? 0;
        let exposureState = frame.exposureState ?? {};

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
                exposure: exposureState,
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
                exposure: exposureState,
            };
        }

        if (typeof this.toolLoader?.ensureConnected === 'function') {
            await this.toolLoader.ensureConnected();
        }
        const rawCatalog = this.toolLoader.getToolDeclarations() || [];
        const isCodeModeActive = options.codeMode !== undefined ? Boolean(options.codeMode) : Boolean(this.codeMode);
        const activePolicy = (options.toolExposure || (options.codeMode !== undefined && options.codeMode !== this.codeMode))
            ? resolveExposurePolicy(options.toolExposure || this.toolExposure, {
                ...this.toolExposureOptions,
                ...options.toolExposureOptions,
                codeMode: isCodeModeActive,
            })
            : this.exposurePolicy;

        const exposureContext = {
            signal,
            maxContextTokens: this.maxContextTokens,
            codeMode: isCodeModeActive,
            policy: options.policy || this.policy,
            toolExposureOptions: {
                ...this.toolExposureOptions,
                ...options.toolExposureOptions,
                codeMode: isCodeModeActive,
                ...(this.policy ? { policy: this.policy } : {}),
            },
            ...this.additionalOptions,
            ...options,
            toolLoader: this.toolLoader,
        };

        const {
            declarations: wireTools = [],
            resolve: resolveMetaTool,
            nextState: policyNextState,
        } = await activePolicy(rawCatalog, exposureState, exposureContext);

        let currentExposureState = policyNextState || exposureState;

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
                tools_available: wireTools.map(t => t.name || t.type),
                tool_count: wireTools.length,
                step: stepNumber
            }
        });

        let response = await this.llmService.chat(messagesToSend, {
            model: this.model,
            outputSchema: this.outputSchema,
            tools: wireTools,
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
                    thoughtSignature: item.thoughtSignature || item.signature,
                });
                nextContext = nextContext.addInput(call);
            } else if (isReasoning(item)) {
                const reasoning = makeReasoning({
                    id: item.id,
                    summary: item.summary,
                    details: item.content,
                    encrypted_content: item.encrypted_content,
                    status: item.status,
                    thoughtSignature: item.thoughtSignature || item.signature,
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
            const thunks = functionCalls.map(call => () => this._executeSingleTool(call, traceId, rootSpanId, signal, resolveMetaTool));

            const toolSettled = await asyncSettleAll(thunks, this.toolConcurrency, 0);

            for (let i = 0; i < toolSettled.length; i++) {
                const settled = toolSettled[i];
                const originalCall = functionCalls[i];
                const callSig = originalCall?.thoughtSignature || originalCall?.signature;
                if (settled.status === 'fulfilled') {
                    const { callId, name, args, source, result, nextExposureState } = settled.value;
                    if (nextExposureState) {
                        currentExposureState = {
                            ...currentExposureState,
                            ...nextExposureState,
                            discovered: Array.from(new Set([
                                ...(currentExposureState.discovered || []),
                                ...(nextExposureState.discovered || []),
                            ])),
                            enabledServers: Array.from(new Set([
                                ...(currentExposureState.enabledServers || []),
                                ...(nextExposureState.enabledServers || []),
                            ])),
                        };
                    }
                    newExecutedTools.push({ name, args });
                    const functionMessage = makeToolResult({
                        callId,
                        name,
                        value: result,
                        ...(source !== undefined ? { source } : {}),
                        thoughtSignature: callSig,
                    });
                    nextContext = nextContext.addInput(functionMessage);
                } else {
                    const name = toolCallName(originalCall);
                    const callId = toolCallId(originalCall);
                    const error = settled.reason;
                    if (this.onToolError === 'throw') {
                        throw error;
                    }
                    newExecutedTools.push({ name, args: {} });
                    const fallbackTool = this.toolLoader ? this.toolLoader.findTool(name) : null;
                    const fallbackSource = fallbackTool?.source
                        ? { ...fallbackTool.source }
                        : (RESERVED_META_TOOL_NAMES.has(name) ? { kind: 'meta' } : { kind: 'local' });
                    const functionMessage = makeToolResult({
                        callId,
                        name,
                        value: { error: error.message },
                        source: fallbackSource,
                        thoughtSignature: callSig,
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
                exposure: currentExposureState,
                next: async (overrideContext = null, nextOptions = {}) => {
                    const stateToPass = overrideContext || nextContext;
                    const mergedOpts = { ...options, ...nextOptions };
                    const nextExposureState = nextOptions.exposureState || currentExposureState;
                    const nextFrame = {
                        stepNumber: stepNumber + 1,
                        executedTools: newExecutedTools,
                        totalRunTokens: updatedRunTokens,
                        exposureState: nextExposureState,
                    };
                    return this._executeTurn(stateToPass, nextFrame, traceId, rootSpanId, updateInternalContext, mergedOpts);
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
                isDone: true,
                exposure: currentExposureState,
            };
        }
    }
}