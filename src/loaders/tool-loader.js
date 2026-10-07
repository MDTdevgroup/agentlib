import { MCPManager } from "../mcp/mcp-manager.js";
import { assertToolSource } from "../tools/sources/tool-source.js";
import { LocalToolSource } from "../tools/sources/local-tool-source.js";
import { MCPToolSource } from "../tools/sources/mcp-tool-source.js";

export const RESERVED_META_TOOL_NAMES = Object.freeze(new Set([
    'search_tools',
    'get_tool_details',
    'call_tool',
    'search_servers',
    'enable_server',
    'disable_server',
]));

/**
 * Manages the lifecycle, storage, validation, and retrieval of an agent's tools.
 * Acts as a facade over an ordered collection of ToolSource instances.
 */
export class ToolLoader {
    /**
     * @param {boolean} [enableMCP=false] - Whether to initialize the MCP manager.
     * @param {object} [options={}]
     * @param {EventEmitter} [options.eventEmitter=null] - Event emitter for MCP events.
     * @param {Function} [options.mcpManagerFactory=null] - Factory to instantiate MCPManager.
     * @param {Function} [options.mcpSourceFactory=null] - Factory to instantiate MCPToolSource.
     * @param {boolean} [options.prefixToolNames=true] - Whether MCP tools are prefixed by default.
     */
    constructor(enableMCP = false, {
        eventEmitter = null,
        mcpManagerFactory = null,
        mcpSourceFactory = null,
        prefixToolNames = true,
    } = {}) {
        this.events = eventEmitter;
        this.prefixToolNames = prefixToolNames;
        this.mcpSourceFactory = mcpSourceFactory;
        this.localSource = new LocalToolSource();
        this.sources = [this.localSource];
        this.nameIndex = new Map();
        this.registeredServers = new Map();

        const createMCP = mcpManagerFactory || (opts => new MCPManager(opts));
        this.mcpManager = enableMCP ? createMCP({ eventEmitter: this.events }) : null;
    }

    /**
     * Returns true if there are lazily registered MCP servers.
     * @returns {boolean}
     */
    hasLazyServers() {
        for (const entry of this.registeredServers.values()) {
            if (entry.isLazy) return true;
        }
        return false;
    }

    /**
     * Sets or updates the event emitter for telemetry and observability.
     * @param {EventEmitter} eventEmitter
     */
    setEventEmitter(eventEmitter) {
        this.events = eventEmitter;
        if (this.mcpManager) {
            this.mcpManager.events = eventEmitter;
        }
        for (const source of this.sources) {
            if (source.events !== undefined) {
                source.events = eventEmitter;
            }
        }
    }

    /**
     * Registers a custom ToolSource instance.
     * @param {object} source - ToolSource instance satisfying the capability contract.
     */
    addSource(source) {
        assertToolSource(source);
        this._assertNoCollisions(source.getDeclarations());
        this.sources.push(source);
        this._rebuildIndex();
    }

    /**
     * Returns serializable tool declarations (metadata only, no executable functions).
     * Local declarations are returned before MCP declarations.
     *
     * @returns {Array<object>} Array of tool declarations.
     */
    getToolDeclarations() {
        const declarations = [];
        for (const source of this.sources) {
            for (const decl of source.getDeclarations()) {
                declarations.push({ ...decl });
            }
        }
        return declarations;
    }

    /**
     * Compatibility method that returns fused tool objects containing both metadata and func.
     * Callers that only require serializable metadata should use getToolDeclarations().
     *
     * @returns {Array<object>} An array of tool objects containing metadata and func.
     */
    getTools() {
        const tools = [];
        for (const source of this.sources) {
            if (source === this.localSource) {
                tools.push(...this.localSource.getTools());
            } else {
                for (const decl of source.getDeclarations()) {
                    const name = decl.name || decl.type;
                    tools.push({
                        ...decl,
                        func: async (args, context) => source.invoke(name, args, context),
                    });
                }
            }
        }
        return tools;
    }

