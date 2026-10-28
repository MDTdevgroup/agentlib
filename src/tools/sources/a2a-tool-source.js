import { randomUUID, createHash } from 'node:crypto';
import { loadOptional } from '../../util/optional-dep.js';
import { sleep } from '../../util/async.js';
import { defineTool, withValidation } from '../define-tool.js';
import { getMaxToolDescriptionChars } from '../../config.js';
import {
    checkUrl,
    createSafeFetch,
    validateAgentCardUrls,
    buildServerDescriptor,
    normalizeDecision,
} from '../../security/policy.js';

const A2A_INSTALL_CMD = 'npm install @a2a-js/sdk express';
const A2A_CUSTOM_MSG = "The A2A client requires '@a2a-js/sdk'.\nInstall with: npm install @a2a-js/sdk";

export const TERMINAL_TASK_STATES = Object.freeze(new Set([
    'completed',
    'failed',
    'canceled',
    'cancelled',
    'rejected',
]));

const MAX_TOOL_NAME_LENGTH = 64;

function capDescription(description, maxChars = getMaxToolDescriptionChars()) {
    if (typeof description !== 'string') return description;
    if (maxChars > 0 && description.length > maxChars) {
        return description.slice(0, maxChars);
    }
    return description;
}

/**
 * Validates arguments passed to a standard A2A tool.
 * @param {object} args
 * @returns {object}
 */
export function validateA2AToolArgs(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new TypeError("A2A tool arguments must be a non-null object.");
    }
    if (typeof args.request !== 'string' || !args.request.trim()) {
        throw new TypeError("A2A tool requires a non-empty 'request' string.");
    }
    return args;
}

const PROTO_STATE_MAP = Object.freeze({
    0: 'unspecified',
    1: 'submitted',
    2: 'working',
    3: 'completed',
    4: 'failed',
    5: 'canceled',
    6: 'input_required',
    7: 'rejected',
    8: 'auth_required',
    TASK_STATE_UNSPECIFIED: 'unspecified',
    TASK_STATE_SUBMITTED: 'submitted',
    TASK_STATE_WORKING: 'working',
    TASK_STATE_COMPLETED: 'completed',
    TASK_STATE_FAILED: 'failed',
    TASK_STATE_CANCELED: 'canceled',
    TASK_STATE_INPUT_REQUIRED: 'input_required',
    TASK_STATE_REJECTED: 'rejected',
    TASK_STATE_AUTH_REQUIRED: 'auth_required',
});

/**
 * Normalizes v1.0 protobuf or v0.3 A2A task states into lowercase strings.
 * @param {string|number|undefined} state
 * @returns {string|undefined}
 */
function normalizeTaskState(state) {
    if (state === undefined || state === null) return undefined;
    if (PROTO_STATE_MAP[state] !== undefined) return PROTO_STATE_MAP[state];
    if (typeof state === 'string') {
        return state.toLowerCase().replace(/^task_state_/, '');
    }
    return String(state);
}

/**
 * Extracts text from A2A message parts or artifact parts (v0.3 or v1.0).
 * @param {Array<object>} [parts]
 * @returns {string}
 */
function extractPartsText(parts) {
    if (!Array.isArray(parts)) return '';
    return parts
        .map(p => {
            if (!p) return '';
            if (typeof p.text === 'string') return p.text;
            if (p.content?.$case === 'text' && typeof p.content.value === 'string') {
                return p.content.value;
            }
            return '';
        })
        .filter(Boolean)
        .join('\n');
}

/**
 * Extracts usable result content from a completed A2A task.
 * @param {object} task
 * @param {Array<string>} [streamedParts=[]]
 * @returns {any}
 */
