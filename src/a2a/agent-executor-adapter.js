import { randomUUID } from 'node:crypto';
import { messageText } from '../memory/message.js';

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

        // Publish initial task state if not already present
        if (!task) {
            eventBus.publish({
                kind: 'task',
                id: taskId,
                contextId: contextId,
                status: { state: 'submitted', timestamp: new Date().toISOString() },
                history: [userMessage],
            });
        }

        // Publish 'working' status
        eventBus.publish({
            kind: 'status-update',
            taskId,
            contextId,
            status: { state: 'working', timestamp: new Date().toISOString() },
            final: false,
        });

        try {
            // Extract text content from the A2A message
            // A2A messages have parts, usually 'text' kind.
            const textPart = userMessage.parts.find(p => p.kind === 'text');
            const inputContent = textPart ? textPart.text : JSON.stringify(userMessage.parts);

            // Add to agent's input
            this.agent.addInput({ role: 'user', content: inputContent });

            // Run the agent
            const response = await this.agent.run();

            // The response from agentlib is an array of turns (CPS history)
            const finalTurn = Array.isArray(response) ? response[response.length - 1] : response;
            const messages = this.agent.context?.getMessages() || [];
            const lastMessage = messages[messages.length - 1];
            const responseText = messageText(finalTurn) || messageText(lastMessage) || "No response generated";

            // Publish the response message
            eventBus.publish({
                kind: 'message',
                messageId: randomUUID(),
                role: 'agent',
                parts: [{ kind: 'text', text: responseText }],
                contextId: contextId,
            });

            // Mark as completed
            eventBus.publish({
                kind: 'status-update',
                taskId,
                contextId,
                status: { state: 'completed', timestamp: new Date().toISOString() },
                final: true,
            });

        } catch (error) {
            eventBus.publish({
                kind: 'status-update',
                taskId,
                contextId,
                status: { state: 'failed', timestamp: new Date().toISOString(), details: error.message },
                final: true,
            });
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
