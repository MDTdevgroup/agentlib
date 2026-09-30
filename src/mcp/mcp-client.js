import {
    Client,
    StreamableHTTPClientTransport,
    TRACEPARENT_META_KEY,
    TRACESTATE_META_KEY,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { trace } from "@opentelemetry/api";
import { makeException } from "../util/exception.js";

export const DEFAULT_CLIENT_INFO = Object.freeze({
    name: "@peebles-group/agentlib-js",
    version: "4.1.0",
});

/**
 * Client wrapper for Model Context Protocol (MCP) servers using SDK v2.
 */
class MCPClient {
    /**
     * @param {object} [options]
     * @param {object} [options.clientInfo] - Client identity name and version.
     * @param {EventEmitter} [options.eventEmitter] - Optional event emitter for status and list changes.
     * @param {number} [options.listMaxPages=64] - Cap on list pagination walk.
     */
    constructor({ clientInfo = DEFAULT_CLIENT_INFO, eventEmitter = null, listMaxPages = 64 } = {}) {
        this.clientInfo = clientInfo;
        this.events = eventEmitter;
        this.listMaxPages = listMaxPages;
        this.mcp = null;
        this.transport = null;
        this.tools = [];
        this.rawTools = [];
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

        switch (server.type) {
            case "stdio":
                this.transport = new StdioClientTransport(server);
                break;
            case "sse": {
                const url = this._validateUrl(server.url, "SSE");
                this.transport = new SSEClientTransport(url, server.transportOptions);
                break;
            }
            case "streamableHttp": {
                const url = this._validateUrl(server.url, "Streamable HTTP");
                const transportOpts = { ...(server.transportOptions || {}) };
                if (server.fetch) {
                    transportOpts.fetch = server.fetch;
                }
                this.transport = new StreamableHTTPClientTransport(url, transportOpts);
                break;
            }
            case "inMemory": {
                if (!server.transport) {
                    throw new Error("inMemory server type requires a transport instance in server.transport.");
                }
                this.transport = server.transport;
                break;
            }
            default:
                throw new Error(`Invalid server type: ${server.type}`);
        }

        this.mcp = new Client(
            this.clientInfo,
            {
                listMaxPages: this.listMaxPages,
                listChanged: {
                    tools: {
                        onChanged: (error, tools) => {
                            this._handleToolsChanged(error, tools);
                        },
                    },
                },
                versionNegotiation: {
                    mode: server.versionNegotiationMode || 'auto',
                },
            }
        );

        await this.mcp.connect(this.transport);
        this.isConnected = true;

        await this.refreshTools();
        return this.tools;
    }

    /**
     * Refreshes the cached list of tools from the server.
     * @returns {Promise<Array<object>>}
     */
    async refreshTools() {
        if (!this.isConnected || !this.mcp) {
            return [];
        }

        const toolsResult = await this.mcp.listTools();
        this.rawTools = toolsResult.tools || [];
        this.tools = this.rawTools.map((tool) => {
            return {
                type: "function",
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
                outputSchema: tool.outputSchema,
                func: async (args, context = {}) => {
                    return await this.executeTool(tool.name, args, context);
                }
            };
        });

        return this.tools;
    }

    /**
     * Internal handler for listChanged notifications from the SDK.
     * @private
     */
    _handleToolsChanged(error, tools) {
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
            this.tools = tools.map((tool) => ({
                type: "function",
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
                outputSchema: tool.outputSchema,
                func: async (args, context = {}) => {
                    return await this.executeTool(tool.name, args, context);
                }
            }));
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

        const output = result.content;
        if (output && typeof output === 'object' && result.structuredContent !== undefined) {
            try {
                Object.defineProperty(output, 'structuredContent', {
                    value: result.structuredContent,
                    writable: true,
                    enumerable: false,
                    configurable: true,
                });
            } catch {
                // If output is frozen or not extensible, fallback without error
            }
        }

        return output;
    }

    /**
     * Returns serializable tool declarations.
     * @returns {Array<object>}
     */
    listDeclarations() {
        if (!this.isConnected) {
            return [];
        }
        return this.rawTools.map(t => ({
            type: 'function',
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
            ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
        }));
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

    // --- Backward compatibility methods ---

    getTools() {
        if (!this.isConnected) {
            return [];
        }
        return this.tools;
    }

    getToolNames() {
        return this.listNames();
    }

    getAvailableTools() {
        return this.listNames();
    }

    getAgentTools() {
        return this.tools;
    }

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