# Agent-to-Agent (A2A) Protocol Integration

AgentLib provides native support for exposing agents as A2A servers and calling remote agents as standard tools.

---

## Installation

A2A requires optional peer dependencies. Install them only if you are using A2A features:

```bash
npm install @a2a-js/sdk express
```

---

## Exposing an Agent over A2A

Use `startA2AServer` to host an agent on an HTTP/JSON-RPC server conforming to the A2A specification:

```javascript
import { Agent, LLMService } from '@peebles-group/agentlib-js';
import { startA2AServer } from '@peebles-group/agentlib-js/a2a';

const llm = new LLMService({ provider: 'openai', apiKey: process.env.OPENAI_API_KEY });
const agent = new Agent(llm, { name: 'CalculatorAgent' });

// Start the server (returns the Node HTTP server instance)
const server = await startA2AServer(agent, {
    port: 4000,
    name: 'CalculatorAgent',
    baseUrl: 'http://localhost:4000'
});

console.log('A2A server listening on port 4000');
```

The server automatically exposes:
- **Agent Card**: `GET /a2a/agent-card.json`
- **JSON-RPC Endpoint**: `POST /a2a/jsonrpc`
- **REST Endpoint**: `POST /a2a/rest`

---

## Consuming a Remote Agent as a Tool

You can connect to a remote A2A agent and expose it as a local callable tool to another agent using `createRemoteAgentTool`:

```javascript
import { Agent, LLMService } from '@peebles-group/agentlib-js';
import { createRemoteAgentTool } from '@peebles-group/agentlib-js/a2a';

const remoteAgentTool = createRemoteAgentTool({
    name: 'remote_calculator',
    description: 'Executes mathematical computations on a remote calculator agent',
    url: 'http://localhost:4000/a2a/jsonrpc'
});

const orchestratorLlm = new LLMService({ provider: 'openai', apiKey: process.env.OPENAI_API_KEY });
const orchestratorAgent = new Agent(orchestratorLlm, {
    name: 'Orchestrator',
    tools: [remoteAgentTool]
});

const history = await orchestratorAgent.run({
    role: 'user',
    content: 'Calculate 42 * 108 using the calculator tool.'
});
```

---

## AgentExecutorAdapter

`AgentExecutorAdapter` is the underlying adapter that translates A2A `RequestContext` and `ExecutionEventBus` protocols into AgentLib's execution model.
