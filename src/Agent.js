import { defaultModel } from "./config.js";
import { ToolLoader } from "./ToolLoader.js";
import { PromptLoader } from "./prompt-loader/promptLoader.js";
import { fileURLToPath } from 'url';
import path, { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const promptLoader = await PromptLoader.create(path.join(__dirname, 'prompts', 'agentPrompts.yml'));

/**
 * Represents an LLM-based agent capable of tool calling.
 */
export class Agent {
  /**
   * @param {object} llmService - The LLM service used for communication with LLM client.
   * @param {object} [options] - Configuration options for the agent.
   * @param {string} [options.model=defaultModel] - The model identifier to use.
   * @param {ToolLoader} [options.toolLoader=null] - Optional ToolLoader instance.
   * @param {Array<object>} [options.tools=[]] - Array of native tools available to the agent.
   * @param {zod object|null} [options.inputSchema=null] - Zod schema for validating input messages.
   * @param {zod object|null} [options.outputSchema=null] - Zod schema for expected final output format.
   * @param {boolean} [options.enableMCP=false] - Whether to enable MCP (Model Context Protocol) usage.
   * @param {boolean} [options.redundantToolInfo=true] - Whether to include tool descriptions in the system prompt.
   * @param {object} [options...] - Additional options passed to the LLM service.
   */
  constructor(llmService, { model = defaultModel, toolLoader = null, inputSchema = null, outputSchema = null, enableMCP = false, redundantToolInfo = true, ...options } = {}) {
    this.llmService = llmService;
    this.model = model;
    this.toolLoader = toolLoader || new ToolLoader();
    this.inputSchema = inputSchema;
    this.outputSchema = outputSchema;
    this.redundantToolInfo = redundantToolInfo;
    this.additionalOptions = options;
    this.input = [];

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
      content: promptLoader.getPrompt('systemPrompt').format({ toolDescriptions })
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
    const allTools = this.toolLoader.getTools() || [];
    const executed = []

    let response = await this.llmService.chat(this.input, {
      model: this.model,
      outputSchema: this.outputSchema,
      tools: allTools,
      ...this.additionalOptions
    });

    const { output, rawResponse } = response;

    rawResponse.output.forEach(item => {
      if (item.type === "function_call") {
        const { parsed_arguments, ...rest } = item;
        const cleanedItem = { ...rest, arguments: JSON.stringify(item.arguments) };
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

        const result = await tool.func(args);

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
        ...this.additionalOptions
      });
    }
    response.executed = executed;
    return response;
  }
}