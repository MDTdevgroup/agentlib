# Code Mode Example (`run_tool_script`)

This example demonstrates **Code Mode** (`codeMode: true`) combined with `toolExposure: 'auto'`.

Instead of spending an LLM round-trip for every sequential tool call and serializing every intermediate payload into the conversation history, the model can invoke `run_tool_script` to execute an async JavaScript function body inside an isolated `WorkerSandbox`.

## What It Shows

1. **Declarative Tools (`defineTool`)**: Defines `list_employees` and `get_timesheet` with validated JSON Schema contracts.
2. **Programmatic Tool Calling (`codeMode: true`)**: Exposes `run_tool_script` so the model can fetch the engineering roster, loop over employee IDs, fetch each employee's timesheet, and filter for `overtime > 0` in a single turn.
3. **Origin-Aware Authorization (`approveToolCall`)**: Logs both `origin: 'model'` (when the model invokes `run_tool_script`) and `origin: 'sandbox'` (for each inner tool call brokered from the worker thread).

## Running the Example

```bash
export OPENAI_API_KEY="your-api-key"
node examples/code_mode/index.js
```
