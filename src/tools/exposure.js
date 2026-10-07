import { rankKeywords } from "./keyword-search.js";
import {
    getDefaultToolExposure,
    getDefaultToolExposureThreshold,
    getDefaultToolExposureMode,
    getDefaultMaxContextTokens,
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
    if (declaration.source?.kind) return declaration.source.kind;
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

export const META_TOOL_DECLARATIONS = Object.freeze({
    search_tools: Object.freeze({
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
    }),
    get_tool_details: Object.freeze({
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
    }),
    call_tool: Object.freeze({
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
    }),
    search_servers: Object.freeze({
        type: 'function',
        name: 'search_servers',
        description: 'Search available MCP servers by description or capability query to find servers that can be enabled.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Natural language search query describing the capability or service needed.',
                },
                limit: {
                    type: 'number',
                    description: 'Maximum number of results to return (default: 5).',
                },
            },
            required: ['query'],
        },
    }),
    enable_server: Object.freeze({
        type: 'function',
        name: 'enable_server',
        description: 'Connect and enable an MCP server mid-run, loading its tools into the catalog.',
        parameters: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'Name of the MCP server to enable.',
                },
            },
            required: ['name'],
        },
    }),
    disable_server: Object.freeze({
        type: 'function',
        name: 'disable_server',
        description: 'Disable an active MCP server. Note: This drops tool definitions from the catalog and should only be used at conversation boundaries.',
        parameters: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'Name of the MCP server to disable.',
                },
            },
            required: ['name'],
        },
    }),
});

/**
 * Shared resolver for lazy MCP server meta-tools (search_servers, enable_server, disable_server).
 * @param {string} name
 * @param {object} args
 * @param {object} options
 * @returns {Promise<{ handled: boolean, result?: any, nextEnabledServers?: Array<string> }>}
 */
async function resolveServerMetaTool(name, args, { toolLoader, ranker = rankKeywords, enabledServers = [] }) {
    if (name === 'search_servers') {
        const query = args.query || '';
        const limit = typeof args.limit === 'number' ? args.limit : 5;
        const servers = toolLoader && typeof toolLoader.getRegisteredMCPServers === 'function'
            ? toolLoader.getRegisteredMCPServers()
            : [];
        const scored = await ranker(query, servers, { limit });
        return {
            handled: true,
            result: { query, totalMatches: scored.length, servers: scored.map(s => s.entry || s) },
            nextEnabledServers: [...enabledServers],
        };
    }
    if (name === 'enable_server') {
        const serverName = args.name || args.server_name;
        if (!toolLoader || typeof toolLoader.enableMCPServer !== 'function') {
            throw new Error("ToolLoader not available in execution context for enable_server.");
        }
        const enableResult = await toolLoader.enableMCPServer(serverName);
        const nextEnabled = enabledServers.includes(serverName)
            ? [...enabledServers]
            : [...enabledServers, serverName];
        return {
            handled: true,
            result: {
                serverName,
                status: 'enabled',
                toolsAdded: enableResult.toolCount,
                tools: (enableResult.tools || []).map(t => t.name),
            },
            nextEnabledServers: nextEnabled,
        };
    }
    if (name === 'disable_server') {
        const serverName = args.name || args.server_name;
        if (!toolLoader || typeof toolLoader.disableMCPServer !== 'function') {
            throw new Error("ToolLoader not available in execution context for disable_server.");
        }
        const disabled = await toolLoader.disableMCPServer(serverName, { disconnect: false });
        const nextEnabled = enabledServers.filter(s => s !== serverName);
        return {
            handled: true,
            result: {
                serverName,
                status: disabled ? 'disabled' : 'not_found',
                notice: 'Server disabled. Note: Disabling drops tools and invalidates prompt prefix cache; should be performed at conversation boundaries.',
            },
            nextEnabledServers: nextEnabled,
        };
    }
    return { handled: false };
}

/**
 * Eager Exposure Policy: Returns every declaration in the catalog upfront.
 *
 * @param {Array<object>} catalog - Full list of tool declarations.
 * @param {object} [exposureState={}] - Current turn's exposure state.
 * @param {object} [context={}] - Execution context.
 * @param {object} [options={}] - Additional options.
 * @returns {Promise<{ declarations: Array<object>, metaTools: Array<object>, resolve: Function, nextState: object }>}
 */
