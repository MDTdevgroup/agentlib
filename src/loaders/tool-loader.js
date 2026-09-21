import { MCPManager } from "../mcp/mcp-manager.js";

/**
 * Manages the lifecycle, storage, validation, and retrieval of an agent's tools.
 */
export class ToolLoader {
    /**
     * @param {boolean} [enableMCP=false] - Whether to initialize the MCP manager.
     * @param {object} [options={}]
     * @param {EventEmitter} [options.eventEmitter=null] - Event emitter for MCP events.
     * @param {Function} [options.mcpManagerFactory=null] - Factory to instantiate MCPManager.
     */
    constructor(enableMCP = false, { eventEmitter = null, mcpManagerFactory = null } = {}) {
        this.localTools = new Map();
        this.mcpTools = new Map();
        this.events = eventEmitter;
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
    }

    /**
     * Returns serializable tool declarations (metadata only, no executable functions).
     * Local declarations are returned before MCP declarations.
     *
     * @returns {Array<Object>} Array of tool declarations.
     */
    getToolDeclarations() {
        const declarations = [];
        for (const record of this.localTools.values()) {
            declarations.push({ ...record.declaration });
        }
        for (const record of this.mcpTools.values()) {
            declarations.push({ ...record.declaration });
        }
        return declarations;
    }

    /**
     * Compatibility method that returns fused tool objects containing both metadata and func.
     * Callers that only require serializable metadata should use getToolDeclarations().
     *
     * @returns {Array<Object>} An array of tool objects containing metadata and func.
     */
    getTools() {
        const tools = [];
        for (const record of this.localTools.values()) {
            tools.push(this._toFusedRecord(record));
        }
        for (const record of this.mcpTools.values()) {
            tools.push(this._toFusedRecord(record));
        }
        return tools;
    }

    /**
     * Finds a tool by name, checking local tools first, then MCP tools.
     *
     * @param {string} name - The name of the tool to find.
     * @returns {Object|null} The fused tool object including the executable function, or null if not found.
     */
    findTool(name) {
        const localRecord = this.localTools.get(name);
        if (localRecord) {
            return this._toFusedRecord(localRecord);
        }
        const mcpRecord = this.mcpTools.get(name);
        if (mcpRecord) {
            return this._toFusedRecord(mcpRecord);
        }
        return null;
    }

    /**
     * Registers a new local tool.
     *
     * @param {Object} tool - The tool definition (fused record or defineTool output).
     * @throws {Error} If the tool structure is invalid or the name is a duplicate.
     */
    addTool(tool) {
        this.addTools([tool]);
    }

    /**
     * Atomically registers multiple local tools.
     * Pre-validates every tool and name before mutating the registry; if any tool is
     * invalid or duplicated, no tools are added.
     *
     * @param {Array<Object>} tools - An array of tool definitions.
     * @throws {Error} If any tool structure is invalid or if any name is a duplicate.
     */
    addTools(tools) {
        if (!Array.isArray(tools)) {
            throw new TypeError("addTools expects an array of tools");
        }

        const batchIdentifiers = new Set();
        const recordsToCommit = [];

        for (const tool of tools) {
            this._validateToolStructure(tool);
            const identifier = this._getToolIdentifier(tool);

            if (
                this.localTools.has(identifier) ||
                this.mcpTools.has(identifier) ||
                batchIdentifiers.has(identifier)
            ) {
                throw new Error(`Tool with name '${identifier}' already exists.`);
            }

            batchIdentifiers.add(identifier);
            recordsToCommit.push({
                identifier,
                record: this._normalizeTool(tool, { kind: 'local' }),
            });
        }

        // Commit all records atomically after full batch validation
        for (const { identifier, record } of recordsToCommit) {
            this.localTools.set(identifier, record);
        }
    }

