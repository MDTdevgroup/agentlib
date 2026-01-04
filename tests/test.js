import { LLMService } from '@peebles-group/agentlib-js';
import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });
import OpenAI from 'openai';

const llm = new LLMService('gemini', process.env.GEMINI_API_KEY);
const response = await llm.chat('Search for top 5 urls for extracting events in montreal!', {
    tools: [{ type: "web_search" }],
});
console.log(response);
console.log(response.rawResponse.output)

// const llm2 = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// const response2 = await llm2.responses.create({
//     model: "gpt-5",
//     tools: [
//         { type: "web_search" },
//     ],
//     input: "Search for top 5 urls for extracting events in montreal!",
// });
// console.log(response2);
