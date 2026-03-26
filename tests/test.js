import { LLMService } from '../src/llmService.js';
import { Agent } from '../src/Agent.js';
import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

const llm = new LLMService({ provider: 'gemini', apiKey: process.env.GEMINI_API_KEY });
const input = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Search for top 5 urls for extracting events in montreal!" }
]
// const input = { role: "user", content: "Search for top 5 urls for extracting events in montreal!" }
const agent = new Agent(llm, { logmode: 'console' });
agent.addInput(input);
const response = await agent.run();
console.log(response);