function extractTaskOutput(task, streamedParts = []) {
    if (!task || typeof task !== 'object') {
        return streamedParts.length > 0 ? streamedParts.join('\n') : '';
    }

    if (Array.isArray(task.artifacts) && task.artifacts.length > 0) {
        const texts = task.artifacts
            .map(art => extractPartsText(art?.parts))
            .filter(Boolean);
        if (texts.length > 0) return texts.join('\n');
    }

    if (task.status?.message) {
        if (typeof task.status.message === 'string') {
            return task.status.message;
        }
        const statusText = extractPartsText(task.status.message.parts);
        if (statusText) return statusText;
    }

    if (Array.isArray(task.history) && task.history.length > 0) {
        for (let i = task.history.length - 1; i >= 0; i--) {
            const msg = task.history[i];
            const isUser = msg?.role === 'user' || msg?.role === 1 || msg?.role === 'ROLE_USER';
            if (msg && !isUser) {
                const msgText = extractPartsText(msg.parts);
                if (msgText) return msgText;
            }
        }
    }

    if (Array.isArray(task.parts)) {
        const directText = extractPartsText(task.parts);
        if (directText) return directText;
    }

    if (task.result !== undefined) return task.result;
    if (task.output !== undefined) return task.output;
    if (streamedParts.length > 0) return streamedParts.join('\n');

    return `Task ${task.id} completed.`;
}

/**
 * Sanitizes a raw skill identifier into a valid tool name segment.
 * @param {string} raw
 * @returns {string}
 */
function sanitizeSkillName(raw) {
    return String(raw || 'skill')
        .trim()
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'skill';
}

/**
 * Qualifies and bounds a tool name to 64 characters.
 * @param {string} peerId
 * @param {string} rawSkillId
 * @param {boolean} prefixToolNames
 * @returns {string}
 */
function buildQualifiedSkillName(peerId, rawSkillId, prefixToolNames) {
    const cleanSkill = sanitizeSkillName(rawSkillId);
    let qualified = prefixToolNames && peerId && !cleanSkill.startsWith(`${peerId}_`)
        ? `${peerId}_${cleanSkill}`
        : cleanSkill;

    if (qualified.length > MAX_TOOL_NAME_LENGTH) {
        const hash = createHash('sha256').update(qualified).digest('hex').slice(0, 8);
        qualified = `${qualified.slice(0, 55)}_${hash}`;
    }
    return qualified;
}

/**
 * ToolSource wrapping a remote A2A peer agent.
 */
export class A2AToolSource {
    /**
     * @param {object} options
     * @param {string} options.remoteUrl - URL of the remote agent (e.g. http://localhost:4000).
     * @param {string} [options.id] - Identifier for the A2A peer source.
     * @param {string} [options.toolName] - Name of the fallback exposed tool.
     * @param {string} [options.description="Ask a remote agent for help."] - Description for the peer/tool.
     * @param {boolean} [options.lazy=false] - Whether to defer connection until enabled.
     * @param {boolean} [options.deriveSkills=true] - Whether to derive tool declarations from Agent Card skills.
     * @param {boolean} [options.prefixToolNames=true] - Whether to prefix derived skill names with peer id.
     * @param {number} [options.timeoutMs=30000] - Timeout in ms when polling/streaming tasks to completion.
     * @param {number} [options.pollIntervalMs=150] - Interval in ms between getTask polls.
     * @param {object} [options.client=null] - Pre-configured or mock A2A client.
     * @param {object} [options.agentCard=null] - Pre-fetched or mock A2A Agent Card.
     * @param {Function} [options.clientFactory=null] - Optional factory (url) => Promise<client>.
     * @param {object|null} [options.policy=null] - Optional security policy.
     * @param {Function} [options.fetch] - Optional custom fetch implementation.
     * @param {Function} [options.lookup] - Optional custom DNS lookup function.
     * @param {boolean} [options.allowLoopback=true] - Whether loopback HTTP/IP is allowed.
     */
    constructor({
        remoteUrl,
        url,
        id,
        toolName,
        serverName,
        description = "Ask a remote agent for help.",
        lazy = false,
        deriveSkills = true,
        prefixToolNames = true,
        timeoutMs = 30000,
        pollIntervalMs = 150,
        client = null,
        agentCard = null,
        clientFactory = null,
        policy = null,
        fetch: fetchImpl = null,
        lookup = null,
        allowLoopback = true,
    } = {}) {
        const resolvedUrl = remoteUrl || url;
        if (!resolvedUrl || typeof resolvedUrl !== 'string') {
            throw new TypeError("A2AToolSource requires a non-empty 'remoteUrl' string.");
        }

        const resolvedId = id || toolName || serverName || 'remote_agent';
        this.remoteUrl = resolvedUrl;
        this.id = resolvedId;
        this.serverName = resolvedId;
        this.toolName = toolName || resolvedId;
        this.description = capDescription(description);
        this.lazy = Boolean(lazy);
        this.deriveSkills = Boolean(deriveSkills);
        this.prefixToolNames = Boolean(prefixToolNames);
        this.timeoutMs = timeoutMs;
        this.pollIntervalMs = pollIntervalMs;
        this.client = client;
        this.agentCard = agentCard || client?.agentCard || null;
        this.clientFactory = clientFactory;
        this.policy = policy;
        this.fetchImpl = fetchImpl;
        this.lookup = lookup;
        this.allowLoopback = allowLoopback;
        this.factory = null;
        this.skillMap = new Map();
        this.cachedDeclarations = null;

        if (this.agentCard) {
            this._buildDeclarationsFromCard(this.agentCard);
        }
    }

