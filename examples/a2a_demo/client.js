
import dotenv from 'dotenv';
dotenv.config();

import { Agent, ToolLoader, createRemoteAgentTool, LLMService } from '../../index.js';
import path from 'path';
import { fileURLToPath } from 'url';
dotenv.config({ path: '../../.env' });

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runClient() {
    // Create a tool that talks to the remote agent
    const remoteTool = await createRemoteAgentTool('http://localhost:4000', 'math_expert', 'Ask the math expert for help with calculations.');

    const toolLoader = new ToolLoader();
    toolLoader.addTool(remoteTool);

    const llmService = new LLMService('openai', process.env.OPENAI_API_KEY);

    const agent = new Agent(llmService, {
        toolLoader,
        model: 'gpt-5',
        redundantToolInfo: true
    });

    console.log("User: What is 123 + 456?");
    agent.addInput({ role: 'user', content: 'What is 123 + 456?' });

    const response = await agent.run();

    if (response.rawResponse && response.rawResponse.content) {
        console.log("Agent Response:", response.rawResponse.content);
    } else {
        console.log("Agent Response (Full Object):", JSON.stringify(response, null, 2));
    }
}

runClient();
