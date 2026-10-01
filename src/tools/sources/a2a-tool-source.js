import { randomUUID } from 'node:crypto';
import { loadOptional } from '../../util/optional-dep.js';

const A2A_INSTALL_CMD = 'npm install @a2a-js/sdk express';
const A2A_CUSTOM_MSG = "The A2A client requires '@a2a-js/sdk'.\nInstall with: npm install @a2a-js/sdk";

/**
 * ToolSource wrapping a remote A2A peer agent.
 */
export class A2AToolSource {
    /**
     * @param {object} options
     * @param {string} options.remoteUrl - URL of the remote agent (e.g. http://localhost:4000).
     * @param {string} [options.toolName='remote_agent'] - Name of the exposed tool.
     * @param {string} [options.description="Ask a remote agent for help."] - Description for tool.
     */
    constructor({
        remoteUrl,
        toolName = 'remote_agent',
        description = "Ask a remote agent for help.",
    } = {}) {
        if (!remoteUrl || typeof remoteUrl !== 'string') {
            throw new TypeError("A2AToolSource requires a non-empty 'remoteUrl' string.");
        }

        this.remoteUrl = remoteUrl;
        this.toolName = toolName;
        this.description = description;
        this.client = null;
        this.factory = null;
    }

    /**
     * Returns descriptor metadata for discovery.
     * @returns {object}
     */
    describe() {
        return {
            id: this.toolName,
            kind: 'a2a',
            title: this.toolName,
            description: this.description,
            connected: Boolean(this.client),
        };
    }

    /**
     * Returns serializable tool declarations.
     * @returns {Promise<Array<object>>}
     */
    async list() {
        return this.getDeclarations();
    }

    /**
     * Synchronously returns cached tool declarations.
     * @returns {Array<object>}
     */
    getDeclarations() {
        return [
            {
                name: this.toolName,
                type: 'function',
                description: this.description,
                parameters: {
                    type: "object",
                    properties: {
                        request: {
                            type: "string",
                            description: "The natural language request to send to the remote agent.",
                        },
                    },
                    required: ["request"],
                },
            },
        ];
    }

    /**
     * Invokes the remote A2A tool.
     *
     * @param {string} name - Must match toolName.
     * @param {object} args - Must include { request }.
     * @param {object} [_context={}] - Execution context.
     * @returns {Promise<string>}
     */
    async invoke(name, args, _context = {}) {
        if (name !== this.toolName) {
            throw new Error(`Tool '${name}' not found on A2A peer '${this.toolName}'`);
        }

        if (!this.client) {
            await this.connect();
        }

        const sendParams = {
            message: {
                messageId: randomUUID(),
                role: 'user',
                parts: [{ kind: 'text', text: args?.request || '' }],
                kind: 'message',
            },
        };

        try {
            const response = await this.client.sendMessage(sendParams);

            if (response.kind === 'task') {
                return `Remote task started: ${response.id} - Status: ${response.status.state}`;
            } else if (response.kind === 'message') {
                return response.parts.map(p => p.text).join('\n');
            }
            return "Unknown response type from remote agent.";
        } catch (error) {
            return `Error communicating with remote agent: ${error.message}`;
        }
    }

    /**
     * Connects to the remote A2A agent.
     * @returns {Promise<void>}
     */
    async connect() {
        const { ClientFactory, ClientFactoryOptions, DefaultAgentCardResolver } = await loadOptional(
            '@a2a-js/sdk/client',
            'A2A client',
            {
                installCommand: A2A_INSTALL_CMD,
                customMessage: A2A_CUSTOM_MSG,
            }
        );

        const factoryOptions = {
            ...(ClientFactoryOptions?.default ?? {}),
            ...(DefaultAgentCardResolver ? { cardResolver: new DefaultAgentCardResolver({ legacyCompat: { enabled: true } }) } : {}),
        };
        this.factory = new ClientFactory(factoryOptions);

        try {
            this.client = await this.factory.createFromUrl(this.remoteUrl);
        } catch (err) {
            throw new Error(`Failed to connect to remote agent at ${this.remoteUrl}: ${err.message}`, { cause: err });
        }
    }

    /**
     * Disconnects and releases client reference.
     * @returns {Promise<void>}
     */
    async close() {
        this.client = null;
        this.factory = null;
    }

    /**
     * Returns a fused tool object compatible with ToolLoader.addTool.
     * @returns {object}
     */
    toFusedTool() {
        const [declaration] = this.getDeclarations();
        return {
            ...declaration,
            func: async (args, context) => this.invoke(this.toolName, args, context),
        };
    }
}
