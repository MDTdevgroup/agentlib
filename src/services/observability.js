import fs from 'node:fs/promises';
import path from 'node:path';
import { trace, context } from '@opentelemetry/api';
import { randomUUID } from 'node:crypto';

/**
 * @typedef {Object} SpanPayload
 * @property {string} traceId - The unique ID for the entire transaction/run.
 * @property {string} spanId - The unique ID for this specific operation.
 * @property {string} [parentSpanId] - The ID of the operation that triggered this one (optional for root).
 * @property {string} name - The human readable name of the operation (e.g., 'llm_chat').
 * @property {Record<string, any>} [attributes] - Metadata (tokens, model name, inputs).
 * @property {string} [error] - Error message if operation failed.
 */

class FileHandler {
    constructor(baseDir) {
        this.baseDir = baseDir;
    }

    /**
     * Writes the event to a JSON file, protecting against path traversal.
     * @param {SpanPayload} payload 
     */
    async handle(payload) {
        const { traceId, spanId, name, sessionId } = payload;
        const rawTraceId = traceId || sessionId || 'default-trace';

        // Sanitize identifiers to prevent directory traversal
        const safeTraceId = String(rawTraceId).replace(/[^a-zA-Z0-9_-]/g, '_');
        const safeSpanId = String(spanId || randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '_');
        const safeName = String(name || 'event').replace(/[^a-zA-Z0-9_-]/g, '_');

        const resolvedBase = path.resolve(this.baseDir);
        const traceDir = path.resolve(resolvedBase, safeTraceId);

        // Security assertion: trace directory must strictly reside within baseDir
        if (!traceDir.startsWith(resolvedBase)) {
            throw new Error('Invalid trace directory: path traversal detected');
        }

        const spansDir = path.join(traceDir, 'spans');
        await fs.mkdir(spansDir, { recursive: true });

        // Unique filename for every event to preserve history of start/complete/error
        const safeTime = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${safeTime}_${safeName}_${safeSpanId}.json`;
        const filePath = path.join(spansDir, filename);

        const data = {
            ...payload,
            traceId: safeTraceId,
            timestamp: new Date().toISOString()
        };

        await fs.writeFile(filePath, JSON.stringify(data, null, 2));
    }
}

class OtelHandler {
    constructor() {
        // The scope name and version of Agentlib
        this.tracer = trace.getTracer('@peebles-group/agentlib-js', '4.0.0');
        this.activeSpans = new Map();
    }

    /**
     * Starts a new OpenTelemetry span.
     * @param {SpanPayload} payload 
     */
    async handleStart(payload) {
        const { spanId, parentSpanId, name, attributes, traceId } = payload;

        // 1. Resolve Parent Context
        let ctx = context.active();
        if (parentSpanId && this.activeSpans.has(parentSpanId)) {
            const parentSpan = this.activeSpans.get(parentSpanId);
            ctx = trace.setSpan(ctx, parentSpan);
        }

        // 2. Start Span
        const span = this.tracer.startSpan(name, { attributes }, ctx);

        // 3. Correlate with Agent IDs
        span.setAttribute('agent.trace_id', traceId || payload.sessionId);
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

        const span = this.activeSpans.get(spanId);
        if (!span) {
            return;
        }

        if (attributes) {
            span.setAttributes(attributes);
        }

        span.end();
        this.activeSpans.delete(spanId);
    }

    /**
     * Records error details and ends an active OpenTelemetry span.
     * @param {SpanPayload} payload 
     */
    async handleError(payload) {
        const { spanId, error, attributes } = payload;

        const span = this.activeSpans.get(spanId);
        if (!span) {
            return;
        }

        if (attributes) {
            span.setAttributes(attributes);
        }

        if (error) {
            span.recordException(new Error(error));
            span.setStatus({ code: 2, message: String(error) }); // 2 = ERROR status
        }

        span.end();
        this.activeSpans.delete(spanId);
    }
}

class ConsoleHandler {
    /**
     * Logs events to the console when console mode is explicitly configured.
     * @param {'start'|'complete'|'error'} eventType 
     * @param {SpanPayload} payload 
     */
    async handle(eventType, payload) {
        const { name, spanId, attributes, traceId, sessionId, error } = payload;
        const time = new Date().toISOString();
        let symbol = '⏳';
        if (eventType === 'complete') symbol = '✅';
        if (eventType === 'error') symbol = '❌';

        const effectiveTraceId = traceId || sessionId || 'unknown';
        console.log(`${symbol} [${time}] [${eventType.toUpperCase()}] ${name}`);
        console.log(`    Trace: ${effectiveTraceId} | Span: ${spanId}`);

        if (error) {
            console.log(`    Error: ${error}`);
        }

        if (attributes) {
            if (attributes.input) {
                const inp = JSON.stringify(attributes.input);
                console.log(`    Input: ${inp.length > 200 ? inp.slice(0, 200) + '...' : inp}`);
            }
            if (attributes.output) {
                const out = JSON.stringify(attributes.output);
                console.log(`    Output: ${out.length > 200 ? out.slice(0, 200) + '...' : out}`);
            }
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
     * @param {string|string[]} [options.mode='console'] - 'file', 'otel', 'console', or array of them.
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
     * Wires up event listeners to standard domain events.
     * @param {EventEmitter} emitter 
     */
    setupListeners(emitter) {
        if (!emitter || typeof emitter.on !== 'function') return;

        // START events
        emitter.on('agent:start', (p) => this.dispatch('start', p));
        emitter.on('tool:start', (p) => this.dispatch('start', p));
        emitter.on('llm:start', (p) => this.dispatch('start', p));
        emitter.on('agent_runner:start', (p) => this.dispatch('start', p));

        // COMPLETE events
        emitter.on('agent:complete', (p) => this.dispatch('complete', p));
        emitter.on('tool:complete', (p) => this.dispatch('complete', p));
        emitter.on('agent_runner:complete', (p) => this.dispatch('complete', p));
        emitter.on('llm:complete', (p) => {
            if (p.attributes && p.attributes.usage) {
                p.attributes.usage = this.normalizeUsage(p.attributes.usage);
            }
            this.dispatch('complete', p);
        });

        // ERROR events
        emitter.on('agent:error', (p) => this.dispatch('error', p));
        emitter.on('tool:error', (p) => this.dispatch('error', p));
        emitter.on('llm:error', (p) => this.dispatch('error', p));
        emitter.on('agent_runner:error', (p) => this.dispatch('error', p));
    }

    /**
     * Dispatches the event to all configured handlers.
     * @param {'start'|'complete'|'error'} eventType 
     * @param {SpanPayload} payload 
     */
    async dispatch(eventType, payload) {
        for (const handler of this.handlers) {
            try {
                if (handler instanceof OtelHandler) {
                    if (eventType === 'start') {
                        await handler.handleStart(payload);
                    } else if (eventType === 'complete') {
                        await handler.handleComplete(payload);
                    } else if (eventType === 'error') {
                        await handler.handleError(payload);
                    }
                } else if (handler instanceof ConsoleHandler) {
                    await handler.handle(eventType, payload);
                } else {
                    // FileHandler processes discrete event payload
                    await handler.handle(payload);
                }
            } catch (_err) {
                // Keep observability safe without interrupting core application execution
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
 * @param {EventEmitter} eventEmitter - Event bus for emitting spans.
 * @param {string} sessionId - Unique session identifier.
 * @param {string} [traceId] - Optional transaction trace identifier.
 */
export const createTracer = (eventEmitter, sessionId, traceId = null) => {
    return async (name, attributes, fn) => {
        const spanId = randomUUID();
        const effectiveTraceId = traceId || sessionId || randomUUID();
        const prefix = name.split(':')[0];

        eventEmitter.emit(`${prefix}:start`, {
            traceId: effectiveTraceId,
            spanId,
            sessionId,
            name,
            attributes,
            timestamp: Date.now()
        });

        try {
            const result = await fn(spanId);

            eventEmitter.emit(`${prefix}:complete`, {
                traceId: effectiveTraceId,
                spanId,
                sessionId,
                name,
                result: typeof result === 'object' ? { ...result, rawResponse: undefined } : result,
                timestamp: Date.now()
            });

            return result;
        } catch (error) {
            eventEmitter.emit(`${prefix}:error`, {
                traceId: effectiveTraceId,
                spanId,
                sessionId,
                name,
                error: error.message,
                timestamp: Date.now()
            });
            throw error;
        }
    };
};