    /**
     * Connects an MCP server, normalizes its tools, and indexes them.
     * If tool validation or duplicate name detection fails, the connection is rolled back.
     *
     * @param {string} serverName - Unique identifier for this MCP server.
     * @param {Object} config - Configuration object for the MCP server connection.
     * @returns {Promise<Object>} The result of the connection attempt.
     * @throws {Error} If MCP is not enabled, or if connection/registration fails.
     */
    async addMCPServer(serverName, config) {
        if (!this.mcpManager) {
            throw new Error("MCP is disabled.");
        }

        const result = await this.mcpManager.addServer(serverName, config);
        const serverTools = result.tools || [];

        const batchIdentifiers = new Set();
        const recordsToCommit = [];

        try {
            for (const tool of serverTools) {
                this._validateToolStructure(tool);
                const identifier = this._getToolIdentifier(tool);

                // TODO: Consider supporting automatic tool name prefixes or namespacing
                // (e.g. `${serverName}_${toolName}`) to prevent collisions across multiple
                // MCP servers or multi-agent catalogs without requiring manual renaming.
                if (
                    this.localTools.has(identifier) ||
                    this.mcpTools.has(identifier) ||
                    batchIdentifiers.has(identifier)
                ) {
                    throw new Error(`MCP tool with name '${identifier}' already exists.`);
                }

                batchIdentifiers.add(identifier);
                recordsToCommit.push({
                    identifier,
                    record: this._normalizeTool(tool, { kind: 'mcp', serverName }),
                });
            }
        } catch (validationError) {
            // Roll back the server connection on failure
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

        for (const { identifier, record } of recordsToCommit) {
            this.mcpTools.set(identifier, record);
        }

        return result;
    }

    /**
     * Removes an MCP server and removes its indexed tools from the registry.
     *
     * @param {string} serverName - Identifier of the server to remove.
     * @returns {Promise<boolean>} True if removed successfully, false otherwise.
     */
    async removeMCPServer(serverName) {
        if (!this.mcpManager) return false;
        const removed = await this.mcpManager.removeServer(serverName);
        if (removed) {
            for (const [identifier, record] of this.mcpTools) {
                if (record.source?.serverName === serverName) {
                    this.mcpTools.delete(identifier);
                }
            }
        }
        return removed;
    }

    /**
     * Generates a text snippet describing available tools for the System Prompt.
     * Reads tool declarations only.
     *
     * @returns {string} A formatted string describing tools, or empty string if none exist.
     */
    getSystemPromptSnippet() {
        const tools = this.getToolDeclarations();
        if (tools.length === 0) return "";

        const descriptions = tools
            .filter(t => t.name && t.description)
            .map(t => `${t.name}: ${t.description}`)
            .join('; ');

        if (!descriptions) return "";

        return `You are a tool-calling agent. You have access to the following tools: ${descriptions}. Use these tools to answer the user's questions.`;
    }

    /**
     * Gets status information about the MCP manager.
     * @returns {Object} Information about the MCP manager, or { enabled: false } if disabled.
     */
    getMCPInfo() {
        return this.mcpManager ? this.mcpManager.getServerInfo() : { enabled: false };
    }

    /**
     * Cleans up MCP resources and clears MCP indexed tools, preserving local tools.
     * @returns {Promise<void>}
     */
    async cleanup() {
        if (this.mcpManager) {
            await this.mcpManager.cleanup();
            this.mcpTools.clear();
        }
    }

    // --- Internals ---

    /**
     * Returns the tool identifier (name for function tools, or name/type for native tools).
     * @private
     */
    _getToolIdentifier(tool) {
        return tool.name || tool.type;
    }

    /**
     * Separates declaration from implementation into a normalized record.
     * @private
     */
    _normalizeTool(tool, source) {
        const isFunction = !tool.type || tool.type === 'function';
        if (isFunction) {
            const { func, ...declaration } = tool;
            // TODO: Reconcile MCP dispatch paths. MCPClient creates a closure-based func
            // that calls client.executeTool(), while MCPManager also provides an executeTool()
            // method that searches across connected clients. Unify these paths in a follow-up.
            return {
                declaration: {
                    type: 'function',
                    ...declaration,
                },
                implementation: func,
                source,
            };
        }

        const { func: _ignored, ...declaration } = tool;
        return {
            declaration: { ...declaration },
            implementation: null,
            source,
        };
    }

    /**
     * Reconstitutes a fused tool object from a normalized record.
     * @private
     */
    _toFusedRecord(record) {
        if (record.implementation) {
            return {
                ...record.declaration,
                func: record.implementation,
            };
        }
        return { ...record.declaration };
    }

    /**
     * Validates that a tool object matches the required schema.
     * @private
     * @param {Object} tool - The tool to validate.
     * @throws {Error} If the tool is missing required properties.
     */
    _validateToolStructure(tool) {
        if (!tool || typeof tool !== 'object') {
            throw new Error("Invalid tool object");
        }

        // Native LLM tools (e.g. { type: "web_search" }) do not need a func or name
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