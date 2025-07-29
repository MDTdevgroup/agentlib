import OpenAI from 'openai';
import { config } from 'dotenv';
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env');
config({ path: envPath });

class LLMService {
    constructor(provider = 'openai') {
        if (provider !== 'openai') {
            throw new Error(`Provider ${provider} is not supported yet.`);
        }
        this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        this.provider = provider;
    }


    async chat(messages, options = {}) {
        const defaultOptions = {
            model: 'gpt-4o-mini',
            response_format: { type: 'json_object' },
            temperature: 0.2,
        };

        const finalOptions = { ...defaultOptions, ...options };
        
        if (finalOptions.response_format === null) {
            delete finalOptions.response_format;
        }

        try {
            const response = await this.client.chat.completions.create({
                messages,
                ...finalOptions,
            });
            return response;
        } catch (error) {
            console.error(`Error during LLM chat completion with provider ${this.provider}:`, error);
            throw error;
        }
    }
}

export default new LLMService(); 