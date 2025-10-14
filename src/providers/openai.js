import OpenAI from 'openai';
import { zodTextFormat } from "openai/helpers/zod";
import { defaultModel } from "../config.js";

// Factory function to create client
export function createClient(apiKey) {
    return new OpenAI({ apiKey });
}

// Now accepts the client as first parameter
export async function chat(client, input, { inputSchema, outputSchema, ...options }) {
    const defaultOptions = { model: defaultModel };
    const finalOptions = { ...defaultOptions, ...options };

    if (inputSchema) {
        input = inputSchema.parse(input);
    }

    try {
        let response;
        if (outputSchema) {
            response = await client.responses.parse({
                input: input,
                text: { 
                    format: zodTextFormat(outputSchema, "output") 
                },
                ...finalOptions,
            });
        } else {
            response = await client.responses.create({
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