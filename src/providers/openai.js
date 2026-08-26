import OpenAI from 'openai';
import { zodTextFormat } from "openai/helpers/zod";
import { defaultOpenaiModel } from "../config.js";

export const defaultModel = defaultOpenaiModel;

// Factory function to create client
export function createClient(auth) {
    return new OpenAI({ apiKey: auth.apiKey });
}

export function isRetryable(error) {
    if (!error) return { retryable: false };

    const status = error.status || error.statusCode || error.response?.status;
    const retryAfterHeader = error.headers?.['retry-after'] || error.response?.headers?.get?.('retry-after');
    let retryAfterMs = undefined;
    if (retryAfterHeader) {
        const parsed = Number(retryAfterHeader);
        if (!Number.isNaN(parsed) && parsed > 0) {
            retryAfterMs = parsed * 1000;
        }
    }

    if (status === 400 || status === 401 || status === 403 || status === 404) {
        return { retryable: false };
    }

    if (status === 429 || (status >= 500 && status <= 599)) {
        return { retryable: true, retryAfterMs };
    }

    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND' || error.name === 'AbortError') {
        return { retryable: true, retryAfterMs };
    }

    return { retryable: false };
}

export function toProvider(input) {
    if (!Array.isArray(input)) return [];
    return input.map((item) => {
        if (!item || typeof item !== 'object') return item;
        if (item.type === 'function_call_output') {
            // Own single-encoding: if already string, pass as is; otherwise stringify once
            const out = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? null);
            const wireItem = {
                type: 'function_call_output',
                call_id: item.call_id,
                output: out,
            };
            if (item.id) wireItem.id = item.id;
            return wireItem;
        }
        if (item.type === 'function_call') {
            const wireItem = {
                type: 'function_call',
                call_id: item.call_id || item.id,
                name: item.name,
                arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
            };
            if (item.id) wireItem.id = item.id;
            return wireItem;
        }
        if (item.type === 'reasoning') {
            const wireItem = {
                type: 'reasoning',
            };
            if (item.summary !== undefined) wireItem.summary = item.summary;
            if (item.content !== undefined) wireItem.content = item.content;
            if (item.id) wireItem.id = item.id;
            return wireItem;
        }
        if (item.type === 'message' || item.role) {
            const textContent = item.content !== undefined ? item.content : (item.text || '');
            const wireItem = {
                type: 'message',
                role: item.role || 'user',
                content: textContent,
            };
            if (item.phase) wireItem.phase = item.phase;
            if (item.id) wireItem.id = item.id;
            return wireItem;
        }
        return item;
    });
}

export function fromProvider(rawResponse) {
    if (!rawResponse || !Array.isArray(rawResponse.output)) {
        return [];
    }
    return rawResponse.output.map((item) => {
        if (item.type === 'function_call') {
            return {
                type: 'function_call',
                id: item.id || item.call_id,
                call_id: item.call_id || item.id,
                name: item.name,
                arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
            };
        }
        if (item.type === 'reasoning') {
            return {
                type: 'reasoning',
                summary: item.summary,
                content: item.content,
            };
        }
        if (item.type === 'message') {
            let text = '';
            if (typeof item.content === 'string') {
                text = item.content;
            } else if (Array.isArray(item.content)) {
                text = item.content
                    .map(b => (typeof b === 'string' ? b : b.text || ''))
                    .filter(Boolean)
                    .join('\n');
            }
            return {
                type: 'message',
                role: item.role || 'assistant',
                content: text,
                id: item.id,
            };
        }
        return item;
    });
}

export async function chat(client, input, { model = defaultOpenaiModel, inputSchema, outputSchema, ...options }) {
    const finalOptions = { model, ...options };

    if (inputSchema) {
        input = inputSchema.parse(input);
    }

    try {
        let response, output;
        const convertedInput = toProvider(input);

        if (outputSchema) {
            response = await client.responses.parse({
                input: convertedInput,
                text: {
                    format: zodTextFormat(outputSchema, "output")
                },
                ...finalOptions,
            });
            output = response.output_parsed;
        } else {
            response = await client.responses.create({
                input: convertedInput,
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