import OpenAI from 'openai';
import { zodTextFormat } from "openai/helpers/zod";
import { defaultOpenaiModel } from "../config.js";

// Factory function to create client
export function createClient(apiKey) {
    return new OpenAI({ apiKey });
}

function _convertInput(input) {
    return input.map((item) => {
        if (item.type === 'function_call_output') {
            return { type: 'function_call_output', call_id: item.call_id, output: JSON.stringify(item.output) };
        } else {
            return item;
        }
    });
}

// Now accepts the client as first parameter
export async function chat(client, input, { inputSchema, outputSchema, ...options }) {
    const defaultOptions = { model: defaultOpenaiModel };
    const finalOptions = { ...defaultOptions, ...options };

    if (inputSchema) {
        input = inputSchema.parse(input);
    }

    try {
        let response, output;
        if (outputSchema) {
            response = await client.responses.parse({
                input: _convertInput(input),
                text: {
                    format: zodTextFormat(outputSchema, "output")
                },
                ...finalOptions,
            });
            output = response.output_parsed;
        } else {
            response = await client.responses.create({
                input: _convertInput(input),
                ...finalOptions,
            });
            output = response.output_text;
        }
        return { output: output, rawResponse: response };
    } catch (error) {
        console.error(`Error during OpenAI chat response creation:`, error);
        throw error;
    }
}