import { Agent, AgentRunner, LLMService } from '../../index.js';
import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });

async function main() {
    const llm = new LLMService({ provider: 'openai', apiKey: process.env.OPENAI_API_KEY });

    // 1. Setup Agents with System Prompts
    const alice = new Agent(llm, { name: 'Alice', model: 'gpt-4o-mini' });
    alice.addInput({ role: 'system', content: 'You are Alice. You love cats. Talk to Bob in 1 sentence.' });

    const bob = new Agent(llm, { name: 'Bob', model: 'gpt-4o-mini' });
    bob.addInput({ role: 'system', content: 'You are Bob. You love dogs. Argue with Alice in 1 sentence.' });

    // 2. Setup the Orchestrator
    const runner = new AgentRunner({ Alice: alice, Bob: bob }, {
        maxTurns: 10,
        turnStrategy: async (agents, agentContexts, turnNumber) => {
            // Figure out whose turn it is
            const speakerName = turnNumber % 2 === 1 ? 'Alice' : 'Bob';
            const listenerName = turnNumber % 2 === 1 ? 'Bob' : 'Alice';

            const speaker = agents[speakerName];
            const listener = agents[listenerName];

            // Execute the speaker
            const currentSpeakerCtx = agentContexts[speakerName] || speaker.context;
            const history = await speaker.run(currentSpeakerCtx);
            const res = history[history.length - 1];

            console.log(`Turn ${turnNumber} | ${speakerName}: ${res.output}`);

            // Pass the speaker's output to the listener's context
            const currentListenerCtx = agentContexts[listenerName] || listener.context;
            const updatedContexts = {
                ...agentContexts,
                [speakerName]: res.context,
                [listenerName]: currentListenerCtx.addInput({ role: 'user', content: res.output })
            };

            return {
                output: res.output,
                context: updatedContexts,
                isSatisfied: false
            };
        }
    });

    console.log("Starting manual conversation...\n");

    // 3. Step-by-Step Manual Execution using .next()

    // Turn 1: Alice speaks
    let currentTurn = await runner.start();

    while (!currentTurn.isDone) {
        currentTurn = await currentTurn.next();
    }

    console.log("\nConversation concluded.")
}

main().catch(console.error);