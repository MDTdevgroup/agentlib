import { GoogleGenAI } from "@google/genai";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getDefaultGeminiModel } from "../config.js";
import {
    getModelLimits as resolveModelLimits,
    getModelContextLimit as resolveModelContextLimit,
    registerModelLimit,
    saveModelLimitsToFile,
} from './model-limits.js';

export const defaultModel = getDefaultGeminiModel();

export function createClient(auth) {
    return new GoogleGenAI({ apiKey: auth.apiKey });
}

export function getModelContextLimit(model = defaultModel) {
    return resolveModelContextLimit('gemini', model);
}

export function getModelLimits(model = defaultModel) {
    return resolveModelLimits('gemini', model);
}

/**
 * Private method: Fetches model context limits dynamically from Google Gemini models API.
 * Updates in-memory registry and optionally persists to model-limits.json.
 *
 * @param {object} client - GoogleGenAI client instance
 * @param {object} [options={}]
 * @param {boolean} [options.updateFile=false] - Whether to write updated limits back to a file
 * @param {string} [options.filePath=null] - Target file path for persisting model limits
 * @returns {Promise<Record<string, { inputTokenLimit: number, outputTokenLimit: number }>>}
 */
export async function _fetchModelLimits(client, { updateFile = false, filePath = null } = {}) {
    const discovered = {};
    if (!client || !client.models) {
        return discovered;
    }

    try {
        let modelsList = [];
        if (typeof client.models.list === 'function') {
            const res = await client.models.list();
            // Handle async iterable or array responses
            if (res && typeof res[Symbol.asyncIterator] === 'function') {
                for await (const m of res) {
                    modelsList.push(m);
                }
            } else if (Array.isArray(res)) {
                modelsList = res;
            } else if (Array.isArray(res?.models)) {
                modelsList = res.models;
            }
        }

        for (const m of modelsList) {
            const rawName = m.name || m.id || '';
            const cleanName = rawName.replace(/^models\//, '');
            if (!cleanName) continue;

            const inputLimit = Number(m.inputTokenLimit) || 1048576;
            const outputLimit = Number(m.outputTokenLimit) || 8192;

            discovered[cleanName] = {
                inputTokenLimit: inputLimit,
                outputTokenLimit: outputLimit,
            };

            registerModelLimit('gemini', cleanName, {
                inputTokenLimit: inputLimit,
                outputTokenLimit: outputLimit,
            });
        }

        if (updateFile && filePath && Object.keys(discovered).length > 0) {
            await saveModelLimitsToFile(filePath);
        }
    } catch {
        // Fall back gracefully if listing models fails
    }

    return discovered;
}

export function isRetryable(error) {
    if (!error) return { retryable: false };

    const status = error.status || error.statusCode || error.response?.status;
    const message = error.message || '';

    // 400, 401, 403, 404: Fatal hard failures
    if (status === 400 || status === 401 || status === 403 || status === 404) {
        return { retryable: false };
    }

    // 429 Rate Limit or 5xx Server Error
    if (status === 429 || (status >= 500 && status <= 599)) {
        return { retryable: true };
    }

    // GoogleGenAI status text identifiers
    if (message.includes('RESOURCE_EXHAUSTED') || message.includes('UNAVAILABLE') || message.includes('DEADLINE_EXCEEDED')) {
        return { retryable: true };
    }

    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND' || error.name === 'AbortError') {
        return { retryable: true };
    }

    return { retryable: false };
}

