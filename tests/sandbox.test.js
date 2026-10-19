import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    WorkerSandbox,
    DenoSandbox,
    assertSandbox,
    createSandbox,
} from '../src/tools/sandbox/index.js';
import { Agent } from '../src/core/agent.js';
import { LLMService } from '../src/services/llm-service.js';
import { registerProvider } from '../src/providers/registry.js';
import { defineTool } from '../src/tools/define-tool.js';
import { isToolResult } from '../src/memory/message.js';
import * as FakeProvider from './helpers/fake-provider.js';

describe('Sandbox Infrastructure (Contract, WorkerSandbox & Factory)', () => {

    describe('assertSandbox & Factory', () => {
        test('validates conformance to the Sandbox contract', () => {
            const valid = { run: async () => ({ result: 1, logs: '', error: null }) };
            assert.doesNotThrow(() => assertSandbox(valid));

            assert.throws(() => assertSandbox(null), {
                name: 'TypeError',
                message: /non-null object/i,
            });
            assert.throws(() => assertSandbox({}), {
                name: 'TypeError',
                message: /must implement 'run\(code, options\)'/i,
            });
            assert.throws(() => assertSandbox({ run: 'not a function' }), {
                name: 'TypeError',
            });
        });

        test('createSandbox instantiates WorkerSandbox by default and DenoSandbox when requested', () => {
            const workerBox = createSandbox();
            assert.ok(workerBox instanceof WorkerSandbox);

            const denoBox = createSandbox({ type: 'deno' });
            assert.ok(denoBox instanceof DenoSandbox);
        });
    });

    describe('WorkerSandbox Execution', () => {
        test('evaluates expressions and returns result', async () => {
            const sandbox = new WorkerSandbox();
            const res = await sandbox.run('return 10 * 4;');

            assert.equal(res.result, 40);
            assert.equal(res.logs, '');
            assert.equal(res.error, null);
        });

        test('captures console logs in order', async () => {
            const sandbox = new WorkerSandbox();
            const code = `
                console.log("start");
                console.info("info", 123);
                console.warn({ key: "val" });
                return "done";
            `;
            const res = await sandbox.run(code);

            assert.equal(res.result, 'done');
            assert.match(res.logs, /start/);
            assert.match(res.logs, /info 123/);
            assert.match(res.logs, /\{"key":"val"\}/);
        });

        test('brokers tool calls over parentPort through onToolCall callback', async () => {
            const sandbox = new WorkerSandbox();
            const stubs = `
                async function fetchUser(args) { return __callTool("fetchUser", args); }
                async function getOrders(args) { return __callTool("getOrders", args); }
            `;
            const code = `
                const user = await fetchUser({ id: 42 });
                console.log("User:", user.name);
                const orders = await getOrders({ userId: user.id });
                return { name: user.name, orderCount: orders.length };
            `;

            const calls = [];
            const onToolCall = async (name, args) => {
                calls.push({ name, args });
                if (name === 'fetchUser') return { id: args.id, name: 'Alice' };
                if (name === 'getOrders') return [{ id: 1 }, { id: 2 }];
                throw new Error(`Unknown tool: ${name}`);
            };

            const res = await sandbox.run(code, { stubs, onToolCall });

            assert.equal(res.error, null);
            assert.deepEqual(res.result, { name: 'Alice', orderCount: 2 });
            assert.match(res.logs, /User: Alice/);
            assert.equal(calls.length, 2);
            assert.deepEqual(calls[0], { name: 'fetchUser', args: { id: 42 } });
            assert.deepEqual(calls[1], { name: 'getOrders', args: { userId: 42 } });
        });

        test('handles tool error caught inside script', async () => {
            const sandbox = new WorkerSandbox();
            const stubs = `async function riskyTool(args) { return __callTool("riskyTool", args); }`;
            const code = `
                try {
                    await riskyTool({ flag: true });
                } catch (err) {
                    console.log("Caught:", err.message);
                    return "fallback";
                }
            `;

            const onToolCall = async () => {
                throw new Error("Disk full");
            };

            const res = await sandbox.run(code, { stubs, onToolCall });

            assert.equal(res.error, null);
            assert.equal(res.result, 'fallback');
            assert.match(res.logs, /Caught: Disk full/);
        });

        test('returns uncaught script error in error property', async () => {
            const sandbox = new WorkerSandbox();
            const code = `throw new Error("Syntax error or fatal logic");`;

            const res = await sandbox.run(code);

            assert.equal(res.result, undefined);
            assert.ok(res.error instanceof Error);
            assert.match(res.error.message, /fatal logic/);
        });

        test('terminates runaway script upon timeoutMS expiry', async () => {
            const sandbox = new WorkerSandbox();
            const code = `while (true) {}`;

            const res = await sandbox.run(code, { timeoutMS: 150 });

            assert.equal(res.result, undefined);
            assert.ok(res.error instanceof Error);
            assert.match(res.error.message, /timed out after 150ms/i);
        });

        test('cancels script when caller AbortSignal fires', async () => {
            const sandbox = new WorkerSandbox();
            const controller = new AbortController();
            const code = `
                await new Promise(() => {}); // never resolves
            `;

            setTimeout(() => controller.abort(new Error("User stopped")), 50);

            const res = await sandbox.run(code, { signal: controller.signal });

            assert.equal(res.result, undefined);
            assert.ok(res.error instanceof Error);
            assert.match(res.error.message, /User stopped|cancelled/i);
        });

        test('truncates logs exceeding maxLogBytes', async () => {
            const sandbox = new WorkerSandbox();
            const code = `
                for (let i = 0; i < 200; i++) {
                    console.log("A very long log line number " + i + " repeating to fill buffer.");
                }
                return "done";
            `;

            const res = await sandbox.run(code, { maxLogBytes: 256 });

            assert.equal(res.result, 'done');
            assert.match(res.logs, /\[\.\.\. truncated \d+ bytes \.\.\.\]/);
            assert.ok(Buffer.byteLength(res.logs, 'utf8') < 1000);
        });
    });

    describe('Agent-level Code Mode with FakeProvider', () => {
        test('executes scripted multi-tool workflow in WorkerSandbox without network', async () => {
            const fakeProvider = FakeProvider.createFakeProvider();
            registerProvider('fake', fakeProvider, 'Fake Provider');

            const listItems = defineTool(
                {
                    name: 'list_items',
                    description: 'List inventory items',
                    parameters: {
                        type: 'object',
                        properties: {},
                    },
                },
                async () => [
                    { sku: 'A1', stock: 12 },
                    { sku: 'B2', stock: 0 },
                    { sku: 'C3', stock: 5 },
                ]
            );

            const restockItem = defineTool(
                {
                    name: 'restock_item',
                    description: 'Order restock for an out-of-stock SKU',
                    parameters: {
                        type: 'object',
                        properties: {
                            sku: { type: 'string' },
                            quantity: { type: 'number' },
                        },
                        required: ['sku', 'quantity'],
                    },
                },
                async ({ sku, quantity }) => ({ sku, ordered: quantity })
            );

            fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
                name: 'run_tool_script',
                args: {
                    code: `
                        const items = await list_items();
                        const outOfStock = items.filter(i => i.stock === 0);
                        const orders = [];
                        for (const item of outOfStock) {
                            orders.push(await restock_item({ sku: item.sku, quantity: 20 }));
                        }
                        console.log("Restocked " + orders.length + " SKUs");
                        return orders;
                    `,
                },
                call_id: 'call_sandbox_agent_1',
            }));

            fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('Restocked SKU B2 with 20 units.'));

            const llm = new LLMService({ provider: 'fake' });
            const agent = new Agent(llm, {
                name: 'sandbox-inventory-agent',
                codeMode: true,
                tools: [listItems, restockItem],
            });
            agent.addInput({ role: 'user', content: 'Restock any out-of-stock items with 20 units.' });

            const history = await agent.run();
            assert.equal(history.length, 2);

            const toolResultMsg = history[0].context.getMessages().find(isToolResult);
            assert.ok(toolResultMsg);
            assert.deepEqual(toolResultMsg.output.result, [{ sku: 'B2', ordered: 20 }]);
            assert.match(toolResultMsg.output.logs, /Restocked 1 SKUs/);
            assert.equal(history[1].output, 'Restocked SKU B2 with 20 units.');
        });
    });
});
