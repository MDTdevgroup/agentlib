import fs from 'node:fs/promises';
import path from 'node:path';
import EventEmitter from 'events';
import { trace, context } from '@opentelemetry/api';
import { v4 as uuidv4 } from 'uuid';

/**
 * @typedef {Object} SpanPayload
 * @property {string} traceId - The unique ID for the entire transaction/run.
 * @property {string} spanId - The unique ID for this specific operation.
 * @property {string} [parentSpanId] - The ID of the operation that triggered this one (optional for root).
 * @property {string} name - The human readable name of the operation (e.g., 'llm_chat').
 * @property {Record<string, any>} [attributes] - Metadata (tokens, model name, inputs).
 */

class FileHandler {
    constructor(baseDir) {
        this.baseDir = baseDir;
    }

    /**
     * Writes the event to a JSON file.
     * @param {SpanPayload} payload 
     */
    async handle(payload) {
        const { traceId, spanId, name } = payload;
        const traceDir = path.join(this.baseDir, traceId);
        const spansDir = path.join(traceDir, 'spans');

        await fs.mkdir(spansDir, { recursive: true });

        // Unique filename for every event to preserve history of start/complete
        const safeTime = new Date().toISOString().replace(/[:.]/g, '-'); // Replace colons and dots with dashes
        const filename = `${safeTime}_${name}_${spanId}.json`;
        const filePath = path.join(spansDir, filename);

        const data = {
            ...payload,
            timestamp: new Date().toISOString()
        };

        await fs.writeFile(filePath, JSON.stringify(data, null, 2));
    }
}

class OtelHandler {
    constructor() {
        // The scope name and version of Agentlib
        this.tracer = trace.getTracer('@peebles-group/agentlib-js', '2.0.0');
        this.activeSpans = new Map();
    }

    /**
     * Starts a new OpenTelemetry span.
     * @param {SpanPayload} payload 
     */
    async handleStart(payload) {
        const { spanId, parentSpanId, name, attributes } = payload;

        // 1. Resolve Parent Context
        let ctx = context.active();
        if (parentSpanId && this.activeSpans.has(parentSpanId)) {
            const parentSpan = this.activeSpans.get(parentSpanId);
            ctx = trace.setSpan(ctx, parentSpan);
        }

        // 2. Start Span
        const span = this.tracer.startSpan(name, { attributes }, ctx);

        // 3. Correlate with Agent IDs
        span.setAttribute('agent.trace_id', payload.traceId);
        span.setAttribute('agent.span_id', spanId);

        // 4. Store active span
        this.activeSpans.set(spanId, span);
    }

    /**
     * Ends an active OpenTelemetry span.
     * @param {SpanPayload} payload 
     */
    async handleComplete(payload) {
        const { spanId, attributes } = payload;

        // Retrieve the active span
        const span = this.activeSpans.get(spanId);
        if (!span) {
            // If we missed the start event or it wasn't tracked, we can't end it.
            return;
        }

        // Update attributes (e.g. usage stats, outputs)
        if (attributes) {
            span.setAttributes(attributes);
        }

        // End the span
        span.end();

        // Clean up map
        this.activeSpans.delete(spanId);
    }
}

class ConsoleHandler {
    /**
     * Logs events to the console.
     * @param {'start'|'complete'} eventType 
     * @param {SpanPayload} payload 
     */
    async handle(eventType, payload) {
        const { name, spanId, attributes, traceId } = payload;
        const time = new Date().toISOString();
        const symbol = eventType === 'start' ? '⏳' : '✅';

        console.log(`${symbol} [${time}] [${eventType.toUpperCase()}] ${name}`);
        console.log(`    Trace: ${traceId} | Span: ${spanId}`);

        if (attributes) {
            if (attributes.input) {
                // Show only a preview of large inputs
                const inp = JSON.stringify(attributes.input);
                console.log(`    Input: ${inp.length > 200 ? inp.slice(0, 200) + '...' : inp}`);
            }
            if (attributes.output) {
                const out = JSON.stringify(attributes.output);
                console.log(`    Output: ${out.length > 200 ? out.slice(0, 200) + '...' : out}`);
            }
            // Print other scalar attributes
            const plainAttrs = Object.entries(attributes)
                .filter(([k]) => k !== 'input' && k !== 'output' && k !== 'response');

            if (plainAttrs.length > 0) {
                console.log(`    Details:`, Object.fromEntries(plainAttrs));
            }
        }
        console.log(''); // newline
    }
}