    /**
     * Returns descriptor metadata for discovery.
     * @returns {object}
     */
    describe() {
        const cardDesc = this.agentCard?.description;
        const cardName = this.agentCard?.name;
        return {
            id: this.id,
            kind: 'a2a',
            title: cardName || this.toolName,
            description: this.description !== "Ask a remote agent for help."
                ? this.description
                : (cardDesc || this.description),
            connected: Boolean(this.client),
        };
    }

    /**
     * Connects if needed, fetches the peer's Agent Card, and returns serializable tool declarations.
     * @returns {Promise<Array<object>>}
     */
    async list() {
        if (!this.client && !this.agentCard) {
            await this.connect();
        } else if (this.client && !this.agentCard && typeof this.client.getAgentCard === 'function') {
            this.agentCard = await this.client.getAgentCard();
            this._buildDeclarationsFromCard(this.agentCard);
        }
        return this.getDeclarations();
    }

    /**
     * Synchronously returns cached tool declarations.
     * @returns {Array<object>}
     */
    getDeclarations() {
        if (this.cachedDeclarations && this.cachedDeclarations.length > 0) {
            return this.cachedDeclarations.map(d => ({ ...d }));
        }

        if (this.agentCard) {
            const built = this._buildDeclarationsFromCard(this.agentCard);
            if (built.length > 0) {
                return built.map(d => ({ ...d }));
            }
        }

        if (this.lazy && !this.client && !this.agentCard) {
            return [];
        }

        return [this._getFallbackDeclaration()];
    }

    /**
     * Builds the default single-tool declaration when no Agent Card skills are derived.
     * @returns {object}
     */
    _getFallbackDeclaration() {
        return {
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
            source: {
                kind: 'a2a',
                serverName: this.id,
                remoteName: this.toolName,
            },
        };
    }

    /**
     * Derives tool declarations from an A2A Agent Card's skills array.
     * @param {object} card
     * @returns {Array<object>}
     */
    _buildDeclarationsFromCard(card) {
        this.skillMap.clear();

        if (!this.deriveSkills || !card || !Array.isArray(card.skills) || card.skills.length === 0) {
            this.cachedDeclarations = [this._getFallbackDeclaration()];
            return this.cachedDeclarations;
        }

        const declarations = card.skills.map(skill => {
            const rawId = skill.id || skill.name || 'skill';
            const qualifiedName = buildQualifiedSkillName(this.id, rawId, this.prefixToolNames);
            const baseDesc = skill.description || skill.name || `Skill ${rawId} on A2A peer ${this.id}`;
            const tagSuffix = Array.isArray(skill.tags) && skill.tags.length > 0
                ? ` [tags: ${skill.tags.join(', ')}]`
                : '';

            const parameters = (skill.parameters && typeof skill.parameters === 'object')
                ? skill.parameters
                : (skill.inputSchema && typeof skill.inputSchema === 'object')
                    ? skill.inputSchema
                    : {
                        type: "object",
                        properties: {
                            request: {
                                type: "string",
                                description: `The natural language request for '${skill.name || rawId}'.`,
                            },
                        },
                        required: ["request"],
                    };

            const decl = {
                name: qualifiedName,
                type: 'function',
                description: capDescription(`${baseDesc}${tagSuffix}`),
                parameters,
                source: {
                    kind: 'a2a',
                    serverName: this.id,
                    remoteName: rawId,
                },
            };

            this.skillMap.set(qualifiedName, { skill, declaration: decl });
            this.skillMap.set(rawId, { skill, declaration: decl });
            if (skill.name) {
                this.skillMap.set(skill.name, { skill, declaration: decl });
            }

            return decl;
        });

        this.cachedDeclarations = declarations;
        return declarations;
    }

