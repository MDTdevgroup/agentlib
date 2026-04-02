import { defaultOpenaiModel, defaultGeminiModel } from "./config.js";
import { ToolLoader } from "./ToolLoader.js";
import { v4 as uuidv4 } from 'uuid';
import EventEmitter from 'events';
import { DomainObservability } from "./utilities/observability.js";

/**
 * Represents an LLM-based agent capable of tool calling.
 */
export class CoreAgent {
  constructor(llmService, options = {}) {
    this.llmService = llmService;
    this.model = options.model || (llmService.provider === 'openai' ? defaultOpenaiModel : defaultGeminiModel);
    this.outputSchema = options.outputSchema || null;
    this.additionalOptions = options.additionalOptions || {};
  }

  /**
   * Executes a single prompt payload against the LLM.
   */
  async execute(messages, tools, tracer) {
    return await tracer('llm:chat', { 
      provider: this.llmService.provider,
      model: this.model, 
      input_length: messages.length,
      tool_count: tools.length 
    }, async () => {
      
      return await this.llmService.chat(messages, {
        model: this.model,
        outputSchema: this.outputSchema,
        tools: tools,
        ...this.additionalOptions
      });

    });
  }
}