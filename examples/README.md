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

## Running Examples with Optional Features

### 1. Multi-Agent Conversation
Uses Tier 1 dependencies (`openai`, `js-yaml`):
```bash
node --env-file=.env examples/multi_agent/index.js
```

### 2. A2A Demo (Agent-to-Agent)
A2A requires optional peer dependencies `@a2a-js/sdk` and `express`:
```bash
npm install @a2a-js/sdk express

# Start server in one terminal
node --env-file=.env examples/a2a_demo/server.js

# Run client in another terminal
node --env-file=.env examples/a2a_demo/client.js
```

### 3. SQL Agent with Telemetry
SQL prompt storage with OpenTelemetry requires `sqlite3` and `@opentelemetry/sdk-node` suite:
```bash
npm install sqlite3 @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-proto @opentelemetry/auto-instrumentations-node

node --env-file=.env examples/sqlAgent/index.js
```

### 4. Playwright MCP
Requires `@modelcontextprotocol/sdk` (Tier 1):
```bash
node --env-file=.env examples/playwright-mcp/index.js
```
