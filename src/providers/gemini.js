import { GoogleGenAI } from "@google/genai";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getDefaultGeminiModel } from "../config.js";

export const defaultModel = getDefaultGeminiModel();

export function createClient(auth) {
    return new GoogleGenAI({ apiKey: auth.apiKey });
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
    if (!Array.isArray(input)) return { contents: [], systemParts: [] };
    const contents = [];
    const systemParts = [];
    const callIdToName = new Map();

    // First pass to map call IDs to names for tool responses
    for (const item of input) {
        if (item && item.type === 'function_call' && (item.call_id || item.id) && item.name) {
            callIdToName.set(item.call_id || item.id, item.name);
        }
    }

    for (const object of input) {
        if (!object || typeof object !== 'object') continue;

        if (object.role === 'system') {
            const systemText = object.content !== undefined ? object.content : (object.text || '');
            if (systemText) {
                systemParts.push({ text: typeof systemText === 'string' ? systemText : JSON.stringify(systemText) });
            }
        } else if (object.type === 'function_call') {
            const callId = object.call_id || object.id;
            let args = object.args;
            if (args === undefined && object.arguments !== undefined) {
                args = typeof object.arguments === 'string' ? JSON.parse(object.arguments) : object.arguments;
            }
            const funcCall = {
                name: object.name,
                args: args ?? {},
            };
            if (callId) funcCall.id = callId;

            const part = { functionCall: funcCall };
            if (object.thoughtSignature) {
                part.thoughtSignature = object.thoughtSignature;
            }
            contents.push({
                role: "model",
                parts: [part],
            });
        } else if (object.type === 'function_call_output') {
            const callId = object.call_id || object.id;
            const toolName = object.name || (callId ? callIdToName.get(callId) : undefined) || 'function_call';
            let outputResult = object.output !== undefined ? object.output : object.value;
            if (typeof outputResult === 'string') {
                try {
                    outputResult = JSON.parse(outputResult);
                } catch {
                    // keep as string
                }
            }

            // Gemini functionResponse.response must be a JSON object
            const responseStruct = (outputResult !== null && typeof outputResult === 'object' && !Array.isArray(outputResult))
                ? outputResult
                : { result: outputResult };

            const funcResponse = {
                name: toolName,
                response: responseStruct,
            };
            if (callId) funcResponse.id = callId;

            contents.push({
                role: 'user',
                parts: [{ functionResponse: funcResponse }]
            });
        } else if (object.role === 'assistant' || object.role === 'model') {
            const textContent = object.content !== undefined ? object.content : (object.text || '');
            if (typeof textContent === 'string') {
                contents.push({
                    role: 'model',
                    parts: [{ text: textContent }]
                });
            }
        } else if (object.role === 'user' || (!object.role && (object.content !== undefined || object.text !== undefined))) {
            const textContent = object.content !== undefined ? object.content : (object.text || '');
            if (typeof textContent === 'string') {
                contents.push({
                    role: 'user',
                    parts: [{ text: textContent }]
                });
            } else if (Array.isArray(object.content)) {
                const parts = [];
                for (const part of object.content) {
                    if (part.type === 'input_image' && part.image_url) {
                        const [prefix, base64ImageFile] = part.image_url.split(",");
                        const mimeMatch = prefix.match(/:(.*?);/);
                        const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
                        parts.push({
                            inlineData: {
                                mimeType,
                                data: base64ImageFile || ''
                            }
                        });
                    } else if (part.type === 'image_url' && part.image_url?.url) {
                        const [prefix, base64ImageFile] = part.image_url.url.split(",");
                        const mimeMatch = prefix.match(/:(.*?);/);
                        const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
                        parts.push({
                            inlineData: {
                                mimeType,
                                data: base64ImageFile || ''
                            }
                        });
                    } else if (part.type === 'input_text' || part.type === 'text') {
                        parts.push({ text: part.text || '' });
                    }
                }
                if (parts.length > 0) {
                    contents.push({
                        role: "user",
                        parts
                    });
                }
            }
        }
    }

    return {
        contents,
        systemParts
    };
}

function _convertCandidateParts(parts) {
    if (!Array.isArray(parts)) return [];
    const output = [];
    for (const part of parts) {
        if (!part) continue;
        if (part.functionCall) {
            const callId = part.functionCall.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            const rawArgs = part.functionCall.args;
            output.push({
                type: "function_call",
                id: callId,
                call_id: callId,
                name: part.functionCall.name,
                arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? {}),
                ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {})
            });
        } else if (part.thought) {
            output.push({
                type: "reasoning",
                content: part.text || '',
                ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {})
            });
        } else if (part.text !== undefined) {
            output.push({
                type: "message",
                role: "assistant",
                content: part.text
            });
        }
    }
    return output;
}

function _convertResponse(response, output) {
    const candidate = response?.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    return {
        output: output,
        rawResponse: {
            output: _convertCandidateParts(parts),
            model: response?.modelVersion,
            id: response?.responseId,
            usage: response?.usageMetadata,
            promptFeedback: response?.promptFeedback,
            finishReason: candidate?.finishReason
        }
    };
}

export function toProvider(input) {
    return _convertInput(input);
}

export function fromProvider(rawResponse) {
    if (!rawResponse || !Array.isArray(rawResponse.output)) {
        return [];
    }
    return rawResponse.output;
}

export async function chat(client, input, { model = defaultModel, inputSchema, outputSchema, tools, ...options }) {
    let response, output;

    if (inputSchema) {
        input = inputSchema.parse(input);
    }

    const formattedInput = _convertInput(input);
    // Separate custom tools (name/description/parameters) from native Gemini tools (e.g. { googleSearch: {} })
    const customTools = tools ? tools.filter(t => t.name) : [];
    const nativeTools = tools ? tools.filter(t => !t.name) : [];

    const toolsConfig = [
        ...(customTools.length > 0 ? [{
            functionDeclarations: customTools.map(tool => ({
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            }))
        }] : []),
        ...nativeTools
    ];

    const config = {
        ...(formattedInput.systemParts && formattedInput.systemParts.length > 0 ? {
            systemInstruction: {
                parts: formattedInput.systemParts
            }
        } : {}),
        ...(toolsConfig.length > 0 ? { tools: toolsConfig } : {}),
        ...options
    };

    if (outputSchema) {
        response = await client.models.generateContent({
            model,
            contents: formattedInput.contents,
            config: {
                ...config,
                responseMimeType: "application/json",
                responseJsonSchema: zodToJsonSchema(outputSchema),
            }
        });

        const candidates = response?.candidates;
        const hasFunctionCall = candidates && candidates[0] && candidates[0].content && candidates[0].content.parts.some(p => p.functionCall);

        if (hasFunctionCall) {
            output = null;
        } else {
            const text = response?.text ? (typeof response.text === 'function' ? response.text() : response.text) : null;
            output = text ? outputSchema.parse(JSON.parse(text)) : null;
        }
    } else {
        response = await client.models.generateContent({
            model,
            contents: formattedInput.contents,
            config: config,
        });
        output = response?.text ? (typeof response.text === 'function' ? response.text() : response.text) : null;
    }
    return _convertResponse(response, output);
}