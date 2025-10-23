# AgentLib

A lightweight Node.js library for building AI agents with LLM providers and MCP (Model Context Protocol) server integration.

## Installation

```bash
npm install peebles-agentlib
```

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
   npm install peebles-agentlib dotenv
   ```

## Features

- **Multi-Provider LLM Support**: OpenAI, Gemini
- **MCP Integration**: Browser automation, filesystem, web search, memory
- **Tool Calling**: Native function execution with type safety
- **Structured Output**: Zod schema validation
- **Agent Orchestration**: Multi-step reasoning with tool use

## Basic Usage

```javascript
import { Agent } from 'peebles-agentlib';
import dotenv from 'dotenv';
dotenv.config();

// Simple agent
const agent = new Agent('openai', process.env.OPENAI_API_KEY, {
  model: 'gpt-4o-mini'
});
agent.addInput({ role: 'user', content: 'Hello!' });
const response = await agent.run();
console.log(response.output_text);

// Agent with MCP servers (auto-installs packages)
const mcpAgent = new Agent('openai', process.env.OPENAI_API_KEY, { 
  model: 'gpt-4o-mini', 
  enableMCP: true 
});

await mcpAgent.addMCPServer('browser', {
  type: 'stdio', 
  command: 'npx',
  args: ['@playwright/mcp@latest']
});
```

## Structured Outputs

AgentLib supports type-safe structured outputs using Zod schemas for reliable JSON responses.

```javascript
import { Agent } from 'peebles-agentlib';
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
import { Agent } from 'peebles-agentlib';

// Instead of (development only)
import { Agent } from './src/Agent.js';
```

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
import { Agent } from 'peebles-agentlib';

const agent = new Agent('openai', process.env.OPENAI_API_KEY, {
  model: 'gpt-4o-mini',
  tools: [],
  enableMCP: true,
  inputSchema: zodSchema,
  outputSchema: zodSchema
});
```

### LLM Providers
- **OpenAI**: `gpt-4o-mini`, `gpt-4o`, `gpt-3.5-turbo`
- **Gemini**: `gemini-2.5-flash-lite`

Input format follows OpenAI's message structure:
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
        type: 'function',
        description: 'Search the web for information',
        name: 'web_search',
        parameters: [Object],
        strict: true
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


