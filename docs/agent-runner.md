# Agent Runner

The `AgentRunner` is a generalized orchestrator for managing multi-turn, multi-agent systems. It builds upon the `Agent` primitive and manages composite states automatically.

## Initialization

Pass a map of Agents to the runner.

```javascript
import { AgentRunner, Agent, LLMService } from '@peebles-group/agentlib-js';

const llm = new LLMService({ provider: 'openai', apiKey: process.env.OPENAI_API_KEY });

const runner = new AgentRunner({
    Alice: new Agent(llm, { name: 'Alice' }),
    Bob: new Agent(llm, { name: 'Bob' })
});
```

## Turn Strategies

The `AgentRunner` can be customized with a `turnStrategy` function to control whose turn it is, and how contexts are shared.

```javascript
const runner = new AgentRunner({ Alice: alice, Bob: bob }, {
    maxTurns: 10,
    turnStrategy: async (agents, agentContexts, turnNumber) => {
        // Simple Round-Robin
        const speakerName = turnNumber % 2 !== 0 ? 'Alice' : 'Bob';
        const speaker = agents[speakerName];
        
        // Retrieve scoped context for the active speaker
        const ctx = agentContexts[speakerName] || speaker.context;
        
        // Execute the speaker's reasoning loop
        const history = await speaker.run(ctx);
        const res = history[history.length - 1];
        
        // Update the global context map
        const updatedContexts = {
            ...agentContexts,
            [speakerName]: res.context,
            // Broadcast message to everyone else (or specific agents)
        };
        
        return {
            output: res.output,
            context: updatedContexts,
            isSatisfied: false // Keep going until maxTurns
        };
    }
});
```

## Execution

Like the `Agent`, the `AgentRunner` can be run completely or stepped through turn-by-turn.

```javascript
// Step-by-step
let currentTurn = await runner.start();
while (!currentTurn.isDone) {
    console.log(`Turn ${currentTurn.turn}: ${currentTurn.output}`);
    currentTurn = await currentTurn.next();
}

// Or run all at once
const fullHistory = await runner.run();
```

## Interface Unification

The runner adheres to the same core interface as an individual Agent, making them composable:

```javascript
{
  output: String,
  context: Object, // A composite object representing state
  isDone: Boolean,
  next: AsyncFunction
}
```
