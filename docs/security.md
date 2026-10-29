# Security Architecture & MCP Best Practices

This document describes how `agentlib` implements the client and host requirements of the [MCP Security Best Practices (2026-07-28)](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices), the threat model for programmatic tool execution, the open platform limits callers should account for in production, and the explicit non-goals that remain the responsibility of the host application or upstream infrastructure.

---

## 1. One Policy Object for Trust Decisions (`src/security/policy.js`)

`agentlib` is a headless library: it has no UI, no interactive user prompt, and no built-in knowledge of a deployment's threat model. Rather than scattering ad-hoc callbacks across transports and tools, `agentlib` routes every trust decision through a single optional `policy` object passed to `Agent`, `ToolLoader`, `MCPManager`, `MCPClient`, or `A2AToolSource`.

```js
import { Agent, composePolicy, strictPolicy } from '@peebles-group/agentlib-js';

const myPolicy = {
    async approveServer(descriptor) {
        // descriptor: { id, kind, transport, command, args, url, warning }
        if (descriptor.transport === 'stdio' && descriptor.command !== 'npx') {
            return { allow: false, reason: 'Only npx stdio servers are permitted.' };
        }
    },
    async approveToolCall(call) {
        // call: { name, args, callId, source, origin, signal }
        if (call.origin === 'sandbox' && call.name.startsWith('payments_')) {
            return { allow: false, reason: 'Payment tools cannot be called from a sandboxed script.' };
        }
    },
    async inspectResult(result, call) {
        // Transform or redact tool output before it enters model context or telemetry
        if (typeof result === 'string') {
            return result.replace(/sk-[a-zA-Z0-9]{20,}/g, '[REDACTED_KEY]');
        }
        return result;
    },
    async allowUrl(url, purpose) {
        // purpose: 'mcp:server' | 'mcp:http' | 'oauth:discovery' | 'a2a:card' | 'redirect' | ...
        if (url.startsWith('https://untrusted.example.com')) {
            return { allow: false, reason: 'Blocked domain.' };
        }
    },
};

const agent = new Agent(llm, {
    enableMCP: true,
    policy: composePolicy(strictPolicy(), myPolicy),
});
```

### Policy Hooks

Every hook is optional and may be synchronous or `async`. Returning `undefined` (or `{ allow: true }`) means "no opinion", which `composePolicy` treats as allow:

| Hook | Signature | Purpose |
| :--- | :--- | :--- |
| `approveServer` | `(descriptor) => Decision` | Invoked before connecting to an MCP server or A2A peer. Receives `{ id, kind, transport, command, args, url, warning }`. |
| `approveToolCall` | `(call) => Decision` | Invoked inside `Agent._executeSingleTool` before any tool or meta-tool runs. Receives `{ name, args, callId, source, origin, signal }`. |
| `inspectResult` | `(result, call) => nextResult` | Invoked after tool execution and before the result enters `Context` or is emitted to telemetry (`tool:complete`). |
| `allowUrl` | `(url, purpose) => Decision` | Invoked before any outbound HTTP connection or redirect hop initiated by `agentlib`. |
| `filterTools` | `(catalog, context) => filteredCatalog` | Optional hook to filter the tool declaration catalog before exposure or `search_tools` ranking. |
| `elicit` | `(params, context) => ElicitResult` | Optional consent handler for MCP `elicitation/create` requests. Returns `{ action: 'accept', content }` or `{ action: 'decline' }`. |

### `origin: 'model' | 'sandbox'`

The MCP security guide requires that approving a script (`run_tool_script`) does not implicitly approve every tool call the script makes. Because `run_tool_script` brokers all inner calls through `Agent._executeSingleTool`, a single `approveToolCall` hook sees direct model calls with `origin: 'model'` and script-initiated calls with `origin: 'sandbox'`.

### Composable Decisions vs. Exceptions

Hooks return `{ allow: false, reason }` (or `false`) rather than throwing:
1. **`composePolicy(...policies)`** runs `approveServer`, `approveToolCall`, and `allowUrl` in order, where the first explicit deny wins. `inspectResult` and `filterTools` chain in order so each policy transforms the value passed to the next.
2. When `approveToolCall` returns `{ allow: false, reason }` and `onToolError` is `'feedback'` (the default), `Agent` converts the denial into a structured tool error result (`{ error: reason }`) that the model can read and recover from without crashing the run.

