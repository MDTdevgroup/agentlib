import MCPClient from "../../mcp/mcp-client.js";

/**
 * ToolSource wrapping an MCP server connection.
 */
export class MCPToolSource {
    /**
     * @param {object} options
     * @param {string} options.serverName - Unique identifier for the MCP server.
     * @param {MCPClient} [options.client=null] - Connected MCP client instance.
     * @param {object} [options.serverConfig=null] - Configuration to connect MCP client.
     * @param {Array<object>} [options.tools=null] - Pre-fetched or mock tools array.
     * @param {boolean} [options.prefixToolNames=true] - Whether to prefix tool names with `${serverName}_`.
     * @param {EventEmitter} [options.eventEmitter=null] - Event emitter for MCP events.
     */
    constructor({
        serverName,
        client = null,
        serverConfig = null,
        tools = null,
        prefixToolNames = true,
        eventEmitter = null,
    } = {}) {
        if (!serverName || typeof serverName !== 'string') {
            throw new TypeError("MCPToolSource requires a non-empty 'serverName' string.");
        }

        this.serverName = serverName;
        this.client = client;
        this.serverConfig = serverConfig;
        this.prefixToolNames = prefixToolNames;
        this.events = eventEmitter;
        this.mockTools = tools ? new Map(tools.map(t => [t.name, t])) : null;
        this.cachedDeclarations = null;

        this._toolsChangedHandler = () => {
            this.cachedDeclarations = null;
        };

        if (this.client && typeof this.client.onToolsChanged === 'function') {
            this.client.onToolsChanged(this._toolsChangedHandler);
        }
    }

    /**
     * Returns descriptor metadata for discovery.
     * @returns {object}
     */
    describe() {
        const isConnected = this.client ? Boolean(this.client.isServerConnected()) : Boolean(this.mockTools);
        return {
            id: this.serverName,
            kind: 'mcp',
            title: this.serverName,
            description: this.client?.getInstructions?.() || `MCP tools from server ${this.serverName}`,
            connected: isConnected,
        };
    }

    /**
     * Returns serializable tool declarations.
     * @returns {Promise<Array<object>>}
     */
    async list() {
        return this.getDeclarations();
    }

    /**
     * Synchronously returns cached tool declarations.
     * @returns {Array<object>}
     */
    getDeclarations() {
        if (this.cachedDeclarations) {
            return this.cachedDeclarations.map(d => ({ ...d }));
        }

        let rawDeclarations = [];
        if (this.client) {
            rawDeclarations = typeof this.client.listDeclarations === 'function'
                ? this.client.listDeclarations()
                : (this.client.tools || []).map(t => {
                    const { func: _f, ...decl } = t;
                    return decl;
                });
        } else if (this.mockTools) {
            rawDeclarations = Array.from(this.mockTools.values()).map(t => {
                const { func: _f, ...decl } = t;
                return { type: 'function', ...decl };
            });
        }

        this.cachedDeclarations = rawDeclarations.map(decl => {
            const qualifiedName = this.prefixToolNames
                ? `${this.serverName}_${decl.name}`
                : decl.name;

            return {
                ...decl,
                type: 'function',
                name: qualifiedName,
            };
        });

        return this.cachedDeclarations.map(d => ({ ...d }));
    }

    /**
     * Invokes an MCP tool by qualified or raw name.
     *
     * @param {string} name - Qualified or raw name of the tool.
     * @param {object} args - Arguments to pass to the tool.
     * @param {object} [context={}] - Execution context.
     * @returns {Promise<any>}
     */
    async invoke(name, args, context = {}) {
        let rawName = name;
        const prefix = `${this.serverName}_`;

        if (this.prefixToolNames && name.startsWith(prefix)) {
            rawName = name.slice(prefix.length);
        }

        if (this.client && typeof this.client.executeTool === 'function') {
            return await this.client.executeTool(rawName, args, context);
        }

        if (this.mockTools) {
            const mockTool = this.mockTools.get(rawName) || this.mockTools.get(name);
            if (mockTool && typeof mockTool.func === 'function') {
                return await mockTool.func(args, context);
            }
        }

        throw new Error(`Tool '${name}' not found on MCP server '${this.serverName}'`);
    }

    /**
     * Connects to the underlying MCP server if not already connected.
     * @returns {Promise<void>}
     */
    async connect() {
        if (!this.client && this.serverConfig) {
            this.client = new MCPClient({ eventEmitter: this.events });
            if (typeof this.client.onToolsChanged === 'function') {
                this.client.onToolsChanged(this._toolsChangedHandler);
            }
        }

        if (this.client && !this.client.isServerConnected() && this.serverConfig) {
            await this.client.connectToServer(this.serverConfig);
            this.cachedDeclarations = null;
        }
    }

    /**
     * Disconnects from the MCP server and releases resources.
     * @returns {Promise<void>}
     */
    async close() {
        if (this.client) {
            if (typeof this.client.offToolsChanged === 'function') {
                this.client.offToolsChanged(this._toolsChangedHandler);
            }
            if (typeof this.client.disconnect === 'function') {
                await this.client.disconnect();
            }
        }
        this.cachedDeclarations = null;
        this.mockTools = null;
    }
}
