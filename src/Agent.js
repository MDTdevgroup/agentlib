import LLMService from "./llmService.js";
import { zodTextFormat } from "openai/helpers/zod";
import { defaultModel } from "./config.js";
import { MCPManager } from "./mcp/MCPManager.js";

export class Agent {
  constructor({model = defaultModel, tools = [], inputSchema = null, outputSchema = null, enableMCP = false} = {}) {
    this.llmService = new LLMService('openai');
    this.model = model;
    this.nativeTools = tools;
    this.inputSchema = inputSchema;
    this.outputSchema = outputSchema;
    this.mcpManager = enableMCP ? new MCPManager() : null;
    this.updateSystemPrompt();
  }

  async addMCPServer(serverName, config) {
    if (!this.mcpManager) {
      throw new Error("MCP is not enabled for this agent");
    }
    
    const result = await this.mcpManager.addServer(serverName, config);
    this.updateSystemPrompt();
    return result;
  }

  async removeMCPServer(serverName) {
    if (!this.mcpManager) return false;
    
    const result = await this.mcpManager.removeServer(serverName);
    if (result) this.updateSystemPrompt();
    return result;
  }

  getAllTools() {
    const mcpTools = this.mcpManager ? this.mcpManager.getAllTools() : [];
    return [...this.nativeTools, ...mcpTools];
  }

  getMCPInfo() {
    return this.mcpManager ? this.mcpManager.getServerInfo() : { enabled: false };
  }

  // Mentioning the tools in the system prompt for maximum reliability
  updateSystemPrompt() {
    const allTools = this.getAllTools();
    this.input = [{
      role: 'system',
      content: 'You are a tool-calling agent. You have access to the following tools: ' +
        allTools.map(tool => `${tool.name}: ${tool.description}`).join('; ') +
        '. Use these tools to answer the user\'s questions.'
    }];
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
    const allTools = this.getAllTools();

    // Step 1: send input to model
    let response = await this.llmService.chat(this.input, {
      model: this.model,
      outputSchema: this.outputSchema,
      tools: allTools,
    });

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

        const tool = allTools.find(t => t.name === call.name);
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
        tools: allTools,
        model: this.model,
        outputSchema: this.outputSchema,
      });
    }

    if (this.outputSchema) {
      try {
        this.outputSchema.parse(response.output_text);
      } catch (error) {
        if(error instanceof z.ZodError){
          console.error("Invalid output schema:", error.issues);
        }
      }
    }

    return response;
  }

  async cleanup() {
    if (this.mcpManager) {
      await this.mcpManager.cleanup();
    }
  }
}