### Provenance on Tool Results

Every normalized tool declaration carries `source: { kind, serverName, remoteName }`. `Agent._executeTurn` forwards `source` into `makeToolResult` (`src/memory/message.js`), and `toolResultSource(item)` reads it back. Policies inspecting `context` or chaining `inspectResult` and `approveToolCall` can always determine which server produced a value before it is passed as an argument to another server.

### Default Policy vs. `strictPolicy()`

- **Default (`policy: null`)**: Allows all servers, tool calls, and results for backwards compatibility.
- **`strictPolicy(options)`**: Opt-in factory implementing the MCP Security Best Practices defaults:
  1. **`approveServer`**: Refuses any stdio server whose descriptor carries a `warning` (`sudo`/`doas`/`su`, `rm -rf`, shell metacharacters in `command`, or inline subshell execution `sh -c`) unless `allowWarnedServers: true`, and validates any remote `url` via `allowUrl`.
  2. **`allowUrl`**: Permits `https:` and permits `http:` only on literal loopback (`localhost`, `127.0.0.1`, `[::1]`). Rejects all other schemes (`file:`, `javascript:`, `data:`, `ftp:`, etc.). Resolves hostnames via `dns.promises.lookup` and blocks private, loopback (for non-literal hostnames and all redirect hops), link-local (`169.254.0.0/16`), CGNAT (`100.64.0.0/10`), multicast, and reserved IPv4/IPv6 ranges using `node:net.BlockList`.
  3. **`approveToolCall`**: Allows tool calls by default, or denies all sandbox-originated calls when `denySandboxTools: true`.
  4. **`elicit`**: Only advertised when `options.elicit` is supplied; otherwise `elicitation` capability is not declared.

### Choosing a Tool Approval Level (`createApprovalPolicy`)

Host applications can let users choose between three tool-approval levels using `createApprovalPolicy({ level, confirm, sensitiveTools })`, either standalone or layered with `strictPolicy()`:

- **`level: 'auto'` (or `'none'`)**: Auto-accepts all tool calls without prompting.
- **`level: 'sensitive'` (default)**: Auto-accepts routine/read-only calls and invokes `confirm(call)` only when `isSensitiveToolCall(call)` flags a call as sensitive:
  - the tool definition sets `sensitive: true`;
  - the MCP tool carries `annotations.destructiveHint: true` or `annotations.readOnlyHint: false`;
  - the call originated inside a sandboxed script (`call.origin === 'sandbox'`);
  - the tool name appears in `sensitiveTools`; or
  - a custom `isSensitive(call)` predicate returns `true`.
- **`level: 'all'` (or `'always'`)**: Invokes `confirm(call)` for every tool call.

```js
import { Agent, composePolicy, strictPolicy, createApprovalPolicy } from '@peebles-group/agentlib-js';

const agent = new Agent(llm, {
    policy: composePolicy(
        strictPolicy(),
        createApprovalPolicy({
            level: 'sensitive', // 'auto' | 'sensitive' | 'all'
            sensitiveTools: ['delete_record', 'transfer_funds'],
            confirm: async (call) => {
                // call.warning and call.reasons explain why the call was flagged
                return await askUser(`Approve ${call.name}? (${call.warning})`);
            },
        })
    ),
});
```

---

## 2. Process and Network Defaults (Phase 8)

### Stdio Environment Allowlist

Spawning a local MCP server with `env: process.env` leaks every host secret (`OPENAI_API_KEY`, cloud credentials, session tokens) to the child process. `MCPClient` constructs the child environment via `buildStdioEnv(server.env)`, which copies only the platform allowlist from `getStdioEnvAllowlist()`:
- **POSIX**: `PATH`, `HOME`, `TMPDIR`, `SHELL`
- **Windows (`win32`)**: `PATH`, `HOME`, `TMPDIR`, `SHELL`, `SystemRoot`, `APPDATA`, `LOCALAPPDATA`, `TEMP`
- Plus any key-value pairs explicitly passed in `server.env`.

### Command Visibility

Before spawning a stdio server, `MCPClient` builds a server descriptor via `buildServerDescriptor()`, attaches a `warning` field if `command` or `args` match high-risk patterns (`sudo`, `rm -rf`, shell metacharacters in `command`, or `sh -c`), emits `mcp:server_launch` on the `EventEmitter` with the untruncated `command` and `args`, and passes the same descriptor to `policy.approveServer(descriptor)`.

