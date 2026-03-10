import { defaultOpenaiModel, defaultGeminiModel } from "./config.js";
import { ToolLoader } from "./ToolLoader.js";
import { v4 as uuidv4 } from 'uuid';
import EventEmitter from 'events';
import { DomainObservability } from "./utilities/observability.js";

/**
 * Represents an LLM-based agent capable of tool calling.
 */
export class Agent {
  /**
   * @param {object} llmService - The LLM service instance used for communication with the LLM provider.
   * @param {object} [options] - Configuration options for the agent.
   * @param {string} [options.name='agent'] - The name of the agent (for logging purposes).
   * @param {EventEmitter} [options.eventEmitter] - Optional event emitter for observability and tracing events (e.g., 'agent:start', 'tool:start').
   * @param {string} [options.model=defaultModel] - The specific model identifier to use (defaults to provider-specific default).
   * @param {ToolLoader} [options.toolLoader=null] - Optional ToolLoader instance.
   * @param {Array<object>} [options.tools=[]] - Array of native tool objects available to the agent.
   * @param {zod.ZodType|null} [options.inputSchema=null] - Zod schema for validating input messages added to the context.
   * @param {zod.ZodType|null} [options.outputSchema=null] - Zod schema for validating/structuring the expected final output.
   * @param {boolean} [options.enableMCP=false] - Whether to enable MCP (Model Context Protocol) support for remote tools.
   * @param {boolean} [options.redundantToolInfo=true] - Whether to explicitly inject tool descriptions into the system prompt (useful for some models).
   * @param {...*} [options] - Additional options passed directly to the LLM service configuration.
   */
  constructor(llmService, {
    name = 'agent',
    eventEmitter,
    logmode = 'none', // 'none', 'file', 'otel', 'console', or array of them.
    model = llmService.provider == 'openai' ? defaultOpenaiModel : defaultGeminiModel,
    toolLoader = null,
    inputSchema = null,
    outputSchema = null,
    enableMCP = false,
    redundantToolInfo = true,
    ...options } = {}) {

    this.name = name;
    this.sessionId = uuidv4();
    this.llmService = llmService;
    this.events = eventEmitter || new EventEmitter();
    this.model = model;
    this.toolLoader = toolLoader || new ToolLoader(enableMCP);
    this.inputSchema = inputSchema;
    this.outputSchema = outputSchema;
    this.redundantToolInfo = redundantToolInfo;
    this.additionalOptions = options;
    this.input = [];

    if (logmode !== 'none') {
      new DomainObservability(this.events, logmode);
    }

    if (this.redundantToolInfo) {
      this.updateSystemPrompt();
    }
  }

