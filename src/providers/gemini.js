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
 * Fetches model context limits dynamically from Google Gemini models API.
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

function _mergeConsecutiveRoles(contents) {
    const merged = [];
    for (const item of contents) {
        const last = merged[merged.length - 1];
        if (last && last.role === item.role) {
            last.parts.push(...item.parts);
        } else {
            merged.push({ role: item.role, parts: [...item.parts] });
        }
    }
    return merged;
}

function _convertInput(input) {
    if (!Array.isArray(input)) {
        throw new Error("User prompt not detected, Gemini requires a user prompt.");
    }

    const contents = [];
    const systemParts = [];
    const callIdToName = new Map();
    const callIdToSignature = new Map();

    for (const item of input) {
        if (!item || typeof item !== 'object') continue;
        const callId = item.call_id || item.id;
        const sig = item.thoughtSignature || item.thought_signature || item.signature;
        if (callId && sig) {
            callIdToSignature.set(callId, sig);
        }
        if ((item.type === 'function_call' || item.type === 'tool_call') && callId && item.name) {
            callIdToName.set(callId, item.name);
        }
    }

    for (const object of input) {
        if (!object || typeof object !== 'object') continue;

        if (object.role === 'system') {
            const systemText = object.content !== undefined ? object.content : (object.text || '');
            if (systemText) {
                systemParts.push({
                    text: typeof systemText === 'string' ? systemText : JSON.stringify(systemText),
                });
            }
        } else if (object.type === 'function_call' || object.type === 'tool_call') {
            let args = object.args;
            if (args === undefined && object.arguments !== undefined) {
                args = typeof object.arguments === 'string' ? JSON.parse(object.arguments) : object.arguments;
            }
            const callId = object.call_id || object.id;
            const part = {
                functionCall: {
                    name: object.name,
                    args: args ?? {},
                },
            };
            const sig = object.thoughtSignature
                || object.thought_signature
                || object.signature
                || (callId ? callIdToSignature.get(callId) : undefined);
            if (sig) {
                part.thoughtSignature = sig;
            }
            contents.push({
                role: 'model',
                parts: [part],
            });
        } else if (object.type === 'function_call_output' || object.type === 'function_result' || object.type === 'tool_result') {
            const callId = object.call_id || object.id;
            const toolName = object.name || (callId ? callIdToName.get(callId) : undefined) || 'function_call';
            let parsedResult;
            if (typeof object.output === 'string') {
                try {
                    parsedResult = JSON.parse(object.output);
                } catch {
                    parsedResult = object.output;
                }
            } else if (object.output !== undefined) {
                parsedResult = object.output;
            } else if (object.value !== undefined) {
                parsedResult = object.value;
            } else if (object.result !== undefined) {
                parsedResult = object.result;
            } else {
                parsedResult = null;
            }

            const part = {
                functionResponse: {
                    name: toolName,
                    response: { result: parsedResult },
                },
            };
            const sig = object.thoughtSignature
                || object.thought_signature
                || object.signature
                || (callId ? callIdToSignature.get(callId) : undefined);
            if (sig) {
                part.thoughtSignature = sig;
            }
            contents.push({
                role: 'user',
                parts: [part],
            });
        } else if (object.role === 'assistant' || object.role === 'model' || object.type === 'model_output') {
            let textContent = object.content !== undefined ? object.content : (object.text || '');
            if (object.speaker && typeof textContent === 'string' && !textContent.startsWith(`[${object.speaker}]:`)) {
                textContent = `[${object.speaker}]: ${textContent}`;
            }
            contents.push({
                role: 'model',
                parts: [{ text: typeof textContent === 'string' ? textContent : JSON.stringify(textContent) }],
            });
        } else if (object.role === 'user' || object.type === 'user_input' || (!object.role && (object.content !== undefined || object.text !== undefined))) {
            let textContent = object.content !== undefined ? object.content : (object.text || '');
            if (object.speaker && typeof textContent === 'string' && !textContent.startsWith(`[${object.speaker}]:`)) {
                textContent = `[${object.speaker}]: ${textContent}`;
            }

            if (typeof textContent === 'string') {
                contents.push({
                    role: 'user',
                    parts: [{ text: textContent }],
                });
            } else if (Array.isArray(object.content)) {
                const parts = [];
                for (const part of object.content) {
                    if (!part || typeof part !== 'object') continue;
                    if (part.type === 'input_image' && part.image_url) {
                        const [prefix, base64ImageFile] = part.image_url.split(',');
                        const mimeMatch = prefix.match(/:(.*?);/);
                        const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
                        parts.push({
                            inlineData: {
                                mimeType,
                                data: base64ImageFile || '',
                            },
                        });
                    } else if (part.type === 'image_url' && part.image_url) {
                        const urlStr = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
                        if (urlStr && urlStr.includes(',')) {
                            const [prefix, base64ImageFile] = urlStr.split(',');
                            const mimeMatch = prefix.match(/:(.*?);/);
                            const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
                            parts.push({
                                inlineData: {
                                    mimeType,
                                    data: base64ImageFile || '',
                                },
                            });
                        }
                    } else if (part.inlineData) {
                        parts.push(part);
                    } else if (part.type === 'input_text' || part.type === 'text') {
                        parts.push({ text: part.text || '' });
                    }
                }
                if (parts.length > 0) {
                    contents.push({
                        role: 'user',
                        parts,
                    });
                }
            }
        }
    }

    if (contents.length === 0) {
        throw new Error("User prompt not detected, Gemini requires a user prompt.");
    }

    return {
        contents: _mergeConsecutiveRoles(contents),
        systemParts,
    };
}