function _convertInput(input) {
    if (!Array.isArray(input)) return { steps: [], system_instruction: undefined };
    const steps = [];
    const systemInstructions = [];
    const callIdToName = new Map();

    // First pass to map call IDs to names for tool responses
    for (const item of input) {
        if (item && (item.type === 'function_call' || item.type === 'tool_call') && (item.call_id || item.id) && item.name) {
            callIdToName.set(item.call_id || item.id, item.name);
        }
    }

    for (const object of input) {
        if (!object || typeof object !== 'object') continue;

        if (object.role === 'system') {
            const systemText = object.content !== undefined ? object.content : (object.text || '');
            if (systemText) {
                systemInstructions.push(typeof systemText === 'string' ? systemText : JSON.stringify(systemText));
            }
        } else if (object.type === 'function_call' || object.type === 'tool_call') {
            const callId = object.call_id || object.id;
            let args = object.args;
            if (args === undefined && object.arguments !== undefined) {
                args = typeof object.arguments === 'string' ? JSON.parse(object.arguments) : object.arguments;
            }
            const funcCall = {
                type: 'function_call',
                id: callId,
                name: object.name,
                arguments: args ?? {},
            };
            if (object.thoughtSignature || object.signature) {
                funcCall.signature = object.thoughtSignature || object.signature;
            }
            steps.push(funcCall);
        } else if (object.type === 'function_call_output' || object.type === 'function_result' || object.type === 'tool_result') {
            const callId = object.call_id || object.id;
            const toolName = object.name || (callId ? callIdToName.get(callId) : undefined) || 'function_call';
            let outputResult = object.output !== undefined ? object.output : (object.value !== undefined ? object.value : object.result);
            if (typeof outputResult === 'string') {
                try {
                    outputResult = JSON.parse(outputResult);
                } catch {
                    // keep as string
                }
            }

            const funcResponse = {
                type: 'function_result',
                call_id: callId,
                name: toolName,
                result: outputResult,
            };
            if (object.thoughtSignature || object.signature) {
                funcResponse.signature = object.thoughtSignature || object.signature;
            }
            steps.push(funcResponse);
        } else if (object.type === 'reasoning' || object.type === 'thought') {
            const thoughtText = object.summary || object.content || object.details || '';
            const thoughtStep = {
                type: 'thought',
                summary: [
                    {
                        type: 'text',
                        text: typeof thoughtText === 'string' ? thoughtText : JSON.stringify(thoughtText),
                    },
                ],
            };
            if (object.thoughtSignature || object.signature) {
                thoughtStep.signature = object.thoughtSignature || object.signature;
            }
            steps.push(thoughtStep);
        } else if (object.role === 'assistant' || object.role === 'model' || object.type === 'model_output') {
            let textContent = object.content !== undefined ? object.content : (object.text || '');
            if (object.speaker && typeof textContent === 'string' && !textContent.startsWith(`[${object.speaker}]:`)) {
                textContent = `[${object.speaker}]: ${textContent}`;
            }
            steps.push({
                type: 'model_output',
                content: [
                    {
                        type: 'text',
                        text: typeof textContent === 'string' ? textContent : JSON.stringify(textContent),
                    },
                ],
            });
        } else if (object.role === 'user' || object.type === 'user_input' || (!object.role && (object.content !== undefined || object.text !== undefined))) {
            let textContent = object.content !== undefined ? object.content : (object.text || '');
            if (object.speaker && typeof textContent === 'string' && !textContent.startsWith(`[${object.speaker}]:`)) {
                textContent = `[${object.speaker}]: ${textContent}`;
            }
            if (typeof textContent === 'string') {
                steps.push({
                    type: 'user_input',
                    content: [
                        {
                            type: 'text',
                            text: textContent,
                        },
                    ],
                });
            } else if (Array.isArray(object.content)) {
                const parts = [];
                for (const part of object.content) {
                    if (!part || typeof part !== 'object') continue;
                    if (part.type === 'input_image' && part.image_url) {
                        const [prefix, base64ImageFile] = part.image_url.split(",");
                        const mimeMatch = prefix.match(/:(.*?);/);
                        const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
                        parts.push({
                            type: 'image',
                            data: base64ImageFile || '',
                            mime_type: mimeType,
                        });
                    } else if (part.type === 'image_url' && part.image_url?.url) {
                        const [prefix, base64ImageFile] = part.image_url.url.split(",");
                        const mimeMatch = prefix.match(/:(.*?);/);
                        const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
                        parts.push({
                            type: 'image',
                            data: base64ImageFile || '',
                            mime_type: mimeType,
                        });
                    } else if (part.type === 'image') {
                        parts.push(part);
                    } else if (part.type === 'input_text' || part.type === 'text') {
                        parts.push({
                            type: 'text',
                            text: part.text || '',
                        });
                    }
                }
                if (parts.length > 0) {
                    steps.push({
                        type: 'user_input',
                        content: parts,
                    });
                }
            }
        }
    }

    const systemInstruction = systemInstructions.length > 0 ? systemInstructions.join('\n\n') : undefined;

    return {
        steps,
        system_instruction: systemInstruction,
    };
}

