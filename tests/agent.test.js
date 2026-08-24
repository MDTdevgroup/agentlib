import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/core/agent.js';
import { LLMService } from '../src/services/llm-service.js';
import { registerProvider } from '../src/providers/registry.js';
import * as FakeProvider from './helpers/fake-provider.js';

describe('Agent Core Loop (Offline)', () => {
    let fakeProvider;

    beforeEach(() => {
        fakeProvider = FakeProvider.createFakeProvider();
        registerProvider('fake', fakeProvider, 'Fake Provider');
    });

    test('1. An agent that answers with no tools', async () => {
        fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('I am a helpful assistant.'));

        const llm = new LLMService({ provider: 'fake' });
        const agent = new Agent(llm, { name: 'test-agent' });
        agent.addInput({ role: 'user', content: 'Hello!' });

        const history = await agent.run();

        assert.equal(history.length, 1, 'Should complete in 1 turn');
        assert.equal(history[0].isDone, true);
        assert.equal(history[0].output, 'I am a helpful assistant.');
        assert.equal(history[0].executedTools.length, 0);
    });

    test('2. An agent that calls one tool, then answers', async () => {
        let toolExecuted = false;
        const addTool = {
            name: 'add',
            description: 'Add two numbers',
            func: async ({ a, b }) => {
                toolExecuted = true;
                return a + b;
            }
        };

        // Turn 1: Model emits tool call
        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
            name: 'add',
            args: { a: 2, b: 3 },
            call_id: 'call_add_1'
        }));
        // Turn 2: Model returns final answer with tool result
        fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('The sum is 5.'));

        const llm = new LLMService({ provider: 'fake' });
        const agent = new Agent(llm, { name: 'calc-agent', tools: [addTool] });
        agent.addInput({ role: 'user', content: 'What is 2 + 3?' });

        const history = await agent.run();

        assert.equal(toolExecuted, true, 'addTool should have been executed');
        assert.equal(history.length, 2, 'Should take 2 turns (tool call + final answer)');
        assert.equal(history[0].isDone, false, 'Turn 1 is not done yet');
        assert.equal(history[0].executedTools.length, 1);
        assert.deepEqual(history[0].executedTools[0], { name: 'add', args: { a: 2, b: 3 } });

        assert.equal(history[1].isDone, true, 'Turn 2 is done');
        assert.equal(history[1].output, 'The sum is 5.');
    });

    test('3. An agent that calls three tools in a single turn', async () => {
        const order = [];
        const tools = [
            {
                name: 'fetch_user',
                func: async ({ id }) => { order.push('fetch_user'); return { id, name: 'Alice' }; }
            },
            {
                name: 'fetch_posts',
                func: async ({ userId: _userId }) => { order.push('fetch_posts'); return [{ id: 1, title: 'Post 1' }]; }
            },
            {
                name: 'fetch_comments',
                func: async ({ postId: _postId }) => { order.push('fetch_comments'); return ['Great!']; }
            }
        ];

        // Turn 1: Model requests 3 tool calls at once
        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse([
            { name: 'fetch_user', args: { id: 42 }, call_id: 'call_u1' },
            { name: 'fetch_posts', args: { userId: 42 }, call_id: 'call_p1' },
            { name: 'fetch_comments', args: { postId: 1 }, call_id: 'call_c1' }
        ]));
        // Turn 2: Model finishes
        fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('User, posts, and comments fetched.'));

        const llm = new LLMService({ provider: 'fake' });
        const agent = new Agent(llm, { name: 'multi-tool-agent', tools });
        agent.addInput({ role: 'user', content: 'Fetch everything for user 42' });

        const history = await agent.run();

        assert.equal(order.length, 3, 'All 3 tools must execute');
        assert.equal(history.length, 2);
        assert.equal(history[0].executedTools.length, 3);
        assert.equal(history[1].isDone, true);
        assert.equal(history[1].output, 'User, posts, and comments fetched.');
    });

    test('4. An agent that hits the step limit terminates gracefully', async () => {
        const dummyTool = {
            name: 'loop_tool',
            func: async () => 'looping...'
        };

        // Always return another tool call
        fakeProvider.setHandler(() => {
            return FakeProvider.fakeToolCallResponse({
                name: 'loop_tool',
                args: {},
                call_id: 'call_loop'
            });
        });

        const llm = new LLMService({ provider: 'fake' });
        const agent = new Agent(llm, { name: 'runaway-agent', tools: [dummyTool], maxToolCalls: 3 });
        agent.addInput({ role: 'user', content: 'Run forever' });

        const history = await agent.run();
        const finalTurn = history[history.length - 1];
        assert.equal(finalTurn.isDone, true);
        assert.equal(finalTurn.stopReason, 'step_limit');
    });

    test('5. A tool that throws with onToolError: throw policy rejects', async () => {
        const failingTool = {
            name: 'failing_tool',
            func: async () => {
                throw new Error('Database connection failed');
            }
        };

        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
            name: 'failing_tool',
            args: {},
            call_id: 'call_fail'
        }));

        const llm = new LLMService({ provider: 'fake' });
        const agent = new Agent(llm, { name: 'error-agent', tools: [failingTool], onToolError: 'throw' });
        agent.addInput({ role: 'user', content: 'Execute failing tool' });

        await assert.rejects(
            async () => { await agent.run(); },
            /Database connection failed/
        );
    });

    test('6. A provider that throws', async () => {
        fakeProvider.setHandler(() => {
            throw new Error('Network connection timeout');
        });

        const llm = new LLMService({ provider: 'fake' });
        // Set low retry delay for fast test execution
        const agent = new Agent(llm, { name: 'provider-error-agent', maxRetries: 1, initialDelay: 10 });
        agent.addInput({ role: 'user', content: 'Hello' });

        await assert.rejects(
            async () => { await agent.run(); },
            (err) => {
                const isCauseMatch = err.cause?.message === 'Network connection timeout';
                const isDirectMatch = /Network connection timeout|RetryExhausted/.test(err.message);
                assert.ok(isCauseMatch || isDirectMatch);
                return true;
            }
        );
    });
});
