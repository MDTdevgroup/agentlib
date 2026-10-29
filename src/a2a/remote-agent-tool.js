import { A2AToolSource, validateA2AToolArgs } from '../tools/sources/a2a-tool-source.js';
import { defineTool, withValidation } from '../tools/define-tool.js';

/**
 * Creates a validated tool function built on defineTool that calls a remote A2A agent.
 * This can be added to a local agent's tool set.
 *
 * @param {string} remoteUrl - The URL of the remote agent (e.g. http://localhost:4000)
 * @param {string} [toolName='remote_agent'] - The name of the tool to register.
 * @param {string} [description="Ask a remote agent for help."] - Description for the tool.
 * @param {object} [options={}] - Optional configuration (timeoutMs, pollIntervalMs, client, clientFactory, policy, fetch, lookup, allowLoopback).
 * @returns {Promise<object>} A fused tool definition built with defineTool.
 */
export async function createRemoteAgentTool(
    remoteUrl,
    toolName = 'remote_agent',
    description = "Ask a remote agent for help.",
    options = {}
) {
    const source = new A2AToolSource({
        ...options,
        remoteUrl,
        toolName,
        description,
        deriveSkills: false,
    });
    await source.connect();
    const [declaration] = source.getDeclarations();
    return defineTool(
        declaration,
        withValidation(
            validateA2AToolArgs,
            async (args, context) => source.invoke(declaration.name, args, context)
        )
    );
}