function _convertSteps(steps) {
    if (!Array.isArray(steps)) return [];
    const output = [];
    for (const step of steps) {
        if (!step || typeof step !== 'object') continue;
        if (step.type === 'function_call') {
            const callId = step.id || step.call_id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            const rawArgs = step.arguments ?? step.args;
            output.push({
                type: 'function_call',
                id: callId,
                call_id: callId,
                name: step.name,
                arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? {}),
                ...(step.signature ? { thoughtSignature: step.signature } : (step.thoughtSignature ? { thoughtSignature: step.thoughtSignature } : {})),
            });
        } else if (step.type === 'thought') {
            let text = '';
            if (Array.isArray(step.summary)) {
                text = step.summary.map(s => (typeof s === 'string' ? s : s.text || '')).filter(Boolean).join('\n');
            } else if (typeof step.summary === 'string') {
                text = step.summary;
            } else if (typeof step.content === 'string') {
                text = step.content;
            }
            output.push({
                type: 'reasoning',
                summary: text || undefined,
                content: text || '',
                ...(step.signature ? { thoughtSignature: step.signature } : (step.thoughtSignature ? { thoughtSignature: step.thoughtSignature } : {})),
            });
        } else if (step.type === 'model_output') {
            let text = '';
            if (Array.isArray(step.content)) {
                text = step.content.map(c => (typeof c === 'string' ? c : c.text || '')).filter(Boolean).join('\n');
            } else if (typeof step.content === 'string') {
                text = step.content;
            } else if (step.text !== undefined) {
                text = step.text;
            }
            output.push({
                type: 'message',
                role: 'assistant',
                content: text,
            });
        } else if (step.type === 'message' || step.type === 'reasoning') {
            output.push(step);
        }
    }
    return output;
}

export function toProvider(input) {
    return _convertInput(input);
}

export function fromProvider(rawResponse) {
    if (!rawResponse) {
        return [];
    }
    if (Array.isArray(rawResponse.output)) {
        return rawResponse.output;
    }
    if (Array.isArray(rawResponse.steps)) {
        return _convertSteps(rawResponse.steps);
    }
    return [];
}

export async function chat(client, input, { model = defaultModel, inputSchema, outputSchema, tools, signal, previousInteractionId, ...options } = {}) {
    if (inputSchema) {
        input = inputSchema.parse(input);
    }

    const formattedInput = _convertInput(input);

    let formattedTools = undefined;
    if (Array.isArray(tools) && tools.length > 0) {
        formattedTools = tools.map((tool) => {
            if (tool.type && tool.type !== 'function') {
                return tool;
            }
            if (tool.googleSearch || tool.type === 'googleSearch') {
                return { type: 'google_search' };
            }
            if (tool.codeExecution || tool.type === 'codeExecution') {
                return { type: 'code_execution' };
            }
            return {
                type: 'function',
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            };
        });
    }

    const payload = {
        model,
        input: formattedInput.steps,
        ...(formattedInput.system_instruction ? { system_instruction: formattedInput.system_instruction } : {}),
        ...(formattedTools && formattedTools.length > 0 ? { tools: formattedTools } : {}),
        ...(previousInteractionId ? { previous_interaction_id: previousInteractionId } : {}),
        ...options,
    };

    if (outputSchema) {
        payload.response_format = zodToJsonSchema(outputSchema);
    }

    const requestOptions = signal ? { fetchOptions: { signal } } : undefined;
    const response = await client.interactions.create(payload, requestOptions);

    const steps = response?.steps || [];
    const hasFunctionCall = steps.some(step => step.type === 'function_call');

    let output = null;
    if (!hasFunctionCall) {
        let text = '';
        for (const step of steps) {
            if (step.type === 'model_output' && Array.isArray(step.content)) {
                for (const part of step.content) {
                    if (part.type === 'text' && part.text) {
                        text += part.text;
                    }
                }
            }
        }
        if (!text && response?.text) {
            text = typeof response.text === 'function' ? response.text() : response.text;
        }
        if (outputSchema) {
            output = text ? outputSchema.parse(JSON.parse(text)) : null;
        } else {
            output = text || null;
        }
    }

    const convertedOutput = _convertSteps(steps);

    return {
        output,
        rawResponse: {
            output: convertedOutput,
            steps: response?.steps,
            model: response?.model || model,
            id: response?.id,
            usage: response?.usage,
            status: response?.status,
            originalFormat: response,
        },
    };
}