import { defaultOpenaiModel, defaultGeminiModel } from "../config.js";

/**
 * The stateless engine. Responsible ONLY for communicating with the LLM.
 */
export class CoreAgent {
  /**
   * @param {object} llmService - The LLM service instance used for provider communication.
   * @param {object} [options={}] - Configuration options for the LLM (e.g. temperature, ).
   * @param {string} [options.model] - The specific LLM model identifier to use.
   * @param {zod.ZodType|null} [options.outputSchema=null] - Zod schema for enforcing structured JSON output.
   * @param {object} [options.additionalOptions={}] - Extra provider-specific configuration options.
   */
  constructor(llmService, options = {}) {
    this.llmService = llmService;
    this.model = options.model || (llmService.provider === 'openai' ? defaultOpenaiModel : defaultGeminiModel);
    this.outputSchema = options.outputSchema || null;
    this.additionalOptions = options.additionalOptions || {};
  }

  /**
   * Executes a single prompt payload against the LLM provider.
   * @param {Array<object>} messages - The array of message objects forming the current context.
   * @param {Array<object>} tools - The array of available tool definition objects.
   * @param {Function} tracer - The telemetry wrapper function injected by the orchestrator.
   * @returns {Promise<object>} The raw and processed response object from the LLM provider.
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