export async function exposeAll(catalog, exposureState = {}, context = {}, options = {}) {
    const toolLoader = context?.toolLoader;
    const hasLazyServers = toolLoader && typeof toolLoader.hasLazyServers === 'function'
        ? toolLoader.hasLazyServers()
        : Boolean(toolLoader?.registeredServers?.size > 0);

    const metaTools = (hasLazyServers || options.enableLazyServers)
        ? [
            META_TOOL_DECLARATIONS.search_servers,
            META_TOOL_DECLARATIONS.enable_server,
            META_TOOL_DECLARATIONS.disable_server,
        ]
        : [];

    let nextEnabledServersList = Array.isArray(exposureState?.enabledServers)
        ? [...exposureState.enabledServers]
        : [];

    const makeState = (overrides = {}) => {
        const state = { ...exposureState, ...overrides };
        if (exposureState?.enabledServers !== undefined || hasLazyServers || options.enableLazyServers) {
            state.enabledServers = [...nextEnabledServersList];
        }
        return state;
    };

    async function resolve(name, args = {}, execContext = {}) {
        const currentLoader = context.toolLoader || execContext.toolLoader;
        const serverResolution = await resolveServerMetaTool(name, args, {
            toolLoader: currentLoader,
            ranker: rankKeywords,
            enabledServers: nextEnabledServersList,
        });

        if (serverResolution.handled) {
            nextEnabledServersList = serverResolution.nextEnabledServers;
            return {
                handled: true,
                result: serverResolution.result,
                nextState: makeState(),
            };
        }
        return { handled: false };
    }

    return {
        declarations: [...metaTools, ...catalog.map(d => ({ ...d }))],
        metaTools,
        resolve,
        nextState: makeState(),
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

    const enabledServersList = Array.isArray(exposureState?.enabledServers)
        ? [...exposureState.enabledServers]
        : [];
    let nextEnabledServersList = [...enabledServersList];

    const metaTools = [
        META_TOOL_DECLARATIONS.search_tools,
        META_TOOL_DECLARATIONS.get_tool_details,
    ];
    if (mode === 'facade') {
        metaTools.push(META_TOOL_DECLARATIONS.call_tool);
    }

    const toolLoader = context.toolLoader;
    const hasLazyServers = toolLoader && typeof toolLoader.hasLazyServers === 'function'
        ? toolLoader.hasLazyServers()
        : Boolean(toolLoader?.registeredServers?.size > 0);

    if (hasLazyServers || options.enableLazyServers) {
        metaTools.push(
            META_TOOL_DECLARATIONS.search_servers,
            META_TOOL_DECLARATIONS.enable_server,
            META_TOOL_DECLARATIONS.disable_server,
        );
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

    const makeState = (overrides = {}) => ({
        ...exposureState,
        mode,
        discovered: [...nextDiscoveredList],
        enabledServers: [...nextEnabledServersList],
        ...overrides,
    });

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
                nextState: makeState(),
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
                    const candidates = functionTools.filter(t => t.source?.remoteName === toolName);
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
                nextState: makeState(),
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
                nextState: makeState(),
            };
        }

        const currentLoader = context.toolLoader || execContext.toolLoader;
        const serverResolution = await resolveServerMetaTool(name, args, {
            toolLoader: currentLoader,
            ranker,
            enabledServers: nextEnabledServersList,
        });

        if (serverResolution.handled) {
            nextEnabledServersList = serverResolution.nextEnabledServers;
            return {
                handled: true,
                result: serverResolution.result,
                nextState: makeState(),
            };
        }

        return { handled: false };
    }

    return {
        declarations: wireDeclarations,
        metaTools,
        resolve,
        nextState: makeState(),
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
    const maxContext = context?.maxContextTokens || getDefaultMaxContextTokens();
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

    return exposeAll(catalog, exposureState, context, options);
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
            return (catalog, state, context) => exposeAll(catalog, state, context, { ...options, ...context?.toolExposureOptions });
    }
}
