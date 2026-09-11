# Tool & Prompt Loaders

AgentLib provides dedicated utilities to manage agent capabilities and prompt templates cleanly.

---

## ToolLoader & Tool Authoring

`ToolLoader` is a **registry and lifecycle manager**. It manages registration, duplicate detection, constant-time $O(1)$ dispatch, and lifecycle for both local tools and remote Model Context Protocol (MCP) servers. The library deliberately avoids directory scanning, dynamic evaluation, or file-based tool discovery—standard Node imports and plain JavaScript functions provide code loading.

### Core Concepts

A tool in AgentLib cleanly separates three distinct concerns:

1. **Declaration (Representation)**: Serializable model-facing metadata (`name`, `description`, `parameters`). Sent to the LLM, prompt snippets, telemetry, and A2A cards. It contains **no executable code** (`func`).
2. **Implementation (Procedure)**: An executable async function following `(args, context) => Promise<any>`. Model-supplied `args` come from untrusted model input, while `context.signal` carries the run's `AbortSignal` for cooperative cancellation.
3. **Registration (Use)**: Registering the tool with a `ToolLoader` instance, which indexes tools for $O(1)$ dispatch by tool name.

### Authoring Tools with `defineTool`

Use `defineTool(declaration, implementation)` to bind a serializable declaration to an executable procedure:

```javascript
import { defineTool } from '@peebles-group/agentlib-js';

const getWeatherDeclaration = {
    type: 'function',
    name: 'get_weather',
    description: 'Get the current weather for a city',
    parameters: {
        type: 'object',
        properties: {
            city: { type: 'string', description: 'City name' }
        },
        required: ['city']
    }
};

async function getWeather(weatherClient, { city }, { signal } = {}) {
    return weatherClient.get(city, { signal });
}

// Inject dependencies via a factory function
export function createGetWeatherTool(weatherClient) {
    return defineTool(
        getWeatherDeclaration,
        (args, context) => getWeather(weatherClient, args, context)
    );
}
```

> [!TIP]
> **Keep Dependencies in Factory Parameters**: Never merge trusted dependencies and model arguments (e.g. `{ ...deps, ...args }`). An untrusted model output could supply a property name that collides with or overrides a trusted dependency. Always pass trusted clients and configuration through the factory scope.

### Optional Runtime Validation with `withValidation`

Provider JSON Schemas guide model output, but they do **not** form a security boundary. To validate or sanitize model arguments before execution without importing a heavy validator into the library core, wrap the handler with `withValidation(validateArgs, implementation)`:

```javascript
import { defineTool, withValidation } from '@peebles-group/agentlib-js';

function validateWeatherArgs(args) {
    if (!args || typeof args.city !== 'string' || !args.city.trim()) {
        throw new Error('Argument "city" must be a non-empty string');
    }
    // Return sanitized or coerced arguments (or return undefined for assertion-only)
    return { city: args.city.trim() };
}

export function createGetWeatherTool(weatherClient) {
    return defineTool(
        getWeatherDeclaration,
        withValidation(
            validateWeatherArgs,
            (args, context) => getWeather(weatherClient, args, context)
        )
    );
}
```

- `withValidation` supports both assertion-style validators (returning `void`) and parser/coercion libraries (such as Zod) that return transformed data.
- Validation failures are converted into a structured `Exception` with `type: 'ToolArgumentInvalid'`, preserving the original error in `cause`.
- The execution context (`{ signal }`) is forwarded untouched, ensuring query and network cancellation continues to work.

### Composing a Tool Catalog

Instead of dumping multiple tool implementations into one large file, create a module per tool and compose them in an explicit catalog:

```javascript
// tools/index.js
import { createGetWeatherTool } from './get-weather.js';
import { createFindCustomerTool } from './find-customer.js';

export function createTools(dependencies) {
    return [
        createGetWeatherTool(dependencies.weatherClient),
        createFindCustomerTool(dependencies.customerStore),
    ];
}
```

### Registry Operations (`ToolLoader`)

```javascript
import { ToolLoader } from '@peebles-group/agentlib-js';

// Initialize loader (pass true to enable MCP support)
const toolLoader = new ToolLoader(false);

// Register a single tool
toolLoader.addTool(weatherTool);

// Atomically register multiple tools (pre-validates the whole batch)
toolLoader.addTools([weatherTool, customerTool]);
```

- **Atomic Registration**: `addTools(tools)` pre-validates every record and name across both local and MCP tools. If any item is invalid or duplicated, none of the tools in the batch are registered.
- **`getToolDeclarations()`**: Returns serializable declarations (local first, then MCP) without `func`. Used by LLM providers, prompts, telemetry, and A2A.
- **`findTool(name)`**: Constant-time $O(1)$ dispatch by tool name with local-first precedence. Reconstructs the fused runtime record with callable `func`.
- **`getTools()`**: Compatibility method for callers that still need fused `{ ...declaration, func }` records. Rebuilds projections from normalized records.
- **Native Provider Tools**: Built-in model tools (such as `{ type: 'web_search' }`) can be registered directly with `addTool`. They have a declaration but no local `func`.

### Adding MCP Servers

When MCP is enabled (`new ToolLoader(true)`), you can connect external MCP servers:

```javascript
const toolLoader = new ToolLoader(true);

await toolLoader.addMCPServer('filesystem', {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']
});

// Inspect status
const info = toolLoader.getMCPInfo();

// Disconnect a server and remove its indexed tools
await toolLoader.removeMCPServer('filesystem');

// Clean up all MCP connections (local tools remain intact)
await toolLoader.cleanup();
```

If an MCP server returns tools that conflict with already registered local tools or existing MCP servers, `addMCPServer` automatically rolls back the server connection before throwing.

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
