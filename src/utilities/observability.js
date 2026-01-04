import fs from 'node:fs/promises';
import path from 'node:path';
import EventEmitter from 'events';

/**
 * @typedef {Object} SpanPayload
 * @property {string} traceId - The unique ID for the entire transaction/run.
 * @property {string} spanId - The unique ID for this specific operation.
 * @property {string} [parentSpanId] - The ID of the operation that triggered this one (optional for root).
 * @property {string} name - The human readable name of the operation (e.g., 'llm_chat').
 * @property {Record<string, any>} [attributes] - Metadata (tokens, model name, inputs).
 */
export class DomainObservability {
  /**
   * Initializes the observability layer.
   * @param {EventEmitter} eventEmitter - The shared event bus.
   * @param {string} baseDir - The root directory to store trace files.
   */
  constructor(eventEmitter, baseDir = './traces') {
    this.baseDir = baseDir;
    this.setupListeners(eventEmitter);
  }

  /**
   * Wires up the event listeners to the specific domain events.
   * @param {EventEmitter} emitter 
   */
  setupListeners(emitter) {
    // Existing listeners...
    emitter.on('agent:start', async (payload) => await this.writeSpan(payload));
    emitter.on('llm:start', async (payload) => await this.writeSpan(payload));
    emitter.on('llm:complete', async (payload) => await this.writeSpan(payload));

    // --- ADD THESE ---
    emitter.on('tool:start', async (payload) => {
      await this.writeSpan(payload);
    });

    emitter.on('tool:complete', async (payload) => {
      await this.writeSpan(payload);
    });

    // LISTENER 2: Handle LLM Start
    emitter.on('llm:start', async (payload) => {
      await this.writeSpan(payload);
    });

    // LISTENER 3: Handle LLM Completion
    emitter.on('llm:complete', async (payload) => {
      // TODO: normalize OpenAI/Gemini responses here before writing
      await this.writeSpan(payload);
    });
  }

  /**
   * Writes the span data to a JSON file on disk.
   * @param {SpanPayload} payload - The trace data to write.
   * @returns {Promise<void>}
   */
  async writeSpan({ traceId, spanId, parentSpanId, name, attributes }) {
    const traceDir = path.join(this.baseDir, traceId);
    const spansDir = path.join(traceDir, 'spans');

    // Ensure the directory exists
    await fs.mkdir(spansDir, { recursive: true });

    const filename = `${Date.now()}_${name}_${spanId}.json`;
    const filePath = path.join(spansDir, filename);

    const data = {
      traceId,
      spanId,
      parentSpanId,
      name,
      timestamp: new Date().toISOString(),
      attributes
    };

    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
  }
}