# AgentLib

A lightweight Node.js library for building AI agents with LLM providers and MCP (Model Context Protocol) server integration.

## Quick Start

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Add API keys**
   ```bash
   # Create .env file
   OPENAI_API_KEY=your_openai_key
   GEMINI_API_KEY=your_gemini_key
   ```

3. **Run examples**
   ```bash
   # Simple agent
   node examples/simpleAgent/index.js
   
   # MCP integration (browser automation, file ops, search)
   node examples/mcp-example/main.js
   ```

## Features

- **Multi-Provider LLM Support**: OpenAI, Gemini
- **MCP Integration**: Browser automation, filesystem, web search, memory
- **Tool Calling**: Native function execution with type safety
- **Structured Output**: Zod schema validation
- **Agent Orchestration**: Multi-step reasoning with tool use

## Basic Usage

```javascript
import { Agent } from './src/Agent.js';

// Simple agent
const agent = new Agent({ model: 'gpt-4o-mini' });
agent.addInput({ role: 'user', content: 'Hello!' });
const response = await agent.run();

// Agent with MCP servers (auto-installs packages)
const mcpAgent = new Agent({ 
  model: 'gpt-4o-mini', 
  enableMCP: true 
});

await mcpAgent.addMCPServer('filesystem', {
  type: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', process.cwd()]
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
import { z } from 'zod';

// Define schema with Zod
const ResponseSchema = z.object({
  answer: z.string(),
  confidence: z.number(),
  sources: z.array(z.string())
});

const agent = new Agent({
  model: 'gpt-4o-mini',
  outputSchema: ResponseSchema  // Pass Zod object directly
});

const result = await agent.run();

// Access structured data from the result
const text = result.output_text;    // Raw text response
```

**Key Points:**
- **Input/Output Schemas**: Pass Zod objects directly to `inputSchema`/`outputSchema`
- **Raw Text**: Access via `result.output_text` (when no schema)
- **Type Safety**: Automatic validation and TypeScript support
- **Model Support**: Works with `gpt-4o-mini` and `gpt-4o` models

## Examples

- **`examples/simpleAgent/`** - Basic agent usage
- **`examples/mcp-example/`** - Full MCP integration demo  
- **`examples/translatorExample/`** - Multi-agent orchestration
- **`examples/sqlAgent/`** - Database operations

## API Reference

### Agent
```javascript
const agent = new Agent({
  model: 'gpt-4o-mini',        // LLM model
  tools: [],                   // Native function tools
  enableMCP: true,             // Enable MCP servers
  inputSchema: zodSchema,      // Input validation (Zod object)
  outputSchema: zodSchema      // Output validation (Zod object)
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
- `usage` - Token consumption details
- `model` - The model used for the response
- `status` - Response status ("completed", "failed", etc.)


