import { LLMService } from '../src/llmService.js';
import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });
import OpenAI from 'openai';

const llm = new LLMService('openai', process.env.OPENAI_API_KEY);
const response = await llm.chat('Search for top 5 urls for extracting events in montreal!', {
    tools: [{ type: "web_search" }],
    model: 'gpt-4o-mini'
});
console.log(response);

// const llm2 = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// const response2 = await llm2.responses.create({
//     model: "gpt-5",
//     tools: [
//         { type: "web_search" },
//     ],
//     input: "Search for top 5 urls for extracting events in montreal!",
// });
// console.log(response2);
