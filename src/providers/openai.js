import OpenAI from 'openai';
import { config } from 'dotenv';
import path from "path";
import { fileURLToPath } from "url";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { defaultModel } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../../.env');
config({ path: envPath });

const openAIClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function chat(input, { inputSchema, outputSchema, ...options }) {
    const defaultOptions = {model: defaultModel};
    const finalOptions = { ...defaultOptions, ...options };

    // Validate input with Zod
    if (inputSchema) {
        input = inputSchema.parse(input);
    }

    try {
        let response;
        if (outputSchema) {
            response = await openAIClient.responses.create({
                input: input,
                text: { 
                    format: zodTextFormat(outputSchema, "output") 
                },
                ...finalOptions,
            });
        } else {
            response = await openAIClient.responses.create({
                input: input,
                ...finalOptions,
            });
        }
        return response;
    } catch (error) {
        console.error(`Error during OpenAI chat completion:`, error);
        throw error;
    }
}