import OpenAI from 'openai';
import { GoogleGenAI } from "@google/genai";
import { config } from 'dotenv';
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env');
config({ path: envPath });

class LLMService {
    constructor() {
        this.openAIClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        this.geminiClient = new GoogleGenAI(process.env.GEMINI_API_KEY);
    }

    async chat(messages, options = {}) {
        const provider = options.provider || 'openai';

        if (provider === 'openai') {
            return this._openAIChat(messages, options);
        } else if (provider === 'gemini') {
            return this._geminiChat(messages, options);
        } else {
            throw new Error(`Provider ${provider} is not supported yet.`);
        }
    }

    async _openAIChat(messages, options = {}) {
        const defaultOptions = {
            model: 'gpt-4o-mini',
            response_format: { type: 'json_object' },
            temperature: 0.2,
        };

        const finalOptions = { ...defaultOptions, ...options };
        delete finalOptions.provider; // Remove provider from options passed to OpenAI

        if (finalOptions.response_format === null) {
            delete finalOptions.response_format;
        }

        try {
            const response = await this.openAIClient.chat.completions.create({
                messages,
                ...finalOptions,
            });
            return response.choices[0].message.content;
        } catch (error) {
            console.error(`Error during OpenAI chat completion:`, error);
            throw error;
        }
    }

    async _geminiChat(contents, options = {}) {
        const defaultOptions = {
            model: 'gemini-2.5-flash-lite',
        };

        const finalOptions = { ...defaultOptions, ...options };
        delete finalOptions.provider; // Remove provider from options passed to Gemini

        if (finalOptions.response_format === null) {
            delete finalOptions.response_format;
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

    _prepareGeminiMessages(messages) {
        let systemInstruction;
        const contents = [];

        messages.forEach(msg => {
            if (msg.role === 'system') {
                if (!systemInstruction) {
                    systemInstruction = { role: 'system', parts: [{ text: msg.content }] };
                }
            } else {
                if (Array.isArray(msg.content)) {
                    const parts = msg.content.map(part => {
                        if (part.type === 'text') {
                            return { text: part.text };
                        }
                        if (part.type === 'image_url') {
                            const match = part.image_url.url.match(/^data:(image\/\w+);base64,(.+)$/);
                            if (match) {
                                return {
                                    inlineData: {
                                        mimeType: match[1],
                                        data: match[2],
                                    }
                                };
                            }
                        }
                        return null;
                    }).filter(p => p);
                    contents.push({
                        role: msg.role === 'assistant' ? 'model' : msg.role,
                        parts: parts,
                    });
                } else {
                     contents.push({
                        role: msg.role === 'assistant' ? 'model' : msg.role,
                        parts: [{ text: msg.content }],
                    });
                }
            }
        });

        return { contents, systemInstruction };
    }
}

export default new LLMService(); 