// import { LLMService } from '@peebles-group/agentlib-js';
import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });
import { GoogleGenAI, Type } from '@google/genai';
import fs from 'fs';

// Define a function that the model can call to control smart lights
const setLightValuesFunctionDeclaration = {
    name: 'set_light_values',
    description: 'Sets the brightness and color temperature of a light.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            brightness: {
                type: Type.NUMBER,
                description: 'Light level from 0 to 100. Zero is off and 100 is full brightness',
            },
            color_temp: {
                type: Type.STRING,
                enum: ['daylight', 'cool', 'warm'],
                description: 'Color temperature of the light fixture, which can be `daylight`, `cool` or `warm`.',
            },
        },
        required: ['brightness', 'color_temp'],
    },
};

/**

*   Set the brightness and color temperature of a room light. (mock API)
*   @param {number} brightness - Light level from 0 to 100. Zero is off and 100 is full brightness
*   @param {string} color_temp - Color temperature of the light fixture, which can be `daylight`, `cool` or `warm`.
*   @return {Object} A dictionary containing the set brightness and color temperature.
*/
function setLightValues(brightness, color_temp) {
    return {
        brightness: brightness,
        colorTemperature: color_temp
    };
}

// Generation config with function declaration
const config = {
    tools: [{
        functionDeclarations: [setLightValuesFunctionDeclaration]
    }]
};

// Configure the client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Define user prompt
const contents = [
    {
        role: 'user',
        parts: [{ text: 'Turn the lights down to a romantic level' }]
    }
];

// Send request with function declarations
const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: contents,
    config: config
});


// Extract tool call details
const tool_call = response.functionCalls[0]

let result;
if (tool_call.name === 'set_light_values') {
    result = setLightValues(tool_call.args.brightness, tool_call.args.color_temp);
}

// Create a function response part
const function_response_part = {
    name: tool_call.name,
    response: { result }
}

// Append function call and result of the function execution to contents
contents.push(response.candidates[0].content);
contents.push({ role: 'user', parts: [{ functionResponse: function_response_part }] });

contents.forEach((content) => {
    console.log(content)
})

// Get the final response from the model
const final_response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: contents,
    config: config
});