    /**
     * Finds a tool by qualified or registered name.
     * Checks local tools first, then MCP tools.
     *
     * @param {string} name - Name of the tool to find.
     * @returns {object|null} Fused tool object including executable function, or null.
     */
    findTool(name) {
        const entry = this.nameIndex.get(name);
        if (!entry) return null;
        if (entry.source === this.localSource) {
            return this.localSource.findTool(name);
        }
        return {
            ...entry.declaration,
            func: async (args, context) => entry.source.invoke(name, args, context),
        };
    }

    /**
     * Registers a new local tool.
     * @param {object} tool - Tool definition.
     */
    addTool(tool) {
        this.addTools([tool]);
    }

    /**
     * Atomically registers multiple local tools.
     *
     * @param {Array<object>} tools - Array of tool definitions.
     * @throws {Error} If any tool is invalid or duplicates an existing tool name.
     */
    addTools(tools) {
        if (!Array.isArray(tools)) {
            throw new TypeError("addTools expects an array of tools");
        }

        for (const tool of tools) {
            this._validateToolStructure(tool);
        }
        this._assertNoCollisions(tools);

        this.localSource.addTools(tools);
        this._rebuildIndex();
    }

    /**
     * Connects an MCP server, wraps it in an MCPToolSource, and indexes its tools.
     * If tool validation or duplicate name detection fails, connection is rolled back.
     *
     * @param {string} serverName - Unique identifier for this MCP server.
     * @param {object} config - Configuration object for MCP server connection.
     * @param {object} [options={}] - Options (e.g. { prefixToolNames }).
     * @returns {Promise<object>} Result of connection attempt.
     */
    async addMCPServer(serverName, config, options = {}) {
        if (!this.mcpManager) {
            throw new Error("MCP is disabled.");
        }

        const result = await this.mcpManager.addServer(serverName, config);
        const client = typeof this.mcpManager.getClient === 'function'
            ? this.mcpManager.getClient(serverName)
            : (result.client || null);
        const serverTools = result.tools || [];
        const prefix = options.prefixToolNames !== undefined ? options.prefixToolNames : this.prefixToolNames;

        const source = new MCPToolSource({
            serverName,
            client,
            tools: serverTools,
            prefixToolNames: prefix,
            eventEmitter: this.events,
        });

        try {
            for (const tool of serverTools) {
                this._validateToolStructure(tool);
            }

            this._assertNoCollisions(source.getDeclarations(), 'MCP tool');

            this.sources.push(source);
            this.registeredServers.set(serverName, {
                serverName,
                status: 'active',
                source,
                isLazy: false,
            });
            this._rebuildIndex();
        } catch (validationError) {
            try {
                await this.mcpManager.removeServer(serverName);
            } catch (rollbackError) {
                throw new AggregateError(
                    [validationError, rollbackError],
                    `Failed to register tools from MCP server '${serverName}' and rollback failed.`
                );
            }
            throw validationError;
        }

        return result;
    }

    /**
     * Removes an MCP server and un-indexes its tools.
     *
     * @param {string} serverName - Server identifier.
     * @returns {Promise<boolean>} True if removed, false otherwise.
     */
    async removeMCPServer(serverName) {
        if (!this.mcpManager) return false;
        const removed = await this.mcpManager.removeServer(serverName);
        if (removed) {
            this.registeredServers.delete(serverName);
            const index = this.sources.findIndex(s => {
                const desc = s.describe();
                return desc.kind === 'mcp' && desc.id === serverName;
            });
            if (index !== -1) {
                const [source] = this.sources.splice(index, 1);
                await source.close();
                this._rebuildIndex();
            }
        }
        return removed;
    }

