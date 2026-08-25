import { AgentExecutorAdapter } from "./agent-executor-adapter.js";
import { loadOptional } from "../util/optional-dep.js";

const A2A_INSTALL_CMD = 'npm install @a2a-js/sdk express';
const A2A_CUSTOM_MSG = "The A2A server requires '@a2a-js/sdk' and 'express'.\nInstall with: npm install @a2a-js/sdk express";

/**
 * Starts an A2A-compliant server for the given agent.
 * @param {import('../core/agent.js').Agent} agent - The agent to expose.
 * @param {object} options
 * @param {number} [options.port=4000] - The port to listen on.
 * @param {string} [options.name] - Agent name override.
 * @param {string} [options.baseUrl] - The public URL (e.g., http://localhost:4000).
 */
export async function startA2AServer(agent, { port = 4000, name, baseUrl = `http://localhost:${port}` } = {}) {
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

    // 1. Generate Agent Card
    const tools = agent.toolLoader.getTools();

    // Convert tools to A2A skills
    const skills = tools.map(tool => ({
        id: tool.name,
        name: tool.name,
        description: tool.description,
        tags: ['tool']
    }));

    const agentCard = {
        name: name || "AgentLib Agent",
        description: "An agent exposed via agentlib A2A.",
        protocolVersion: '0.3.0',
        version: '1.0.0',
        url: `${baseUrl}/a2a/jsonrpc`,
        skills: skills,
        capabilities: {
            pushNotifications: false,
        },
        defaultInputModes: ['text'],
        defaultOutputModes: ['text'],
        additionalInterfaces: [
            { url: `${baseUrl}/a2a/jsonrpc`, transport: 'JSONRPC' },
            { url: `${baseUrl}/a2a/rest`, transport: 'HTTP+JSON' },
        ],
    };

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
    const server = app.listen(port, () => {
        console.log(`  A2A Server started on ${baseUrl}`);
        console.log(`   Card: ${baseUrl}/${AGENT_CARD_PATH}`);
    });

    return server;
}
