import LLMService from "./llmService.js";

export class Agent {
  constructor(model = 'gpt-4o-mini', tools = []) {
    this.llmService = new LLMService('openai');
    this.model = model;
    this.tools = tools;
    this.input = []; 
  }

  addInput(role, message) {   
    this.input.push({ role: role, content: message });
  }

  /**
   * Run the agent for a single step
   */
  async run() {
    
    const response = await this.llmService.chat(this.input, null, {
      tools: this.tools, 
      model: this.model
    });

    // Parse the response output array
    let responseOutput;
    try {
      responseOutput = JSON.parse(response);
    } catch (e) {
      // If not JSON, treat as text response
      return { type: "text", content: response };
    }

    // Save function call outputs for subsequent requests
    let functionCall = null;
    let functionCallArguments = null;
    this.input = this.input.concat(responseOutput.output);

    responseOutput.output.forEach((item) => {
      console.log("Processing output item:", item.type, item.name);
      if (item.type === "function_call") {
        functionCall = item;
        functionCallArguments = JSON.parse(item.arguments);
      }
    });

    console.log("Function call detected:", functionCall ? functionCall.name : "none");
    
    if (functionCall) {
      const toolName = functionCall.name;
      const tool = this.tools.find((t) => t.name === toolName);
      
      if (!tool || !tool.func) {
        throw new Error(`Tool ${toolName} not found or missing implementation.`);
      }

      // Execute the function
      const result = await tool.func(functionCallArguments);

      // Add function call output to input
      this.input.push({
        // role: "assistant",
        // content: `Called ${toolName}(${JSON.stringify(functionCallArguments)}) -> Result: ${JSON.stringify(result)}`
        type: "function_call_output",
        call_id: functionCall.call_id,
        output: JSON.stringify(result),
      });

      return { type: "function_call", tool: toolName, args: functionCallArguments, result: result };
    }

    // No function called, return the response
    return { type: "response", content: responseOutput };
  }
}
