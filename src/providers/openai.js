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

/**
 * Determines whether an OpenAI API error is retryable.
 * Uses inverted logic: only explicitly non-retryable status codes (user errors)
 * are rejected. Everything else (5xx, network failures, etc.) is retryable.
 * For 429 (rate limit), extracts the Retry-After header so the caller can
 * respect the server's requested delay.
 *
 * @returns {{ retryable: boolean, retryAfterMs?: number|null }}
 */
export function isRetryable(error) {
    const status = error.status || error.code;
    const hardFails = [400, 401, 403, 404];
    if (hardFails.includes(status)) return { retryable: false };

    let retryAfterMs = null;
    if (status === 429) {
        const retryAfter = error.headers?.get?.('retry-after')
            || error.headers?.['retry-after'];
        if (retryAfter) {
            const parsed = parseInt(retryAfter, 10) * 1000;
            if (!isNaN(parsed)) retryAfterMs = parsed;
        }
    }

    return { retryable: true, retryAfterMs };
}

export async function chat(client, input, { inputSchema, outputSchema, signal, ...options }) {
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
            }, { signal });
            output = response.output_parsed;
        } else {
            response = await client.responses.create({
                input: _convertInput(input),
                ...finalOptions,
            }, { signal });
            output = response.output_text;
        }
        return { output: output, rawResponse: response };
    } catch (error) {
        console.error(`Error during OpenAI chat response creation:`, error);
        throw error;
    }
}