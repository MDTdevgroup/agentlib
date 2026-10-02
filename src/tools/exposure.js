import { rankKeywords } from "./keyword-search.js";
import {
    getDefaultToolExposure,
    getDefaultToolExposureThreshold,
    getDefaultToolExposureMode,
} from "../config.js";

/**
 * Heuristically estimates the token count for a JSON Schema declaration or list of declarations.
 * Uses ~4 characters per token plus framing overhead.
 *
 * @param {object|Array<object>} declarationOrArray
 * @returns {number}
 */
export function estimateDeclarationTokens(declarationOrArray) {
    if (!declarationOrArray) return 0;
    if (Array.isArray(declarationOrArray)) {
        return declarationOrArray.reduce((acc, d) => acc + estimateDeclarationTokens(d), 0);
    }
    if (typeof declarationOrArray === 'object') {
        const json = JSON.stringify(declarationOrArray);
        return Math.max(1, Math.ceil((json.length + 16) / 4));
    }
    return 0;
}

/**
 * Extracts the source origin for a tool (MCP server name, peer agent, or local).
 * @param {object} declaration
 * @returns {string}
 */
function getToolSource(declaration) {
    if (declaration.source?.serverName) return declaration.source.serverName;
    if (declaration.source?.id) return declaration.source.id;
    const name = declaration.name || '';
    const idx = name.indexOf('_');
    if (idx > 0) return name.slice(0, idx);
    return 'local';
}

/**
 * Formats a declaration to the requested detail level.
 * @param {object} decl
 * @param {'name_only'|'name_and_description'|'full_schema'} detail
 * @returns {object}
 */
function formatToolByDetail(decl, detail = 'name_and_description') {
    switch (detail) {
        case 'name_only':
            return { name: decl.name };
        case 'full_schema':
            return { ...decl };
        case 'name_and_description':
        default:
            return {
                name: decl.name,
                description: decl.description || '',
            };
    }
}

/**
 * Generates the search_tools meta-tool declaration.
 */
function createSearchToolsDeclaration() {
    return {
        type: 'function',
        name: 'search_tools',
        description: 'Search available tools by natural language query. Returns matching tool names and descriptions grouped by source.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Natural language search query describing the capability needed.',
                },
                detail: {
                    type: 'string',
                    enum: ['name_only', 'name_and_description', 'full_schema'],
                    description: 'Detail level for results: "name_only", "name_and_description" (default), or "full_schema".',
                },
                limit: {
                    type: 'number',
                    description: 'Maximum number of results to return (default: 10).',
                },
            },
            required: ['query'],
        },
    };
}

/**
 * Generates the get_tool_details meta-tool declaration.
 */
function createGetToolDetailsDeclaration() {
    return {
        type: 'function',
        name: 'get_tool_details',
        description: 'Retrieve the complete parameter schema and documentation for specific tool names.',
        parameters: {
            type: 'object',
            properties: {
                names: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'List of tool names to inspect.',
                },
            },
            required: ['names'],
        },
    };
}

/**
 * Generates the call_tool proxy declaration used in facade mode.
 */
function createCallToolDeclaration() {
    return {
        type: 'function',
        name: 'call_tool',
        description: 'Invoke an available tool by name with arguments.',
        parameters: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'Name of the tool to invoke.',
                },
                arguments: {
                    type: 'object',
                    description: 'Arguments to pass to the tool.',
                },
            },
            required: ['name', 'arguments'],
        },
    };
}

/**
 * Eager Exposure Policy: Returns every declaration in the catalog upfront.
 * Matches existing AgentLib default behavior.
 *
 * @param {Array<object>} catalog - Full list of tool declarations.
 * @param {object} exposureState - Current turn's exposure state.
 * @returns {Promise<{ declarations: Array<object>, metaTools: Array<object>, resolve: Function, nextState: object }>}
 */
export async function exposeAll(catalog, exposureState = {}) {
    return {
        declarations: catalog.map(d => ({ ...d })),
        metaTools: [],
        resolve: async () => ({ handled: false }),
        nextState: exposureState || {},
    };
}

