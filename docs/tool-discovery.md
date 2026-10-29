# Tool Discovery, Exposure Policies & Code Mode

When an agent connects to multiple Model Context Protocol (MCP) servers, A2A peers, or large local catalogs, eagerly serializing every tool JSON Schema into every LLM turn introduces three compounding costs:

1. **Context Overhead**: A typical MCP tool declaration spans $150\text{–}250$ tokens. Fifty tools consume $7{,}500\text{–}12{,}500$ tokens on every single turn before any conversation history or tool output is added.
2. **Selection Accuracy Degradation**: Tool-calling accuracy drops noticeably once a model must choose among more than $\sim 30\text{–}40$ overlapping schemas simultaneously.
3. **Round-Trip Amplification**: Standard JSON tool calling requires a full LLM round-trip for every sequential step, re-billing the entire conversation prefix on each turn.

`agentlib` solves this through **Exposure Policies** and **Code Mode**, separating the full registered catalog (`ToolLoader`) from the wire declarations sent to the provider on any single turn.

---

## 1. Exposure Policies

An exposure policy is a pure transformation:

```javascript
// (catalog, exposureState, context) => Promise<{ declarations, metaTools, resolve, nextState }>
```

Configure the policy on `Agent` via `toolExposure` (or globally via `AGENTLIB_TOOL_EXPOSURE`):

| Policy | `toolExposure` Value | Wire Declarations Sent per Turn | Best For |
|---|---|---|---|
| **Eager (`exposeAll`)** | `'all'` (default) | Full catalog of registered function and native tools. | Small catalogs ($\le 20$ tools) with low schema token footprints. |
| **Progressive (`exposeProgressive`)** | `'progressive'` | Discovery meta-tools (`search_tools`, `get_tool_details`, and `call_tool` in `facade` mode) + previously discovered tools (in `expand` mode). | Large MCP/A2A catalogs where only a few tools are needed per task. |
| **Auto (`exposeAuto`)** | `'auto'` | Runs `'all'` when catalog tokens $\le$ threshold; switches automatically to `'progressive'` when catalog tokens $>$ threshold. | Dynamic environments (e.g., connecting variable MCP servers like Playwright or GitHub). |

Any exposure policy can be combined with **Code Mode (`codeMode: true`)**, which adds the `run_tool_script` meta-tool so the model can write and execute multi-step JavaScript tool scripts inside a sandbox.

---

## 2. Auto Threshold Math & Numbers

Under `toolExposure: 'auto'`, `agentlib` computes the token footprint of all tool declarations before each turn using `estimateDeclarationTokens(catalog)`:

$$\text{tokens}(d) = \max\!\left(1,\; \left\lceil \frac{\text{UTF-8 length}(\text{JSON.stringify}(d)) + 16}{4} \right\rceil\right)$$

$$\text{totalDeclarationTokens} = \sum_{d \in \text{catalog}} \text{tokens}(d)$$

The policy compares `totalDeclarationTokens` against a fraction (`thresholdRatio`, default **`0.05`** or **5%**) of the model's context budget (`maxContextTokens`, default **`128,000`**):

$$\text{tokenBudget} = \lfloor \text{maxContextTokens} \times \text{thresholdRatio} \rfloor$$

### Concrete Numbers

| Model Context (`maxContextTokens`) | Default `thresholdRatio` | Token Budget ($5\%$) | Equivalent Catalog Size ($\sim 200$ tokens/tool) | Behavior |
|---|---|---|---|---|
| $128{,}000$ (default) | $0.05$ | **$6{,}400$ tokens** | $\sim 32$ tools | $\le 6{,}400$ tokens $\to$ `'all'`; $> 6{,}400$ tokens $\to$ `'progressive'` |
| $200{,}000$ | $0.05$ | **$10{,}000$ tokens** | $\sim 50$ tools | $\le 10{,}000$ tokens $\to$ `'all'`; $> 10{,}000$ tokens $\to$ `'progressive'` |
| $32{,}000$ | $0.05$ | **$1{,}600$ tokens** | $\sim 8$ tools | $\le 1{,}600$ tokens $\to$ `'all'`; $> 1{,}600$ tokens $\to$ `'progressive'` |

Once an agent run exceeds `tokenBudget` and switches to progressive mode (`switched: true` in `exposureState`), it remains in progressive mode for the rest of the run so the wire `tools` prefix does not flip back and forth.

```javascript
import { Agent, LLMService } from '@peebles-group/agentlib-js';

const agent = new Agent(llmService, {
    toolExposure: 'auto',
    toolExposureOptions: {
        thresholdRatio: 0.05, // 5% of maxContextTokens (default)
        mode: 'expand',       // 'expand' | 'facade' when progressive activates
    },
});
```

---

## 3. Prompt-Cache Trade-Off: `expand` vs `facade`

LLM providers (OpenAI, Anthropic, Google Gemini) cache the static prefix of a request—which starts with the `tools` array and `system` prompt. Any change to the `tools` array invalidates the cached prefix for that turn.

`exposeProgressive` offers two modes via `toolExposureOptions.mode` (or `AGENTLIB_TOOL_EXPOSURE_MODE`):

### `expand` Mode (Default)

When the model inspects a tool via `get_tool_details({ names: ['github_create_issue'] })`, that tool's JSON Schema is added to the active discovered set (`exposure.discovered`) and appended to the wire `tools` array on subsequent turns.

- **Pros**: The model invokes discovered tools using native provider tool calls (`github_create_issue({ ... })`), benefiting from provider-side constrained decoding / strict schema validation.
- **Cons**: Each newly discovered tool mutates the wire `tools` array, causing **one prompt-cache miss** on the turn following discovery.

