import { MCPManager } from "./mcp/MCPManager.js";

/**
 * Manages the lifecycle, storage, and retrieval of the agent's tools.
 */
export class ToolLoader {
    /**
     * @param {boolean} [enableMCP=false] - Whether to initialize the MCP manager.
     */
    constructor(enableMCP = false) {
        this.nativeTools = new Map();
        this.mcpManager = enableMCP ? new MCPManager() : null;
    }

    /**
     * @returns {Array<Object>} An array of tool objects containing name, description, and schemas.
     */
    getTools() {
        const native = Array.from(this.nativeTools.values());
        const mcp = this.mcpManager ? this.mcpManager.getAllTools() : [];
        return [...native, ...mcp];
    }

    /**
     * Finds a tool by name, searching Native tools first, then MCP tools.
     * @param {string} name - The name of the tool to find.
     * @returns {Object|null} The tool object including the executable function, or null if not found.
     */
    findTool(name) {
        if (this.nativeTools.has(name)) {
            return this.nativeTools.get(name);
        }
        if (this.mcpManager) {
            return this.mcpManager.getAllTools().find(t => t.name === name);
        }
        return null;
    }

    /**
     * Registers a new tool.
     * @param {Object} tool - The tool definition.
     * @param {string} tool.name - The unique name of the tool.
     * @param {Function} tool.func - The function to execute when the tool is called.
     * @param {string} [tool.description] - A description of what the tool does.
     * @throws {Error} If the tool structure is invalid or the name is a duplicate.
     */
    addTool(tool) {
        this._validateToolStructure(tool);

        if (this._isDuplicate(tool.name)) {
            throw new Error(`Tool with name '${tool.name}' already exists.`);
        }

        this.nativeTools.set(tool.name, {
            description: '',
            ...tool
        });
    }

    /**
     * Registers multiple tools.
     * @param {Array<Object>} tools - An array of tool definitions.
     * @throws {Error} If any tool structure is invalid or if any name is a duplicate.
     */
    addTools(tools) {
        tools.forEach(tool => this.addTool(tool));
    }

    /**
     * Adds an MCP server configuration to the manager.
     * @param {string} serverName - A unique identifier for this MCP server.
     * @param {Object} config - The configuration object for the MCP server connection.
     * @returns {Promise<Object>} The result of the connection attempt.
     * @throws {Error} If MCP is not enabled for this registry.
     */
    async addMCPServer(serverName, config) {
        if (!this.mcpManager) {
            throw new Error("MCP is disabled.");
        }
        return this.mcpManager.addServer(serverName, config);
    }

    /**
     * Removes an MCP server and cleans up its resources.
     * @param {string} serverName - The identifier of the server to remove.
     * @returns {Promise<boolean>} True if removed successfully, false otherwise.
     */
    async removeMCPServer(serverName) {
        if (!this.mcpManager) return false;
        return this.mcpManager.removeServer(serverName);
    }

    /**
     * Generates a text snippet describing available tools for the System Prompt.
     * @returns {string} A formatted string describing all tools, or an empty string if no tools exist.
     */
    getSystemPromptSnippet() {
        const tools = this.getTools();
        if (tools.length === 0) return "";

        const descriptions = tools
            .map(t => `${t.name}: ${t.description}`)
            .join('; ');

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
     * Cleans up resources, specifically closing MCP connections.
     * @returns {Promise<void>}
     */
    async cleanup() {
        if (this.mcpManager) await this.mcpManager.cleanup();
    }

    // --- Internals ---

    /**
     * Validates that a tool object matches the required schema.
     * @private
     * @param {Object} tool - The tool to validate.
     * @throws {Error} If the tool is missing required properties.
     */
    _validateToolStructure(tool) {
        if (!tool || typeof tool !== 'object') throw new Error("Invalid tool object");
        if (typeof tool.name !== 'string' || !tool.name.trim()) throw new Error("Tool missing name");
        if (typeof tool.func !== 'function') throw new Error("Tool missing func");
    }

    /**
     * Checks if a tool name already exists in either Native or MCP registries.
     * @private
     * @param {string} name - The tool name to check.
     * @returns {boolean} True if the name exists, false otherwise.
     */
    _isDuplicate(name) {
        const existsNative = this.nativeTools.has(name);
        const existsMCP = this.mcpManager?.getAllTools().some(t => t.name === name);
        return existsNative || existsMCP;
    }
}