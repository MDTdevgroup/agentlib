# AgentLib

A lightweight Node.js library for building immutable, functional AI agents with LLM providers, tool execution, and MCP (Model Context Protocol) integration.

## Installation

### Core Install (Default)
Gets you agents, tools, hosted providers (OpenAI, Gemini), vLLM, MCP, and YAML prompts:

```bash
npm install @peebles-group/agentlib-js
```

### Optional Features
Install optional peer dependencies only when you need specific peripheral features:

```bash
# Expose an agent over A2A (Agent-to-Agent protocol)
npm install @a2a-js/sdk express

# Load prompts from a SQLite prompt store
npm install sqlite3

# Structured outputs via Zod schemas
npm install zod zod-to-json-schema

# Export traces to an OTLP collector (Jaeger, Honeycomb, ...)
npm install @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-proto @opentelemetry/auto-instrumentations-node
```

## Quick Start

Run your scripts with Node 20.12+ built-in env support: `node --env-file=.env script.js`

### 1. Simple Agent

```javascript
import { Agent, LLMService } from '@peebles-group/agentlib-js';

const llm = new LLMService({ provider: 'openai', apiKey: process.env.OPENAI_API_KEY });
const agent = new Agent(llm, { model: 'gpt-4o-mini' });

agent.addInput({ role: 'user', content: 'What is 2+2?' });
const history = await agent.run();
const lastTurn = history[history.length - 1];

console.log(lastTurn.output);
```

### 2. Multi-Agent Runner

```javascript
import { Agent, AgentRunner, LLMService } from '@peebles-group/agentlib-js';

const llm = new LLMService({ provider: 'openai', apiKey: process.env.OPENAI_API_KEY });

const alice = new Agent(llm, { name: 'Alice' });
alice.addInput({ role: 'system', content: 'You are Alice.' });

const bob = new Agent(llm, { name: 'Bob' });
bob.addInput({ role: 'system', content: 'You are Bob.' });

const runner = new AgentRunner({ Alice: alice, Bob: bob });

// Runs until default turnStrategy is satisfied
const history = await runner.run({ role: 'user', content: 'Hello team!' });
```

### 3. Agent-to-Agent (A2A) Server

```javascript
import { Agent, LLMService } from '@peebles-group/agentlib-js';
import { startA2AServer } from '@peebles-group/agentlib-js/a2a';

const llm = new LLMService({ provider: 'openai', apiKey: process.env.OPENAI_API_KEY });
const agent = new Agent(llm);

await startA2AServer(agent, { port: 4000, name: 'CalculatorAgent' });
```

## Documentation

For detailed guides and API references, check the `docs/` folder:
- [LLM Service](./docs/llm-service.md)
- [Agent](./docs/agent.md)
- [Agent Runner](./docs/agent-runner.md)
- [Context & Compaction](./docs/context.md)
- [Tool & Prompt Loaders](./docs/loaders.md)
- [Agent-to-Agent (A2A) Integration](./docs/a2a.md)
- [Observability & Tracing](./docs/observability.md)
- [Migration Guide](./MIGRATION.md)