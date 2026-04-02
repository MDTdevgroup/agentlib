
import express from 'express';
import {
    AGENT_CARD_PATH
} from '@a2a-js/sdk';
import {
    DefaultRequestHandler,
    InMemoryTaskStore,
} from '@a2a-js/sdk/server';
import {
    agentCardHandler,
    jsonRpcHandler,
    restHandler,
    UserBuilder
} from '@a2a-js/sdk/server/express';
import { AgentExecutorAdapter } from './AgentExecutorAdapter.js';

/**
 * Starts an A2A-compliant server for the given agent.
 * @param {import('../Agent').Agent} agent - The agent to expose.
 * @param {object} options
 * @param {number} [options.port=4000] - The port to listen on.
 * @param {string} [options.name] - Agent name override.
 * @param {string} [options.baseUrl] - The public URL (e.g., http://localhost:4000).
 */
export function startA2AServer(agent, { port = 4000, name, baseUrl = `http://localhost:${port}` } = {}) {

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
