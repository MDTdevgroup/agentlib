import { Agent, LLMService, PromptLoader } from '../../index.js';
import { travelAgentToolLoader, grumpyTravelerToolLoader } from './tools.js';
import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });

async function runMultiAgent() {
    let isSatisfied = false;
    const llmService = new LLMService({ provider: 'openai', apiKey: process.env.OPENAI_API_KEY });

    const travelAgent = new Agent(llmService, {
        name: 'TravelAgent',
        toolLoader: travelAgentToolLoader,
        model: 'gpt-5-nano'
    });

    const grumpyTraveler = new Agent(llmService, {
        name: 'GrumpyTraveler',
        toolLoader: grumpyTravelerToolLoader,
        model: 'gpt-5-nano'
    });

    const promptLoader = await PromptLoader.create('./prompts.yml');

    travelAgent.addInput({
        role: 'system',
        content: promptLoader.getPrompt('travel_agent_system_instruction').format(),
    });

    grumpyTraveler.addInput({
        role: 'system',
        content: promptLoader.getPrompt('grumpy_traveler_system_instruction').format(),
    });

    console.log("Starting Multi-Agent Conversation...");

    let initialMessage = "Give me a vacation plan.";
    console.log(`\nGrumpy Traveler: ${initialMessage}`);

    travelAgent.addInput({ role: 'user', content: initialMessage });

    let turnCount = 0;
    while (!isSatisfied && turnCount < 5) {
        turnCount++;

        console.log(`\n--- Turn ${turnCount} ---`);
        console.log("Travel Agent is thinking...");
        const TAResponse = await travelAgent.run();
        const travelAgentReply = TAResponse.output || '(No text response)';

        console.log(`\n%cTravel Agent: ${travelAgentReply}`, "color: blue; font-size: 20px;");


        grumpyTraveler.addInput({ role: 'user', content: travelAgentReply });

        console.log("\nGrumpy Traveler is thinking...");
        const GTResponse = await grumpyTraveler.run();

        if (GTResponse.executed && GTResponse.executed.some(t => t.name === 'exit_loop')) {
            isSatisfied = true;
            break;
        }

        const grumpyReply = GTResponse.output || '(No text response)';
        console.log(`\n%cGrumpy Traveler: ${grumpyReply}`, "color: red; font-size: 20px;");

        travelAgent.addInput({ role: 'user', content: grumpyReply });
    }

    if (!isSatisfied) {
        console.log("\nInteraction limit reached. The grumpy traveler walked out.");
    } else {
        console.log("\nInteraction successful! The grumpy traveler booked the trip.");
    }
}

runMultiAgent().catch(console.error);
