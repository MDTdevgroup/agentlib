import { Agent, ToolLoader, LLMService } from '../../index.js';
import { createRemoteAgentTool } from '../../src/a2a/index.js';

async function runClient() {
    // Create a tool that talks to the remote agent
    const remoteTool = await createRemoteAgentTool('http://localhost:4000', 'math_expert', 'Ask the math expert for help with calculations.');

    const toolLoader = new ToolLoader();
    toolLoader.addTool(remoteTool);

    const llmService = new LLMService({ provider: 'openai', apiKey: process.env.OPENAI_API_KEY });

    const agent = new Agent(llmService, {
        toolLoader,
        model: 'gpt-5',
    });

    console.log("User: What is 123 + 456?");
    agent.addInput({ role: 'user', content: 'What is 123 + 456?' });

    const history = await agent.run();
    const response = history[history.length - 1];
    console.log("CLIENT:", response.output);
}

runClient();