/**
 * Progressive Tool Exposure Policy: Exposes meta-tools and discovered tools.
 *
 * @param {Array<object>} catalog - Full list of tool declarations.
 * @param {object} [exposureState={}] - Current turn's exposure state.
 * @param {object} [context={}] - Execution context (toolLoader, signal, etc.).
 * @param {object} [options={}]
 * @param {'expand'|'facade'} [options.mode='expand'] - Prompt caching strategy.
 * @param {Function} [options.rank=null] - Injectable ranking function (query, entries) => Promise<scored>.
 * @returns {Promise<{ declarations: Array<object>, metaTools: Array<object>, resolve: Function, nextState: object }>}
 */
export async function exposeProgressive(catalog, exposureState = {}, context = {}, options = {}) {
    const mode = exposureState?.mode || options.mode || context?.mode || context?.toolExposureOptions?.mode || getDefaultToolExposureMode();
    const ranker = options.rank || context?.rank || context?.toolExposureOptions?.rank || rankKeywords;

    // Separate native LLM tools (e.g. { type: 'web_search' }) from function tools
    const nativeTools = catalog.filter(d => d.type && d.type !== 'function');
    const functionTools = catalog.filter(d => !d.type || d.type === 'function');

    const discoveredList = Array.isArray(exposureState?.discovered)
        ? [...exposureState.discovered]
        : [];
    const discoveredSet = new Set(discoveredList);

    const metaTools = [
        createSearchToolsDeclaration(),
        createGetToolDetailsDeclaration(),
    ];
    if (mode === 'facade') {
        metaTools.push(createCallToolDeclaration());
    }

    // Determine wire declarations array for this turn
    let wireDeclarations = [];
    if (mode === 'facade') {
        // Facade mode: wire array is strictly fixed metaTools + nativeTools
        wireDeclarations = [...metaTools, ...nativeTools];
    } else {
        // Expand mode: metaTools + nativeTools + discovered tools appended in order
        const discoveredDeclarations = [];
        for (const name of discoveredList) {
            const found = functionTools.find(t => t.name === name);
            if (found) {
                discoveredDeclarations.push({ ...found });
            }
        }
        wireDeclarations = [...metaTools, ...nativeTools, ...discoveredDeclarations];
    }

    let nextDiscoveredList = [...discoveredList];

    /**
     * Resolves meta-tool invocations.
     */
    async function resolve(name, args = {}, execContext = {}) {
        if (name === 'search_tools') {
            const query = args.query || '';
            const detailLevel = args.detail || 'name_and_description';
            const limit = typeof args.limit === 'number' ? args.limit : 10;

            const scoredMatches = await ranker(query, functionTools, { limit });
            const matchedTools = scoredMatches.map(m => m.entry || m);

            // Group matched tools by source server/provider
            const groupedBySource = {};
            const results = [];

            for (const tool of matchedTools) {
                const formatted = formatToolByDetail(tool, detailLevel);
                results.push(formatted);

                const src = getToolSource(tool);
                if (!groupedBySource[src]) {
                    groupedBySource[src] = [];
                }
                groupedBySource[src].push(formatted);
            }

            return {
                handled: true,
                result: {
                    query,
                    totalMatches: results.length,
                    results,
                    groupedBySource,
                },
                nextState: {
                    ...exposureState,
                    mode,
                    discovered: nextDiscoveredList,
                },
            };
        }

        if (name === 'get_tool_details') {
            const rawNames = args.names || args.name || args.tool_names || args.tools || [];
            const requestedNames = Array.isArray(rawNames)
                ? rawNames
                : (typeof rawNames === 'string' ? [rawNames] : []);

            const details = [];
            for (const toolName of requestedNames) {
                let tool = functionTools.find(t => t.name === toolName);
                if (!tool) {
                    const candidates = functionTools.filter(t => t.name?.endsWith('_' + toolName));
                    if (candidates.length === 1) {
                        tool = candidates[0];
                    }
                }

                if (tool) {
                    details.push({ ...tool });
                    if (!discoveredSet.has(tool.name)) {
                        discoveredSet.add(tool.name);
                        nextDiscoveredList.push(tool.name);
                    }
                } else {
                    details.push({ name: toolName, error: `Tool '${toolName}' not found in catalog.` });
                }
            }

            return {
                handled: true,
                result: {
                    tools: details,
                },
                nextState: {
                    ...exposureState,
                    mode,
                    discovered: nextDiscoveredList,
                },
            };
        }

        if (name === 'call_tool') {
            const targetToolName = args.name || args.tool_name;
            let targetArgs = args.arguments || args.args || {};
            if (typeof targetArgs === 'string') {
                try {
                    targetArgs = JSON.parse(targetArgs);
                } catch {
                    // keep as is
                }
            }
            const toolLoader = context.toolLoader || execContext.toolLoader;

            if (!toolLoader || typeof toolLoader.findTool !== 'function') {
                throw new Error("ToolLoader not available in execution context for call_tool.");
            }

            const tool = toolLoader.findTool(targetToolName);
            if (!tool || typeof tool.func !== 'function') {
                throw new Error(`Tool '${targetToolName}' not found or missing executable implementation.`);
            }

            const canonicalName = tool.name || targetToolName;
            if (!discoveredSet.has(canonicalName)) {
                discoveredSet.add(canonicalName);
                nextDiscoveredList.push(canonicalName);
            }

            const toolResult = await tool.func(targetArgs, execContext);
            return {
                handled: true,
                result: toolResult,
                nextState: {
                    ...exposureState,
                    mode,
                    discovered: nextDiscoveredList,
                },
            };
        }

        return { handled: false };
    }

    return {
        declarations: wireDeclarations,
        metaTools,
        resolve,
        nextState: {
            ...exposureState,
            mode,
            discovered: nextDiscoveredList,
        },
    };
}

