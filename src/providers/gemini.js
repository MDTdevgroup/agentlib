import { GoogleGenAI } from "@google/genai";
import { zodToJsonSchema } from "zod-to-json-schema";
import util from 'util';

export function createClient(auth) {
    return new GoogleGenAI({ apiKey: auth.apiKey });
}

function _convertInput(input) {
    const contents = [];
    const systemParts = [];
    for (const object of input) {
        if (object.role === 'user' && typeof object.content === 'string') {
            contents.push({
                role: object.role,
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
        } else if (Array.isArray(object.content)) {
            for (const part of object.content) {
                if (part.type === 'input_image') {
                    const [prefix, base64ImageFile] = part.image_url.split(",");
                    const mimeType = prefix.match(/:(.*?);/)[1]; // Extracts something like "image/jpeg"
                    contents.push({
                        role: "user",
                        parts: [{
                            inlineData: {
                                mimeType,
                                data: base64ImageFile
                            }
                        }]
                    });
                } else if (part.type === 'input_text') {
                    contents.push({
                        role: "user",
                        parts: [{ text: part.text }]
                    })
                }
            }
        }
    }

    if (contents.length === 0) {
        throw new Error("User prompt not detected, Gemini requires a user prompt.");
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
            // originalFormat: response
        }
    };
}

async function _applySemanticPruning(messages) {
    // TODO: Implement embedding-based cosine similarity filtering
    return messages;
}

export async function chat(client, input, { model = defaultGeminiModel, pruningOptions, inputSchema, outputSchema, tools, ...options }) {
    const originalWarn = console.warn;
    console.warn = (...args) => {
        if (typeof args[0] === 'string' && args[0].includes('there are non-text parts')) {
            return;
        }
        originalWarn(...args);
    };
    try {
        let response, output;

        if (pruningOptions?.enabled) {
            input = await _applySemanticPruning(input);
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
                    func: tool.func
                }))
            }] : []),
            ...nativeTools
        ];

        const config = {
            systemInstruction: {
                parts: formattedInput.systemParts || []
            },
            tools: toolsConfig,
            ...options
        }

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
                model,
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