import { Agent, AgentRunner, LLMService } from '../../index.js';

async function main() {
    const llm = new LLMService({ provider: 'openai', apiKey: process.env.OPENAI_API_KEY });

    // 1. Setup N Agents with System Prompts
    const agentsConfig = [
        { name: 'Alice', instruction: 'You are Alice. You love cats. Talk in exactly 1 short sentence.' },
        { name: 'Bob', instruction: 'You are Bob. You love dogs. Argue with the others in exactly 1 short sentence.' },
        { name: 'Charlie', instruction: 'You are Charlie. You love birds. Try to change the subject to birds in exactly 1 short sentence.' },
        { name: 'Diana', instruction: 'You are Diana. You love hamsters. Try to bring the conversation back to hamsters in exactly 1 short sentence.' }
    ];

    const agentsMap = {};
    for (const config of agentsConfig) {
        const agent = new Agent(llm, { name: config.name, model: 'gpt-4o-mini' });
        agent.addInput({ role: 'system', content: config.instruction });
        agentsMap[config.name] = agent;
    }

    const agentNames = Object.keys(agentsMap);
    const totalAgents = agentNames.length;

    // 2. Setup the Orchestrator
    const runner = new AgentRunner(agentsMap, {
        maxTurns: 12,
        turnStrategy: async (agents, agentContexts, turnNumber) => {
            // turnNumber is 1-indexed (1, 2, 3...)
            const speakerIndex = (turnNumber - 1) % totalAgents;
            const speakerName = agentNames[speakerIndex];
            const speaker = agents[speakerName];

            // Execute the speaker
            const currentSpeakerCtx = agentContexts[speakerName] || speaker.context;
            const history = await speaker.run(currentSpeakerCtx);
            const res = history[history.length - 1];

            console.log(`Turn ${turnNumber} | ${speakerName}: ${res.output}`);

            // Pass the speaker's output to the next agent's context
            const listenerIndex = turnNumber % totalAgents;
            const listenerName = agentNames[listenerIndex];
            
            const currentListenerCtx = agentContexts[listenerName] || agents[listenerName].context;

            const updatedContexts = { 
                ...agentContexts, 
                [speakerName]: res.context,
                [listenerName]: currentListenerCtx.addInput({ 
                    role: 'user', 
                    content: `[${speakerName}]: ${res.output}` 
                })
            };

            return {
                output: res.output,
                context: updatedContexts,
                isSatisfied: false
            };
        }
    });

    console.log(`Starting round-robin conversation with ${totalAgents} agents...\n`);

    // 3. Step-by-Step Execution
    let currentTurn = await runner.start();

    while (!currentTurn.isDone) {
        currentTurn = await currentTurn.next();
    }

    console.log("\nConversation concluded.");
}

main().catch(console.error);
