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

> [!NOTE]
> *Placeholder: Documentation for context pruning strategies (Windowing, Summarization, Semantic/Provence) will be added here in a future update.*
