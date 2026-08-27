# Tool & Prompt Loaders

AgentLib provides dedicated loader utilities to manage agent capabilities and prompt templates cleanly.

---

## ToolLoader

`ToolLoader` manages the lifecycle, registry, validation, and retrieval of both native JavaScript tools and remote Model Context Protocol (MCP) tools.

### Initialization

```javascript
import { ToolLoader } from '@peebles-group/agentlib-js';

// With MCP disabled (default)
const toolLoader = new ToolLoader(false);

// With MCP support enabled
const mcpToolLoader = new ToolLoader(true);
```

### Adding Native Tools

A tool is a plain object defining `name`, `description`, `func`, and optional `parameters` schema:

```javascript
toolLoader.addTool({
    name: 'get_weather',
    description: 'Fetch current weather for a city',
    parameters: {
        type: 'object',
        properties: {
            city: { type: 'string' }
        },
        required: ['city']
    },
    func: async ({ city }) => {
        return { temperature: 72, condition: 'Sunny', city };
    }
});

// Or add multiple tools at once
toolLoader.addTools([tool1, tool2]);
```

### Adding MCP Servers

When MCP is enabled, you can connect external MCP servers over stdio, SSE, or streamable HTTP:

```javascript
await toolLoader.addMCPServer('filesystem', {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']
});

// Inspect connected MCP status
const info = toolLoader.getMCPInfo();
```

---

## PromptLoader & Prompt

`PromptLoader` loads structured prompt collections from multiple file formats and data stores, returning formatted `Prompt` template objects.

### Supported File & Store Types

- **YAML** (`.yaml`, `.yml`)
- **JSON** (`.json`)
- **SQLite Database** (`.db`, `.sqlite`)
- **Custom Text / Markdown** (`.txt`, `.md`)

### Loading Prompts

```javascript
import { PromptLoader } from '@peebles-group/agentlib-js';

// Load from a YAML file
const loader = await PromptLoader.create('./prompts.yml');

// Retrieve a Prompt template by key
const prompt = loader.getPrompt('greeting_instruction');

// Format template variables (default delimiters: {{variable}})
const formattedText = prompt.format({ name: 'Alice', role: 'Support Agent' });
```

### Custom Delimiters

You can specify custom variable delimiters:

```javascript
const loader = await PromptLoader.create('./prompts.json', {
    delimiterStart: '${',
    delimiterEnd: '}'
});
```