    /**
     * Lazily registers an MCP server configuration without connecting.
     * Deferring connection eliminates startup latency and child process overhead.
     *
     * @param {string} serverName - Identifier for the MCP server.
     * @param {object} serverConfig - Server configuration blueprint (e.g. transport, command, url).
     * @param {object} [options={}]
     * @param {string} [options.description=''] - Natural language description of server capabilities.
     * @param {boolean} [options.prefixToolNames] - Override default tool name prefixing.
     * @returns {{ serverName: string, status: 'dormant' }}
     */
    registerMCPServer(serverName, serverConfig, { description = '', prefixToolNames, sourceFactory = null } = {}) {
        if (!serverName || typeof serverName !== 'string') {
            throw new TypeError("registerMCPServer requires a non-empty 'serverName' string.");
        }
        if (!serverConfig || typeof serverConfig !== 'object') {
            throw new TypeError("registerMCPServer requires a valid 'serverConfig' object.");
        }
        if (this.registeredServers.has(serverName)) {
            throw new Error(`MCP server '${serverName}' is already registered.`);
        }

        const isActivelyConnected = this.sources.some(s => {
            const desc = s.describe();
            return desc.kind === 'mcp' && desc.id === serverName;
        });
        if (isActivelyConnected) {
            throw new Error(`MCP server '${serverName}' is already actively connected.`);
        }

        const prefix = prefixToolNames !== undefined ? prefixToolNames : this.prefixToolNames;
        this.registeredServers.set(serverName, {
            serverName,
            serverConfig,
            description,
            prefixToolNames: prefix,
            sourceFactory,
            status: 'dormant',
            source: null,
            isLazy: true,
        });

        return { serverName, status: 'dormant' };
    }

    /**
     * Connects and activates a registered MCP server mid-run, indexing its tools into the catalog.
     *
     * @param {string} serverName - Identifier of registered server to enable.
     * @returns {Promise<{ serverName: string, status: string, tools: Array<object>, toolCount: number }>}
     */
    async enableMCPServer(serverName) {
        if (!this.registeredServers.has(serverName)) {
            throw new Error(`MCP server '${serverName}' is not registered.`);
        }

        const entry = this.registeredServers.get(serverName);
        if (entry.status === 'active' && entry.source) {
            const decls = entry.source.getDeclarations();
            return {
                serverName,
                status: 'active',
                tools: decls,
                toolCount: decls.length,
            };
        }

        const createSource = entry.sourceFactory || this.mcpSourceFactory || (opts => new MCPToolSource(opts));
        const source = entry.source || createSource({
            serverName,
            serverConfig: entry.serverConfig,
            description: entry.description,
            prefixToolNames: entry.prefixToolNames,
            eventEmitter: this.events,
        });

        try {
            await source.connect();
            const declarations = await source.list();

            this._assertNoCollisions(declarations, 'MCP tool');

            if (!this.sources.includes(source)) {
                this.sources.push(source);
            }
            this._rebuildIndex();

            entry.source = source;
            entry.status = 'active';

            if (this.events) {
                this.events.emit('mcp:server_enabled', {
                    serverName,
                    toolCount: declarations.length,
                    tools: declarations.map(d => d.name),
                });
            }

            return {
                serverName,
                status: 'active',
                tools: declarations,
                toolCount: declarations.length,
            };
        } catch (error) {
            try {
                await source.close();
            } catch {
                // Ignore close error during rollback
            }
            throw error;
        }
    }

    /**
     * Deactivates an active MCP server, removing its tools from active index.
     * NOTE: Disabling drops tool definitions and invalidates prompt prefix cache.
     * Should be performed at conversation boundaries.
     *
     * @param {string} serverName - Server to disable.
     * @param {object} [options={}]
     * @param {boolean} [options.disconnect=false] - Whether to close the underlying connection.
     * @returns {Promise<boolean>}
     */
    async disableMCPServer(serverName, { disconnect = false } = {}) {
        const entry = this.registeredServers.get(serverName);
        let foundSource = entry?.source;

        if (!foundSource) {
            const found = this.sources.find(s => {
                const desc = s.describe();
                return desc.kind === 'mcp' && desc.id === serverName;
            });
            if (found) foundSource = found;
        }

        if (!entry && !foundSource) {
            return false;
        }

        if (entry) {
            entry.status = 'disabled';
        }

        if (foundSource) {
            const index = this.sources.indexOf(foundSource);
            if (index !== -1) {
                this.sources.splice(index, 1);
                this._rebuildIndex();
            }
            if (disconnect) {
                await foundSource.close();
                if (entry && entry.isLazy) entry.source = null;
            }
        }

        if (this.events) {
            this.events.emit('mcp:server_disabled', { serverName });
        }

        return true;
    }