  /**
   * Updates the system prompt with descriptions of all currently available tools.
   */
  updateSystemPrompt() {
    const allTools = this.toolLoader.getTools();
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
   * Emits a tracing event if an event emitter is configured.
   * 
   * @param {string} eventName - The name of the event (e.g., 'agent:start', 'llm:start').
   * @param {object} details - The details of the trace event.
   * @param {string} details.traceId - A unique UUID for the entire execution trace.
   * @param {string} details.spanId - A unique UUID for this specific span/operation.
   * @param {string} [details.parentSpanId] - The UUID of the parent span (if this is a child operation).
   * @param {string} details.name - A human-readable name for the operation (e.g., "agent_run").
   * @param {object} [details.attributes] - specific metadata about the operation (e.g., model name, tool count).
   */
  _emitTrace(eventName, { traceId, spanId, parentSpanId, name, attributes }) {
    if (this.events) {
      this.events.emit(eventName, {
        traceId,
        spanId,
        parentSpanId,
        name,
        attributes,
        sessionId: this.sessionId
      });
    }
  }

  /**
   * Runs the agent for a single conversational turn, including tool use if necessary.
   * This method handles the multi-step reasoning: LLM -> Tool Execution -> LLM Final Response.
   * @returns {Promise<object>} The final response object from the LLM, including execution details.
   */
  async run() {
    try {
      // Generate a new trace ID and root span ID
      const traceId = this.name + "-" + uuidv4();
      const rootSpanId = this.name + "-" + uuidv4();
      const allTools = this.toolLoader.getTools() || [];
      const executed = [];

      // 1. EMIT: Agent start
      this._emitTrace('agent:start', {
        traceId,
        spanId: rootSpanId,
        name: "agent_run",
        attributes: {
          llm_provider: this.llmService.provider,
          input: this.input,
          input_length: this.input.length,
          model: this.model,
          tools_available: allTools.map(t => t.name),
          tool_count: allTools.length,
          mcp_enabled: this.mcpManager ? this.mcpManager.isEnabled() : false,
          mcp_servers: this.mcpManager ? this.mcpManager.getServerInfo() : {}
        }
      });

      // 2. EMIT: First LLM Call
      const llmSpanId1 = "llm_chat_initial-" + uuidv4();
      this._emitTrace('llm:start', {
        traceId,
        spanId: llmSpanId1,
        parentSpanId: rootSpanId,
        name: "llm_chat_initial",
        attributes: {
          llm_provider: this.llmService.provider,
          model: this.model,
          input: this.input,
          input_length: this.input.length,
          tools_available: allTools.map(t => t.name),
          tool_count: allTools.length,
        }
      });

      let response = await this.llmService.chat(this.input, {
        model: this.model,
        outputSchema: this.outputSchema,
        tools: allTools,
        ...this.additionalOptions
      });

      // 3. EMIT: First LLM Call Complete
      this._emitTrace('llm:complete', {
        traceId,
        spanId: llmSpanId1,
        parentSpanId: rootSpanId,
        name: "llm_chat_initial",
        attributes: {
          model: this.model,
          usage: response.rawResponse?.usage,
          response: response
        }
      });

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

          const tool = this.toolLoader.findTool(call.name);
          if (!tool || !tool.func) {
            throw new Error(`Tool ${call.name} not found or missing implementation.`);
          }

          // 4. EMIT: Tool Start
          const toolSpanId = "tool_call:" + call.name + "-" + uuidv4();
          this._emitTrace('tool:start', {
            traceId,
            spanId: toolSpanId,
            parentSpanId: rootSpanId,
            name: `tool_exec:${call.name}`,
            attributes: {
              tool_name: call.name,
              arguments: args,
            }
          });

          const result = await tool.func(args);

          // 5. EMIT: Tool Complete
          this._emitTrace('tool:complete', {
            traceId,
            spanId: toolSpanId,
            parentSpanId: rootSpanId,
            name: `tool_exec:${call.name}`,
            attributes: {
              tool_name: call.name,
              arguments: args,
              result_preview: JSON.stringify(result).slice(0, 100)
            }
          });

          this.input.push({
            name: call.name,       // Required for Gemini translation
            call_id: call.call_id, // Required for OpenAI translation
            type: "function_call_output",
            output: JSON.stringify(result),
          });
        }

        // 6. EMIT: Final LLM Call
        const llmSpanId2 = "llm_chat_final-" + uuidv4();
        this._emitTrace('llm:start', {
          traceId,
          spanId: llmSpanId2,
          parentSpanId: rootSpanId,
          name: "llm_chat_final",
          attributes: {
            llm_provider: this.llmService.provider,
            model: this.model,
            input: this.input,
            input_length: this.input.length,
            tools_available: allTools.map(t => t.name),
            tool_count: allTools.length,
          }
        });

        // Step 6: send updated input back to model for final response
        response = await this.llmService.chat(this.input, {
          tools: allTools,
          model: this.model,
          outputSchema: this.outputSchema,
          ...this.additionalOptions
        });

        // 7. EMIT: Final LLM Call Complete
        this._emitTrace('llm:complete', {
          traceId,
          spanId: llmSpanId2,
          parentSpanId: rootSpanId,
          name: "llm_chat_final",
          attributes: {
            llm_provider: this.llmService.provider,
            model: this.model,
            response: response,
            usage: response.rawResponse?.usage,
          }
        });
      }

      // 8. EMIT: Agent Complete
      this._emitTrace('agent:complete', {
        traceId,
        spanId: rootSpanId,
        name: "agent_run",
        attributes: {
          success: true,
          total_tools_executed: executed.length
        }
      });

      response.executed = executed;
      return response;
    } catch (error) {
      console.error('Error running agent:', error);
      throw error;
    }
  }
}