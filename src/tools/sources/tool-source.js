/**
 * @typedef {object} ToolSourceDescriptor
 * @property {string} id - Unique identifier for this source (e.g. 'local', serverName, peerName).
 * @property {'local'|'mcp'|'a2a'} kind - Kind of tool provider.
 * @property {string} title - Human-readable display title.
 * @property {string} description - High-level description for discovery.
 * @property {boolean} connected - Connection status.
 */

/**
 * Validates that an object satisfies the ToolSource contract.
 *
 * A valid ToolSource provides:
 * - describe(): ToolSourceDescriptor
 * - list(): Promise<Array<object>>
 * - getDeclarations(): Array<object>
 * - invoke(name, args, context): Promise<any>
 * - connect(): Promise<void>
 * - close(): Promise<void>
 *
 * @param {object} source - Candidate tool source instance.
 * @throws {TypeError} If source does not satisfy the contract.
 */
export function assertToolSource(source) {
    if (!source || typeof source !== 'object') {
        throw new TypeError("ToolSource must be a non-null object.");
    }

    const requiredMethods = ['describe', 'list', 'getDeclarations', 'invoke', 'connect', 'close'];
    for (const method of requiredMethods) {
        if (typeof source[method] !== 'function') {
            throw new TypeError(`ToolSource must implement '${method}()' as a function.`);
        }
    }
}
