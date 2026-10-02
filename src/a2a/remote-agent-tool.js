import { A2AToolSource } from '../tools/sources/a2a-tool-source.js';

/**
 * Creates a tool function that calls a remote A2A agent.
 * This can be added to a local agent's tool set.
 *
 * @param {string} remoteUrl - The URL of the remote agent (e.g. http://localhost:4000)
 * @param {string} [toolName='remote_agent'] - The name of the tool to register.
 * @param {string} [description="Ask a remote agent for help."] - Description for the tool.
 * @returns {Promise<object>} A tool definition compatible with ToolLoader.
 */
export async function createRemoteAgentTool(remoteUrl, toolName = 'remote_agent', description = "Ask a remote agent for help.") {
    const source = new A2AToolSource({ remoteUrl, toolName, description });
    await source.connect();
    return source.toFusedTool();
}
