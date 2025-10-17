import { GoogleGenAI } from "@google/genai";

export function createClient(apiKey) {
    return new GoogleGenAI(apiKey);
}

export async function chat(client, input, { inputSchema, outputSchema, ...options }) {
    // TODO: Add translation of input to provide 
    const defaultOptions = { model: 'gemini-2.5-flash-lite' };
    const finalOptions = { ...defaultOptions, ...options };

    try {
        const response = await client.models.generateContent({
            contents: input,
            ...finalOptions,
        });
        return response;
    } catch (error) {
        console.error(`Error during Gemini chat completion:`, error);
        throw error;
    }
}