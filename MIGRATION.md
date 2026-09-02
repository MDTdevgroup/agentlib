# Migration Guide: AgentLib 2.x to 4.0.0

AgentLib 4.0.0 is a major release focused on architectural hardening, abstraction barriers, zero runtime side effects, bounded execution costs, and modern modular packaging.

This guide details all breaking changes and provides step-by-step instructions for upgrading your applications.

---

## 1. Subpath Exports

In v2, internal files were sometimes imported via deep paths (such as `@peebles-group/agentlib-js/src/services/llm-service.js`). In 4.0.0, deep imports into `src/` are blocked in favor of standardized package entrypoints:

```javascript
// ✅ Core Library Entrypoint
import { Agent, AgentRunner, Context, LLMService, ToolLoader, PromptLoader } from '@peebles-group/agentlib-js';

// ✅ Agent-to-Agent (A2A) Protocol
import { startA2AServer, createRemoteAgentTool } from '@peebles-group/agentlib-js/a2a';

// ✅ OpenTelemetry Telemetry Bootstrap
import { initTelemetry } from '@peebles-group/agentlib-js/telemetry';
```

---

## 2. Optional Dependencies & Tiered Packaging

To keep the default install lightweight and eliminate platform-specific native binary compilation issues (e.g. SQLite), peripheral capabilities are now optional peer dependencies:

| Feature | Required Packages | Install Command |
|---|---|---|
| **A2A Server** | `@a2a-js/sdk`, `express` | `npm install @a2a-js/sdk express` |
| **SQLite Prompt Store** | `sqlite3` | `npm install sqlite3` |
| **Zod Schema Parsing** | `zod`, `zod-to-json-schema` | `npm install zod zod-to-json-schema` |
| **OTLP Trace Exporter** | `@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-proto`, `@opentelemetry/auto-instrumentations-node` | `npm install @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-proto @opentelemetry/auto-instrumentations-node` |

If you invoke a feature without its required package installed, AgentLib throws a structured `MissingDependency` exception specifying the exact install command.

---

## 3. `startA2AServer` is Now Asynchronous

Because `startA2AServer` lazily loads `@a2a-js/sdk` and `express` on demand, its signature is now `async`:

```javascript
// ❌ v2 (Synchronous)
// const server = startA2AServer(agent, { port: 4000 });

// ✅ v4.0.0 (Asynchronous)
import { startA2AServer } from '@peebles-group/agentlib-js/a2a';
const server = await startA2AServer(agent, { port: 4000 });
```

---

## 4. Non-Throwing Tool Errors & Step Limits

In v2, tool execution failures and step budget exhaustion threw unhandled exceptions that aborted the entire conversation.

In 4.0.0:
- **Tool Failures**: Invalid tool JSON arguments, missing tools, and tool exceptions are captured and fed back to the language model as structured tool results (`{ error: ... }`). This allows the LLM to self-correct, pick an alternative tool, or explain the issue to the user. To enforce immediate termination instead, pass `onToolError: 'throw'` to the `Agent` constructor.
- **Step Limits**: Reaching `maxToolCalls` or `maxTurns` returns a normal terminal turn object with `isDone: true` and `stopReason: 'step_limit'`.

```javascript
const turn = history[history.length - 1];
if (turn.isDone && turn.stopReason === 'step_limit') {
    console.log('Agent completed turn because step limit was reached.');
}
```

---

## 5. Opt-in Telemetry & Zero Stdout Pollution

- **Import Isolation**: Importing `@peebles-group/agentlib-js` no longer boots an OpenTelemetry agent across the process, nor does it monkey-patch Node built-ins (`http`, `fs`, `dns`).
- **Telemetry Bootstrap**: To export traces to an OTLP collector, explicitly call `await initTelemetry({ serviceName: '...' })`.
- **Zero Stdout**: All console logging across library internals has been eliminated. To view traces in the console or write trace files, configure `DomainObservability` with `{ mode: 'console' }` or `{ mode: 'file' }`.

---

## 6. Config Accessors Replace Bare Constants

Bare constants exported from `src/config.js` have been replaced with accessor functions:

```javascript
// ❌ v2
// import { defaultMaxToolCalls, defaultGeminiModel } from './src/config.js';

// ✅ v4.0.0
import { getDefaultMaxToolCalls, getDefaultGeminiModel, getDefaultModel } from './src/config.js';

const maxCalls = getDefaultMaxToolCalls(); // 15
const model = getDefaultModel('gemini');   // 'gemini-3-pro-preview'
```

---

## 7. Canonical Message Format & Selectors

Messages are managed through functional constructors and selectors in `src/memory/message.js`:
- `makeTextMessage({ role, text, speaker })`
- `makeToolCall({ id, name, args })`
- `makeToolResult({ callId, name, value })`
- `isToolCall(message)`, `toolCallName(message)`, `toolCallArgs(message)`, `messageText(message)`

All message objects created by these constructors are deeply frozen (`Object.freeze`), guaranteeing context immutability.

---

## 8. Structured Output Access

When using `outputSchema`, the parsed structured output is available directly via `response.output` or `turn.output`:

```javascript
// ❌ v2
// const result = turn.rawResponse.output_parsed;

// ✅ v4.0.0
const result = turn.output;
```

---

## 9. Context Compaction Strategies

To prevent quadratic token growth in long conversations, pluggable compaction strategies (`WindowCompactor`, `SummarizerCompactor`, `ProvenceCompactor`) are available:

```javascript
import { Agent } from '@peebles-group/agentlib-js';

const agent = new Agent(llm, {
    pruningStrategy: 'window',
    maxContextTokens: 8000,
    truncateToTokens: 6000,
});
```
Compactors only compact the payload sent to the LLM, preserving the full immutable history in `Context`.
