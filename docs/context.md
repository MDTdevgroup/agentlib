# Context

The `Context` class is a simple data container in AgentLib that handles episodic and semantic memory for an agent. It is designed to be **immutable**—meaning operations that modify the context return a new instance rather than mutating the existing one. This functional approach ensures safe time-travel branching and state management.

## Initialization

You can initialize a new `Context` with an array of messages or start with an empty context.

```javascript
import { Context } from '@peebles-group/agentlib-js';

// Empty context
const ctx = new Context();

// Context with initial messages
const initialCtx = new Context([
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello!' }
]);
```

## Adding Inputs

To append messages (like user prompts, tool responses, or assistant replies) to the conversation history, use the `addInput` method. Because `Context` is immutable, `addInput` returns a *new* `Context` instance. Note that we are
following OpenAI's message format ({role: '...', content: '...'}) for adding messages.

```javascript
const newCtx = ctx.addInput({ role: 'user', content: 'What is the weather today?' });

// You can also add multiple messages at once by passing an array
const multiCtx = newCtx.addInput([
    { role: 'system', content: 'You are a weather checker for any cities that are input into the system.' },
    { role: 'user', content: 'New York' }
]);
```

## Retrieving Messages

To get the current conversational history formatted for LLM consumption, use `getMessages()`.

```javascript
const messages = newCtx.getMessages();
console.log(messages); 
// [ { role: 'user', content: 'What is the weather today?' } ]
```

## Cloning Context

If you need a deeply cloned, isolated instance of the current context (useful when branching execution paths manually), you can use the `clone()` method.

```javascript
const branchedCtx = currentCtx.clone();
```

## Using Context with Agent

When working with an `Agent`, you rarely need to instantiate a `Context` manually. The `Agent` manages its own internal `Context` instance. You can append to it directly using `agent.addInput()`.

```javascript
import { Agent } from '@peebles-group/agentlib-js';

const agent = new Agent(llm, { model: 'gpt-4o-mini' });

// agent.context is automatically initialized as an empty Context.
// This calls agent.context.addInput() internally.
agent.addInput({ role: 'system', content: 'You are a helpful assistant.' });

// When you run the agent, it uses this internal context.
const history = await agent.run();
```

Alternatively, you can pass an external `Context` instance (or a raw message array) directly to `agent.run(externalContext)` or `agent.start(externalContext)`. Doing so will override the agent's default state for that execution run.

## Context Pruning & Compaction

Long conversations cause quadratic token billing across turns. AgentLib provides pluggable **compaction strategies** that shrink the wire payload sent to the LLM while preserving the full, lossless conversation history inside `Context`.

All compactors enforce **atomic tool integrity**—a tool call and its corresponding result are treated as an indivisible unit and never split.

### 1. Sliding Window (`WindowCompactor`)

Preserves all system instructions and the most recent conversation turns within a configured token budget (`truncateToTokens`).

```javascript
import { Agent, WindowCompactor } from '@peebles-group/agentlib-js';

const agent = new Agent(llm, {
    pruningStrategy: 'window', // or new WindowCompactor({ maxTokens: 8000, truncateToTokens: 6000 })
    maxContextTokens: 8000,
    truncateToTokens: 6000,
});
```

### 2. Incremental Summarization (`SummarizerCompactor`)

Condenses older messages into an incremental `[Conversation Summary]` system message while preserving recent turns verbatim. If the summarization model call fails, it gracefully falls back to a sliding window without failing the agent run.

```javascript
const agent = new Agent(llm, {
    pruningStrategy: 'summarizer',
    maxContextTokens: 8000,
    truncateToTokens: 6000,
});
```

### 3. Semantic Pruning (`ProvenceCompactor`)

Uses vector embeddings and cosine similarity against the active query to retain the most relevant messages up to a token budget. Embeddings are cached in-memory across turns so immutable messages are never re-embedded.

```javascript
import { ProvenceCompactor } from '@peebles-group/agentlib-js';

const compactor = new ProvenceCompactor({
    embeddingService: {
        embed: async (text) => myEmbeddingModel.embed(text)
    },
    similarityThreshold: 0.75,
    truncateToTokens: 6000
});

const agent = new Agent(llm, { pruningStrategy: compactor });
```

### 4. Custom Compactor (`BaseCompactor`)

You can create a custom compactor by subclassing `BaseCompactor` and implementing `compact(messages) -> Promise<messages>`:

```javascript
import { BaseCompactor, groupAtomicUnits, truncateToBudget } from '@peebles-group/agentlib-js';

export class CustomCompactor extends BaseCompactor {
    async compact(messages) {
        // Custom transformation
        return truncateToBudget(messages, 4000);
    }
}
```
