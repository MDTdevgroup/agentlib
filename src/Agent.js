import { defaultOpenaiModel, defaultGeminiModel } from "./config.js";
import { MCPManager } from "./mcp/MCPManager.js";
import { v4 as uuidv4 } from 'uuid';
import EventEmitter from 'events';

/**
 * Represents an LLM-based agent capable of tool calling.
 */
export class Agent {
  /**
   * @param {object} llmService - The LLM service used for communication with LLM client.
   * @param {object} [options] - Configuration options for the agent.
   * @param {string} [options.model] - The model identifier to use.
   * @param {Array<object>} [options.tools=[]] - Array of native tools available to the agent.
   * @param {zod object|null} [options.inputSchema=null] - Zod schema for validating input messages.
   * @param {zod object|null} [options.outputSchema=null] - Zod schema for expected final output format.
   * @param {boolean} [options.enableMCP=false] - Whether to enable MCP (Model Context Protocol) usage.
   * @param {boolean} [options.redundantToolInfo=true] - Whether to include tool descriptions in the system prompt.
   * @param {object} [options...] - Additional options passed to the LLM service.
   */
  constructor(llmService, { eventEmitter, model = llmService.provider === 'openai' ? defaultOpenaiModel : defaultGeminiModel, tools = [], inputSchema = null, outputSchema = null, enableMCP = false, redundantToolInfo = true, ...options } = {}) {
    this.llmService = llmService;
    this.events = eventEmitter;
    this.model = model;
    this.nativeTools = tools;
    this.inputSchema = inputSchema;
    this.outputSchema = outputSchema;
    this.mcpManager = enableMCP ? new MCPManager() : null;
    this.redundantToolInfo = redundantToolInfo;
    this.additionalOptions = options;
    this.input = [];

    if (this.redundantToolInfo) {
      this.updateSystemPrompt();
    }
  }

  /**
   * Adds a new MCP server for remote tool access.
   * @param {string} serverName - A unique name for the server.
   * @param {object} config - Configuration details for the MCP server connection.
   * @returns {Promise<object>} The result of adding the server.
   * @throws {Error} If MCP is not enabled.
   */
  async addMCPServer(serverName, config) {
    if (!this.mcpManager) {
      throw new Error("MCP is not enabled for this agent");
    }

    const result = await this.mcpManager.addServer(serverName, config);
    if (this.redundantToolInfo) {
      this.updateSystemPrompt();
    }
    return result;
  }

  /**
   * Removes an existing MCP server.
   * @param {string} serverName - The unique name of the server to remove.
   * @returns {Promise<boolean>} True if the server was successfully removed, false otherwise.
   */
  async removeMCPServer(serverName) {
    if (!this.mcpManager) return false;

    const result = await this.mcpManager.removeServer(serverName);
    if (result && this.redundantToolInfo) {
      this.updateSystemPrompt();
    }
    return result;
  }

  /**
   * Adds a native tool to the agent's array of tools.
   * @param {object} tool - The tool object.
   * @param {string} tool.name - The unique name of the tool.
   * @param {function} tool.func - The function to execute when the tool is called.
   * @param {string} [tool.description=''] - A description for the LLM on when to use the tool.
   * @returns {object} The added tool object.
   * @throws {Error} If the tool is invalid or a name collision occurs.
   */
  addTool(tool) {
    if (!tool || typeof tool !== 'object') {
      throw new Error('Invalid tool: expected an object');
    }

    const { name, func } = tool;
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error("Invalid tool: missing valid 'name' (string)");
    }
    if (typeof func !== 'function') {
      throw new Error("Invalid tool: missing 'func' (function)");
    }

    const nameExistsInNative = this.nativeTools.some(t => t && t.name === name);
    const nameExistsInMCP = this.mcpManager ? this.mcpManager.getAllTools().some(t => t && t.name === name) : false;
    if (nameExistsInNative || nameExistsInMCP) {
      throw new Error(`Tool with name '${name}' already exists`);
    }

    if (typeof tool.description !== 'string') {
      tool.description = '';
    }

