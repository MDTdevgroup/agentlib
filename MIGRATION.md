# AgentLib Migration Guides

This directory contains version migration guides and changelog documentation for upgrading `@peebles-group/agentlib-js`.

---

## Available Guides

- **[AgentLib 4.1.0 Migration Guide](./migrations/v4.1.md)**
  - Decoupling tool declarations from executable implementations (`defineTool`).
  - Runtime argument validation boundary (`withValidation`).
  - Immutability of `getTools()` projections and metadata separation via `getToolDeclarations()`.
  - Constant-time $O(1)$ dispatch and atomic batch registration.
  - Automatic connection rollback on MCP duplicate/invalid tools.
  - Cooperative cancellation semantics via `context.signal`.
  - **MCP & A2A Tool Name Prefixing (`${serverName}_${toolName}`)**: By default, tools loaded from MCP servers and A2A peers are now scoped with their server/peer ID (`prefixToolNames: true`) and truncated to 64 characters (`<55-chars>_<sha256-8>`) when needed. Pass `{ prefixToolNames: false }` to preserve unprefixed raw names.

- **[AgentLib 2.x to 4.0.0 Migration Guide](./migrations/v2-to-v4.0.md)**
  - Subpath exports and blocking deep imports into `src/`.
  - Tiered optional dependencies (A2A, SQLite prompt store, OTLP telemetry).
  - Asynchronous `startA2AServer`.
  - Non-throwing tool errors and bounded step limits.
  - Opt-in telemetry and zero stdout pollution.
  - Functional message constructors and context compaction strategies.
