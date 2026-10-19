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

When MCP is enabled (`new ToolLoader(true)`), you can connect external MCP servers eagerly or register them lazily:

#### Eager Connection (`addMCPServer`)
```javascript
const toolLoader = new ToolLoader(true);

// Eagerly connects and indexes tools.
// By default, tool names are prefixed as `${serverName}_${toolName}` (e.g. `filesystem_read_file`).
await toolLoader.addMCPServer('filesystem', {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']
});

// To disable prefixing and preserve legacy raw names:
await toolLoader.addMCPServer('filesystem', serverConfig, { prefixToolNames: false });

// Inspect status
const info = toolLoader.getMCPInfo();

// Disconnect a server and remove its indexed tools
await toolLoader.removeMCPServer('filesystem');

// Clean up all MCP connections (local tools remain intact)
await toolLoader.cleanup();
```

If an MCP server returns tools that conflict with already registered local tools or existing MCP servers, `addMCPServer` automatically rolls back the server connection before throwing.

#### Lazy Server Registration (`registerMCPServer`)
For workflows where capabilities are optional and connecting at startup would pay unnecessary latency, register servers lazily:

```javascript
toolLoader.registerMCPServer('github', githubConfig, {
    description: 'GitHub operations: pull requests, issues, commits',
});
```

When lazy servers are registered, discovery meta-tools (`search_servers`, `enable_server`, `disable_server`) allow the model to discover and connect dormant servers on demand.

### MCP & A2A Name Scoping

When connecting multiple MCP servers or A2A peers, raw tool names frequently collide (for example, both a `github` server and a `jira` server exposing `search_issues` or `get_user`).

By default (`prefixToolNames: true`), `MCPToolSource` and `A2AToolSource` scope every remote tool name with its server/peer identifier:

1. **Default Qualification**: Tool names are formatted as `${serverName}_${rawToolName}` (e.g., `github_search_issues`, `filesystem_read_file`).
2. **64-Character Provider Limit**: Major LLM providers (including OpenAI and Anthropic) enforce a strict 64-character ceiling on function tool names. If a qualified name exceeds 64 characters, `agentlib` deterministically truncates it to `<first_55_chars>_<8_char_sha256_hash>` (64 characters total).
3. **Provenance Metadata (`declaration.source`)**: Every tool declaration carries a `source` descriptor so callers, search rankers, and telemetry can inspect its origin without parsing the name string:
   ```javascript
   {
       name: 'filesystem_read_file',
       description: 'Read a file from disk',
       parameters: { ... },
       source: {
           kind: 'mcp',              // 'local' | 'mcp' | 'a2a'
           serverName: 'filesystem', // Server or peer ID
           remoteName: 'read_file'   // Original unprefixed name on the remote server
       }
   }
   ```
4. **Dual Resolution on `invoke()`**: `MCPToolSource.invoke()` and `A2AToolSource.invoke()` accept both the qualified (or hash-truncated) tool name and the raw unprefixed name.
5. **Opting Out (`prefixToolNames: false`)**: For single-server setups or legacy compatibility where raw tool names must be preserved, pass `{ prefixToolNames: false }` to `addMCPServer`, `registerMCPServer`, `MCPToolSource`, or `createA2ASource`.

---

### The `ToolSource` Contract

`ToolLoader` is built on a uniform, 6-method capability interface called `ToolSource`. Local tools, MCP servers, and remote A2A agents are all implementations of this contract:

| Method | Signature | Description |
|---|---|---|
| `describe()` | `() => { id, kind, title, description, connected }` | Returns synchronous metadata identifying the source and its connection state. |
| `list()` | `async () => Array<Declaration>` | Connects if necessary and returns serializable tool declarations (never executable `func` closures). |
| `getDeclarations()` | `() => Array<Declaration>` | Synchronously returns cached tool declarations (or `[]` for unconnected lazy sources). |
| `invoke(name, args, context)` | `async (name, args, context) => any` | Executes a named tool on the source, forwarding `context.signal` (`AbortSignal`) for cancellation. |
| `connect()` | `async () => void` | Establishes the underlying transport session (no-op for in-process sources). |
| `close()` | `async () => void` | Tears down connections, child processes, or in-memory state cleanly. |

#### Built-in `ToolSource` Implementations

- **`LocalToolSource`**: In-process JavaScript tools registered via `defineTool` or `addTool`. Always connected.
- **`MCPToolSource`**: Wraps an MCP client session (`stdio` or `http`), translating MCP tool schemas into `agentlib` declarations with name scoping.
- **`A2AToolSource` (`createA2ASource`)**: Connects to a remote A2A agent, derives tool declarations from the peer's Agent Card `skills`, and polls/streams remote tasks to completion.

```javascript
import {
    ToolLoader,
    createA2ASource,
    assertToolSource,
} from '@peebles-group/agentlib-js';

const loader = new ToolLoader(true);

// Register a remote A2A peer as a lazy ToolSource
const researchPeer = createA2ASource('http://localhost:4000', {
    id: 'research_peer',
    lazy: true,
    description: 'Academic paper search and citation analysis specialist',
});

assertToolSource(researchPeer); // Validates all 6 contract methods
loader.addSource(researchPeer);
```

See [Tool Discovery & Code Mode (`docs/tool-discovery.md`)](tool-discovery.md) for how `ToolLoader` catalogs interact with progressive discovery, `facade` caching, and sandboxed script execution.

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