function _convertCandidateParts(parts) {
    if (!Array.isArray(parts)) return [];
    const output = [];
    for (const part of parts) {
        if (!part || typeof part !== 'object') continue;
        if (part.functionCall) {
            const callId = part.functionCall.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            output.push({
                type: "function_call",
                id: callId,
                call_id: callId,
                name: part.functionCall.name,
                arguments: typeof part.functionCall.args === 'string'
                    ? part.functionCall.args
                    : JSON.stringify(part.functionCall.args ?? {}),
                ...((part.thoughtSignature || part.thought_signature || part.signature) ? { thoughtSignature: part.thoughtSignature || part.thought_signature || part.signature } : {}),
            });
        } else if (part.thought) {
            output.push({
                type: "reasoning",
                summary: part.text || '',
                content: part.text || '',
                ...((part.thoughtSignature || part.thought_signature || part.signature) ? { thoughtSignature: part.thoughtSignature || part.thought_signature || part.signature } : {}),
            });
        } else if (part.text !== undefined) {
            output.push({
                type: "message",
                role: "assistant",
                content: {
                    text: part.text,
                },
                text: part.text,
            });
        }
    }
    return output;
}

function _convertResponse(response, output) {
    const candidateParts = response?.candidates?.[0]?.content?.parts || [];
    return {
        output: output,
        rawResponse: {
            output: _convertCandidateParts(candidateParts),
            model: response?.modelVersion || response?.model,
            id: response?.responseId || response?.id,
            usage: response?.usageMetadata || response?.usage,
            originalFormat: response,
        },
    };
}

function _extractText(response) {
    const parts = response?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
        const textParts = parts.filter(p => typeof p.text === 'string' && !p.thought);
        if (textParts.length > 0) {
            return textParts.map(p => p.text).join('');
        }
        return null;
    }
    if (response?.text) {
        return typeof response.text === 'function' ? response.text() : response.text;
    }
    return null;
}

async function _applySemanticPruning(messages) {
    // TODO: Implement embedding-based cosine similarity filtering
    return messages;
}

export function toProvider(input) {
    return _convertInput(input);
}

export function fromProvider(rawResponse) {
    if (!rawResponse) return [];
    if (Array.isArray(rawResponse.output)) {
        return rawResponse.output.map(item => {
            if (item.type === 'message') {
                const text = typeof item.content === 'string'
                    ? item.content
                    : (item.content?.text ?? item.text ?? '');
                return {
                    type: 'message',
                    role: item.role || 'assistant',
                    content: text,
                    text,
                };
            }
            if (item.type === 'function_call') {
                const callId = item.call_id || item.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
                const sig = item.thoughtSignature || item.thought_signature || item.signature;
                return {
                    type: 'function_call',
                    id: callId,
                    call_id: callId,
                    name: item.name,
                    arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
                    ...(sig ? { thoughtSignature: sig } : {}),
                };
            }
            if (item.type === 'reasoning') {
                const sig = item.thoughtSignature || item.thought_signature || item.signature;
                return {
                    type: 'reasoning',
                    summary: item.summary,
                    content: item.content,
                    ...(sig ? { thoughtSignature: sig } : {}),
                };
            }
            return item;
        });
    }
    if (Array.isArray(rawResponse.candidates?.[0]?.content?.parts)) {
        return _convertCandidateParts(rawResponse.candidates[0].content.parts);
    }
    return [];
}

export async function chat(client, input, { model = defaultModel, pruningOptions, inputSchema, outputSchema, tools, signal, ...options } = {}) {
    if (inputSchema) {
        input = inputSchema.parse(input);
    }

    try {
        let response, output;

        if (pruningOptions?.enabled) {
            input = await _applySemanticPruning(input);
        }

        const formattedInput = _convertInput(input);
        const customTools = tools ? tools.filter(t => t.name) : [];
        const nativeTools = tools ? tools.filter(t => !t.name) : [];

        const toolsConfig = [
            ...(customTools.length > 0 ? [{
                functionDeclarations: customTools.map(tool => {
                    const decl = {
                        name: tool.name,
                        description: tool.description,
                    };
                    if (tool.parametersJsonSchema) {
                        decl.parametersJsonSchema = tool.parametersJsonSchema;
                    } else if (tool.parameters) {
                        decl.parameters = tool.parameters;
                    }
                    return decl;
                }),
            }] : []),
            ...nativeTools,
        ];

        const config = {
            ...(formattedInput.systemParts.length > 0 ? {
                systemInstruction: {
                    parts: formattedInput.systemParts,
                },
            } : {}),
            ...(toolsConfig.length > 0 ? { tools: toolsConfig } : {}),
            ...(signal ? { abortSignal: signal } : {}),
            ...options,
        };

        if (outputSchema) {
            response = await client.models.generateContent({
                model,
                contents: formattedInput.contents,
                config: {
                    ...config,
                    responseMimeType: "application/json",
                    responseJsonSchema: zodToJsonSchema(outputSchema),
                },
            });

            const candidates = response.candidates;
            const hasFunctionCall = candidates && candidates[0] && candidates[0].content && candidates[0].content.parts && candidates[0].content.parts.some(p => p.functionCall);

            if (hasFunctionCall) {
                output = null;
            } else {
                const text = _extractText(response);
                output = text ? outputSchema.parse(JSON.parse(text)) : null;
            }
        } else {
            response = await client.models.generateContent({
                model,
                contents: formattedInput.contents,
                config: config,
            });
            output = _extractText(response);
        }
        return _convertResponse(response, output);
    } catch (error) {
        console.error(`Error during Gemini chat completion:`, error);
        throw error;
    }
}