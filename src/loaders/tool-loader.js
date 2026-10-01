import { MCPManager } from "../mcp/mcp-manager.js";
import { assertToolSource } from "../tools/sources/tool-source.js";
import { LocalToolSource } from "../tools/sources/local-tool-source.js";
import { MCPToolSource } from "../tools/sources/mcp-tool-source.js";

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
     * @param {boolean} [options.prefixToolNames=true] - Whether MCP tools are prefixed by default.
     */
    constructor(enableMCP = false, {
        eventEmitter = null,
        mcpManagerFactory = null,
        prefixToolNames = true,
    } = {}) {
        this.events = eventEmitter;
        this.prefixToolNames = prefixToolNames;
        this.localSource = new LocalToolSource();
        this.sources = [this.localSource];
        this.nameIndex = new Map();
        this.rawNameIndex = new Map();

        const createMCP = mcpManagerFactory || (opts => new MCPManager(opts));
        this.mcpManager = enableMCP ? createMCP({ eventEmitter: this.events }) : null;
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
        const declarations = typeof source.getDeclarations === 'function'
            ? source.getDeclarations()
            : [];

        const batchIdentifiers = new Set();
        for (const decl of declarations) {
            const identifier = decl.name || decl.type;
            if (this.nameIndex.has(identifier) || batchIdentifiers.has(identifier)) {
                throw new Error(`Tool with name '${identifier}' already exists.`);
            }
            batchIdentifiers.add(identifier);
        }

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
            const sourceDecls = typeof source.getDeclarations === 'function'
                ? source.getDeclarations()
                : [];
            for (const decl of sourceDecls) {
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
                const decls = typeof source.getDeclarations === 'function' ? source.getDeclarations() : [];
                for (const decl of decls) {
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
     * Finds a tool by qualified or unambiguous raw name.
     * Checks local tools first, then MCP tools.
     *
     * @param {string} name - Name of the tool to find.
     * @returns {object|null} Fused tool object including executable function, or null.
     */
    findTool(name) {
        // 1. Direct match on qualified name index
        const entry = this.nameIndex.get(name);
        if (entry) {
            if (entry.source === this.localSource) {
                return this.localSource.findTool(name);
            }
            return {
                ...entry.declaration,
                func: async (args, context) => entry.source.invoke(name, args, context),
            };
        }

        // 2. Unambiguous raw name fallback
        const rawMatches = this.rawNameIndex.get(name);
        if (rawMatches && rawMatches.length === 1) {
            const match = rawMatches[0];
            return {
                ...match.declaration,
                func: async (args, context) => match.source.invoke(match.qualifiedName, args, context),
            };
        }

        return null;
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

        const batchIdentifiers = new Set();
        for (const tool of tools) {
            this._validateToolStructure(tool);
            const identifier = this._getToolIdentifier(tool);

            if (this.nameIndex.has(identifier) || batchIdentifiers.has(identifier)) {
                throw new Error(`Tool with name '${identifier}' already exists.`);
            }
            batchIdentifiers.add(identifier);
        }

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
        const serverTools = result.tools || [];
        const prefix = options.prefixToolNames !== undefined ? options.prefixToolNames : this.prefixToolNames;

        const source = new MCPToolSource({
            serverName,
            client: result.client,
            tools: serverTools,
            prefixToolNames: prefix,
            eventEmitter: this.events,
        });

        const batchIdentifiers = new Set();
        try {
            for (const tool of serverTools) {
                this._validateToolStructure(tool);
            }

            const declarations = source.getDeclarations();
            for (const decl of declarations) {
                const identifier = decl.name;
                if (this.nameIndex.has(identifier) || batchIdentifiers.has(identifier)) {
                    throw new Error(`MCP tool with name '${identifier}' already exists.`);
                }
                batchIdentifiers.add(identifier);
            }

            this.sources.push(source);
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

        if (this.mcpManager) {
            await this.mcpManager.cleanup();
        }

        this._rebuildIndex();
    }

    // --- Internals ---

    _rebuildIndex() {
        this.nameIndex.clear();
        this.rawNameIndex.clear();

        for (const source of this.sources) {
            const declarations = typeof source.getDeclarations === 'function'
                ? source.getDeclarations()
                : [];

            for (const decl of declarations) {
                const qualifiedName = decl.name || decl.type;
                this.nameIndex.set(qualifiedName, { source, declaration: decl });

                let rawName = qualifiedName;
                const sourceDesc = source.describe();
                if (sourceDesc.kind === 'mcp' && qualifiedName.startsWith(`${sourceDesc.id}_`)) {
                    rawName = qualifiedName.slice(sourceDesc.id.length + 1);
                }

                if (!this.rawNameIndex.has(rawName)) {
                    this.rawNameIndex.set(rawName, []);
                }
                this.rawNameIndex.get(rawName).push({
                    source,
                    qualifiedName,
                    declaration: decl,
                });
            }
        }
    }

    _getToolIdentifier(tool) {
        return tool.name || tool.type;
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
        if (typeof tool.func !== 'function') {
            throw new Error("Tool missing func");
        }
    }
}