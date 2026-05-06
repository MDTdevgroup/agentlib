import { AgentRunner } from '../../src/core/agent-runner.js';
import { Agent } from '../../src/core/agent.js';
import { LLMService } from '../../src/services/llm-service.js';
import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 1. Concurrent Orchestrator 
async function asyncForceAll(thunks, limit, step) {
    const results = [], executing = new Set();
    for (const thunk of thunks) {
        const p = Promise.resolve().then(() => thunk());
        results.push(p); executing.add(p);
        p.finally(() => executing.delete(p));
        if (executing.size >= limit) await Promise.race(executing);
        await sleep(step);
    }
    return Promise.all(results);
}

// 2. The 2-LLM Conversation Thunk
const thunkConvo = (id) => async () => {
    const llm = new LLMService({ provider: 'gemini', apiKey: process.env.GEMINI_API_KEY });
    
    const a = new Agent(llm, { name: 'Optimist' });
    a.addInput({ role: 'system', content: 'You are an optimist. Reply in exactly 1 sentence.' });
    a.addInput({ role: 'user', content: 'What is the meaning of life?' });

    const b = new Agent(llm, { name: 'Pessimist' });
    b.addInput({ role: 'system', content: 'You are a pessimist. Reply in exactly 1 sentence. You always disagree.' });

    const runner = new AgentRunner({ Optimist: a, Pessimist: b }, {
        maxTurns: 4,
        turnStrategy: async (agents, turn, state) => {
            const speaker = turn % 2 === 1 ? agents.Optimist : agents.Pessimist;
            const listener = turn % 2 === 1 ? agents.Pessimist : agents.Optimist;
            
            const res = await speaker.run(state);
            console.log(`[Convo ${id}] Turn ${turn} | ${speaker.name}: ${res.output}`);
            
            listener.addInput({ role: 'user', content: res.output });
            return { newContext: res.newContext, isSatisfied: false };
        }
    });

    await runner.run();
    console.log(`[Convo ${id}] Finished.\n`);
};

// 3. Execution
async function main() {
    console.log("Queuing 3 conversations...");
    const thunks = [thunkConvo(1), thunkConvo(2), thunkConvo(3)];
    
    console.log("Forcing execution with asyncForceAll (limit: 2 concurrent)...\n");
    await asyncForceAll(thunks, 2, 500);
    console.log("\nAll concurrent jobs complete!");
}

main().catch(console.error);
