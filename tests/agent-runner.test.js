import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRunner } from '../src/core/agent-runner.js';
import { Agent } from '../src/core/agent.js';
import { LLMService } from '../src/services/llm-service.js';
import { registerProvider } from '../src/providers/registry.js';
import * as FakeProvider from './helpers/fake-provider.js';

describe('AgentRunner (Offline)', () => {
    let fakeProvider;

    beforeEach(() => {
        fakeProvider = FakeProvider.createFakeProvider();
        registerProvider('fake', fakeProvider, 'Fake Provider');
    });

    test('Test 1: Constructor stores agent by name', () => {
        const llm = new LLMService({ provider: 'fake' });
        const agent = new Agent(llm, { name: 'my-agent' });
        const runner = new AgentRunner(agent);

        assert.equal(runner.agents['my-agent'], agent);
    });

    test('Test 2: Input normalization', () => {
        const llm = new LLMService({ provider: 'fake' });
        const agent = new Agent(llm, { name: 'agent' });
        const runner = new AgentRunner(agent);

        const n1 = runner._normalizeInput('hi');
        assert.deepEqual(n1, { role: 'user', content: 'hi' });

        const n2 = runner._normalizeInput({ role: 'user', content: 'hello' });
        assert.deepEqual(n2, { role: 'user', content: 'hello' });

        assert.throws(() => runner._normalizeInput(123), /initialInput must be a string or an object/);
    });

    test('Test 3: Single Agent Run with continuation', async () => {
        fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('Hello from fake model'));

        const llm = new LLMService({ provider: 'fake' });
        const agent = new Agent(llm, { name: 'agent' });
        const runner = new AgentRunner(agent);

        const history = await runner.run('Say hello');
        assert.equal(history.length, 1, 'History has 1 turn');
        assert.equal(history[0].isSatisfied, true, 'Turn is satisfied');
        assert.equal(typeof history[0].output, 'string');
        assert.ok(history[0].output.includes('Hello from fake model'));
        assert.equal(typeof history[0].next, 'function', 'Continuation next function is present');
    });

    test('Test 4: Branching / Time-Travel with next continuation', async () => {
        fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('Original response'));

        const llm = new LLMService({ provider: 'fake' });
        const agent = new Agent(llm, { name: 'agent' });
        const runner = new AgentRunner(agent);

        const history = await runner.run('Initial prompt');
        assert.equal(history.length, 1);

        fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('Branched response'));
        const nextTurn = await history[0].next();
        assert.equal(nextTurn.turn, 2, 'Continuation steps to turn 2');
        assert.equal(nextTurn.output, 'Branched response');
    });

    test('Test 5: Multi-agent turnStrategy that runs exactly N turns', async () => {
        let writerCount = 0;
        let editorCount = 0;

        fakeProvider.setHandler(async (input) => {
            const lastMsg = input[input.length - 1]?.content || '';
            if (lastMsg.includes('Draft')) {
                writerCount++;
                return FakeProvider.fakeTextResponse(`Draft ${writerCount}`);
            }
            if (lastMsg.includes('Review')) {
                editorCount++;
                return FakeProvider.fakeTextResponse(`Looks good ${editorCount}`);
            }
            return FakeProvider.fakeTextResponse('OK');
        });

        const llm = new LLMService({ provider: 'fake' });
        const writerAgent = new Agent(llm, { name: 'writer' });
        const editorAgent = new Agent(llm, { name: 'editor' });

        const multiRunner = new AgentRunner({ writer: writerAgent, editor: editorAgent }, {
            turnStrategy: async (agents, agentContexts, turn) => {
                const res1 = await agents.writer.run([{ role: 'user', content: `Draft turn ${turn}` }]);
                const res2 = await agents.editor.run([{ role: 'user', content: `Review turn ${turn}` }]);
                return {
                    isSatisfied: turn >= 3,
                    writerRes: res1[res1.length - 1].output,
                    editorRes: res2[res2.length - 1].output,
                    context: agentContexts
                };
            }
        });

        const multiHistory = await multiRunner.run();
        assert.equal(multiHistory.length, 3, 'Runs exactly 3 turns based on turnStrategy isSatisfied');
        assert.ok(multiHistory[0].writerRes.includes('Draft 1'));
        assert.ok(multiHistory[2].editorRes.includes('Looks good 3'));
        assert.equal(multiHistory[2].isSatisfied, true);
    });
});
