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

- **[AgentLib 2.x to 4.0.0 Migration Guide](./migrations/v2-to-v4.0.md)**
  - Subpath exports and blocking deep imports into `src/`.
  - Tiered optional dependencies (A2A, SQLite prompt store, OTLP telemetry).
  - Asynchronous `startA2AServer`.
  - Non-throwing tool errors and bounded step limits.
  - Opt-in telemetry and zero stdout pollution.
  - Functional message constructors and context compaction strategies.
