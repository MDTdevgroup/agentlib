import OpenAI from 'openai';
import { zodResponseFormat } from "openai/helpers/zod";
import {
    getModelLimits as resolveModelLimits,
    getModelContextLimit as resolveModelContextLimit,
} from './model-limits.js';

export const defaultModel = 'default';

// Factory function to create client pointing to vLLM
export function createClient(auth) {
    return new OpenAI({
        // vLLM doesn't strictly require an API key by default, but the OpenAI SDK 
        // requires the field to be populated.
        apiKey: auth.apiKey || 'EMPTY',
        baseURL: auth.baseURL || 'http://localhost:8000/v1'
    });
}

export function getModelContextLimit(model = defaultModel) {
    return resolveModelContextLimit('vllm', model);
}

export function getModelLimits(model = defaultModel) {
    return resolveModelLimits('vllm', model);
}

export { isRetryable } from './openai.js';

export function toProvider(input) {
    // Map your agentlib structured inputs onto the standard Chat Completions `messages` format
    return input.map((item) => {
        if (item.type === 'function_call_output') {
            const out = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? null);
            return {
                role: 'tool',
                tool_call_id: item.call_id,
                content: out,
            };
        } else if (item.role === 'assistant' && item.type === 'function_call') {
            return {
                role: 'assistant',
                tool_calls: [{
                    id: item.call_id,
                    type: 'function',
                    function: {
                        name: item.name,
                        arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments)
                    }
                }]
            };
        }

        // Ensure only standardized properties are sent for regular messages
        const cleanItem = { role: item.role || 'user' };
        if (item.content !== undefined) cleanItem.content = item.content;
        if (item.name) cleanItem.name = item.name;

        return cleanItem;
    });
}

function _convertResponse(response) {
    // Map Chat Completions format to Responses format
    const choice = response.choices[0];

    let output = [];
    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
        // Map tool calls
        output = choice.message.tool_calls.map(tc => ({
            type: "function_call",
            id: tc.id,
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
            status: "completed"
        }));
    } else if (choice.message.content !== null) {
        // Map standard message content
        output = [
            {
                type: "message",
                id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`, // Generate a fake message ID to match format
                status: "completed",
                role: choice.message.role,
                content: [
                    {
                        type: "output_text",
                        text: choice.message.content,
                        annotations: choice.message.annotations || []
                    }
                ]
            }
        ];
    }

    return {
        id: response.id.replace('chatcmpl-', 'resp_'),
        object: "response",
        created_at: response.created,
        status: choice.finish_reason === "stop" || choice.finish_reason === "tool_calls" ? "completed" : choice.finish_reason,
        completed_at: response.created,
        model: response.model,
        output: output,
        usage: response.usage,
        originalFormat: response
    };
}

export const fromProvider = _convertResponse;

export async function chat(client, input, { model, inputSchema, outputSchema, ...options }) {
    const finalOptions = { model, ...options };

    if (inputSchema) {
        input = inputSchema.parse(input);
    }

    let response, output;
    const messages = toProvider(input);

    // vLLM exposes the standard Chat Completions API instead of the new Responses API
    if (outputSchema) {
        // vLLM supports structured outputs via typical json_schema format
        response = await client.chat.completions.create({
            messages: messages,
            response_format: zodResponseFormat(outputSchema, "output"),
            ...finalOptions,
        });
        output = JSON.parse(response.choices[0].message.content);
    } else {
        response = await client.chat.completions.create({
            messages: messages,
            ...finalOptions,
        });
        output = response.choices[0].message.content;
    }

    return { output: output, rawResponse: _convertResponse(response) };
}
