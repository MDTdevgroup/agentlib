import { AgentExecutorAdapter } from "./agent-executor-adapter.js";
import { loadOptional } from "../util/optional-dep.js";

const A2A_INSTALL_DEPS = {
    installCommand: 'npm install @a2a-js/sdk express',
    customMessage: "The A2A server requires '@a2a-js/sdk' and 'express'.\nInstall with: npm install @a2a-js/sdk express",
};

function buildEndpoints(baseUrl) {
    return {
        url: `${baseUrl}/a2a/jsonrpc`,
        additionalInterfaces: [
            { url: `${baseUrl}/a2a/jsonrpc`, transport: 'JSONRPC' },
            { url: `${baseUrl}/a2a/rest`, transport: 'HTTP+JSON' },
        ],
        supportedInterfaces: [
            { url: `${baseUrl}/a2a/jsonrpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
            { url: `${baseUrl}/a2a/rest`, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' },
        ],
    };
}

/**
 * Resolves the full tool catalog from an agent, independent of progressive exposure state.
 * @param {object} agent
 * @returns {Promise<Array<object>>}
 */
async function resolveFullCatalog(agent) {
    const loader = agent?.toolLoader;
    if (!loader) return [];

    if (Array.isArray(loader.sources) && loader.sources.length > 0) {
        const declarations = [];
        for (const source of loader.sources) {
            const items = typeof source.list === 'function'
                ? await source.list()
                : (typeof source.getDeclarations === 'function' ? source.getDeclarations() : []);
            for (const decl of items) {
                declarations.push({ ...decl });
            }
        }
        return declarations;
    }
    if (typeof loader.getCatalog === 'function') return loader.getCatalog();
    if (typeof loader.getTools === 'function') {
        return loader.getTools().map(({ func: _f, ...decl }) => decl);
    }
    return typeof loader.getToolDeclarations === 'function' ? loader.getToolDeclarations() : [];
}

/**
 * Builds the A2A Agent Card for an agent from its full tool catalog.
 * @param {import('../core/agent.js').Agent} agent
 * @param {object} [options={}]
 * @returns {Promise<object>}
 */
export async function buildAgentCard(agent, {
    port = 4000,
    name,
    description,
    baseUrl = `http://localhost:${port}`,
} = {}) {
    const tools = await resolveFullCatalog(agent);
    const skills = tools.map(tool => ({
        id: tool.name,
        name: tool.name,
        description: tool.description || `Tool ${tool.name}`,
        tags: ['tool', ...(tool.source?.kind ? [tool.source.kind] : [])],
        ...(tool.parameters ? { parameters: tool.parameters, inputSchema: tool.parameters } : {}),
    }));

    return {
        name: name || agent?.name || "AgentLib Agent",
        description: description || "An agent exposed via agentlib A2A.",
        protocolVersion: '0.3.0',
        version: '1.0.0',
        skills,
        capabilities: { pushNotifications: false },
        defaultInputModes: ['text'],
        defaultOutputModes: ['text'],
        ...buildEndpoints(baseUrl),
    };
}

/**
 * Starts an A2A-compliant server for the given agent.
 * @param {import('../core/agent.js').Agent} agent - The agent to expose.
 * @param {object} [options={}]
 */
export async function startA2AServer(agent, { port = 4000, name, description, baseUrl } = {}) {
    const { AGENT_CARD_PATH } = await loadOptional('@a2a-js/sdk', 'A2A server', A2A_INSTALL_DEPS);
    const { DefaultRequestHandler, InMemoryTaskStore } = await loadOptional('@a2a-js/sdk/server', 'A2A server', A2A_INSTALL_DEPS);
    const { agentCardHandler, jsonRpcHandler, restHandler, UserBuilder } = await loadOptional('@a2a-js/sdk/server/express', 'A2A server', A2A_INSTALL_DEPS);
    const expressModule = await loadOptional('express', 'A2A server', A2A_INSTALL_DEPS);
    const express = expressModule.default || expressModule;

    const initialBaseUrl = baseUrl || `http://localhost:${port}`;
    const agentCard = await buildAgentCard(agent, { port, name, description, baseUrl: initialBaseUrl });
    const requestHandler = new DefaultRequestHandler(agentCard, new InMemoryTaskStore(), new AgentExecutorAdapter(agent));

    const app = express();
    app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
    app.use('/a2a/jsonrpc', jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
    app.use('/a2a/rest', restHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

    return new Promise((resolve, reject) => {
        const server = app.listen(port, () => {
            const addr = server.address();
            const boundPort = typeof addr === 'object' && addr ? addr.port : port;
            const resolvedBaseUrl = baseUrl || `http://localhost:${boundPort}`;

            if (!baseUrl && boundPort !== port) {
                Object.assign(agentCard, buildEndpoints(resolvedBaseUrl));
            }

            if (agent.events) {
                agent.events.emit('a2a:start', {
                    baseUrl: resolvedBaseUrl,
                    port: boundPort,
                    cardUrl: `${resolvedBaseUrl}/${AGENT_CARD_PATH}`,
                });
            }
            resolve(server);
        });

        server.on('error', reject);
    });
}
