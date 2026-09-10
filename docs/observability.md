# Observability & Tracing

AgentLib is completely silent by default (zero `stdout`/`stderr` side effects). All telemetry, tool lifecycle events, LLM retries, and runner steps are routed through an `EventEmitter`.

---

## DomainObservability

`DomainObservability` subscribes to an `EventEmitter` and dispatches traces across multiple handlers.

### Modes

- `'console'`: Prints human-friendly emojis and formatted traces to `console.log`.
- `'file'`: Writes structured JSON event logs to disk under `./traces/<traceId>/spans/`.
- `'otel'`: Dispatches OpenTelemetry spans to active tracers.

### Usage

```javascript
import { Agent, DomainObservability, LLMService } from '@peebles-group/agentlib-js';
import EventEmitter from 'node:events';

const events = new EventEmitter();

// Attach observability to the shared event bus
const observability = new DomainObservability(events, {
    mode: ['console', 'file'], // can pass single mode or array
    baseDir: './traces'
});

const llm = new LLMService({ provider: 'openai', apiKey: process.env.OPENAI_API_KEY });
const agent = new Agent(llm, {
    name: 'ResearchAgent',
    eventEmitter: events,
    logmode: 'none' // managed via DomainObservability instance
});

await agent.run({ role: 'user', content: 'Summarize quantum computing.' });
```

### Event Names & Lifecycle

| Event Prefix | Lifecycle Stages | Payload Description |
|---|---|---|
| `agent:*` | `start`, `complete`, `error` | Agent run input, model, tool list, and output |
| `tool:*` | `start`, `complete`, `error` | Tool name, arguments, execution duration, and results |
| `llm:*` | `start`, `complete`, `error`, `retry` | Provider name, model, token usage, and retry attempts |
| `agent_runner:*` | `start`, `complete`, `error` | Multi-agent macro turn steps and turn state |

---

## OpenTelemetry OTLP Exporter (`initTelemetry`)

To export OpenTelemetry traces to an OTLP collector (Jaeger, Honeycomb, Datadog), install the optional OpenTelemetry dependencies:

```bash
npm install @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-proto @opentelemetry/auto-instrumentations-node
```

Then initialize telemetry at your application entrypoint:

```javascript
import { initTelemetry } from '@peebles-group/agentlib-js/telemetry';

const sdk = await initTelemetry({
    serviceName: 'my-ai-service',
    exporterUrl: 'http://localhost:4318/v1/traces'
});

// Run your application...
```
