/**
 * @fileoverview Defines the retrieve_tool_output tool (and context_tree_query alias)
 * allowing the model to pull raw tool outputs from disk on demand.
 */

import { defineTool } from '../define-tool.js';

/**
 * Creates the retrieve_tool_output tool bound to an active ToolOutputArchive instance.
 *
 * @param {import('./tool-output-archive.js').ToolOutputArchive} archive
 * @returns {object} Fused tool instance.
 */
export function createRetrieveTool(archive, name = 'retrieve_tool_output') {
    const declaration = {
        type: 'function',
        name,
        description: 'Retrieves raw archived tool output from disk that was previously offloaded. Supports line slicing and keyword querying to inspect large outputs on demand without flooding context.',
        parameters: {
            type: 'object',
            properties: {
                id: {
                    type: 'string',
                    description: 'The archive identifier (e.g. "t1", "t2") found in the archived tool notice.',
                },
                query: {
                    type: 'string',
                    description: 'Optional substring to filter and search specific matching lines in the raw output.',
                },
                offset: {
                    type: 'number',
                    description: '0-indexed starting line number (default: 0).',
                },
                limit: {
                    type: 'number',
                    description: 'Maximum number of lines to return (default: 100).',
                },
            },
            required: ['id'],
        },
    };

    const implementation = async (args = {}) => {
        const id = args.id;
        if (!id || typeof id !== 'string') {
            return { error: `${name} requires a valid "id" string (e.g. "t1").` };
        }

        return await archive.retrieve(id, {
            query: args.query,
            offset: typeof args.offset === 'number' ? args.offset : 0,
            limit: typeof args.limit === 'number' ? args.limit : 100,
        });
    };

    return defineTool(declaration, implementation);
}