    /**
     * Invokes the remote A2A tool or derived skill.
     *
     * @param {string} name - Qualified skill name, raw skill id, or peer toolName.
     * @param {object} args - Arguments (typically { request }, or skill-specific parameters).
     * @param {object} [context={}] - Execution context (e.g. { signal, timeoutMs, pollIntervalMs }).
     * @returns {Promise<any>}
     */
    async invoke(name, args, context = {}) {
        if (!this.client) {
            await this.connect();
        }

        const isDefaultName = name === this.toolName || name === this.id;
        const matchedSkillEntry = this.skillMap.get(name);
        if (!isDefaultName && !matchedSkillEntry) {
            throw new Error(`Tool '${name}' not found on A2A peer '${this.id}'`);
        }

        const signal = context?.signal || null;
        signal?.throwIfAborted?.();

        const timeoutMs = context?.timeoutMs ?? this.timeoutMs ?? 30000;
        const pollIntervalMs = context?.pollIntervalMs ?? this.pollIntervalMs ?? 150;

        let requestText;
        if (typeof args?.request === 'string') {
            requestText = args.request;
        } else if (typeof args === 'string') {
            requestText = args;
        } else if (args && typeof args === 'object') {
            requestText = JSON.stringify(args);
        } else {
            requestText = '';
        }

        const isSdkClient = Boolean(this.factory) || this.client?.constructor?.name === 'Client';
        const sendParams = {
            message: {
                messageId: randomUUID(),
                role: isSdkClient ? 1 : 'user',
                parts: [
                    {
                        kind: 'text',
                        text: requestText,
                        content: { $case: 'text', value: requestText },
                        filename: '',
                        mediaType: 'text/plain',
                    },
                ],
                kind: 'message',
                ...(matchedSkillEntry ? { metadata: { skillId: matchedSkillEntry.skill.id || matchedSkillEntry.skill.name } } : {}),
            },
        };

        if (typeof this.client.sendMessage === 'function') {
            const response = await this.client.sendMessage(sendParams, signal ? { signal } : undefined);

            if (!response) {
                return "Unknown response type from remote agent.";
            }

            const isMessageResponse = response.kind === 'message'
                || ('messageId' in response && Array.isArray(response.parts) && !('status' in response));
            if (isMessageResponse) {
                return extractPartsText(response.parts);
            }

            const isTaskResponse = response.kind === 'task'
                || ('id' in response && ('status' in response || 'artifacts' in response || 'history' in response));
            if (isTaskResponse) {
                return await this._waitForTask(response, { timeoutMs, pollIntervalMs, signal });
            }

            return "Unknown response type from remote agent.";
        }

        if (typeof this.client.sendMessageStream === 'function') {
            return await this._consumeTaskStream(
                this.client.sendMessageStream(sendParams, signal ? { signal } : undefined),
                { timeoutMs, signal }
            );
        }

        throw new Error(`A2A client for '${this.id}' does not support sendMessage or sendMessageStream.`);
    }