    this.nativeTools.push(tool);
    if (this.redundantToolInfo) {
      this.updateSystemPrompt();
    }
    return tool;
  }

  /**
   * Retrieves all available tools, including native and MCP tools.
   * @returns {Array<object>} An array of all tools.
   */
  getAllTools() {
    const mcpTools = this.mcpManager ? this.mcpManager.getAllTools() : [];
    return [...this.nativeTools, ...mcpTools];
  }

  /**
   * Gets status information about the MCP manager.
   * @returns {object} Information about the MCP manager, or { enabled: false } if disabled.
   */
  getMCPInfo() {
    return this.mcpManager ? this.mcpManager.getServerInfo() : { enabled: false };
  }

  /**
   * Updates the system prompt with descriptions of all currently available tools.
   */
  updateSystemPrompt() {
    const allTools = this.getAllTools();
    const toolDescriptions = allTools.map(tool => `${tool.name}: ${tool.description}`).join('; ');
    this.input = [{
      role: 'system',
      content: `You are a tool-calling agent. You have access to the following tools: ${toolDescriptions}. 
      Use these tools to answer the user's questions.`
    }];
  }

  /**
   * Adds user instruction or assistant response to the current conversation history.
   * @param {object} input - The message object to add.
   */
  addInput(input) {
    if (this.inputSchema) {
      this.inputSchema.parse(input);
    }
    this.input.push(input);
  }

  /**
   * Runs the agent for a single conversational turn, including tool use if necessary.
   * This method handles the multi-step reasoning: LLM -> Tool Execution -> LLM Final Response.
   * @returns {Promise<object>} The final response object from the LLM, including execution details.
   */
  async run() {
    // 1. EMIT: Agent start
    const traceId = uuidv4();
    const rootSpanId = uuidv4();
    if (this.events) {
      this.events.emit('agent:start', {
        traceId,
        spanId: rootSpanId,
        name: "agent_run",
        attributes: {
          model: this.model,
          toolCount: this.getAllTools().length
        }
      });
    }

    const allTools = this.getAllTools();
    const executed = []

    // 2. EMIT: First LLM Call
    const llmSpanId1 = uuidv4();
    if (this.events) {
      this.events.emit('llm:start', {
        traceId,
        spanId: llmSpanId1,
        parentSpanId: rootSpanId,
        name: "llm_chat_initial",
        attributes: {
          input_length: this.input.length,
          tools_available: allTools.map(t => t.name),
          provider: this.llmService.provider,
          model: this.llmService.model
        }
      });
    }

    let response = await this.llmService.chat(this.input, {
      model: this.model,
      outputSchema: this.outputSchema,
      tools: allTools,
      ...this.additionalOptions
    });

    // --- NORMALIZE METRICS ---
    let normalizedUsage = {};
    const rawUsage = response.rawResponse?.usage;

    if (rawUsage) {
      if (rawUsage.input_tokens !== undefined) {
        // OpenAI Format
        normalizedUsage = {
          input_tokens: rawUsage.input_tokens,
          output_tokens: rawUsage.output_tokens,
          total_tokens: rawUsage.total_tokens
        };
      } else if (rawUsage.promptTokenCount !== undefined) {
        // Gemini Format
        normalizedUsage = {
          input_tokens: rawUsage.promptTokenCount,
          output_tokens: rawUsage.candidatesTokenCount,
          total_tokens: rawUsage.totalTokenCount
        };
      }
    }

    // 3. EMIT: First LLM Call Complete
    if (this.events) {
      this.events.emit('llm:complete', {
        traceId,
        spanId: llmSpanId1,
        parentSpanId: rootSpanId,
        name: "llm_chat_initial",
        attributes: {
          usage: normalizedUsage,
          model: this.model
        }
      });
    }

    const { output, rawResponse } = response;

    rawResponse.output.forEach(item => {
      if (item.type === "function_call") {
        const { parsed_arguments, ...rest } = item;
        const args = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments);
        const cleanedItem = { ...rest, arguments: args };
        this.addInput(cleanedItem);
      } else {
        this.addInput(item);
      }
    });

    const functionCalls = rawResponse.output.filter(item => item.type === "function_call");

    if (functionCalls.length > 0) {
      for (const call of functionCalls) {
        let args;
        args = JSON.parse(call.arguments);
        call.arguments = args
        executed.push(call)

        const tool = allTools.find(t => t.name === call.name);
        if (!tool || !tool.func) {
          throw new Error(`Tool ${call.name} not found or missing implementation.`);
        }

        // 4. EMIT: Tool Start
        const toolSpanId = uuidv4();
        if (this.events) {
          this.events.emit('tool:start', {
            traceId,
            spanId: toolSpanId,
            parentSpanId: rootSpanId,
            name: `tool_exec:${call.name}`,
            attributes: { arguments: args }
          });
        }

        const result = await tool.func(args);

        // 5. EMIT: Tool Complete
        if (this.events) {
          this.events.emit('tool:complete', {
            traceId,
            spanId: toolSpanId,
            parentSpanId: rootSpanId,
            name: `tool_exec:${call.name}`,
            attributes: { result_preview: JSON.stringify(result).slice(0, 100) }
          });
        }

        this.input.push({
          ...call,
          type: "function_call_output",
          output: JSON.stringify(result),
        });
      }

      // 6. EMIT: Final LLM Call
      const llmSpanId2 = uuidv4();
      if (this.events) {
        this.events.emit('llm:start', {
          traceId,
          spanId: llmSpanId2,
          parentSpanId: rootSpanId,
          name: "llm_chat_final",
          attributes: { input_length: this.input.length }
        });
      }

      // Step 6: send updated input back to model for final response
      response = await this.llmService.chat(this.input, {
        tools: allTools,
        model: this.model,
        outputSchema: this.outputSchema,
        ...this.additionalOptions
      });

      // 7. EMIT: Final LLM Call Complete
      if (this.events) {
        this.events.emit('llm:complete', {
          traceId,
          spanId: llmSpanId2,
          parentSpanId: rootSpanId,
          name: "llm_chat_final",
          attributes: { response_type: response.type }
        });
      }
    }

    response.executed = executed;
    return response;
  }

  /**
   * Performs cleanup operations, primarily closing MCP server connections.
   * @returns {Promise<void>}
   */
  async cleanup() {
    if (this.mcpManager) {
      await this.mcpManager.cleanup();
    }
  }
}