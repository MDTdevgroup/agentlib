import { v4 as uuidv4 } from 'uuid';

/**
 * Adapts an agentlib Agent to the A2A AgentExecutor interface.
 * This allows the agent to be run by the A2A server.
 */
export class AgentExecutorAdapter {
    /**
     * @param {import('../Agent').Agent} agent - The agent to adapt.
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

            // The response from agentlib is typically { rawResponse, output: [...messages], ... }
            // We want the final text response.
            // Depending on the Agent implementation, output might be the full history or just the new messages.
            // Based on Agent.js, run() returns `response` which has `executed`. 
            // The last message in `this.agent.input` should be the assistant's response.

            const lastMessage = this.agent.input[this.agent.input.length - 1];
            let responseText = "No response generated";

            if (lastMessage && lastMessage.role === 'assistant') {
                responseText = lastMessage.content;
            } else if (response.rawResponse && response.rawResponse.content) {
                // Fallback if not added to input yet
                responseText = response.rawResponse.content;
            }

            // Publish the response message
            eventBus.publish({
                kind: 'message',
                messageId: uuidv4(),
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
            console.error("Error executing agent:", error);
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

    async cancelTask(taskId, eventBus) {
        this.cancelledTasks.add(taskId);
        // Note: To fully support cancellation, Agent.js would need to check this flag during its execution loop.
        // For now, this just marks it.
    }
}
