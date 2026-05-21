import { Agent, LLMService, PromptLoader } from '../../index.js';
import { travelAgentToolLoader, grumpyTravelerToolLoader } from './tools.js';
import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });

/**
 * CPS-based multi-agent conversation loop.
 *
 * runTurn never returns a value — it passes a TurnResult into the
 * continuation `k`.  Each TurnResult carries a `resume(k2)` function
 * that re-runs from the *same* snapshot, letting the caller branch
 * into an alternate timeline by supplying a different continuation.
 *
 * TurnResult shape:
 *   {
 *     turn:              number,
 *     travelAgentReply:  string,
 *     grumpyReply:       string | null,
 *     isSatisfied:       boolean,
 *     resume:            (k: (result) => Promise<void>) => Promise<void>
 *   }
 */

/**
 * @param {number}   turn
 * @param {Agent}    travelAgent
 * @param {Agent}    grumpyTraveler
 * @param {number}   maxTurns
 * @param {Function} k  – the continuation: (TurnResult) => Promise<void>
 */
async function runTurn(turn, travelAgent, grumpyTraveler, maxTurns, k) {
    // ── snapshot both agents' contexts before anything mutates ──
    const taSnapshot = travelAgent.context;
    const gtSnapshot = grumpyTraveler.context;

    // ── Travel Agent responds ──
    console.log(`\n--- Turn ${turn} ---`);
    console.log("Travel Agent is thinking...");
    const taHistory = await travelAgent.run();
    const TAResponse = taHistory[taHistory.length - 1];
    const travelAgentReply = TAResponse.output || '(No text response)';
    console.log(`\nTravel Agent: ${travelAgentReply}`);

    // ── Grumpy Traveler responds ──
    grumpyTraveler.addInput({ role: 'user', content: travelAgentReply });
    console.log("\nGrumpy Traveler is thinking...");
    const gtHistory = await grumpyTraveler.run();
    const GTResponse = gtHistory[gtHistory.length - 1];

    const isSatisfied = GTResponse.executedTools?.some(t => t.name === 'exit_loop') ?? false;
    const grumpyReply = isSatisfied ? null : (GTResponse.output || '(No text response)');

    if (!isSatisfied) {
        console.log(`\nGrumpy Traveler: ${grumpyReply}`);
        travelAgent.addInput({ role: 'user', content: grumpyReply });
    }

    // ── Pass result into the continuation ──
    await k({
        turn,
        travelAgentReply,
        grumpyReply,
        isSatisfied,

        /**
         * Resume from this turn's starting state with a new continuation.
         * Restores the snapshots, then re-enters runTurn in CPS.
         *
         * @param {Function} k2 – new continuation for the replayed turn
         */
        resume: async (k2) => {
            travelAgent.context = taSnapshot;
            grumpyTraveler.context = gtSnapshot;
            await runTurn(turn, travelAgent, grumpyTraveler, maxTurns, k2);
        },
    });
}

/**
 * Drives the CPS loop: each continuation decides whether to keep going.
 */
async function loop(turn, travelAgent, grumpyTraveler, maxTurns, history) {
    await runTurn(turn, travelAgent, grumpyTraveler, maxTurns, async (result) => {
        history.push(result);

        if (result.isSatisfied) {
            console.log("\nInteraction successful! The grumpy traveler booked the trip.");
            return;
        }
        if (turn >= maxTurns) {
            console.log("\nInteraction limit reached. The grumpy traveler walked out.");
            return;
        }

        await loop(turn + 1, travelAgent, grumpyTraveler, maxTurns, history);
    });
}

async function runMultiAgent() {
    const maxTurns = 5;
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

    console.log("Starting Multi-Agent Conversation...\n");

    const initialMessage = "Give me a vacation plan.";
    console.log(`Grumpy Traveler: ${initialMessage}`);
    travelAgent.addInput({ role: 'user', content: initialMessage });

    // ── Run the conversation in CPS, collecting every turn result ──
    const history = [];
    await loop(1, travelAgent, grumpyTraveler, maxTurns, history);

    // ── Branching demo: resume from Turn 1 with a fresh continuation ──
    console.log("\n\n========== BRANCHING DEMO ==========");
    console.log("Resuming from Turn 1 to explore an alternative branch...\n");

    await history[0].resume(async (branch) => {
        console.log(`\n[Branch] Turn ${branch.turn} — Travel Agent (alternate):`);
        console.log(branch.travelAgentReply);

        if (branch.grumpyReply) {
            console.log(`[Branch] Grumpy Traveler (alternate):`);
            console.log(branch.grumpyReply);
        }

        // Could keep going: await branch.resume(async (b2) => { ... });
    });
}

runMultiAgent().catch(console.error);
