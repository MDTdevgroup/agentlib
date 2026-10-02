/**
 * ToolSource implementing in-process local tools.
 */
export class LocalToolSource {
    /**
     * @param {object} [options]
     * @param {string} [options.id='local']
     * @param {string} [options.title='Local Tools']
     * @param {string} [options.description='In-process local tools']
     */
    constructor({ id = 'local', title = 'Local Tools', description = 'In-process local tools' } = {}) {
        this.id = id;
        this.title = title;
        this.description = description;
        this.tools = new Map();
    }

    /**
     * Returns descriptor metadata for discovery.
     * @returns {object}
     */
    describe() {
        return {
            id: this.id,
            kind: 'local',
            title: this.title,
            description: this.description,
            connected: true,
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
        const declarations = [];
        for (const record of this.tools.values()) {
            declarations.push({ ...record.declaration });
        }
        return declarations;
    }

    /**
     * Invokes a local tool by name.
     *
     * @param {string} name - Name of the tool.
     * @param {object} args - Arguments to pass to implementation.
     * @param {object} [context={}] - Execution context.
     * @returns {Promise<any>}
     */
    async invoke(name, args, context = {}) {
        const record = this.tools.get(name);
        if (!record || typeof record.implementation !== 'function') {
            throw new Error(`Tool '${name}' not found in local tools.`);
        }
        return await record.implementation(args, context);
    }

    /**
     * Lifecycle connect (no-op for local tools).
     * @returns {Promise<void>}
     */
    async connect() {
        // Local tools are in-process and always connected
    }

    /**
     * Lifecycle teardown: clears all registered local tools.
     * @returns {Promise<void>}
     */
    async close() {
        this.tools.clear();
    }

    /**
     * Registers a single local tool.
     * @param {object} tool
     */
    addTool(tool) {
        this.addTools([tool]);
    }

    /**
     * Atomically registers multiple local tools.
     * Pre-validates every tool and name before mutating state.
     *
     * @param {Array<object>} tools
     * @throws {TypeError|Error} If any tool is invalid or duplicates an existing name.
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

            if (this.tools.has(identifier) || batchIdentifiers.has(identifier)) {
                throw new Error(`Tool with name '${identifier}' already exists.`);
            }

            batchIdentifiers.add(identifier);
            recordsToCommit.push({
                identifier,
                record: this._normalizeTool(tool),
            });
        }

        for (const { identifier, record } of recordsToCommit) {
            this.tools.set(identifier, record);
        }
    }

    /**
     * Finds a local tool by name and returns a fused record.
     * @param {string} name
     * @returns {object|null}
     */
    findTool(name) {
        const record = this.tools.get(name);
        if (!record) {
            return null;
        }
        return this._toFusedRecord(record);
    }

    /**
     * Returns all local tools as fused records with callable func.
     * @returns {Array<object>}
     */
    getTools() {
        const result = [];
        for (const record of this.tools.values()) {
            result.push(this._toFusedRecord(record));
        }
        return result;
    }

    // --- Internals ---

    _getToolIdentifier(tool) {
        return tool.name || tool.type;
    }

    _normalizeTool(tool) {
        const isFunction = !tool.type || tool.type === 'function';
        if (isFunction) {
            const { func, ...declaration } = tool;
            return {
                declaration: {
                    type: 'function',
                    ...declaration,
                },
                implementation: func,
            };
        }

        const { func: _ignored, ...declaration } = tool;
        return {
            declaration: { ...declaration },
            implementation: null,
        };
    }

    _toFusedRecord(record) {
        if (record.implementation) {
            return {
                ...record.declaration,
                func: record.implementation,
            };
        }
        return { ...record.declaration };
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
