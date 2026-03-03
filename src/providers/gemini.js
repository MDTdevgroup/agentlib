import { GoogleGenAI } from "@google/genai";
import { defaultGeminiModel } from "../config.js";
import { zodToJsonSchema } from "zod-to-json-schema";

export function createClient(apiKey) {
    return new GoogleGenAI({ apiKey });
}

function _convertInput(input) {
    const contents = [];
    const systemParts = [];
    for (const object of input) {
        if (object.role === 'user') {
            contents.push({
                role: "user",
                parts: [{ text: object.content }]
            })
        } else if (object.type === 'function_call') {
            contents.push({
                role: "model",
                parts: [{
                    functionCall: {
                        name: object.name,
                        args: object.args || (typeof object.arguments === 'string' ? JSON.parse(object.arguments) : object.arguments),
                    },
                    thoughtSignature: object.thoughtSignature
                }],
            })
        } else if (object.type === 'function_call_output') {
            contents.push({
                role: 'user',
                parts: [{ functionResponse: { name: object.name, response: { result: JSON.parse(object.output) } } }]
            })
        } else if (object.role === 'system') {
            systemParts.push({
                text: object.content
            })
        }
    }
    return {
        contents,
        systemParts
    }
}

function _convertCandidateParts(parts) {
    const output = [];
    for (const part of parts) {
        if (part.functionCall) {
            output.push({
                type: "function_call",
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args),
                thoughtSignature: part.thoughtSignature
            })
        }
        else {
            output.push({
                type: "message",
                content: {
                    text: part.text
                }
            })
        }
    }
    return output;
}

function _convertResponse(response, output) {
    return {
        output: output,
        rawResponse: {
            output: _convertCandidateParts(response.candidates[0].content.parts),
            model: response.modelVersion,
            id: response.responseId,
            usage: response.usageMetadata,
            originalFormat: response
        }
    };
}

/**
 * Determines whether a Gemini API error is retryable.
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

export async function chat(client, input, { inputSchema, outputSchema, tools, signal, ...options }) {
    try {
        let response, output;
        const formattedInput = _convertInput(input);
        const config = {
            abortSignal: signal,
            systemInstruction: {
                parts: formattedInput.systemParts || []
            },
            tools: tools ? [{
                functionDeclarations: tools.map(tool => ({
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                    func: tool.func
                }))
            }] : [],
            ...options
        }

        if (outputSchema) {
            response = await client.models.generateContent({
                model: defaultGeminiModel,
                contents: formattedInput.contents,
                config: {
                    ...config,
                    responseMimeType: "application/json",
                    responseJsonSchema: zodToJsonSchema(outputSchema),
                }
            });

            const candidates = response.candidates;
            const hasFunctionCall = candidates && candidates[0] && candidates[0].content && candidates[0].content.parts.some(p => p.functionCall);

            if (hasFunctionCall) {
                output = null;
            } else {
                const text = response.text ? (typeof response.text === 'function' ? response.text() : response.text) : null;
                output = text ? outputSchema.parse(JSON.parse(text)) : null;
            }
        } else {
            response = await client.models.generateContent({
                model: defaultGeminiModel,
                contents: formattedInput.contents,
                config: config,
            });
            output = response.text ? (typeof response.text === 'function' ? response.text() : response.text) : null;
        }
        return _convertResponse(response, output);
    } catch (error) {
        console.error(`Error during Gemini chat completion:`, error);
        throw error;
    }
}