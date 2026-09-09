import { Agent, ToolLoader, LLMService } from '../../../index.js';
import { createRemoteAgentTool } from '../../../src/a2a/index.js';

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

    const llmService = new LLMService({ provider: 'openai', apiKey: process.env.OPENAI_API_KEY });

    const agent = new Agent(llmService, {
        toolLoader,
        model: 'gpt-5',
    });

    // 3. Run the flow 
    const query = "What is the weather like in London?";
    console.log(`\nUser: ${query}`);

    agent.addInput({ role: 'user', content: query });

    const history = await agent.run();
    const response = history[history.length - 1];
    console.log("\nAgent Response:", response.output);
}

runClient().catch(err => console.error(err));
