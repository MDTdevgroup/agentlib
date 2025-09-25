import LLMService from "./llmService.js";
import { zodTextFormat } from "openai/helpers/zod";
import { defaultModel } from "./config.js";

export class Agent {
  constructor({model = defaultModel, tools = [], inputSchema = null, outputSchema = null} = {}) {
    this.llmService = new LLMService('openai');
    this.model = model;
    this.tools = tools;
    // Mentioning the tools in the system prompt for maximum reliability
    this.input = [ {
      role: 'system',
      content:
        'You are a tool-calling agent. You have access to the following tools: ' +
        this.tools.map((tool) => `${tool.name}: ${tool.description}`).join('; ') +
        '. Use these tools to answer the user\'s questions.'
    }]; 
    this.inputSchema = inputSchema;
    this.outputSchema = outputSchema;
  }

  addInput(input) {
    if (this.inputSchema) {
      this.inputSchema.parse(input);
    }
    this.input.push(input);
  }

   /**
   * Run the agent for a single step
   */
  async run() {

    // Step 1: send input to model
    let response = await this.llmService.chat(
      this.input,
      {
        model: this.model,
        outputSchema: this.outputSchema,
        options: {
          tools: this.tools,
        }
      }
    );

     // Step 2: Add the response (including function calls) to input history
     this.input = this.input.concat(response.output);

     // Step 3: collect all function calls
     const functionCalls = response.output.filter(item => item.type === "function_call");

     if (functionCalls.length > 0) {
       for (const call of functionCalls) {
        let args;
        try {
          args = JSON.parse(call.arguments);
        } catch (err) {
          console.error("Failed to parse function call arguments:", call.arguments);
          continue;
        }

        const tool = this.tools.find(t => t.name === call.name);
        if (!tool || !tool.func) {
          throw new Error(`Tool ${call.name} not found or missing implementation.`);
        }

        // Step 4: execute the function
        const result = await tool.func(args);

        // Step 5: append function call output to input
        this.input.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result),
        });
      }

      // Step 6: send updated input back to model for final response
      response = await this.llmService.chat(this.input, {
        tools: this.tools,
        model: this.model,
        outputSchema: this.outputSchema,
      });
    }

    const output = { type: "response", content: response };
    return this.outputSchema ? this.outputSchema.parse(output) : output;
  }
}
