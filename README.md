# AgentLib

A lightweight Node.js library for building immutable, functional AI agents with LLM providers and MCP (Model Context Protocol) server integration.

## Installation

```bash
npm install @peebles-group/agentlib-js
```

## Quick Start

### 1. Simple Agent

```javascript
import { Agent, LLMService } from '@peebles-group/agentlib-js';
import dotenv from 'dotenv';
dotenv.config();

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

## Documentation

For detailed guides and API references, check the `docs/` folder:
- [LLM Service](./docs/llm-service.md)
- [Agent](./docs/agent.md)
- [Agent Runner](./docs/agent-runner.md)
- [Context](./docs/context.md)