    /**
     * Polls or streams a non-terminal A2A task until completion or timeout.
     * @param {object} initialTask
     * @param {object} options
     * @returns {Promise<any>}
     */
    async _waitForTask(initialTask, { timeoutMs, pollIntervalMs, signal }) {
        let currentTask = initialTask;
        const initialState = normalizeTaskState(currentTask.status?.state);

        if (TERMINAL_TASK_STATES.has(initialState)) {
            return this._resolveTerminalTask(currentTask);
        }

        const deadline = Date.now() + timeoutMs;

        // If client provides resubscribeTask stream and not getTask, consume stream
        if (typeof this.client.getTask !== 'function' && typeof this.client.resubscribeTask === 'function') {
            return await this._consumeTaskStream(
                this.client.resubscribeTask({ id: currentTask.id }, signal ? { signal } : undefined),
                { timeoutMs, signal, initialTask: currentTask }
            );
        }

        if (typeof this.client.getTask === 'function') {
            while (Date.now() < deadline) {
                signal?.throwIfAborted?.();
                const remaining = deadline - Date.now();
                if (remaining <= 0) break;

                const delay = Math.min(pollIntervalMs, remaining);
                await sleep(delay, signal);

                if (Date.now() >= deadline) break;

                let timeoutId;
                try {
                    const pollBudget = Math.max(1, deadline - Date.now());
                    const pollPromise = this.client.getTask({ id: currentTask.id }, signal ? { signal } : undefined);
                    const timeoutPromise = new Promise((_, reject) => {
                        timeoutId = setTimeout(() => reject(new Error('__A2A_POLL_TIMEOUT__')), pollBudget);
                        if (timeoutId.unref) timeoutId.unref();
                    });
                    currentTask = await Promise.race([pollPromise, timeoutPromise]);
                } catch (err) {
                    if (err?.message === '__A2A_POLL_TIMEOUT__') {
                        break;
                    }
                    throw err;
                } finally {
                    if (timeoutId !== undefined) clearTimeout(timeoutId);
                }

                const state = normalizeTaskState(currentTask?.status?.state);
                if (TERMINAL_TASK_STATES.has(state)) {
                    return this._resolveTerminalTask(currentTask);
                }
            }
        }

        const pendingState = normalizeTaskState(currentTask?.status?.state) || 'working';
        return {
            status: 'pending',
            taskId: currentTask.id,
            id: currentTask.id,
            state: pendingState,
            ...(currentTask.contextId ? { contextId: currentTask.contextId } : {}),
            message: `Remote task ${currentTask.id} did not complete within ${timeoutMs}ms (state: ${pendingState}).`,
        };
    }

    /**
     * Consumes an A2A event stream until completion or timeout.
     * @param {AsyncIterable<object>} stream
     * @param {object} options
     * @returns {Promise<any>}
     */
    async _consumeTaskStream(stream, { timeoutMs, signal, initialTask = null }) {
        let currentTask = initialTask || { id: 'unknown', status: { state: 'working' } };
        const streamedParts = [];
        const deadline = Date.now() + timeoutMs;

        const iterator = stream[Symbol.asyncIterator]();
        try {
            while (Date.now() < deadline) {
                signal?.throwIfAborted?.();
                const remaining = deadline - Date.now();
                if (remaining <= 0) break;

                let timeoutId;
                let nextItem;
                try {
                    const timeoutPromise = new Promise((_, reject) => {
                        timeoutId = setTimeout(() => reject(new Error('__A2A_STREAM_TIMEOUT__')), remaining);
                        if (timeoutId.unref) timeoutId.unref();
                    });
                    nextItem = await Promise.race([iterator.next(), timeoutPromise]);
                } catch (err) {
                    if (err?.message === '__A2A_STREAM_TIMEOUT__') {
                        break;
                    }
                    throw err;
                } finally {
                    if (timeoutId !== undefined) clearTimeout(timeoutId);
                }

                if (!nextItem || nextItem.done) {
                    const currentState = normalizeTaskState(currentTask.status?.state);
                    if (TERMINAL_TASK_STATES.has(currentState)) {
                        return this._resolveTerminalTask(currentTask, streamedParts);
                    }
                    if (streamedParts.length > 0) {
                        return streamedParts.join('\n');
                    }
                    break;
                }

                const rawEvent = nextItem.value;
                if (!rawEvent) continue;

                const event = rawEvent.payload?.$case
                    ? { kind: rawEvent.payload.$case, ...rawEvent.payload.value }
                    : (rawEvent.data && rawEvent.kind
                        ? { kind: rawEvent.kind, ...rawEvent.data }
                        : rawEvent);

                if (event.kind === 'message') {
                    const text = extractPartsText(event.parts);
                    if (text) streamedParts.push(text);
                } else if (event.kind === 'task') {
                    currentTask = event;
                    const taskState = normalizeTaskState(currentTask.status?.state);
                    if (TERMINAL_TASK_STATES.has(taskState)) {
                        return this._resolveTerminalTask(currentTask, streamedParts);
                    }
                } else if (event.kind === 'artifact-update' || event.kind === 'artifactUpdate') {
                    const text = extractPartsText(event.artifact?.parts);
                    if (text) streamedParts.push(text);
                } else if (event.kind === 'status-update' || event.kind === 'statusUpdate') {
                    currentTask = {
                        ...currentTask,
                        id: event.taskId || currentTask.id,
                        contextId: event.contextId || currentTask.contextId,
                        status: event.status || currentTask.status,
                    };
                    const statusState = normalizeTaskState(event.status?.state);
                    if (event.final || TERMINAL_TASK_STATES.has(statusState)) {
                        return this._resolveTerminalTask(currentTask, streamedParts);
                    }
                }
            }
        } finally {
            if (typeof iterator.return === 'function') {
                try {
                    await iterator.return();
                } catch {
                    // ignore stream cleanup error
                }
            }
        }

        const pendingState = normalizeTaskState(currentTask?.status?.state) || 'working';
        return {
            status: 'pending',
            taskId: currentTask.id,
            id: currentTask.id,
            state: pendingState,
            ...(currentTask.contextId ? { contextId: currentTask.contextId } : {}),
            message: `Remote task ${currentTask.id} did not complete within ${timeoutMs}ms (state: ${pendingState}).`,
        };
    }