export class DomainObservability {
    /**
     * Initializes the observability layer.
     * @param {EventEmitter} eventEmitter - The shared event bus.
     * @param {Object} options
     * @param {string|string[]} [options.mode='file'] - 'file', 'otel', 'console', or array of them.
     * @param {string} [options.baseDir='./traces'] - Directory for file traces.
     */
    constructor(eventEmitter, { mode = 'console', baseDir = './traces' } = {}) {
        this.handlers = [];
        let modes = Array.isArray(mode) ? mode : [mode];

        if (modes.includes('file')) {
            this.handlers.push(new FileHandler(baseDir));
        }

        if (modes.includes('otel')) {
            this.handlers.push(new OtelHandler());
        }

        if (modes.includes('console')) {
            this.handlers.push(new ConsoleHandler());
        }

        this.setupListeners(eventEmitter);
    }

    /**
     * Wires up the event listeners to the specific domain events.
     * @param {EventEmitter} emitter 
     */
    setupListeners(emitter) {
        // START events
        emitter.on('agent:start', (p) => this.dispatch('start', p));
        emitter.on('tool:start', (p) => this.dispatch('start', p));
        emitter.on('llm:start', (p) => this.dispatch('start', p));

        // COMPLETE events
        emitter.on('agent:complete', (p) => this.dispatch('complete', p));
        emitter.on('tool:complete', (p) => this.dispatch('complete', p));

        emitter.on('llm:complete', (p) => {
            if (p.attributes && p.attributes.usage) {
                p.attributes.usage = this.normalizeUsage(p.attributes.usage);
            }
            this.dispatch('complete', p);
        });
    }

    /**
     * Dispatches the event to all configured handlers.
     * @param {'start'|'complete'} eventType 
     * @param {SpanPayload} payload 
     */
    async dispatch(eventType, payload) {
        for (const handler of this.handlers) {
            try {
                if (handler instanceof OtelHandler) {
                    if (eventType === 'start') {
                        await handler.handleStart(payload);
                    } else {
                        await handler.handleComplete(payload);
                    }
                } else if (handler instanceof ConsoleHandler) {
                    await handler.handle(eventType, payload);
                } else {
                    // FileHandler treats everything as a discrete event log
                    await handler.handle(payload);
                }
            } catch (err) {
                console.error(`[Observability] Error in ${handler.constructor.name}:`, err);
            }
        }
    }

    /**
     * Normalizes token usage from different providers into a standard format.
     * @param {object} rawUsage - The raw usage object from the provider.
     * @returns {object} Normalized usage with input_tokens, output_tokens, and total_tokens.
     */
    normalizeUsage(rawUsage) {
        if (!rawUsage) return {};

        if (rawUsage.input_tokens !== undefined) {
            // OpenAI Format
            return {
                input_tokens: rawUsage.input_tokens,
                output_tokens: rawUsage.output_tokens,
                total_tokens: rawUsage.total_tokens
            };
        } else if (rawUsage.promptTokenCount !== undefined) {
            // Gemini Format
            return {
                input_tokens: rawUsage.promptTokenCount,
                output_tokens: rawUsage.candidatesTokenCount,
                total_tokens: rawUsage.totalTokenCount
            };
        }

        return rawUsage;
    }
}

/**
 * Creates a reusable tracer function that wraps operations and emits standardized telemetry.
 */
export const createTracer = (eventEmitter, sessionId) => {
    return async (name, attributes, fn) => {
        const spanId = uuidv4();

        eventEmitter.emit(`${name.split(':')[0]}:start`, {
            spanId,
            sessionId,
            name,
            attributes,
            timestamp: Date.now()
        });

        try {
            const result = await fn(spanId);

            eventEmitter.emit(`${name.split(':')[0]}:complete`, {
                spanId,
                sessionId,
                name,
                result: typeof result === 'object' ? { ...result, rawResponse: undefined } : result,
                timestamp: Date.now()
            });

            return result;
        } catch (error) {
            eventEmitter.emit(`${name.split(':')[0]}:error`, {
                spanId,
                sessionId,
                name,
                error: error.message
            });
            throw error;
        }
    };
};