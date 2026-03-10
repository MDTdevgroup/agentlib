import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path, { dirname } from 'path';
import * as fs from "node:fs";
import { LLMService } from '@peebles-group/agentlib-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from the parent directory
dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function main() {
    const base64ImageFile = fs.readFileSync("image.jpg", {
        encoding: "base64",
    });

    const ai = new LLMService({
        model: 'gemini-2.5-flash',
        apiKey: process.env.GEMINI_API_KEY
    });

    const input = [
        {
            role: 'user',
            content: "Describe this image."
        }
    ]

    const response = await ai.chat(input);

    console.log('\n--- Gemini Response ---');
    console.log(response.text);
    console.log('-----------------------\n');
}

main().catch(console.error);
