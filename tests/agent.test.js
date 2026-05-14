import { Agent } from '../src/core/agent.js';
import { LLMService } from '../src/services/llm-service.js';
import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

const llm = new LLMService({ provider: 'openai', apiKey: process.env.OPENAI_API_KEY });

console.log(await llm.chat([{ role: 'user', content: 'Hello, world!' }]))

const tool = {
    type: "function",
    name: "greet",
    description: "Greet the user",
    parameters: {
        type: "object",
        properties: {
            name: {
                type: "string",
                description: "The name of the user",
            },
        },
        required: ["name"],
    },
    func: async ({ name }) => {
        return `Hello, ${name}!`;
    },
}

const agent = new Agent(llm, { name: 'test-agent', tools: [tool] });

agent.addInput({ role: 'user', content: 'Say hello to Bob' });

const response = await agent.run();

console.log(response);