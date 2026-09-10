# Agent

The `Agent` class is the core primitive in AgentLib. It handles interactions with the LLM service, manages context and conversational history via the immutable `Context` class, and executes tools.

## Initialization

```javascript
import { Agent, LLMService } from '@peebles-group/agentlib-js';

const llm = new LLMService({ provider: 'openai', apiKey: process.env.OPENAI_API_KEY });

const agent = new Agent(llm, {
    name: 'ResearchAgent',
    toolConcurrency: 3,                 // Max concurrent tool executions per turn (default: 5)
    onToolError: 'feedback',            // 'feedback' (feed error to LLM, default) | 'throw' (abort on error)
    maxToolCalls: 15,                   // Maximum tool iterations per run (default: 15)
    maxRunTokens: 50000,                // Cumulative token budget across the run before stopping
    pruningStrategy: 'window',          // 'window' | 'summarizer' | 'provence' | custom BaseCompactor
    maxContextTokens: 8000,             // Threshold triggering compaction (default: 75% of model limit)
    truncateToTokens: 6000,             // Target tokens after compaction (default: 50% of model limit)
});
```

### Configuration Options

| Option | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | `'agent'` | Name identifier for logging and speaker labeling. |
| `eventEmitter` | `EventEmitter` | `null` | Emitter for observability and telemetry events. |
| `model` | `string` | provider default | Model identifier to use. |
| `tools` | `Array<object>` | `[]` | Array of native tool definitions. |
| `enableMCP` | `boolean` | `false` | Whether to enable Model Context Protocol support. |
| `toolConcurrency` | `number` | `5` | Maximum parallel tool calls executed concurrently in a turn. |
| `onToolError` | `'feedback' \| 'throw'` | `'feedback'` | How tool failures are handled. `'feedback'` sends `{ error }` back to LLM to self-correct; `'throw'` terminates immediately. |
| `maxToolCalls` | `number` | `15` | Maximum tool-calling steps before loop terminates. |
| `maxRunTokens` | `number \| null` | `null` | Hard ceiling on total cumulative tokens spent across all turns in a run. |
| `pruningStrategy` | `string \| object \| null` | `null` | Compaction strategy (`'window'`, `'summarizer'`, `'provence'`, or a `BaseCompactor` instance). |
| `outputSchema` | `zod.ZodType \| null` | `null` | Zod schema for structured output parsing. |

## Context Management

Agents maintain state immutably using the `Context` class.

```javascript
// Add input (user message, tool response, etc.)
agent.addInput({ role: 'user', content: 'Find me some recent news.' });
```

## Execution (CPS Loop)

AgentLib uses a Continuation-Passing Style (CPS) loop, which allows you to run an agent fully to completion, or step-by-step to implement Human-in-the-Loop workflows.

### Run to Completion

```javascript
const history = await agent.run(); // Array of turns
const finalTurn = history[history.length - 1];
console.log(finalTurn.output);
```

### Step-by-Step

```javascript
let turn = await agent.start(); // initial LLM call
while (!turn.isDone) {
    // LLM returned a tool call. You can inspect it here.
    console.log("Tools called:", turn.executedTools);
    
    // Continue execution
    turn = await turn.next();
}
console.log(turn.output);
```

### Turn Structure

Every turn returns a unified interface representing a single "thought process" loop of the agent:

```javascript
{
  output: String,               // LLM text output (can be empty during tool calls)
  rawResponse: Object,          // The full raw LLM response (Escape Hatch)
  executedTools: Array,         // Tools executed in this turn
  context: Context,             // The updated Context instance
  isDone: Boolean,              // True if LLM produced final response or budget reached
  stopReason: String,           // 'step_limit' | 'budget_exhausted' (if terminated prematurely)
  next: AsyncFunction           // Calling next() continues to the next step
}
```

#### Why this structure?
1. **The `rawResponse`:** AI providers constantly add new features (caching, reasoning traces, billing info). By surfacing the exact raw payload returned by the provider, you have day-one access to new features without waiting for the library to update.
2. **Traceability:** Because each turn encapsulates its own `context` state and `executedTools`, the `history` array returned by `.run()` acts as an immutable ledger of the entire thought process. This makes debugging and observing multi-step tool execution trivial.
3. **Continuation-Passing Style (CPS):** Having `isDone` and `next()` natively on the state object enables powerful Human-in-the-Loop workflows. You can pause execution, store the state, and resume simply by calling `.next()` later.

> [!TIP]
> On intermediate turns where the agent is busy calling tools (`isDone: false`), the `output` string might be empty. The `next` function is absent on the final turn where `isDone: true`.

## Time Travel Branching

Because `Context` is immutable and the Agent uses a CPS loop, you can "time travel" by branching off a previous turn.

```javascript
const branchHistory = await agent.branch(historicalTurn, overrideContext);
```
