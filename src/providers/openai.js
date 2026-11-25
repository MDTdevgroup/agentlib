import OpenAI from 'openai';
import { zodTextFormat } from "openai/helpers/zod";
import { getDefaultOpenaiModel, getDefaultOpenaiDecisionModel } from "../config.js";
import {
    getModelLimits as resolveModelLimits,
    getModelContextLimit as resolveModelContextLimit,
} from './model-limits.js';

export const defaultModel = getDefaultOpenaiModel();
export const defaultDecisionModel = getDefaultOpenaiDecisionModel();

// Factory function to create client
export function createClient(auth) {
    return new OpenAI({ apiKey: auth.apiKey });
}

export function getModelContextLimit(model = defaultModel) {
    return resolveModelContextLimit('openai', model);
}

export function getModelLimits(model = defaultModel) {
    return resolveModelLimits('openai', model);
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
            let summary = item.summary;
            if (typeof summary === 'string') {
                summary = [{ type: 'summary_text', text: summary }];
            } else if (!Array.isArray(summary)) {
                summary = [];
            }
            let content = item.content;
            if (typeof content === 'string') {
                content = [{ type: 'reasoning_text', text: content }];
            } else if (!Array.isArray(content) && content !== undefined) {
                content = [];
            }

            const wireItem = {
                type: 'reasoning',
                summary,
            };
            if (item.id) wireItem.id = item.id;
            if (content !== undefined) wireItem.content = content;
            if (item.encrypted_content !== undefined) wireItem.encrypted_content = item.encrypted_content;
            if (item.status !== undefined) wireItem.status = item.status;
            return wireItem;
        }
        if (item.type === 'message' || item.role) {
            let content = item.content !== undefined ? item.content : (item.text || '');
            if (typeof content === 'string') {
                if (item.speaker && !content.startsWith(`[${item.speaker}]:`)) {
                    content = `[${item.speaker}]: ${content}`;
                }
            } else if (Array.isArray(content)) {
                content = content.map((part) => {
                    if (!part || typeof part !== 'object') return part;
                    if (part.type === 'input_image' || part.type === 'input_text' || part.type === 'input_file') {
                        return part;
                    }
                    if (part.type === 'image_url' && part.image_url) {
                        return {
                            type: 'input_image',
                            image_url: typeof part.image_url === 'string' ? part.image_url : part.image_url.url,
                        };
                    }
                    if (part.type === 'text') {
                        return {
                            type: 'input_text',
                            text: part.text || '',
                        };
                    }
                    return part;
                });
            }
            const wireItem = {
                type: 'message',
                role: item.role || 'user',
                content,
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
    const items = rawResponse.output.map((item) => {
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
            const reasoningItem = {
                type: 'reasoning',
                id: item.id,
                summary: item.summary ?? [],
                content: item.content ?? [],
            };
            if (item.encrypted_content !== undefined) reasoningItem.encrypted_content = item.encrypted_content;
            if (item.status !== undefined) reasoningItem.status = item.status;
            return reasoningItem;
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
    items.output = items;
    return items;
}

export async function chat(client, input, { model = defaultModel, inputSchema, outputSchema, tools, signal, ...options } = {}) {
    if (inputSchema) {
        input = inputSchema.parse(input);
    }

    let response, output;
    const convertedInput = toProvider(input);
    const requestOptions = signal ? { signal } : undefined;

    let formattedTools = undefined;
    if (Array.isArray(tools) && tools.length > 0) {
        formattedTools = tools.map((tool) => {
            if (tool.type && tool.type !== 'function') {
                const { source: _source, ...rest } = tool;
                return rest;
            }
            return {
                type: 'function',
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
                ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
            };
        });
    }

    const payload = {
        input: convertedInput,
        model,
        ...(formattedTools ? { tools: formattedTools } : {}),
        ...options,
    };

    if (outputSchema) {
        response = await client.responses.parse({
            ...payload,
            text: {
                format: zodTextFormat(outputSchema, "output")
            },
        }, requestOptions);
        output = response.output_parsed ?? null;
    } else {
        response = await client.responses.create(payload, requestOptions);
        output = response.output_text ?? null;
    }
    return { output: output, rawResponse: response };
}

function _normalizeDecisionPart(part, role = 'user') {
    if (!part || typeof part !== 'object') return part;
    if (
        part.type === 'input_text'
        || part.type === 'input_image'
        || part.type === 'input_json'
        || part.type === 'output_text'
        || part.type === 'refusal'
    ) {
        return part;
    }
    if (part.type === 'image_url' && part.image_url) {
        return {
            type: 'input_image',
            image_url: typeof part.image_url === 'string' ? part.image_url : part.image_url.url,
            ...(part.detail !== undefined ? { detail: part.detail } : {}),
            ...(part.prompt_cache_breakpoint !== undefined ? { prompt_cache_breakpoint: part.prompt_cache_breakpoint } : {}),
        };
    }
    if (part.type === 'text') {
        return {
            type: role === 'assistant' ? 'output_text' : 'input_text',
            text: part.text || '',
            ...(part.prompt_cache_breakpoint !== undefined ? { prompt_cache_breakpoint: part.prompt_cache_breakpoint } : {}),
        };
    }
    return part;
}

function _normalizeDecisionInput(input) {
    if (input === null || input === undefined) {
        throw new TypeError('Decision input is required.');
    }
    if (typeof input === 'string') {
        return input;
    }
    if (!Array.isArray(input)) {
        throw new TypeError('Decision input must be a string or an array of input items.');
    }

    const items = [];
    for (const item of input) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'reasoning') {
            continue;
        }
        if (item.type === 'function_call') {
            const wireItem = {
                type: 'function_call',
                call_id: item.call_id || item.id,
                name: item.name,
                arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
            };
            if (item.id !== undefined) wireItem.id = item.id;
            if (item.namespace !== undefined) wireItem.namespace = item.namespace;
            if (item.status !== undefined) wireItem.status = item.status;
            items.push(wireItem);
            continue;
        }
        if (item.type === 'function_call_output') {
            let out;
            if (Array.isArray(item.output)) {
                out = item.output.map(p => _normalizeDecisionPart(p, 'user'));
            } else if (typeof item.output === 'string') {
                out = item.output;
            } else {
                out = JSON.stringify(item.output ?? null);
            }
            const wireItem = {
                type: 'function_call_output',
                call_id: item.call_id || item.id,
                output: out,
            };
            if (item.id !== undefined) wireItem.id = item.id;
            if (item.status !== undefined) wireItem.status = item.status;
            items.push(wireItem);
            continue;
        }
        if (item.type === 'custom_tool_call') {
            const wireItem = {
                type: 'custom_tool_call',
                call_id: item.call_id || item.id,
                name: item.name,
                input: typeof item.input === 'string' ? item.input : JSON.stringify(item.input ?? ''),
            };
            if (item.id !== undefined) wireItem.id = item.id;
            if (item.namespace !== undefined) wireItem.namespace = item.namespace;
            if (item.status !== undefined) wireItem.status = item.status;
            items.push(wireItem);
            continue;
        }
        if (item.type === 'custom_tool_call_output') {
            let out;
            if (Array.isArray(item.output)) {
                out = item.output.map(p => _normalizeDecisionPart(p, 'user'));
            } else if (typeof item.output === 'string') {
                out = item.output;
            } else {
                out = JSON.stringify(item.output ?? null);
            }
            const wireItem = {
                type: 'custom_tool_call_output',
                call_id: item.call_id || item.id,
                output: out,
            };
            if (item.id !== undefined) wireItem.id = item.id;
            if (item.status !== undefined) wireItem.status = item.status;
            items.push(wireItem);
            continue;
        }
        if (item.type === 'message' || item.role) {
            const role = item.role || 'user';
            let content = item.content !== undefined ? item.content : (item.text || '');
            if (typeof content === 'string') {
                if (item.speaker && !content.startsWith(`[${item.speaker}]:`)) {
                    content = `[${item.speaker}]: ${content}`;
                }
            } else if (Array.isArray(content)) {
                content = content.map(part => _normalizeDecisionPart(part, role));
            }
            const wireItem = {
                type: 'message',
                role,
                content,
            };
            if (item.phase !== undefined) wireItem.phase = item.phase;
            items.push(wireItem);
            continue;
        }
        items.push(item);
    }

    return items;
}

function _normalizeDecisionQuestions(questions) {
    if (!Array.isArray(questions) || questions.length === 0) {
        throw new TypeError('Decision questions must be a non-empty array.');
    }

    return questions.map((question, index) => {
        if (!question || typeof question !== 'object') {
            throw new TypeError(`Decision question at index ${index} must be an object.`);
        }
        const { type, name, instructions, choices, levels } = question;
        if (type !== 'predicate' && type !== 'choice' && type !== 'score') {
            throw new Error(`Unsupported decision question type "${type}" at index ${index}. Expected "predicate", "choice", or "score".`);
        }
        if (typeof instructions !== 'string' && (!Array.isArray(instructions) || instructions.length === 0)) {
            throw new TypeError(`Decision question at index ${index} requires instructions as a string or non-empty array of content parts.`);
        }

        const normalizedInstructions = Array.isArray(instructions)
            ? instructions.map(part => _normalizeDecisionPart(part, 'user'))
            : instructions;

        const wireQuestion = {
            type,
            instructions: normalizedInstructions,
            ...(name !== undefined ? { name } : {}),
        };

        if (type === 'choice') {
            if (!Array.isArray(choices) || choices.length < 2) {
                throw new Error(`Choice question "${name ?? index}" requires at least 2 choices.`);
            }
            wireQuestion.choices = choices.map((c) => ({
                value: c.value,
                ...(c.description !== undefined ? { description: c.description } : {}),
            }));
        } else if (type === 'score') {
            if (!Array.isArray(levels) || levels.length < 2) {
                throw new Error(`Score question "${name ?? index}" requires at least 2 levels.`);
            }
            wireQuestion.levels = levels.map((lvl) => ({
                label: lvl.label,
                ...(lvl.description !== undefined ? { description: lvl.description } : {}),
            }));
        }

        return wireQuestion;
    });
}

export function toDecisionProvider(input, questions) {
    return {
        input: _normalizeDecisionInput(input),
        questions: _normalizeDecisionQuestions(questions),
    };
}

export function fromDecisionProvider(rawResponse, model = defaultDecisionModel) {
    return {
        answers: Array.isArray(rawResponse?.answers) ? rawResponse.answers : [],
        model: rawResponse?.model ?? model,
        usage: rawResponse?.usage ?? null,
        rawResponse: rawResponse ?? null,
    };
}

export async function decide(client, input, questions, { model = defaultDecisionModel, inputSchema, signal, ...options } = {}) {
    if (!client?.decisions || typeof client.decisions.create !== 'function') {
        throw new Error('OpenAI Decisions API requires openai >= 7.x with client.decisions.create support.');
    }

    if (inputSchema) {
        input = inputSchema.parse(input);
    }

    const { input: convertedInput, questions: convertedQuestions } = toDecisionProvider(input, questions);
    const requestOptions = signal ? { signal } : undefined;

    const payload = {
        model,
        input: convertedInput,
        questions: convertedQuestions,
        ...options,
    };

    const response = await client.decisions.create(payload, requestOptions);
    return fromDecisionProvider(response, model);
}