import { GoogleGenAI } from "@google/genai";
import { config } from 'dotenv';
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../../.env');
config({ path: envPath });

const geminiClient = new GoogleGenAI(process.env.GEMINI_API_KEY);

export async function chat(input, responseFormat, options) {
    // TODO: Add translation of input to provide 
    const defaultOptions = {
        model: 'gemini-2.5-flash-lite',
        config: {'response_mime_type' : responseFormat}
    };

    const finalOptions = { ...defaultOptions, ...options };
    delete finalOptions.provider; 

    if (responseFormat !== 'application/json') {
        delete finalOptions.config;
    }

    try {
        const response = await geminiClient.models.generateContent({
            contents: input,
            ...finalOptions,
        });
        return response.text;
    } catch (error) {
        console.error(`Error during Gemini chat completion:`, error);
        throw error;
    }
}