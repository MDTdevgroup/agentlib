import LLMService from "./llmService.js";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

export class Agent {
  constructor(model = 'gpt-4o-mini', tools = [], inputSchema = null, outputSchema = null) {
    this.llmService = new LLMService('openai');
    this.model = model;
    this.tools = tools;
    this.input = []; 
    this.inputSchema = inputSchema;
    this.outputSchema = outputSchema;
  }

  addInput(role, message) {
    const entry = { role, content: message };
    if (this.inputSchema) {
      this.inputSchema.parse(entry);
    }
    this.input.push(entry);
  }

  async run() {
    const response = await this.llmService.chat(
      this.input,
      this.outputSchema ? 'json_schema' : null,
      {
        tools: this.tools,
        model: this.model,
        parallel_tool_calls: false,
        text: {
          format: zodTextFormat(this.outputSchema, "output"),
        },
      }
    );

    let functionCall = null;
    let functionCallArguments = null;
    this.input = this.input.concat(response.output);

    response.output.forEach((item) => {
      if (item.type === "function_call") {
        functionCall = item;
        functionCallArguments = JSON.parse(item.arguments);
      }
    });
    
    if (functionCall) {
      const toolName = functionCall.name;
      const tool = this.tools.find((t) => t.name === toolName);
      if (!tool || !tool.func) {
        throw new Error(`Tool ${toolName} not found or missing implementation.`);
      }
      const parsedArgs = tool.schema ? tool.schema.parse(functionCallArguments) : functionCallArguments;
      const result = await tool.func(parsedArgs);
      this.input.push({
        type: "function_call_output",
        call_id: functionCall.call_id,
        output: JSON.stringify(result),
      });
      const output = { type: "function_call", tool: toolName, args: parsedArgs, result };
      return this.outputSchema ? this.outputSchema.parse(output) : output;
    }

    const output = { type: "response", content: response };
    return this.outputSchema ? this.outputSchema.parse(output) : output;
  }
}
