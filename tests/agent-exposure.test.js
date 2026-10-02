import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/core/agent.js';
import { LLMService } from '../src/services/llm-service.js';
import { registerProvider } from '../src/providers/registry.js';
import * as FakeProvider from './helpers/fake-provider.js';

describe('Agent with Progressive Tool Exposure (agent-exposure.test.js)', () => {
    let fakeProvider;

    beforeEach(() => {
        fakeProvider = FakeProvider.createFakeProvider();
        registerProvider('fake', fakeProvider, 'Fake Provider');
    });

    const addTool = {
        name: 'add',
        description: 'Add two numbers',
        parameters: {
            type: 'object',
            properties: {
                a: { type: 'number' },
                b: { type: 'number' },
            },
            required: ['a', 'b'],
        },
        func: async ({ a, b }) => a + b,
    };

    const multiplyTool = {
        name: 'multiply',
        description: 'Multiply two numbers',
        parameters: {
            type: 'object',
            properties: {
                a: { type: 'number' },
                b: { type: 'number' },
            },
            required: ['a', 'b'],
        },
        func: async ({ a, b }) => a * b,
    };

    test('1. Default toolExposure is "all" and exposes all tools upfront', async () => {
        fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('Hello!'));

        const llm = new LLMService({ provider: 'fake' });
        const agent = new Agent(llm, { name: 'eager-agent', tools: [addTool, multiplyTool] });
        agent.addInput({ role: 'user', content: 'Hi' });

        const history = await agent.run();
        assert.equal(history.length, 1);
        assert.equal(history[0].isDone, true);

        // Verify provider saw all tools
        const calls = fakeProvider.getCalls();
        const lastCall = calls[calls.length - 1];
        const wireToolNames = lastCall.options.tools.map(t => t.name);
        assert.deepEqual(wireToolNames, ['add', 'multiply']);
    });

    test('2. Progressive discovery (expand mode): search -> details -> call discovered tool', async () => {
        // Turn 1: Model calls search_tools to discover capability
        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
            name: 'search_tools',
            args: { query: 'math add numbers' },
            call_id: 'call_search_1',
        }));

        // Turn 2: Model calls get_tool_details to inspect parameter schema
        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
            name: 'get_tool_details',
            args: { names: ['add'] },
            call_id: 'call_details_1',
        }));

        // Turn 3: Model calls the newly discovered "add" tool directly (it is now on wire)
        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
            name: 'add',
            args: { a: 5, b: 7 },
            call_id: 'call_add_1',
        }));

        // Turn 4: Final response
        fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('The sum is 12.'));

        const llm = new LLMService({ provider: 'fake' });
        const agent = new Agent(llm, {
            name: 'progressive-agent',
            toolExposure: 'progressive',
            toolExposureOptions: { mode: 'expand' },
            tools: [addTool, multiplyTool],
        });
        agent.addInput({ role: 'user', content: 'Please calculate 5 + 7' });

        const history = await agent.run();

        // 4 turns: Turn 1 (search), Turn 2 (details), Turn 3 (add), Turn 4 (final answer)
        assert.equal(history.length, 4);

        // Turn 1: wire tools only have search_tools, get_tool_details
        assert.deepEqual(history[0].exposure.discovered, []);
        assert.equal(history[0].executedTools[0].name, 'search_tools');

        // Turn 2: details inspects 'add', updating discovered set
        assert.deepEqual(history[1].exposure.discovered, ['add']);
        assert.equal(history[1].executedTools[1].name, 'get_tool_details');

        // Turn 3: 'add' was on wire and executed
        assert.equal(history[2].executedTools[2].name, 'add');
        assert.deepEqual(history[2].executedTools[2].args, { a: 5, b: 7 });

        // Turn 4: complete
        assert.equal(history[3].isDone, true);
        assert.equal(history[3].output, 'The sum is 12.');

        // Verify wire tools in Turn 3 included 'add'
        const calls = fakeProvider.getCalls();
        const turn3Call = calls[2];
        const turn3ToolNames = turn3Call.options.tools.map(t => t.name);
        assert.ok(turn3ToolNames.includes('add'), 'Discovered tool "add" must be present on wire in turn 3');
    });

    test('3. Progressive discovery (facade mode): invokes target tool via call_tool', async () => {
        // Turn 1: Model calls call_tool directly
        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
            name: 'call_tool',
            args: {
                name: 'multiply',
                arguments: { a: 6, b: 7 },
            },
            call_id: 'call_facade_1',
        }));

        // Turn 2: Final response
        fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('The product is 42.'));

        const llm = new LLMService({ provider: 'fake' });
        const agent = new Agent(llm, {
            name: 'facade-agent',
            toolExposure: 'progressive',
            toolExposureOptions: { mode: 'facade' },
            tools: [addTool, multiplyTool],
        });
        agent.addInput({ role: 'user', content: 'What is 6 * 7?' });

        const history = await agent.run();
        assert.equal(history.length, 2);

        // Wire tools in facade mode never include 'multiply' directly
        const calls = fakeProvider.getCalls();
        const lastCall = calls[calls.length - 1];
        const wireToolNames = lastCall.options.tools.map(t => t.name);
        assert.ok(!wireToolNames.includes('multiply'));
        assert.ok(wireToolNames.includes('call_tool'));

        assert.equal(history[0].executedTools[0].name, 'call_tool');
        assert.deepEqual(history[0].exposure.discovered, ['multiply']);
        assert.equal(history[1].output, 'The product is 42.');
    });

    test('4. Auto policy activates progressive mode when declarations exceed threshold', async () => {
        // Force low threshold to trigger auto switch
        fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('Switched auto response'));

        const llm = new LLMService({ provider: 'fake' });
        const agent = new Agent(llm, {
            name: 'auto-agent',
            toolExposure: 'auto',
            toolExposureOptions: { thresholdRatio: 0.0001 }, // Extremely low threshold
            tools: [addTool, multiplyTool],
        });
        agent.addInput({ role: 'user', content: 'Hello' });

        const history = await agent.run();
        assert.equal(history.length, 1);
        assert.equal(history[0].isDone, true);

        // Under low threshold, wire declarations should have meta-tools
        const calls = fakeProvider.getCalls();
        const lastCall = calls[calls.length - 1];
        const wireToolNames = lastCall.options.tools.map(t => t.name);
        assert.ok(wireToolNames.includes('search_tools'));
        assert.ok(wireToolNames.includes('get_tool_details'));
    });

    test('5. Time-travel branching preserves isolated exposure states without leak', async () => {
        // Turn 1: Model inspects "add"
        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
            name: 'get_tool_details',
            args: { names: ['add'] },
            call_id: 'call_1',
        }));

        const llm = new LLMService({ provider: 'fake' });
        const agent = new Agent(llm, {
            name: 'branch-agent',
            toolExposure: 'progressive',
            tools: [addTool, multiplyTool],
        });
        agent.addInput({ role: 'user', content: 'Start turn' });

        const turn1 = await agent.start();
        assert.deepEqual(turn1.exposure.discovered, ['add']);

        // Now branch from turn1 with different path:
        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
            name: 'get_tool_details',
            args: { names: ['multiply'] },
            call_id: 'call_branch_1',
        }));
        fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('Done with branch'));

        const branchHistory = await agent.branch(turn1);
        assert.equal(branchHistory.length, 3); // turn1 + branch turn 1 + branch final

        // Branch discovered both 'add' (inherited from turn1) and 'multiply'
        assert.deepEqual(branchHistory[1].exposure.discovered, ['add', 'multiply']);

        // Original turn1 object remains untouched with only ['add']
        assert.deepEqual(turn1.exposure.discovered, ['add']);
    });
});
