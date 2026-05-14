import OpenAI from 'openai';
import { zodTextFormat } from "openai/helpers/zod";
import { defaultOpenaiModel } from "../config.js";

// Factory function to create client
export function createClient(auth) {
    return new OpenAI({ apiKey: auth.apiKey });
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

async function _applySemanticPruning(messages) {
    // TODO: Implement embedding-based cosine similarity filtering
    return messages;
}

export async function chat(client, input, { model = defaultOpenaiModel, pruningOptions, inputSchema, outputSchema, ...options }) {
    const finalOptions = { model, ...options };

    if (inputSchema) {
        input = inputSchema.parse(input);
    }

    if (pruningOptions?.enabled) {
        input = await _applySemanticPruning(input);
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