### Outbound URL Validation & Fetch Middleware

`checkUrl(url, purpose, options)` and `createUrlCheckMiddleware(options)` (built on `@modelcontextprotocol/client`'s `createMiddleware` and `applyMiddlewares`) protect all three outbound URL surfaces:
1. **MCP HTTP server URLs** (`StreamableHTTPClientTransport`).
2. **OAuth discovery and metadata URLs** (`WWW-Authenticate` `resource_metadata`, RFC 9728 Protected Resource Metadata, and RFC 8414 / OIDC Authorization Server Metadata fetched through the transport's `fetch` pipeline).
3. **A2A Agent Cards** (`remoteUrl`, plus the server-controlled `url`, `additionalInterfaces`, and `supportedInterfaces` endpoints inside the resolved card in `A2AToolSource` and `createRemoteAgentTool`).

Address validation uses `node:net.BlockList` over all addresses returned by `dns.promises.lookup(hostname, { all: true, verbatim: true })` rather than regex or hand-written IP parsers, neutralizing octal (`0177.0.0.1`), hexadecimal (`0x7f000001`), integer (`2130706433`), and IPv4-mapped IPv6 (`::ffff:127.0.0.1`, `::ffff:169.254.169.254`) representations.

### Open Network Limits

Two platform-level limits cannot be closed inside `agentlib` without adding external runtime dependencies and are documented both here and in comments at the implementation site (`src/security/policy.js`):

1. **Time-of-Check to Time-of-Use (DNS TOCTOU / DNS Rebinding)**:
   `checkUrl` resolves the hostname with `dns.promises.lookup` and checks every address against `node:net.BlockList`, after which Node's built-in `fetch` resolves the hostname a second time when opening the socket. An attacker-controlled DNS server with a zero-TTL record can return a public IP during `checkUrl` and rebind to `127.0.0.1` or `169.254.169.254` for the socket connect. Closing this window in-process requires an `undici` `Agent` dispatcher with a pinned `connect.lookup` callback, and Node.js does not expose `undici` as a `node:` built-in module.
   - **Mitigation**: `MCPClient` and `A2AToolSource` keep the `fetch` option pluggable so deployments can pass a custom `fetch` backed by a pinned `undici` dispatcher, or route outbound traffic through a dedicated egress proxy that enforces IP range blocks at connection time (as recommended by the MCP Security Best Practices).
2. **Manual Redirect Handling**:
   Node's `fetch` follows `3xx` redirects internally without re-invoking application hooks on intermediate hops. `createUrlCheckMiddleware` sets `redirect: 'manual'` on every request and follows `301`, `302`, `303`, `307`, and `308` responses in an explicit loop capped at `maxRedirects` (default `5`). Every redirect hop is validated with `checkUrl(..., 'redirect', { allowLoopback: false, isRedirect: true })`, blocking redirects to loopback or private networks and stripping `Authorization`, `Cookie`, and `DPoP` headers across origin changes.

### Telemetry Redaction and Size Caps

`Agent._executeSingleTool` routes every tool result through `policy.inspectResult(result, call)` and a token/character budget cap (`_capResultToBudget` and `_capForTelemetry`) **before** emitting `tool:complete`, and caps `arguments` before emitting `tool:start` and `tool:complete`. Secrets redacted by `inspectResult` are never written to observability or tracing sinks.

---

## 3. Untrusted Text and Server-Initiated Requests (Phase 9)

1. **Server Instructions (`ToolLoader.getSystemPromptSnippet()`)**:
   MCP servers can advertise usage notes via `client.getInstructions()`. Because server-chosen text must never be merged into or placed ahead of the host's own system prompt, `getSystemPromptSnippet()` appends server instructions at the end of the snippet inside an explicitly labelled, delimited block (`<mcp_server_instructions server="..." untrusted="true">...</mcp_server_instructions>`) preceded by a notice instructing the model to treat the block as untrusted data rather than system instructions. Any closing `</mcp_server_instructions>` tag in the server text is stripped.
2. **Tool Descriptions and Progressive Discovery (`src/tools/exposure.js`)**:
   - Tool descriptions from local, MCP, and A2A sources are capped at `getMaxToolDescriptionChars()` (`1024` characters).
   - `search_tools` preserves the `source` identifier on every returned match (`name_and_description` and `full_schema`) so both the model and any policy can see which server suggested a tool.
   - `policy.filterTools(catalog, context)` allows the host to filter the tool catalog before ranking or exposure.
   - *Limitation*: No library-level heuristic can reliably detect an adversarial natural-language tool description engineered to rank highly in search queries. Hosts connecting to untrusted servers should use `approveServer`, `filterTools`, and `approveToolCall`.
3. **Bounded Tool Results**:
   `Agent` caps tool results using `estimateTokens` and `truncateToBudget` from `src/memory/compactors/base.js` (defaulting to `getDefaultMaxToolResultTokens()`, `8192` tokens) and passes every result through `policy.inspectResult` before it enters `Context`.
4. **Client Capabilities (`elicitation`, `sampling`, `roots`)**:
   - **Elicitation**: `MCPClient` declares the `elicitation` capability only when the policy (or server config) supplies an `elicit` handler, and returns `{ action: 'decline' }` whenever no handler is present or consent is withheld.
   - **Sampling**: Kept off by default because `sampling/createMessage` allows a remote server to spend the host's LLM quota and inject a fresh system prompt. It is only enabled when `enableSampling: true` and an explicit handler are supplied.
   - **Roots**: Not declared (`agentlib` does not expose host filesystem roots to MCP servers).

---

## 4. Sandbox Threat Model (`run_tool_script`)

When `codeMode` is enabled, the model can chain tool calls in JavaScript via `run_tool_script`:
- **`WorkerSandbox` (`src/tools/sandbox/worker-sandbox.js`)**: Runs code inside a `node:worker_threads` worker and `node:vm` context with `timeoutMS` (`30000` ms), V8 `resourceLimits` (`memoryMB: 128`), and `maxLogBytes` (`16384` bytes), and removes ambient `process` and `fetch` globals. **`node:vm` is not a security boundary against untrusted adversarial code**; use `WorkerSandbox` only as a resource-bounded execution environment for model-generated glue scripts when `DenoSandbox` is unavailable.
- **`DenoSandbox` (`src/tools/sandbox/deno-sandbox.js`)**: Runs code in an isolated `deno` subprocess with `--no-prompt`, `--no-remote`, `--no-npm`, and all OS permissions (filesystem, network, environment, subprocess) denied by default, communicating with the parent process exclusively via newline-delimited JSON over stdio.
- **Brokered Tool Calls**: Neither sandbox holds direct credentials or network access to MCP servers. Every tool stub call inside a script is sent back to the host and routed through `Agent._executeSingleTool` with `origin: 'sandbox'`, enforcing `policy.approveToolCall`, `policy.inspectResult`, and result token caps on every call.

---

## 5. Explicit Non-Goals

The following items from the MCP Security Best Practices specification sit outside `agentlib`'s boundary as a client and host library and are intentionally not implemented in `agentlib`:

1. **OAuth Flows, PKCE, Token Storage, and Redirect URI Validation**:
   Delegated to `@modelcontextprotocol/client`'s built-in OAuth implementation (`auth()`, `OAuthClientProvider`) and the host application's `AuthProvider`. `agentlib` forwards `authProvider` and transport options to `StreamableHTTPClientTransport` and validates discovery/token URLs through `createUrlCheckMiddleware`, but does not implement an OAuth authorization server, callback listener, or token store.
2. **Browser and OS URL Opening**:
   `agentlib` never invokes `open`, `xdg-open`, `ShellExecute`, or browser navigation APIs. Any authorization URL or URL-mode elicitation payload is surfaced as data to the host application.
3. **MCP Proxy and Multi-Tenant Gateway Controls**:
   `agentlib` is an in-process client and agent runtime, not an MCP proxy, API gateway, or multi-tenant relay. Confused-deputy protections at a shared proxy boundary belong in the proxy service.
4. **State Handle Hijacking and Server Session Binding**:
   Generating cryptographically random `Mcp-Session-Id` values and binding session state to authenticated principals are MCP server responsibilities.
5. **Scope Minimization and Incremental Consent**:
   Owned by the caller's `AuthProvider` / `OAuthClientProvider`. `agentlib` passes per-server `scope` and `onInsufficientScope` configuration through to `StreamableHTTPClientTransport` and never requests OAuth scopes of its own.