### `facade` Mode

In `facade` mode, discovered tools are **never** added to the wire `tools` array. Instead, the wire `tools` array remains 100% identical across every turn of the conversation:

1. `search_tools`
2. `get_tool_details`
3. `call_tool` (plus `search_servers` / `enable_server` / `disable_server` if lazy servers are registered, `run_tool_script` if `codeMode` is enabled, and any native provider tools)

To execute a tool, the model calls the `call_tool` meta-tool:

```json
{
  "name": "call_tool",
  "arguments": {
    "name": "github_create_issue",
    "arguments": {
      "repo": "org/repo",
      "title": "Bug report"
    }
  }
}
```

| Dimension | `expand` Mode | `facade` Mode |
|---|---|---|
| **Wire `tools` Array** | Grows as tools are discovered | **Identical on every turn** |
| **Prompt Prefix Cache** | Invalidated once per new discovery turn | **100% cache hit preservation across all turns** |
| **Invocation Mechanism** | Direct native tool call (`tool_name(args)`) | Indirect via `call_tool({ name, arguments })` |
| **Argument Validation** | Provider grammar + `withValidation` | `ToolLoader` / `withValidation` at dispatch |

```javascript
const agent = new Agent(llmService, {
    toolExposure: 'progressive',
    toolExposureOptions: {
        mode: 'facade', // Guarantees an identical tools array across turns
    },
});
```

---

## 4. Code Mode: Writing and Running Tool Scripts

Even with progressive discovery, standard tool calling requires one LLM turn per dependent tool call, and every raw tool return value is serialized into the conversation history.

Enabling **Code Mode (`codeMode: true`)** equips the model with the **`run_tool_script`** meta-tool (`{ code, tools? }`), which executes an async JavaScript function body inside a sandboxed worker (`WorkerSandbox` or `DenoSandbox`) with JSDoc-annotated async tool stubs (`generateToolStubs`) injected into scope.

### How a Tool Script Works

1. **Generated Tool Stubs (`generateToolStub` / `generateToolStubs`)**:
   Before executing the script, `agentlib` generates JSDoc-annotated async stubs for the requested `tools` (or all catalog tools) and injects them into the sandbox scope:
   ```javascript
   /**
    * List all users in a department
    * @param {object} [args={}]
    * @param {string} args.department - Department name
    * @returns {Promise<any>}
    */
   async function list_users(args = {}) {
       return __callTool("list_users", args);
   }

   /**
    * Fetch orders for a user ID
    * @param {object} [args={}]
    * @param {string} args.userId - User ID
    * @returns {Promise<any>}
    */
   async function get_orders(args = {}) {
       return __callTool("get_orders", args);
   }
   ```

2. **Write & Run the Script (`run_tool_script`)**:
   The model submits an async JavaScript body to `run_tool_script`. Inside the sandbox, all `await tool_name(args)` calls are brokered back to the host `Agent` (honoring `approveToolCall` with `origin: 'sandbox'` and emitting child telemetry spans with `origin: 'sandbox'`), while only the final `return` value and `console.log` output are returned to the LLM context:
   ```javascript
   const users = await list_users({ department: "engineering" });
   const highValue = [];

   for (const user of users) {
       const orders = await get_orders({ userId: user.id });
       const total = orders.reduce((sum, o) => sum + o.amount, 0);
       if (total > 1000) {
           highValue.push({ name: user.name, total });
       }
   }

   console.log(`Scanned ${users.length} users, matched ${highValue.length}`);
   return highValue;
   ```

3. **Result Envelope**:
   `run_tool_script` returns a compact `{ result, logs, error }` envelope to the model:
   ```json
   {
     "result": [
       { "name": "Ada", "total": 2450 }
     ],
     "logs": "Scanned 50 users, matched 1",
     "error": null
   }
   ```
   All 50 intermediate `get_orders` payloads stay out of the LLM context window, and all 51 tool calls complete in a **single LLM turn**.

### Configuring Code Mode on an Agent

```javascript
import { Agent, LLMService, createSandbox } from '@peebles-group/agentlib-js';

const agent = new Agent(llmService, {
    toolExposure: 'auto', // Works with 'all', 'progressive', or 'auto'
    codeMode: true,       // Exposes run_tool_script and creates default WorkerSandbox
    // Optional: pass custom sandbox options or a custom Sandbox instance:
    sandbox: createSandbox({
        type: 'worker',     // 'worker' (default) | 'deno'
        timeoutMS: 10000,   // Per-script execution timeout (default: 10,000ms)
        maxLogBytes: 16384, // Max captured console output (default: 16KB)
    }),
    tools: [listUsersTool, getOrdersTool],
});
```

---

## 5. Sandbox Security & Threat Model

Code Mode executes model-generated JavaScript inside a sandbox (`WorkerSandbox` by default, or `DenoSandbox` when `type: 'deno'` is configured) and authorizes every brokered tool call through `approveToolCall({ name, args, callId, origin: 'sandbox', signal })`.

For the complete sandbox security architecture—including the isolation boundary of `node:worker_threads` (`WorkerSandbox`), OS-level zero-permission lockdown with `deno run --no-prompt --deny-read --deny-write --deny-net --deny-env --deny-run --deny-ffi --deny-sys` (`DenoSandbox`), resource ceilings, and rules for handling untrusted inputs—see **[Security & Sandbox Threat Model (`docs/security.md`)](security.md)**.
