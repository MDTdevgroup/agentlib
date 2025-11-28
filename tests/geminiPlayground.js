// import { LLMService } from '@peebles-group/agentlib-js';
import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });
import { GoogleGenAI, Type } from '@google/genai';
import fs from 'fs';

// Configure the client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Define the function declaration for the model
const weatherFunctionDeclaration = {
    name: 'get_current_temperature',
    description: 'Gets the current temperature for a given location.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            location: {
                type: Type.STRING,
                description: 'The city name, e.g. San Francisco',
            },
        },
        required: ['location'],
    },
};

// Send request with function declarations
const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: "What's the temperature in London?",
    config: {
        tools: [{
            functionDeclarations: [weatherFunctionDeclaration]
        }],
    },
});

fs.writeFileSync('gemini_debug.json', JSON.stringify(response, null, 2));
console.log("Saved full response to gemini_debug.json");

// Check for function calls in the response
if (response.functionCalls && response.functionCalls.length > 0) {
    const functionCall = response.functionCalls[0]; // Assuming one function call
    console.log(`Function to call: ${functionCall.name}`);
    console.log(`Arguments: ${JSON.stringify(functionCall.args)}`);
    // In a real app, you would call your actual function here:
    // const result = await getCurrentTemperature(functionCall.args);
} else {
    console.log("No function call found in the response.");
    console.log(response.text);
}
