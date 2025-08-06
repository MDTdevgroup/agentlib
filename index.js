import OpenAI from "openai";
import dotenv from 'dotenv';
import { PromptHandler, FilePath}  from "./prompts.js";

dotenv.config();


const promptHandler = new PromptHandler(new FilePath('test_prompt.yml'));

console.log(promptHandler.getAllPrompts())


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
