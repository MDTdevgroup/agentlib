# AgentLib Examples

This directory contains executable examples illustrating multi-agent workflows, tool calling, Model Context Protocol (MCP), Agent-to-Agent (A2A) protocol, structured output, and SQL database interactions.

## Environment Variables

AgentLib does not bundle or depend on `dotenv`. On Node 20.12+, you can load environment variables directly from your `.env` file using Node's built-in `--env-file` flag:

```bash
# Run from repository root
node --env-file=.env examples/multi_agent/index.js

# Or from within a subfolder
node --env-file=../../.env index.js
```

## Running Examples

If you are developing inside this repository, running `npm install` at the root installs all development dependencies needed for the examples. You can run any example immediately!

For an external project consuming `@peebles-group/agentlib-js`, install only the optional packages needed for the features you use.

### 1. Multi-Agent Conversation
Uses core dependencies (`openai`, `js-yaml`):
```bash
node --env-file=.env examples/multi_agent/index.js
```

### 2. A2A Demo (Agent-to-Agent)
A2A requires optional peer dependencies `@a2a-js/sdk` and `express`:
```bash
# In a consumer project:
npm install @a2a-js/sdk express

# Start server in one terminal
node --env-file=.env examples/a2a_demo/server.js

# Run client in another terminal
node --env-file=.env examples/a2a_demo/client.js
```

### 3. SQL Agent with Telemetry
SQL prompt storage and OpenTelemetry require `sqlite3`, `sqlite`, and the `@opentelemetry/sdk-node` suite:
```bash
# In a consumer project:
npm install sqlite3 sqlite @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-proto @opentelemetry/auto-instrumentations-node

# Run example:
node --env-file=.env examples/sqlAgent/index.js
```

### 4. Playwright MCP
Uses MCP with Playwright (via `npx @playwright/mcp`):
```bash
node --env-file=.env examples/playwright-mcp/index.js
```

### 5. RAG Example
Requires local or remote MongoDB and the `mongodb` driver:
```bash
# In a consumer project:
npm install mongodb

# Run example:
node --env-file=.env examples/rag-example/index.js
```
