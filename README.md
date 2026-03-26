# AgentLib

A lightweight Node.js library for building AI agents with LLM providers and MCP (Model Context Protocol) server integration.

## Installation

```bash
npm install @peebles-group/agentlib-js
```

## Testing

Run `npm test` to run the test script under `tests/test.js`.

## Quick Start

1. **Set up API keys**
   ```bash
   # Create .env file
   OPENAI_API_KEY=your_openai_key
   GEMINI_API_KEY=your_gemini_key
   ```

2. **Create a new project**
   ```bash
   mkdir my-agent-project
   cd my-agent-project
   npm init -y
   npm install @peebles-group/agentlib-js dotenv
   ```

## Features

- **Standardized API**: Uses OpenAI's message and response syntax across all LLM providers.
- **Multi-Provider LLM Support**: OpenAI, Gemini
- **MCP Integration**: Browser automation, filesystem, web search, memory
- **Tool Calling**: Native function execution with type safety
- **Structured Output**: Zod schema validation
- **Agent Orchestration**: Multi-step reasoning with tool use

## Basic Usage

```javascript
import { Agent, LLMService } from '@peebles-group/agentlib-js';
import dotenv from 'dotenv';
dotenv.config();

// Initialize LLM service
const llm = new LLMService('openai', process.env.OPENAI_API_KEY);

// Simple agent
const agent = new Agent(llm, {
  model: 'gpt-4o-mini'
});
agent.addInput({ role: 'user', content: 'Hello!' });
const response = await agent.run();
console.log(response.output_text);

// Agent with MCP servers (auto-installs packages)
const mcpAgent = new Agent(llm, { 
  model: 'gpt-4o-mini', 
  enableMCP: true 
});

await mcpAgent.addMCPServer('browser', {
  type: 'stdio', 
  command: 'npx',
  args: ['@playwright/mcp@latest']
});
```

## Prompt Management (Prompt Loader)

Manage prompts efficiently using the `PromptLoader`. Support for yml/db/md/json/txt files.

```javascript
import { PromptLoader } from '@peebles-group/agentlib-js';

// Load prompts from a file
const loader = await PromptLoader.create('./prompts.yml');

/*
prompts.yml

system_instruction: |
  Write an essay on {{topic}}.
  Make sure to make it {{depth}}.
*/

// Get and format a prompt
const prompt = loader.getPrompt('system_instruction').format({
  topic: 'AI Agents',
  depth: 'detailed'
});

agent.addInput({ role: 'user', content: prompt });

```

## Defining Custom Tools

When defining native tools to pass into the agent or `ToolLoader`, they must follow this generalized format. Note that the `type: "function"` field is required.

```javascript
const myTool = {
  type: "function",
  name: "tool_name",
  description: "Clear description of what the tool does and when to use it.",
  parameters: {
    type: "object",
    properties: {
      param1: { type: "string", description: "Description of the parameter" },
      param2: { type: "number" }
    },
    // Required parameters array
    required: ["param1"],
  },
  func: async (args) => {
    // The underlying implementation
    // 'args' will contain the parsed arguments provided by the LLM
    return `Executed with ${args.param1}`;
  },
};
```

## Structured Outputs

AgentLib supports type-safe structured outputs using Zod schemas for reliable JSON responses.

```javascript
import { Agent } from '@peebles-group/agentlib-js';
import { z } from 'zod';
import dotenv from 'dotenv';
dotenv.config();

// Define schema with Zod
const ResponseSchema = z.object({
  answer: z.string(),
  confidence: z.number(),
  sources: z.array(z.string())
});

const agent = new Agent('openai', process.env.OPENAI_API_KEY, {
  model: 'gpt-4o-mini',
  outputSchema: ResponseSchema  // Pass Zod object directly
});

agent.addInput({ role: 'user', content: 'What is the capital of France?' });
const result = await agent.run();

// Access structured data from the result
const parsedData = result.output_parsed;  // Structured data when schema is used
const text = result.output_text;          // Raw text response
```

**Key Points:**
- **Input/Output Schemas**: Pass Zod objects directly to `inputSchema`/`outputSchema`
- **Raw Text**: Access via `result.output_text` (when no schema)
- **Type Safety**: Automatic validation and TypeScript support
- **Model Support**: Works with `gpt-4o-mini` and `gpt-4o` models

## Examples

The repository includes several development examples that demonstrate different features:

- **`examples/simpleAgent/`** - Basic agent usage with tools
- **`examples/mcp-example/`** - Full MCP integration demo  
- **`examples/translatorExample/`** - Multi-agent orchestration
- **`examples/sqlAgent/`** - Database operations
- **`examples/schema-example/`** - Structured input/output with Zod schemas
- **`examples/rag-example/`** - Agentic RAG example with mongodb hybrid search

**Note:** These examples use relative imports for development. In your projects, use the npm package:

```javascript
// In your project
import { Agent } from '@peebles-group/agentlib-js';

// Instead of (development only)
import { Agent } from './src/Agent.js';
```

## Observability (OpenTelemetry)

