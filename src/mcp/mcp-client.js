import {
    Client,
    StreamableHTTPClientTransport,
    TRACEPARENT_META_KEY,
    TRACESTATE_META_KEY,
    applyMiddlewares,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { trace } from "@opentelemetry/api";
import { makeException } from "../util/exception.js";
import {
    getDefaultMCPListMaxPages,
    getMCPClientIdentity,
    getDefaultMCPCallTimeoutMS,
    capDescription,
} from "../config.js";
import {
    buildStdioEnv,
    buildServerDescriptor,
    normalizeDecision,
    createUrlCheckMiddleware,
    resolveElicitHandler,
} from "../security/policy.js";

export const DEFAULT_LIST_MAX_PAGES = getDefaultMCPListMaxPages();

export const DEFAULT_CLIENT_INFO = getMCPClientIdentity();

/**
 * Client wrapper for Model Context Protocol (MCP) servers using SDK v2.
 */
class MCPClient {
    /**
     * @param {object} [options]
     * @param {object} [options.clientInfo] - Client identity name and version.
     * @param {EventEmitter} [options.eventEmitter] - Optional event emitter for status and list changes.
     * @param {number} [options.listMaxPages=64] - Cap on list pagination walk.
     * @param {object|null} [options.policy=null] - Optional security policy object.
     * @param {string|null} [options.serverName=null] - Logical name of the server.
     * @param {number} [options.callTimeoutMS] - Default per-call timeout in ms.
     */
    constructor({
        clientInfo = DEFAULT_CLIENT_INFO,
        eventEmitter = null,
        listMaxPages = DEFAULT_LIST_MAX_PAGES,
        policy = null,
        serverName = null,
        callTimeoutMS = getDefaultMCPCallTimeoutMS(),
    } = {}) {
        this.clientInfo = clientInfo;
        this.events = eventEmitter;
        this.listMaxPages = listMaxPages;
        this.policy = policy;
        this.serverName = serverName;
        this.callTimeoutMS = callTimeoutMS;
        this.mcp = null;
        this.transport = null;
        this.tools = [];
        this.rawTools = [];
        this.toolsCacheMeta = null;
        this.isConnected = false;
        this.serverConfig = null;
        this._listChangeListeners = new Set();
    }

    /**
     * Returns client identity information.
     */
    getClientInfo() {
        return this.clientInfo;
    }

    /**
     * Registers a listener callback invoked when the server reports tool changes.
     * @param {Function} listener
     */
    onToolsChanged(listener) {
        if (typeof listener === 'function') {
            this._listChangeListeners.add(listener);
        }
    }

    /**
     * Removes a tool change listener.
     * @param {Function} listener
     */
    offToolsChanged(listener) {
        this._listChangeListeners.delete(listener);
    }

    /**
     * Connects to an MCP server using the specified transport configuration.
     *
     * @param {object} server - Server configuration.
     * @returns {Promise<Array<object>>} List of normalized tool objects.
     */
    async connectToServer(server) {
        if (this.isConnected || this.transport) {
            throw new Error("MCPClient is already connected. Disconnect before connecting again.");
        }

        if (!server || typeof server !== 'object') {
            throw new TypeError("Server configuration must be a valid object.");
        }

        this.serverConfig = server;
        const activePolicy = server.policy ?? this.policy;
        const serverId = server.id || server.name || this.serverName || 'default';
        const descriptor = buildServerDescriptor(serverId, server, 'mcp');

        const assertApproved = async () => {
            if (activePolicy && typeof activePolicy.approveServer === 'function') {
                const decision = normalizeDecision(
                    await activePolicy.approveServer(descriptor),
                    `Server '${descriptor.id}' was rejected by security policy.`
                );
                if (!decision.allow) throw new Error(decision.reason);
            }
        };

        switch (server.type) {
            case "stdio": {
                if (this.events) {
                    this.events.emit('mcp:server_launch', {
                        id: descriptor.id,
                        serverName: descriptor.id,
                        command: descriptor.command,
                        args: descriptor.args,
                        warning: descriptor.warning,
                        descriptor,
                    });
                }
                await assertApproved();
                this.transport = new StdioClientTransport({
                    ...server,
                    env: buildStdioEnv(server.env),
                });
                break;
            }
            case "http":
            case "streamableHttp": {
                const url = this._validateUrl(server.url, "Streamable HTTP");
                await assertApproved();

                const transportOpts = { ...(server.transportOptions || {}) };
                for (const key of ['authProvider', 'requestInit', 'reconnectionOptions', 'onInsufficientScope']) {
                    if (server[key] && !transportOpts[key]) {
                        transportOpts[key] = server[key];
                    }
                }

                const baseFetch = server.fetch || transportOpts.fetch || globalThis.fetch;
                const isInMemoryHandlerTest =
                    !activePolicy && !server.lookup && !server.checkUrl &&
                    typeof server.fetch === 'function' && url.hostname === 'test.local';

                transportOpts.fetch = isInMemoryHandlerTest
                    ? baseFetch
                    : applyMiddlewares(createUrlCheckMiddleware({
                        policy: activePolicy,
                        lookup: server.lookup,
                        allowLoopback: server.allowLoopback,
                        maxRedirects: server.maxRedirects,
                        purpose: 'mcp:http',
                    }))(baseFetch);

                this.transport = new StreamableHTTPClientTransport(url, transportOpts);
                if (server.scope !== undefined && this.transport._scope === undefined) {
                    this.transport._scope = server.scope;
                }
                break;
            }
            case "inMemory": {
                if (!server.transport) {
                    throw new Error("inMemory server type requires a transport instance in server.transport.");
                }
                await assertApproved();
                this.transport = server.transport;
                break;
            }
            default:
                throw new Error(`Invalid server type: ${server.type}`);
        }

        const elicitHandler = resolveElicitHandler(activePolicy, server);
        const samplingHandler = server.enableSampling === true
            ? (typeof activePolicy?.sample === 'function'
                ? activePolicy.sample.bind(activePolicy)
                : (typeof server.samplingHandler === 'function'
                    ? server.samplingHandler.bind(server)
                    : (typeof server.onSampling === 'function' ? server.onSampling.bind(server) : null)))
            : null;

        const capabilities = {
            ...(elicitHandler ? { elicitation: {} } : {}),
            ...(samplingHandler ? { sampling: {} } : {}),
        };

        const clientOptions = {
            listMaxPages: this.listMaxPages,
            listChanged: {
                tools: {
                    onChanged: (error, tools) => this._handleToolsChanged(error, tools),
                },
            },
            versionNegotiation: {
                mode: server.versionNegotiationMode || 'auto',
            },
            ...(Object.keys(capabilities).length > 0
                ? { capabilities, inputRequired: { autoFulfill: true } }
                : {}),
        };

        this.mcp = new Client(this.clientInfo, clientOptions);

        if (elicitHandler) {
            this.mcp.setRequestHandler('elicitation/create', (request, ctx) =>
                this.handleElicitation(request, ctx, elicitHandler)
            );
        }
        if (samplingHandler) {
            this.mcp.setRequestHandler('sampling/createMessage', (request, ctx) =>
                samplingHandler(request?.params ?? request, ctx)
            );
        }

        await this.mcp.connect(this.transport);
        this.isConnected = true;

        await this.refreshTools();
        return this.tools;
    }

    /**
     * Handles an `elicitation/create` request using the policy's elicitation handler,
     * returning `{ action: 'decline' }` whenever no handler is supplied or consent is refused.
     */
    async handleElicitation(request, ctx = {}, handler = null) {
        const activePolicy = this.serverConfig?.policy ?? this.policy;
        const fn = handler || resolveElicitHandler(activePolicy, this.serverConfig);
        if (typeof fn !== 'function') {
            return { action: 'decline' };
        }

        const params = request?.params !== undefined ? request.params : request;
        const response = await fn(params, {
            request,
            context: ctx,
            serverName: this.serverName || this.serverConfig?.id || 'default',
        });

        if (response && typeof response === 'object' && ['accept', 'decline', 'cancel'].includes(response.action)) {
            return response;
        }
        return { action: 'decline' };
    }

    /**
     * Refreshes the cached list of tools from the server, recording `ttlMs` and `cacheScope` hints.
     * @returns {Promise<Array<object>>}
     */
    async refreshTools() {
        if (!this.isConnected || !this.mcp) {
            return [];
        }

        const toolsResult = await this.mcp.listTools();
        this.rawTools = toolsResult.tools || [];
        this.tools = this.rawTools.map(tool => this._mapTool(tool));

        const rawTtl = toolsResult.ttlMs ?? toolsResult._meta?.ttlMs;
        const rawScope = toolsResult.cacheScope ?? toolsResult._meta?.cacheScope;
        this.toolsCacheMeta = {
            fetchedAt: Date.now(),
            ttlMs: typeof rawTtl === 'number' && Number.isFinite(rawTtl) && rawTtl > 0 ? rawTtl : null,
            cacheScope: typeof rawScope === 'string' ? rawScope : null,
            stale: false,
        };

        return this.tools;
    }

    /**
     * Returns metadata about the cached tool list (`fetchedAt`, `ttlMs`, `cacheScope`, `stale`).
     * @returns {object|null}
     */
    getToolsCacheMeta() {
        return this.toolsCacheMeta ? { ...this.toolsCacheMeta } : null;
    }

    /**
     * Returns true if the cached tool list was invalidated by `list_changed` or has exceeded its `ttlMs`.
     * @param {number} [now=Date.now()]
     * @returns {boolean}
     */
    isToolsCacheExpired(now = Date.now()) {
        if (!this.toolsCacheMeta) return false;
        if (this.toolsCacheMeta.stale) return true;
        if (this.toolsCacheMeta.ttlMs !== null && now - this.toolsCacheMeta.fetchedAt >= this.toolsCacheMeta.ttlMs) {
            return true;
        }
        return false;
    }

    _toDeclaration(tool) {
        return {
            type: "function",
            name: tool.name,
            description: capDescription(tool.description),
            parameters: tool.inputSchema,
            ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
            ...(tool.annotations ? { annotations: { ...tool.annotations } } : {}),
            ...(tool.sensitive !== undefined ? { sensitive: Boolean(tool.sensitive) } : {}),
        };
    }

    /**
     * Maps an MCP SDK tool representation to an internal fused tool object.
     * @private
     */
    _mapTool(tool) {
        return {
            ...this._toDeclaration(tool),
            outputSchema: tool.outputSchema,
            func: async (args, context = {}) => this.executeTool(tool.name, args, context),
        };
    }

    /**
     * Internal handler for listChanged notifications from the SDK.
     * Treats a cached list as stale immediately upon `notifications/tools/list_changed`,
     * even before its TTL expires.
     * @private
     */
    _handleToolsChanged(error, tools) {
        if (this.toolsCacheMeta) {
            this.toolsCacheMeta = { ...this.toolsCacheMeta, stale: true };
        }

        if (error) {
            if (this.events) {
                this.events.emit('mcp:error', {
                    action: 'listChanged',
                    error: error.message,
                });
            }
            return;
        }

        if (Array.isArray(tools)) {
            this.rawTools = tools;
            this.tools = tools.map(tool => this._mapTool(tool));
            this.toolsCacheMeta = {
                fetchedAt: Date.now(),
                ttlMs: this.toolsCacheMeta?.ttlMs ?? null,
                cacheScope: this.toolsCacheMeta?.cacheScope ?? null,
                stale: false,
            };
        } else {
            this.refreshTools().catch((err) => {
                if (this.events) {
                    this.events.emit('mcp:error', {
                        action: 'refreshTools',
                        error: err.message,
                    });
                }
            });
        }

        for (const listener of this._listChangeListeners) {
            try {
                listener(this.tools);
            } catch {
                // Ignore listener errors
            }
        }

        if (this.events) {
            this.events.emit('mcp:toolsChanged', {
                tools: this.tools,
            });
        }
    }

    /**
     * Executes a tool by name with arguments and execution context.
     *
     * @param {string} toolName - Name of the tool.
     * @param {object} args - Arguments to pass to the tool.
     * @param {object} [context={}] - Execution context (e.g. { signal, timeout, onprogress }).
     * @returns {Promise<any>} The tool execution content, carrying structuredContent if available.
     * @throws {Exception} If the tool execution failed (isError: true).
     */
    async executeTool(toolName, args, context = {}) {
        if (!this.isConnected || !this.mcp) {
            throw new Error("MCP client is not connected to a server");
        }

        const tool = this.tools.find(t => t.name === toolName);
        if (!tool) {
            throw new Error(`Tool '${toolName}' not found on MCP server`);
        }

        const requestOptions = {};
        if (context.signal) {
            requestOptions.signal = context.signal;
        }
        if (context.timeout) {
            requestOptions.timeout = context.timeout;
        } else if (this.callTimeoutMS) {
            requestOptions.timeout = this.callTimeoutMS;
        }
        if (context.onprogress) {
            requestOptions.onprogress = context.onprogress;
        }
        if (context.resetTimeoutOnProgress !== undefined) {
            requestOptions.resetTimeoutOnProgress = context.resetTimeoutOnProgress;
        }
        if (context.maxTotalTimeout !== undefined) {
            requestOptions.maxTotalTimeout = context.maxTotalTimeout;
        }

        // Attach W3C distributed trace context if OpenTelemetry is active
        const meta = { ...(context._meta || {}) };
        try {
            const activeSpan = trace?.getActiveSpan?.();
            if (activeSpan) {
                const spanContext = activeSpan.spanContext();
                if (spanContext?.traceId && spanContext?.spanId) {
                    meta[TRACEPARENT_META_KEY] = `00-${spanContext.traceId}-${spanContext.spanId}-${(spanContext.traceFlags ?? 1).toString(16).padStart(2, '0')}`;
                    if (spanContext.traceState) {
                        meta[TRACESTATE_META_KEY] = spanContext.traceState.serialize();
                    }
                }
            }
        } catch {
            // Ignore telemetry capture failures
        }

        if (Object.keys(meta).length > 0) {
            requestOptions._meta = meta;
        }

        const result = await this.mcp.callTool({
            name: toolName,
            arguments: args,
        }, requestOptions);

        if (result.isError) {
            const errorText = Array.isArray(result.content)
                ? result.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
                : (typeof result.content === 'string' ? result.content : `Tool "${toolName}" failed on MCP server`);

            throw makeException('ToolExecutionFailed', {
                message: errorText || `Tool "${toolName}" failed on MCP server`,
                toolName,
                content: result.content,
                structuredContent: result.structuredContent,
                isError: true,
            });
        }

        if (result.structuredContent !== undefined) {
            return {
                content: result.content,
                structuredContent: result.structuredContent,
            };
        }

        return result.content;
    }

    /**
     * Returns serializable tool declarations.
     * @returns {Array<object>}
     */
    listDeclarations() {
        if (!this.isConnected) return [];
        return this.rawTools.map(t => this._toDeclaration(t));
    }

    /**
     * Returns list of available tool names.
     * @returns {Array<string>}
     */
    listNames() {
        return this.rawTools.map(t => t.name);
    }

    /**
     * Returns usage instructions advertised by the MCP server for system prompt inclusion.
     * @returns {string|undefined}
     */
    getInstructions() {
        return this.mcp?.getInstructions?.();
    }

    /**
     * Returns capabilities declared by the server.
     * @returns {object|undefined}
     */
    getServerCapabilities() {
        return this.mcp?.getServerCapabilities?.();
    }

    /**
     * Returns server version information.
     * @returns {object|undefined}
     */
    getServerVersion() {
        return this.mcp?.getServerVersion?.();
    }

    /**
     * Returns the negotiated protocol version (e.g. '2026-07-28' or '2025-11-25').
     * @returns {string|undefined}
     */
    getNegotiatedProtocolVersion() {
        return this.mcp?.getNegotiatedProtocolVersion?.();
    }

    /**
     * Returns modern DiscoverResult if negotiated, or undefined for legacy servers.
     * @returns {object|undefined}
     */
    getDiscoverResult() {
        return this.mcp?.getDiscoverResult?.();
    }

    /**
     * Checks if the client is connected to a server.
     * @returns {boolean}
     */
    isServerConnected() {
        return this.isConnected;
    }

    /**
     * Closes the MCP client connection and terminates sessions if supported.
     */
    async disconnect() {
        if (this.transport && this.isConnected) {
            try {
                if (typeof this.transport.terminateSession === 'function') {
                    await this.transport.terminateSession().catch(() => {});
                }
            } catch {
                // Ignore session termination failures
            }

            try {
                if (this.mcp) {
                    await this.mcp.close();
                }
            } catch {
                // Ignore close errors
            }

            this.isConnected = false;
            this.tools = [];
            this.rawTools = [];
            this.toolsCacheMeta = null;
            this.transport = null;
            this.mcp = null;
        }
    }

    // --- Internal Helpers ---

    _validateUrl(rawUrl, transportName) {
        if (!rawUrl) {
            throw new Error(`${transportName} transport requires a valid server URL.`);
        }

        let parsed;
        try {
            parsed = new URL(rawUrl);
        } catch (err) {
            throw new Error(`Invalid ${transportName} URL '${rawUrl}': ${err.message}`, { cause: err });
        }

        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error(`Invalid ${transportName} URL protocol '${parsed.protocol}'. Only http: and https: are allowed.`);
        }

        return parsed;
    }
}

export default MCPClient;