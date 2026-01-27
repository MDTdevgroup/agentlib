
import dotenv from 'dotenv';
dotenv.config();

import { Agent, ToolLoader, LLMService, createRemoteAgentTool } from '../../../index.js';
import path from 'path';
import { fileURLToPath } from 'url';

// Load env from root
dotenv.config({ path: '../../../.env' });

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runClient() {
    console.log("Creating client connecting to http://localhost:8000...");

    // 1. Create the remote tool
    // We point to the Python server running on port 8000
    const weatherTool = await createRemoteAgentTool(
        'http://localhost:8000',
        'weather_expert',
        'Get weather information for cities using the remote expert.'
    );

    // 2. Setup Local Agent
    const toolLoader = new ToolLoader();
    toolLoader.addTool(weatherTool);

    const llmService = new LLMService('openai', process.env.OPENAI_API_KEY);

    const agent = new Agent(llmService, {
        toolLoader,
        model: 'gpt-4o', // Or gpt-4o-mini
    });

    // 3. Run the flow
    const query = "What is the weather like in London and in Wiltshire?";
    console.log(`\nUser: ${query}`);

    agent.addInput({ role: 'user', content: query });

    const response = await agent.run();

    if (response.rawResponse && response.rawResponse.content) {
        console.log("\nAgent Response:", response.rawResponse.content);
    } else {
        console.log("\nAgent Response:", response);
    }
}

runClient().catch(err => console.error(err));
