import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/core/agent.js';
import { LLMService } from '../src/services/llm-service.js';
import { registerProvider } from '../src/providers/registry.js';
import * as FakeProvider from './helpers/fake-provider.js';
import { isToolResult } from '../src/memory/message.js';

describe('Agent Tool Output Archiving Lifecycle (Pi-style)', () => {
    let fakeProvider;

    beforeEach(() => {
        fakeProvider = FakeProvider.createFakeProvider();
        registerProvider('fake', fakeProvider, 'Fake Provider');
    });

    const fetchOrdersTool = {
        name: 'fetch_orders',
        description: 'Fetches recent customer orders',
        parameters: {
            type: 'object',
            properties: {
                limit: { type: 'number' },
            },
        },
        func: async ({ limit = 30 }) => {
            return Array.from({ length: limit }, (_, i) => ({
                orderId: `ord_${1000 + i}`,
                customer: `customer_${i}`,
                amount: (i + 1) * 15.5,
                items: [`item_${i}_A`, `item_${i}_B`],
            }));
        },
    };

    test('1. active turn keeps full raw tool output, then subsequent turns use archived disk handles with on-demand retrieval', async () => {
        // Turn 1: Model requests fetch_orders
        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
            name: 'fetch_orders',
            args: { limit: 25 },
            call_id: 'call_orders_1',
        }));

        // Turn 2: Model sees the archived notice in history and calls retrieve_tool_output to inspect customer_7
        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
            name: 'retrieve_tool_output',
            args: { id: 't1', query: 'customer_7' },
            call_id: 'call_retrieve_1',
        }));

        // Turn 3: Model responds with final answer
        fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('Order for customer_7 is ord_1007 with amount $124.00.'));

        const llm = new LLMService({ provider: 'fake' });
        const agent = new Agent(llm, {
            name: 'archiving-agent',
            archiveToolOutputs: { thresholdBytes: 150 }, // low threshold so 25 orders easily exceeds
            tools: [fetchOrdersTool],
        });
        agent.addInput({ role: 'user', content: 'Find customer_7 order' });

        // Start Turn 1
        const turn1 = await agent.start();
        assert.equal(turn1.isDone, false);
        assert.equal(turn1.executedTools[0].name, 'fetch_orders');

        // CRITICAL CHECK 1: In the active Turn 1, the context contains the FULL RAW output!
        const turn1Messages = turn1.context.getMessages();
        const turn1Result = turn1Messages.find(isToolResult);
        assert.ok(turn1Result);
        assert.equal(Array.isArray(turn1Result.output), true);
        assert.equal(turn1Result.output.length, 25);
        assert.equal(turn1Result.output[7].customer, 'customer_7');
        assert.equal(turn1Result.output._archived, undefined); // Not yet archived in active turn!

        // Transition to Turn 2: turn1.next() triggers archiving of completed turn outputs
        const turn2 = await turn1.next();
        assert.equal(turn2.isDone, false);

        // CRITICAL CHECK 2: In Turn 2, the message sent to the wire has been replaced with the archive notice!
        const calls = fakeProvider.getCalls();
        const turn2WireMessages = calls[1].input;
        const turn2ToolResult = turn2WireMessages.find(m => m.type === 'function_call_output' && m.call_id === 'call_orders_1');
        assert.ok(turn2ToolResult);
        assert.equal(turn2ToolResult.output._archived, true);
        assert.equal(turn2ToolResult.output.id, 't1');
        assert.match(turn2ToolResult.output.notice, /t1/);

        // Turn 2 executed retrieve_tool_output
        assert.equal(turn2.executedTools[1].name, 'retrieve_tool_output');

        // Transition to Turn 3: final completion
        const turn3 = await turn2.next();
        assert.equal(turn3.isDone, true);
        assert.match(turn3.output, /customer_7/);

        await agent.cleanup();
    });

    test('2. retrieve_tool_output tool is exposed in tool declarations when archiveToolOutputs is active', async () => {
        fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('Hello!'));

        const llm = new LLMService({ provider: 'fake' });
        const agent = new Agent(llm, {
            name: 'exposure-agent',
            archiveToolOutputs: true,
            tools: [fetchOrdersTool],
        });
        agent.addInput({ role: 'user', content: 'Hi' });

        await agent.run();

        const calls = fakeProvider.getCalls();
        const wireTools = calls[0].options.tools.map(t => t.name);

        assert.ok(wireTools.includes('retrieve_tool_output'));
        assert.ok(wireTools.includes('fetch_orders'));

        await agent.cleanup();
    });
});
