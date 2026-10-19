import { randomUUID } from 'node:crypto';
import { messageText } from '../memory/message.js';

const TASK_STATE_SUBMITTED = 1;
const TASK_STATE_WORKING = 2;
const TASK_STATE_COMPLETED = 3;
const TASK_STATE_FAILED = 4;
const ROLE_AGENT = 2;

function extractUserMessageText(userMessage) {
    const parts = userMessage?.parts;
    if (!Array.isArray(parts)) return '';
    for (const part of parts) {
        if (!part) continue;
        if (typeof part.text === 'string') return part.text;
        if (part.content?.$case === 'text' && typeof part.content.value === 'string') {
            return part.content.value;
        }
    }
    return JSON.stringify(parts);
}

function buildAgentMessage(text, taskId, contextId) {
    return {
        messageId: randomUUID(),
        taskId,
        contextId,
        role: ROLE_AGENT,
        parts: [
            {
                kind: 'text',
                text,
                content: { $case: 'text', value: text },
                mediaType: 'text/plain',
                filename: '',
                metadata: {},
            },
        ],
        metadata: {},
        extensions: [],
        referenceTaskIds: [],
    };
}

/**
 * Adapts an agentlib Agent to the A2A AgentExecutor interface.
 * This allows the agent to be run by the A2A server.
 */
export class AgentExecutorAdapter {
    /**
     * @param {import('../core/agent.js').Agent} agent - The agent to adapt.
     */
    constructor(agent) {
        this.agent = agent;
        this.cancelledTasks = new Set();
    }

    /**
     * Executes the agent logic for a given task.
     * @param {import('@a2a-js/sdk/server').RequestContext} requestContext
     * @param {import('@a2a-js/sdk/server').ExecutionEventBus} eventBus
     */
    async execute(requestContext, eventBus) {
        const { taskId, contextId, userMessage, task } = requestContext;
        const isV1Bus = typeof EventTarget !== 'undefined' && eventBus instanceof EventTarget;

        if (isV1Bus) {
            const initialTask = task || {
                id: taskId,
                contextId,
                status: {
                    state: TASK_STATE_SUBMITTED,
                    timestamp: new Date().toISOString(),
                },
                artifacts: [],
                history: userMessage ? [userMessage] : [],
                metadata: {},
            };
            eventBus.publish({
                kind: 'task',
                data: initialTask,
            });
            eventBus.publish({
                kind: 'statusUpdate',
                data: {
                    taskId,
                    contextId,
                    status: {
                        state: TASK_STATE_WORKING,
                        timestamp: new Date().toISOString(),
                    },
                    metadata: {},
                },
            });
        } else {
            if (!task) {
                eventBus.publish({
                    kind: 'task',
                    id: taskId,
                    contextId: contextId,
                    status: { state: 'submitted', timestamp: new Date().toISOString() },
                    history: [userMessage],
                });
            }
            eventBus.publish({
                kind: 'status-update',
                taskId,
                contextId,
                status: { state: 'working', timestamp: new Date().toISOString() },
                final: false,
            });
        }

        try {
            const inputContent = extractUserMessageText(userMessage);

            // Add to agent's input
            this.agent.addInput({ role: 'user', content: inputContent });

            // Run the agent
            const response = await this.agent.run();

            // The response from agentlib is an array of turns (CPS history)
            const finalTurn = Array.isArray(response) ? response[response.length - 1] : response;
            const messages = this.agent.context?.getMessages() || [];
            const lastMessage = messages[messages.length - 1];
            const responseText = messageText(finalTurn) || messageText(lastMessage) || "No response generated";

            if (isV1Bus) {
                eventBus.publish({
                    kind: 'statusUpdate',
                    data: {
                        taskId,
                        contextId,
                        status: {
                            state: TASK_STATE_COMPLETED,
                            message: buildAgentMessage(responseText, taskId, contextId),
                            timestamp: new Date().toISOString(),
                        },
                        metadata: {},
                    },
                });
            } else {
                eventBus.publish({
                    kind: 'message',
                    messageId: randomUUID(),
                    role: 'agent',
                    parts: [{ kind: 'text', text: responseText }],
                    contextId: contextId,
                });
                eventBus.publish({
                    kind: 'status-update',
                    taskId,
                    contextId,
                    status: { state: 'completed', timestamp: new Date().toISOString() },
                    final: true,
                });
            }
        } catch (error) {
            if (isV1Bus) {
                eventBus.publish({
                    kind: 'statusUpdate',
                    data: {
                        taskId,
                        contextId,
                        status: {
                            state: TASK_STATE_FAILED,
                            message: buildAgentMessage(error.message || String(error), taskId, contextId),
                            timestamp: new Date().toISOString(),
                        },
                        metadata: {},
                    },
                });
            } else {
                eventBus.publish({
                    kind: 'status-update',
                    taskId,
                    contextId,
                    status: { state: 'failed', timestamp: new Date().toISOString(), details: error.message },
                    final: true,
                });
            }
        } finally {
            eventBus.finished();
        }
    }

    async cancelTask(taskId, _eventBus) {
        this.cancelledTasks.add(taskId);
        // Note: To fully support cancellation, Agent.js would need to check this flag during its execution loop.
        // For now, this just marks it.
    }
}
