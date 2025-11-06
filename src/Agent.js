import { LLMService } from "./llmService.js";
import { defaultLLMService, defaultModel } from "./config.js";
import { MCPManager } from "./mcp/MCPManager.js";

export class Agent {
  constructor(llmService, {model = defaultModel, tools = [], inputSchema = null, outputSchema = null, enableMCP = false, redundantToolInfo = true, ...options} = {}) {
    this.llmService = llmService;
    this.model = model;
    this.nativeTools = tools;
    this.inputSchema = inputSchema;
    this.outputSchema = outputSchema;
    this.mcpManager = enableMCP ? new MCPManager() : null;
    if (redundantToolInfo) this.updateSystemPrompt();
  }

  async addMCPServer(serverName, config) {
    if (!this.mcpManager) {
      throw new Error("MCP is not enabled for this agent");
    } 

    const result = await this.mcpManager.addServer(serverName, config);
    if (redundantToolInfo)this.updateSystemPrompt();
    return result;
  }

  async removeMCPServer(serverName) {
    if (!this.mcpManager) return false;

    const result = await this.mcpManager.removeServer(serverName);
    if (result && redundantToolInfo) this.updateSystemPrompt();
    return result;
  }

  /**
   * Add a native tool at runtime
   * Expected shape: { name: string, description?: string, func: (args) => Promise<any> | any }
   */
  addTool(tool) {
    if (!tool || typeof tool !== 'object') {
      throw new Error("Invalid tool: expected an object");
    }
    const { name, func } = tool;
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error("Invalid tool: missing valid 'name' (string)");
    }
    if (typeof func !== 'function') {
      throw new Error("Invalid tool: missing 'func' (function)");
    }

    // Prevent name collisions across native and MCP tools
    const nameExistsInNative = this.nativeTools.some(t => t && t.name === name);
    const nameExistsInMCP = this.mcpManager ? this.mcpManager.getAllTools().some(t => t && t.name === name) : false;
    if (nameExistsInNative || nameExistsInMCP) {
      throw new Error(`Tool with name '${name}' already exists`);
    }

    if (typeof tool.description !== 'string') {
      tool.description = '';
    }

    this.nativeTools.push(tool);
    if (redundantToolInfo)this.updateSystemPrompt();
    return tool;
  }

  getAllTools() {
    const mcpTools = this.mcpManager ? this.mcpManager.getAllTools() : [];
    return [...this.nativeTools, ...mcpTools];
  }

  getMCPInfo() {
    return this.mcpManager ? this.mcpManager.getServerInfo() : { enabled: false };
  }

  // Mentioning the tools in the system prompt for maximum reliability; set redundantToolInfo to false to conserve these tokens
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
      ...options
    });

    const { output, rawResponse } = response;

    // Step 2: Clean and add the response to input history
    // Remove parsed_arguments (if it exists) from function calls before adding to history
    const cleanedOutput = rawResponse.output.map(item => {
      if (item.type === "function_call" && item.parsed_arguments) {
        const { parsed_arguments, ...cleanItem } = item;
        return cleanItem;
      }
      return item;
    });
      
    this.input = this.input.concat(cleanedOutput);

    // Step 3: collect all function calls
    const functionCalls = rawResponse.output.filter(item => item.type === "function_call");

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
    return response;
  }

  async cleanup() {
    if (this.mcpManager) {
      await this.mcpManager.cleanup();
    }
  }
}
