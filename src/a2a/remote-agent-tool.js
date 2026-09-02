import { randomUUID } from 'node:crypto';
import { loadOptional } from '../util/optional-dep.js';

const A2A_INSTALL_CMD = 'npm install @a2a-js/sdk express';
const A2A_CUSTOM_MSG = "The A2A client requires '@a2a-js/sdk'.\nInstall with: npm install @a2a-js/sdk";

/**
 * Creates a tool function that calls a remote A2A agent.
 * This can be added to a local agent's tool set.
 * 
 * @param {string} remoteUrl - The URL of the remote agent (e.g. http://localhost:4000)
 * @param {string} [toolName='remote_agent'] - The name of the tool to register.
 * @param {string} [description] - Description for the tool. Use this to tell the agent when to use it.
 * @returns {Promise<object>} A tool definition compatible with ToolLoader.
 */
export async function createRemoteAgentTool(remoteUrl, toolName = 'remote_agent', description = "Ask a remote agent for help.") {
    const { ClientFactory } = await loadOptional('@a2a-js/sdk/client', 'A2A client', {
        installCommand: A2A_INSTALL_CMD,
        customMessage: A2A_CUSTOM_MSG,
    });

    const factory = new ClientFactory();
    let client;

    try {
        client = await factory.createFromUrl(remoteUrl);
    } catch (err) {
        throw new Error(`Failed to connect to remote agent at ${remoteUrl}: ${err.message}`);
    }

    return {
        name: toolName,
        type: 'function',
        description: description,
        func: async ({ request }) => {
            if (!client) {
                // Try connecting again if initially failed
                client = await factory.createFromUrl(remoteUrl);
            }

            const sendParams = {
                message: {
                    messageId: randomUUID(),
                    role: 'user',
                    parts: [{ kind: 'text', text: request }],
                    kind: 'message',
                },
            };

            try {
                const response = await client.sendMessage(sendParams);

                if (response.kind === 'task') {
                    // It returned a task object, check artifacts or wait?
                    // Simple case: just report the status
                    return `Remote task started: ${response.id} - Status: ${response.status.state}`;
                } else if (response.kind === 'message') {
                    // Return the text
                    return response.parts.map(p => p.text).join('\n');
                }
                return "Unknown response type from remote agent.";

            } catch (error) {
                return `Error communicating with remote agent: ${error.message}`;
            }
        },
        parameters: {
            type: "object",
            properties: {
                request: {
                    type: "string",
                    description: "The natural language request to send to the remote agent."
                }
            },
            required: ["request"]
        }
    };
}
