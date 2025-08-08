import OpenAI from 'openai';
import { GoogleGenAI } from "@google/genai";
import { config } from 'dotenv';
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env');
config({ path: envPath });

class LLMService {
    constructor(provider='openai') {
        this.provider = provider;
        if (provider === 'openai') {
            this.openAIClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        } else if (provider === 'gemini') {
            this.geminiClient = new GoogleGenAI(process.env.GEMINI_API_KEY);
        } else {
            throw new Error(`Provider ${provider} is not supported yet.`);
        }
    }

    async chat(systemPrompt, prompt, responseFormat = null, options = {}) {
        const provider = this.provider || 'openai';

        if (provider === 'openai') {
            return this._openAIChat(systemPrompt, prompt, responseFormat, options);
        } else if (provider === 'gemini') {
            return this._geminiChat(prompt, responseFormat, options);
        } else {
            throw new Error(`Provider ${provider} is not supported yet.`);
        }
    }

    async _openAIChat(systemPrompt, prompt, responseFormat, options) {
        const defaultOptions = {
            model: 'gpt-4o-mini',
            response_format: null,
        };

        if (responseFormat === 'json_object') {
            defaultOptions.response_format = { type: 'json_object' };
        } else {
            delete defaultOptions.response_format;
        }

        const finalOptions = { ...defaultOptions, ...options };

        try {
            const response = await this.openAIClient.chat.completions.create({
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: prompt },
                ],
                ...finalOptions,
            });
            
            if (response.choices[0].message.tool_calls) {
              return response.choices[0].message;
            }
            
            return response.choices[0].message.content;
        } catch (error) {
            console.error(`Error during OpenAI chat completion:`, error);
            throw error;
        }
    }

    async _geminiChat(contents, responseFormat, options) {
        const defaultOptions = {
            model: 'gemini-2.5-flash-lite',
            config: {'response_mime_type' : responseFormat}
        };

        const finalOptions = { ...defaultOptions, ...options };
        delete finalOptions.provider; // Remove provider from options passed to Gemini

        if (responseFormat !== 'application/json') {
            delete finalOptions.config;
        }

        try {
            const response = await this.geminiClient.models.generateContent({
                contents: contents,
                ...finalOptions,
            });
            return response.text;
        } catch (error) {
            console.error(`Error during Gemini chat completion:`, error);
            throw error;
        }
    }
}

export default LLMService; 