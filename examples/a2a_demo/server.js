
import dotenv from 'dotenv';
dotenv.config();

import { Agent, ToolLoader, LLMService, startA2AServer } from '../../index.js';
import path from 'path';
import { fileURLToPath } from 'url';
dotenv.config({ path: '../../.env' });

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

    const llmService = new LLMService('openai', process.env.OPENAI_API_KEY);

    const agent = new Agent(llmService, {
        toolLoader,
        model: 'gpt-5',
        redundantToolInfo: true
    });

    console.log("Starting Math Expert Agent Server...");
    startA2AServer(agent, { port: 4000, name: "Math Expert" });
}

runServer();
