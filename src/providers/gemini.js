import { GoogleGenAI } from "@google/genai";
import { defaultGeminiModel } from "../config.js";
import { zodToJsonSchema } from "zod-to-json-schema";

export function createClient(apiKey) {
    return new GoogleGenAI({ apiKey });
}

function _convertInput(input) {
    return {
        user: input.filter(object => object.role === 'user').map(object => ({
            role: "user",
            parts: [{ text: object.content }]
        })),
        system: input.filter(object => object.role === 'system').map(object => ({
            text: object.content
        })),
    };
}

function _convertCandidateParts(parts) {
    console.log(parts);
    const output = [];
    for (const part of parts) {
        if (part.functionCall) {
            output.push({
                type: "function_call",
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args)
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

export async function chat(client, input, { inputSchema, outputSchema, tools, ...options }) {
    try {
        let response, output;
        const formattedInput = _convertInput(input);
        const config = {
            systemInstruction: {
                parts: formattedInput.system || []
            },
            tools: [{
                functionDeclarations: tools.map(tool => ({
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                    func: tool.func
                }))
            }],
            ...options
        }

        if (outputSchema) {
            response = await client.responses.parse({
                model: defaultGeminiModel,
                contents: formattedInput.user,
                config: config.push({
                    responseMimeType: "application/json",
                    responseJsonSchema: zodToJsonSchema(outputSchema),
                })
            });
            output = outputSchema.parse(JSON.parse(response.text));
        } else {
            response = await client.models.generateContent({
                model: defaultGeminiModel,
                contents: formattedInput.user,
                config: config,
            });
            output = response.text;
        }
        return _convertResponse(response, output);
    } catch (error) {
        console.error(`Error during Gemini chat completion:`, error);
        throw error;
    }
}