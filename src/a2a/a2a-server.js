import { AgentExecutorAdapter } from "./agent-executor-adapter.js";
import { loadOptional } from "../util/optional-dep.js";

const A2A_INSTALL_CMD = 'npm install @a2a-js/sdk express';
const A2A_CUSTOM_MSG = "The A2A server requires '@a2a-js/sdk' and 'express'.\nInstall with: npm install @a2a-js/sdk express";

/**
 * Resolves the full tool catalog from an agent, independent of progressive exposure state.
 * @param {object} agent
 * @returns {Promise<Array<object>>}
 */
async function resolveFullCatalog(agent) {
    if (!agent) return [];

    if (typeof agent.getCatalog === 'function') {
        return await agent.getCatalog();
    }
    if (typeof agent.getFullCatalog === 'function') {
        return await agent.getFullCatalog();
    }

    const loader = agent.toolLoader;
    if (!loader) return [];

    if (typeof loader.getCatalog === 'function') {
        return await loader.getCatalog();
    }
    if (typeof loader.getFullCatalog === 'function') {
        return await loader.getFullCatalog();
    }
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
    if (typeof loader.getTools === 'function') {
        return loader.getTools().map(({ func: _f, ...decl }) => decl);
    }
    if (typeof loader.getToolDeclarations === 'function') {
        return loader.getToolDeclarations();
    }
    return [];
}

/**
 * Builds the A2A Agent Card for an agent from its full tool catalog.
 * @param {import('../core/agent.js').Agent} agent
 * @param {object} [options={}]
 * @param {number} [options.port=4000]
 * @param {string} [options.name]
 * @param {string} [options.description]
 * @param {string} [options.baseUrl]
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
        url: `${baseUrl}/a2a/jsonrpc`,
        skills,
        capabilities: {
            pushNotifications: false,
        },
        defaultInputModes: ['text'],
        defaultOutputModes: ['text'],
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
 * Starts an A2A-compliant server for the given agent.
 * @param {import('../core/agent.js').Agent} agent - The agent to expose.
 * @param {object} options
 * @param {number} [options.port=4000] - The port to listen on.
 * @param {string} [options.name] - Agent name override.
 * @param {string} [options.description] - Agent description override.
 * @param {string} [options.baseUrl] - The public URL (e.g., http://localhost:4000).
 */
export async function startA2AServer(agent, { port = 4000, name, description, baseUrl } = {}) {
    const { AGENT_CARD_PATH } = await loadOptional('@a2a-js/sdk', 'A2A server', {
        installCommand: A2A_INSTALL_CMD,
        customMessage: A2A_CUSTOM_MSG,
    });
    const { DefaultRequestHandler, InMemoryTaskStore } = await loadOptional('@a2a-js/sdk/server', 'A2A server', {
        installCommand: A2A_INSTALL_CMD,
        customMessage: A2A_CUSTOM_MSG,
    });
    const {
        agentCardHandler,
        jsonRpcHandler,
        restHandler,
        UserBuilder
    } = await loadOptional('@a2a-js/sdk/server/express', 'A2A server', {
        installCommand: A2A_INSTALL_CMD,
        customMessage: A2A_CUSTOM_MSG,
    });
    const expressModule = await loadOptional('express', 'A2A server', {
        installCommand: A2A_INSTALL_CMD,
        customMessage: A2A_CUSTOM_MSG,
    });
    const express = expressModule.default || expressModule;

    const initialBaseUrl = baseUrl || `http://localhost:${port}`;

    // 1. Generate Agent Card from full catalog (unaffected by progressive discovery subset)
    const agentCard = await buildAgentCard(agent, { port, name, description, baseUrl: initialBaseUrl });

    // 2. Setup Executor and Handlers
    const executor = new AgentExecutorAdapter(agent);
    const taskStore = new InMemoryTaskStore();
    const requestHandler = new DefaultRequestHandler(
        agentCard,
        taskStore,
        executor
    );

    // 3. Setup Express
    const app = express();

    // Agent Card Endpoint
    app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));

    // Communication Endpoints
    // Note: Using UserBuilder.noAuthentication for easy testing.
    app.use('/a2a/jsonrpc', jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
    app.use('/a2a/rest', restHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

    // Start Server
    return new Promise((resolve, reject) => {
        const server = app.listen(port, () => {
            const addr = server.address();
            const boundPort = typeof addr === 'object' && addr ? addr.port : port;
            const resolvedBaseUrl = baseUrl || `http://localhost:${boundPort}`;

            if (!baseUrl && boundPort !== port) {
                agentCard.url = `${resolvedBaseUrl}/a2a/jsonrpc`;
                agentCard.additionalInterfaces = [
                    { url: `${resolvedBaseUrl}/a2a/jsonrpc`, transport: 'JSONRPC' },
                    { url: `${resolvedBaseUrl}/a2a/rest`, transport: 'HTTP+JSON' },
                ];
                agentCard.supportedInterfaces = [
                    { url: `${resolvedBaseUrl}/a2a/jsonrpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
                    { url: `${resolvedBaseUrl}/a2a/rest`, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' },
                ];
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
