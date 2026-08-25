import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { LLMService, Agent } from '../../index.js';

describe('Live API Smoke Tests', () => {
    test('OpenAI live chat completion', async (t) => {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            t.skip('OPENAI_API_KEY not configured; skipping live test');
            return;
        }

        const llm = new LLMService({ provider: 'openai', apiKey });
        const agent = new Agent(llm, { model: 'gpt-4o-mini' });
        agent.addInput({ role: 'user', content: 'Say "hello" and nothing else.' });

        const history = await agent.run();
        const lastTurn = history[history.length - 1];
        assert.ok(lastTurn.output, 'Expected non-empty output from OpenAI');
    });

    test('Gemini live chat completion', async (t) => {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            t.skip('GEMINI_API_KEY not configured; skipping live test');
            return;
        }

        const llm = new LLMService({ provider: 'gemini', apiKey });
        const agent = new Agent(llm);
        agent.addInput({ role: 'user', content: 'Say "hello" and nothing else.' });

        const history = await agent.run();
        const lastTurn = history[history.length - 1];
        assert.ok(lastTurn.output, 'Expected non-empty output from Gemini');
    });
});
