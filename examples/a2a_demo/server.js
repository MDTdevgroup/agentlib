import { Agent, ToolLoader, LLMService } from '../../index.js';
import { startA2AServer } from '../../src/a2a/index.js';

// Define a simple tool
const mathTool = {
    name: 'calculate_sum',
    description: 'Calculates the sum of two numbers.',
    func: async ({ a, b }) => {
        console.log(`[Server] Calculating ${a} + ${b}`);
        return { result: Number(a) + Number(b) };
    },
    parameters: {
        type: "object",
        properties: {
            a: { type: "number" },
            b: { type: "number" }
        },
        required: ["a", "b"]
    }
};

async function runServer() {
    const toolLoader = new ToolLoader();
    toolLoader.addTool(mathTool);

    const llmService = new LLMService({ provider: 'openai', apiKey: process.env.OPENAI_API_KEY });

    const agent = new Agent(llmService, {
        toolLoader,
        model: 'gpt-5'
    });

    console.log("Starting Math Expert Agent Server...");
    await startA2AServer(agent, { port: 4000, name: "Math Expert" });
}

runServer();
