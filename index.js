import OpenAI from "openai";
import dotenv from 'dotenv';
import loadYaml  from "./prompts.js";

dotenv.config();



let prompts = loadYaml('test_prompt.yml');
console.log(prompts.reply_node.prompt)


try {
    const client = new OpenAI();

    const response = await client.responses.create({
        model: "gpt-4.1",
        input: prompts.reply_node.prompt
    });
    
    console.log(response.output_text);
} catch (error) {
    console.error('Error sending message to ChatGPT:', error.response ? error.response.data : error.message);
}