    /**
     * Returns a summary list of all registered (dormant, active, disabled) and eager MCP servers.
     *
     * @returns {Array<{ name: string, description: string, status: 'dormant'|'active'|'disabled', toolCount: number }>}
     */
    getRegisteredMCPServers() {
        const list = [];
        for (const [name, entry] of this.registeredServers) {
            const desc = entry.source ? entry.source.describe() : {};
            const toolCount = entry.source ? entry.source.getDeclarations().length : 0;
            list.push({
                name,
                description: entry.description || desc.description || `MCP tools from server ${name}`,
                status: entry.status,
                toolCount,
            });
        }
        return list;
    }

    /**
     * Generates a text snippet describing available tools for the System Prompt.
     *
     * @returns {string} Formatted description or empty string.
     */
    getSystemPromptSnippet() {
        const tools = this.getToolDeclarations();
        if (tools.length === 0) return "";

        const descriptions = tools
            .filter(t => t.name && t.description)
            .map(t => `${t.name}: ${t.description}`)
            .join('; ');

        if (!descriptions) return "";

        let snippet = `You are a tool-calling agent. You have access to the following tools: ${descriptions}. Use these tools to answer the user's questions.`;

        const instructions = [];
        for (const source of this.sources) {
            const desc = source.describe();
            if (desc.kind === 'mcp' && desc.description && !desc.description.startsWith('MCP tools from server')) {
                instructions.push(`[${desc.title} instructions]: ${desc.description}`);
            }
        }
        if (instructions.length > 0) {
            snippet += `\n\n${instructions.join('\n')}`;
        }

        return snippet;
    }

    /**
     * Gets status information about the MCP manager.
     * @returns {object}
     */
    getMCPInfo() {
        return this.mcpManager ? this.mcpManager.getServerInfo() : { enabled: false };
    }

    /**
     * Cleans up MCP resources and un-indexes MCP tools, preserving local tools.
     * @returns {Promise<void>}
     */
    async cleanup() {
        const nonLocalSources = this.sources.filter(s => s !== this.localSource);
        for (const source of nonLocalSources) {
            try {
                await source.close();
            } catch {
                // Ignore close errors during cleanup
            }
        }
        this.sources = [this.localSource];

        for (const [_name, entry] of this.registeredServers) {
            if (entry.source) {
                try {
                    await entry.source.close();
                } catch {
                    // Ignore close errors
                }
                if (entry.isLazy) {
                    entry.source = null;
                    entry.status = 'dormant';
                } else {
                    entry.status = 'disabled';
                }
            }
        }

        if (this.mcpManager) {
            await this.mcpManager.cleanup();
        }

        this._rebuildIndex();
    }

    // --- Internals ---

    _rebuildIndex() {
        this.nameIndex.clear();
        for (const source of this.sources) {
            for (const decl of source.getDeclarations()) {
                this.nameIndex.set(decl.name || decl.type, { source, declaration: decl });
            }
        }
    }

    _assertNoCollisions(declarations, prefix = 'Tool') {
        const batchIdentifiers = new Set();
        for (const item of declarations) {
            const identifier = item.name || item.type;
            if (this.nameIndex.has(identifier) || batchIdentifiers.has(identifier)) {
                throw new Error(`${prefix} with name '${identifier}' already exists.`);
            }
            batchIdentifiers.add(identifier);
        }
    }

    _validateToolStructure(tool) {
        if (!tool || typeof tool !== 'object') {
            throw new Error("Invalid tool object");
        }

        if (tool.type && tool.type !== 'function') {
            return;
        }

        if (typeof tool.name !== 'string' || !tool.name.trim()) {
            throw new Error("Tool missing name");
        }
        if (RESERVED_META_TOOL_NAMES.has(tool.name)) {
            throw new Error(`Tool name '${tool.name}' is reserved for agent meta-tools.`);
        }
        if (typeof tool.func !== 'function') {
            throw new Error("Tool missing func");
        }
    }
}