import { createHash } from "node:crypto";
import MCPClient from "../../mcp/mcp-client.js";

export const TOOL_NAME_SEPARATOR = '_';
export const MAX_TOOL_NAME_LENGTH = 64;

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
        description = '',
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
        this.description = description;
        this.serverConfig = serverConfig;
        this.prefixToolNames = prefixToolNames;
        this.events = eventEmitter;
        this.cachedDeclarations = null;
        this.nameMapping = new Map();

        if (!client && tools) {
            const toolMap = new Map(tools.map(t => [t.name, t]));
            this.client = {
                isServerConnected: () => true,
                listDeclarations: () => Array.from(toolMap.values()).map(({ func: _f, ...decl }) => ({ type: 'function', ...decl })),
                executeTool: async (n, a, c) => {
                    const tool = toolMap.get(n);
                    if (tool && typeof tool.func === 'function') {
                        return tool.func(a, c);
                    }
                    throw new Error(`Tool '${n}' not found on MCP server '${this.serverName}'`);
                },
            };
        } else {
            this.client = client;
        }

        this._toolsChangedHandler = () => {
            this.cachedDeclarations = null;
            this.nameMapping.clear();
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
        const isConnected = Boolean(this.client?.isServerConnected?.());
        return {
            id: this.serverName,
            kind: 'mcp',
            title: this.serverName,
            description: this.description || this.client?.getInstructions?.() || `MCP tools from server ${this.serverName}`,
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
                : (this.client.tools || []).map(({ func: _f, ...decl }) => decl);
        }

        this.nameMapping.clear();
        this.cachedDeclarations = rawDeclarations.map(decl => {
            let qualifiedName = this.prefixToolNames
                ? `${this.serverName}${TOOL_NAME_SEPARATOR}${decl.name}`
                : decl.name;

            if (qualifiedName.length > MAX_TOOL_NAME_LENGTH) {
                const hash = createHash('sha256').update(qualifiedName).digest('hex').slice(0, 8);
                qualifiedName = `${qualifiedName.slice(0, 55)}_${hash}`;
            }

            this.nameMapping.set(qualifiedName, decl.name);

            return {
                ...decl,
                type: 'function',
                name: qualifiedName,
                source: {
                    kind: 'mcp',
                    serverName: this.serverName,
                    remoteName: decl.name,
                },
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
        let rawName = this.nameMapping.get(name);
        if (!rawName) {
            const matched = this.cachedDeclarations?.find(d => d.name === name || d.source?.remoteName === name);
            rawName = matched ? matched.source.remoteName : name;
        }

        if (this.client && typeof this.client.executeTool === 'function') {
            return await this.client.executeTool(rawName, args, context);
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
    }
}
