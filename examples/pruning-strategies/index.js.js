import { Context } from '../../src/memory/context.js';
import { WindowCompactor, SummarizerCompactor, ProvenceCompactor } from '../../src/memory/compactors/index.js';
import { AgentRunner } from '../../src/core/agent-runner.js';
import { Agent } from '../../src/core/agent.js';
import { LLMService } from '../../src/services/llm-service.js';
import OpenAI from 'openai';
import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });

const llm = new LLMService({ provider: 'openai', apiKey: process.env.OPENAI_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Real Embedding Service using OpenAI
class OpenAIEmbeddingService {
    async embed(text) {
        if (typeof text !== 'string' || text.trim() === '') return [0, 0, 0];
        try {
            const response = await openai.embeddings.create({
                model: "text-embedding-3-small",
                input: text,
            });
            return response.data[0].embedding;
        } catch (error) {
            console.error("Error creating embedding:", error);
            return [0, 0, 0];
        }
    }
}

async function runExample() {
    console.log("=====================================");
    console.log(" Context Pruning Mechanisms Example");
    console.log("=====================================\n");

    // Create a mock conversation history
    const initialMessages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello, I have a question.' },
        { role: 'assistant', content: 'Sure, what is it?' },
        { role: 'user', content: 'This is an irrelevant detail about my day.' },
        { role: 'assistant', content: 'I see. How can I help?' },
        { role: 'user', content: 'This is similar to the final question.' },
        { role: 'assistant', content: 'Got it. Please state your query.' },
        { role: 'user', content: 'Query: What is the capital of France?' }
    ];

    const context = new Context(initialMessages);

    console.log("INITIAL CONTEXT:");
    console.log(`Length: ${context.getMessages().length} messages`);
    console.dir(context.getMessages(), { depth: null });
    console.log("\n-------------------------------------\n");

    // 1. Window Pruning
    console.log("1. WINDOW COMPACTOR (Max 5 messages)");
    const windowCompactor = new WindowCompactor({ maxMessages: 5 });
    const windowPruned = await windowCompactor.compact(context.getMessages());
    console.log(`Length Before: ${context.getMessages().length} | After: ${windowPruned.length}`);
    console.dir(windowPruned, { depth: null });
    console.log("\n-------------------------------------\n");

    // 2. Summarizer Pruning
    console.log("2. SUMMARIZER COMPACTOR (Max 5 messages)");
    const summarizerCompactor = new SummarizerCompactor({
        maxMessages: 5,
        llmService: llm,
        model: 'gpt-4o-mini'
    });
    const summarizerPruned = await summarizerCompactor.compact(context.getMessages());
    console.log(`Length Before: ${context.getMessages().length} | After: ${summarizerPruned.length}`);
    console.dir(summarizerPruned, { depth: null });
    console.log("\n-------------------------------------\n");

    // 3. Provence (Semantic) Pruning
    console.log("3. PROVENCE (SEMANTIC) COMPACTOR");
    const embeddingService = new OpenAIEmbeddingService();
    const provenceCompactor = new ProvenceCompactor({
        embeddingService: embeddingService,
        similarityThreshold: 0.3 // Adjusted threshold for real embeddings
    });
    const provencePruned = await provenceCompactor.compact(context.getMessages());
    console.log(`Length Before: ${context.getMessages().length} | After: ${provencePruned.length}`);
    console.dir(provencePruned, { depth: null });
    console.log("\n-------------------------------------\n");

    // 4. Using Compactor with Agent
    console.log("4. RUNNING AGENT WITH COMPACTOR");
    const agent = new Agent(llm, {
        name: 'PruningAgent',
        model: 'gpt-4o-mini',
        compactor: 'window',
        maxMessages: 4
    });
    agent.addInput(initialMessages);

    console.log(`Agent Context Length Before Run: ${agent.context.getMessages().length}`);
    await agent.start();
    console.log(`Agent Context Length After Turn (Window max 4): ${agent.context.getMessages().length}`);
    console.log("(Should be: 1 system msg + 3 recent msgs + 1 new LLM response = 5 messages)");
}

runExample().catch(console.error);