/**
 * Auto Exposure Policy: Eager by default; automatically switches to progressive discovery
 * if tool declaration tokens exceed the configured context limit ratio.
 *
 * @param {Array<object>} catalog - Full list of tool declarations.
 * @param {object} [exposureState={}] - Current turn's exposure state.
 * @param {object} [context={}] - Execution context.
 * @param {object} [options={}] - Options including thresholdRatio and mode.
 * @returns {Promise<{ declarations: Array<object>, metaTools: Array<object>, resolve: Function, nextState: object }>}
 */
export async function exposeAuto(catalog, exposureState = {}, context = {}, options = {}) {
    if (exposureState?.switched) {
        return exposeProgressive(catalog, exposureState, context, options);
    }

    const totalTokens = estimateDeclarationTokens(catalog);
    const maxContext = context?.maxContextTokens || 64000;
    const thresholdRatio = options.thresholdRatio ?? context?.thresholdRatio ?? context?.toolExposureOptions?.thresholdRatio ?? getDefaultToolExposureThreshold();
    const thresholdTokens = Math.floor(maxContext * thresholdRatio);

    if (totalTokens > thresholdTokens) {
        return exposeProgressive(
            catalog,
            { ...exposureState, switched: true },
            context,
            options
        );
    }

    return exposeAll(catalog, exposureState);
}

/**
 * Resolves a toolExposure option ('all', 'progressive', 'auto', or function) into an executable policy.
 *
 * @param {string|Function} [policyOrName='all']
 * @param {object} [options={}]
 * @returns {Function}
 */
export function resolveExposurePolicy(policyOrName = getDefaultToolExposure(), options = {}) {
    if (typeof policyOrName === 'function') {
        return policyOrName;
    }

    const normalized = String(policyOrName || '').toLowerCase().trim();
    switch (normalized) {
        case 'progressive':
            return (catalog, state, context) => exposeProgressive(catalog, state, context, { ...options, ...context?.toolExposureOptions });
        case 'auto':
            return (catalog, state, context) => exposeAuto(catalog, state, context, { ...options, ...context?.toolExposureOptions });
        case 'all':
        default:
            return (catalog, state, context) => exposeAll(catalog, state, context);
    }
}