AgentLib supports [OpenTelemetry](https://opentelemetry.io/) for deeply tracing agent execution flow. This allows you to visualize tool calls, LLM requests, and agent reasoning.

### Quick Start (Automatic Setup)
The easiest way to enable observability is to use the logmode option in the Agent constructor. This automatically initializes the necessary emitters and handlers.

```javascript
// Single mode
const agent = new Agent(llm, { logmode: 'console' });

// Multiple modes (Console + file tracing)
const agent = new Agent(llm, { 
  logmode: ['console', 'file'] 
});
```

### Manual Setup
Initialize the observability layer with `mode: 'otel'` (or `'both'` for files + traces).

```javascript
import { DomainObservability } from '@peebles-group/agentlib-js';
import EventEmitter from 'events';

const emitter = new EventEmitter();
// modes: 'file' (JSON logs), 'otel' (Trace spans), 'console' (Stdout), or array
new DomainObservability(emitter, { mode: ['console', 'otel'] });

// Pass the emitter to your Agent
const agent = new Agent(llmService, { eventEmitter: emitter, ... });
```

### 2. Configure Your App's Instrumentation
To send traces to a collector (like Jaeger), you need to configure the Node SDK with the OTLP exporter.

Create a file named `instrumentation.js`:
```javascript
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const sdk = new NodeSDK({
  // OTLP exporter points to http://localhost:4318/v1/traces by default
  traceExporter: new OTLPTraceExporter(),
  instrumentations: [getNodeAutoInstrumentations()],
  serviceName: 'my-agent-service',
});

sdk.start();
```

### 3. Example: Jaeger (Visualization Tool)
The easiest way to view traces is to run Jaeger via Docker. This will collect traces from your app and show them in a UI.

```bash
docker run --name jaeger \
  --restart=always \
  -e COLLECTOR_ZIPKIN_HOST_PORT=:9494 \
  -p 16686:16686 \
  -p 4317:4317 \
  -p 4318:4318 \
  -d jaegertracing/all-in-one:latest
```

### 4. View Traces
Open your browser to [http://localhost:16686](http://localhost:16686).
- Select `my-agent-service` from the Service dropdown.
- Click "Find Traces".
- Select a trace to view the full waterfall execution of your agent.

## API Reference

### Agent Constructor
```javascript
const agent = new Agent(provider, apiKey, options);
```

**Parameters:**
- `provider` (string): LLM provider name ('openai', 'gemini')
- `apiKey` (string): API key for the provider
- `options` (object): Configuration options
  - `model` (string): LLM model name (default: 'gpt-4o-mini')
  - `tools` (array): Native function tools
  - `enableMCP` (boolean): Enable MCP servers
  - `inputSchema` (Zod object): Input validation schema
  - `outputSchema` (Zod object): Output validation schema

**Example:**
```javascript
import { Agent } from '@peebles-group/agentlib-js';

const agent = new Agent('openai', process.env.OPENAI_API_KEY, {
  model: 'gpt-4o-mini',
  tools: [],
  enableMCP: true,
  inputSchema: zodSchema,
  outputSchema: zodSchema
});
```

### LLM Providers

**Standardized Syntax:** All inputs and outputs across all providers (including Gemini) strictly follow OpenAI's API structure (which are converted to Gemini's API structure internally). Input format follows OpenAI's message structure:
```javascript
[{ role: 'user', content: 'Hello' }]
```

### LLM Result Format

When calling an LLM, the result object has the following structure:

```javascript
{
  "id": "resp_67ccd2bed1ec8190b14f964abc0542670bb6a6b452d3795b",
  "object": "response",
  "created_at": 1741476542,
  "status": "completed",
  "error": null,
  "incomplete_details": null,
  "instructions": null,
  "max_output_tokens": null,
  "model": "gpt-4.1-2025-04-14",
  "output": [
    {
      "type": "message",
      "id": "msg_67ccd2bf17f0819081ff3bb2cf6508e60bb6a6b452d3795b",
      "status": "completed",
      "role": "assistant",
      "content": [
        {
          "type": "output_text",
          "text": "In a peaceful grove beneath a silver moon...",
          "annotations": []
        }
      ]
    },
    {
      id: 'fc_0c7a9f052c2a6aec0068fa6e20bca0819abbc24ec38aad74dc',
      type: 'function_call',
      status: 'completed',
      arguments: '{"element":"Our Menu","ref":"e222","doubleClick":false,"button":"left","modifiers":[]}',
      call_id: 'call_iBNFPVHDsSH1UUGUIUM5uvCE',
      name: 'browser_click'
    }
  ],
  "parallel_tool_calls": true,
  "previous_response_id": null,
  "reasoning": {
    "effort": null,
    "summary": null
  },
  "store": true,
  "temperature": 1.0,
  "text": {
    "format": {
      "type": "text"
    }
  },
  "tool_choice": "auto",
  "tools": [],
  "top_p": 1.0,
  "truncation": "disabled",
  "usage": {
    "input_tokens": 36,
    "input_tokens_details": {
      "cached_tokens": 0
    },
    "output_tokens": 87,
    "output_tokens_details": {
      "reasoning_tokens": 0
    },
    "total_tokens": 123
  },
  "user": null,
  "metadata": {}
}
```

**Key Fields:**
- `output_text` - The actual response text
- `output_parsed` - Response ONLY WHEN OUTPUT SCHEMA IS PRESENT
- `usage` - Token consumption details
- `model` - The model used for the response
- `status` - Response status ("completed", "failed", etc.)