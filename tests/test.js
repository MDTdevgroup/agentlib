import { LLMService } from 'agentlib';
import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

const llm = new LLMService('openai', process.env.OPENAI_API_KEY);
const response = await llm.chat('Hello!', { model: 'gpt-4o-mini' });
console.log(response);