    /**
     * Resolves a task in a terminal state to its output or throws on failure.
     * @param {object} task
     * @param {Array<string>} [streamedParts=[]]
     * @returns {any}
     */
    _resolveTerminalTask(task, streamedParts = []) {
        const state = normalizeTaskState(task?.status?.state);
        if (state === 'completed') {
            return extractTaskOutput(task, streamedParts);
        }

        const details = task?.status?.details
            || extractPartsText(task?.status?.message?.parts)
            || (typeof task?.status?.message === 'string' ? task.status.message : '')
            || task?.error?.message
            || `Remote task ${task?.id || 'unknown'} ended in state '${state}'`;

        const err = new Error(details);
        err.taskId = task?.id;
        err.state = state;
        throw err;
    }

    /**
     * Connects to the remote A2A agent and resolves its Agent Card.
     * @returns {Promise<void>}
     */
    async connect() {
        const descriptor = buildServerDescriptor(
            this.toolName,
            { type: 'http', url: this.remoteUrl },
            'a2a'
        );

        if (this.policy && typeof this.policy.approveServer === 'function') {
            const decision = normalizeDecision(
                await this.policy.approveServer(descriptor),
                `A2A peer '${this.toolName}' at '${this.remoteUrl}' was rejected by security policy.`
            );
            if (!decision.allow) {
                throw new Error(decision.reason);
            }
        }

        const urlOptions = {
            policy: this.policy,
            ...(this.lookup ? { lookup: this.lookup } : {}),
            allowLoopback: this.allowLoopback,
            purpose: 'a2a:card',
        };

        await checkUrl(this.remoteUrl, 'a2a:card', urlOptions);

        if (!this.client) {
            if (typeof this.clientFactory === 'function') {
                this.client = await this.clientFactory(this.remoteUrl);
            } else {
                const {
                    ClientFactory,
                    ClientFactoryOptions,
                    DefaultAgentCardResolver,
                    JsonRpcTransportFactory,
                    RestTransportFactory,
                } = await loadOptional(
                    '@a2a-js/sdk/client',
                    'A2A client',
                    {
                        installCommand: A2A_INSTALL_CMD,
                        customMessage: A2A_CUSTOM_MSG,
                    }
                );

                const safeFetch = createSafeFetch(this.fetchImpl || globalThis.fetch, {
                    ...urlOptions,
                    purpose: 'a2a:http',
                });

                const transports = (JsonRpcTransportFactory && RestTransportFactory)
                    ? [
                        new JsonRpcTransportFactory({ fetchImpl: safeFetch, legacyCompat: { enabled: true } }),
                        new RestTransportFactory({ fetchImpl: safeFetch, legacyCompat: { enabled: true } }),
                    ]
                    : (ClientFactoryOptions?.default?.transports ?? []);

                let cardResolver;
                if (DefaultAgentCardResolver) {
                    const baseResolver = new DefaultAgentCardResolver({
                        fetchImpl: safeFetch,
                        legacyCompat: { enabled: true },
                    });
                    cardResolver = {
                        resolve: async (baseUrl, path) => {
                            const agentCardUrl = new URL(path ?? '.well-known/agent-card.json', baseUrl);
                            const res = await safeFetch(agentCardUrl);
                            if (!res.ok) {
                                throw new Error(`Failed to fetch Agent Card from ${agentCardUrl}: ${res.status}`);
                            }
                            const rawCard = await res.json();
                            const normalizedCard = cardResolver.normalizeAgentCard(rawCard);
                            await validateAgentCardUrls(normalizedCard, urlOptions);
                            return normalizedCard;
                        },
                        normalizeAgentCard: (rawCard) => {
                            if (rawCard && typeof rawCard === 'object' && Array.isArray(rawCard.skills)) {
                                rawCard = {
                                    ...rawCard,
                                    capabilities: rawCard.capabilities || {},
                                    defaultInputModes: Array.isArray(rawCard.defaultInputModes) ? rawCard.defaultInputModes : ['text'],
                                    defaultOutputModes: Array.isArray(rawCard.defaultOutputModes) ? rawCard.defaultOutputModes : ['text'],
                                    skills: rawCard.skills.map(s => ({
                                        ...s,
                                        id: s?.id || s?.name || 'skill',
                                        name: s?.name || s?.id || 'skill',
                                        description: s?.description || s?.name || '',
                                        tags: Array.isArray(s?.tags) ? s.tags : [],
                                    })),
                                };
                            }
                            return baseResolver.normalizeAgentCard(rawCard);
                        },
                    };
                }

                const factoryOptions = {
                    ...(ClientFactoryOptions?.default ?? {}),
                    transports,
                    ...(cardResolver ? { cardResolver } : {}),
                };
                this.factory = new ClientFactory(factoryOptions);

                try {
                    this.client = await this.factory.createFromUrl(this.remoteUrl);
                } catch (err) {
                    throw new Error(`Failed to connect to remote agent at ${this.remoteUrl}: ${err.message}`, { cause: err });
                }
            }
        }

        if (!this.agentCard && this.client) {
            if (typeof this.client.getAgentCard === 'function') {
                this.agentCard = await this.client.getAgentCard();
            } else if (this.client.agentCard) {
                this.agentCard = this.client.agentCard;
            }
        }

        if (this.agentCard) {
            await validateAgentCardUrls(this.agentCard, urlOptions);
            this._buildDeclarationsFromCard(this.agentCard);
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
     * Returns a fused tool object built with defineTool and argument validation.
     * @returns {object}
     */
    toFusedTool() {
        const [declaration] = this.getDeclarations();
        const impl = withValidation(
            validateA2AToolArgs,
            async (args, context) => this.invoke(declaration.name, args, context)
        );
        return defineTool(declaration, impl);
    }
}

/**
 * Creates an A2AToolSource whose list() derives tool declarations from the peer's Agent Card skills.
 *
 * @param {string|object} url - Remote A2A agent URL (or options object containing url/remoteUrl).
 * @param {object} [options={}]
 * @param {string} [options.id] - Peer identifier used for server management and tool namespacing.
 * @param {boolean} [options.lazy=false] - Whether to defer connecting until enable_server is called.
 * @param {string} [options.description] - Optional description for server discovery.
 * @param {boolean} [options.prefixToolNames=true] - Whether to prefix derived skill names with id.
 * @param {number} [options.timeoutMs=30000] - Task completion timeout in ms.
 * @param {number} [options.pollIntervalMs=150] - Task polling interval in ms.
 * @param {object} [options.client] - Optional pre-configured A2A client.
 * @param {object} [options.agentCard] - Optional pre-fetched Agent Card.
 * @param {Function} [options.clientFactory] - Optional custom client factory.
 * @returns {A2AToolSource}
 */
export function createA2ASource(url, options = {}) {
    if (url && typeof url === 'object') {
        return new A2AToolSource({
            ...url,
            deriveSkills: url.deriveSkills ?? true,
        });
    }
    return new A2AToolSource({
        ...options,
        remoteUrl: url,
        id: options.id || options.toolName || options.serverName || 'remote_agent',
        lazy: Boolean(options.lazy),
        deriveSkills: options.deriveSkills ?? true,
    });
}

