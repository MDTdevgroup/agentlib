import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/core/agent.js';
import { LLMService } from '../src/services/llm-service.js';
import { registerProvider } from '../src/providers/registry.js';
import * as FakeProvider from './helpers/fake-provider.js';

describe('Agent with Lazy MCP Servers (tests/agent-lazy-servers.test.js)', () => {
    let fakeProvider;

    beforeEach(() => {
        fakeProvider = FakeProvider.createFakeProvider();
        registerProvider('fake-lazy-mcp', fakeProvider, 'Fake Lazy MCP Provider');
    });

    function createMockSource({ serverName, tools = [], description = '' }) {
        let connected = false;
        let closed = false;

        return {
            serverName,
            description,
            async connect() {
                connected = true;
            },
            async list() {
                return tools.map(t => ({
                    name: t.name,
                    description: t.description || '',
                    parameters: t.parameters || { type: 'object' },
                }));
            },
            async invoke(name, args, context) {
                const tool = tools.find(t => t.name === name);
                if (!tool) throw new Error(`Tool ${name} not found`);
                return tool.func ? await tool.func(args, context) : null;
            },
            getDeclarations() {
                return tools.map(t => ({
                    name: t.name,
                    description: t.description || '',
                    parameters: t.parameters || { type: 'object' },
                    type: 'function',
                }));
            },
            getTools() {
                return tools;
            },
            async close() {
                closed = true;
                connected = false;
            },
            describe() {
                return {
                    id: serverName,
                    kind: 'mcp',
                    title: serverName,
                    description: description || `Mock tools from ${serverName}`,
                    connected,
                };
            },
            isConnected: () => connected,
            isClosed: () => closed,
        };
    }

    test('1. Multi-turn Agent run: search_servers -> enable_server -> execute tool', async () => {
        let salesConnected = false;

        // Turn 1: Model calls search_servers to discover relevant servers
        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
            name: 'search_servers',
            args: { query: 'customer order database' },
            call_id: 'call_search_srv_1',
        }));

        // Turn 2: Model enables the sales_server mid-run
        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
            name: 'enable_server',
            args: { name: 'sales_server' },
            call_id: 'call_enable_srv_1',
        }));

        // Turn 3: Model executes the newly loaded tool
        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
            name: 'sales_server_find_orders',
            args: { customerId: 'cust-101' },
            call_id: 'call_find_orders_1',
        }));

        // Turn 4: Final response
        fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('Found 2 orders for cust-101.'));

        const llm = new LLMService({ provider: 'fake-lazy-mcp' });
        const agent = new Agent(llm, { name: 'lazy-mcp-agent' });

        // Register lazy server (no connection at startup!)
        agent.registerMCPServer('sales_server', { type: 'inMemory' }, {
            description: 'Customer orders and transactions database',
            sourceFactory: (opts) => {
                salesConnected = true;
                return createMockSource({
                    ...opts,
                    tools: [
                        {
                            name: 'sales_server_find_orders',
                            description: 'Find orders by customer ID',
                            parameters: {
                                type: 'object',
                                properties: { customerId: { type: 'string' } },
                                required: ['customerId'],
                            },
                            func: async ({ customerId }) => ([
                                { id: 'ord-1', customerId, amount: 49.99 },
                                { id: 'ord-2', customerId, amount: 120.00 },
                            ]),
                        },
                    ],
                });
            },
        });

        // Verify server is dormant before running
        assert.equal(salesConnected, false, 'Server must NOT be connected at registration');

        agent.addInput({ role: 'user', content: 'What orders does cust-101 have?' });
        const history = await agent.run();

        // 4 turns
        assert.equal(history.length, 4);

        // Turn 1: search_servers
        assert.equal(history[0].executedTools[0].name, 'search_servers');
        assert.deepEqual(history[0].executedTools[0].args, { query: 'customer order database' });

        // Turn 2: enable_server
        assert.equal(salesConnected, true, 'Server must be connected mid-run upon enable_server');
        assert.equal(history[1].executedTools[1].name, 'enable_server');
        assert.deepEqual(history[1].executedTools[1].args, { name: 'sales_server' });

        // Turn 3: execution of sales_server_find_orders
        assert.equal(history[2].executedTools[2].name, 'sales_server_find_orders');
        assert.deepEqual(history[2].executedTools[2].args, { customerId: 'cust-101' });

        const messages = history[2].context.getMessages();
        const ordersOutput = messages.find(m => m.type === 'function_call_output' && m.name === 'sales_server_find_orders');
        assert.ok(ordersOutput);
        assert.equal(ordersOutput.output.length, 2);
        assert.equal(ordersOutput.output[0].id, 'ord-1');

        // Turn 4: completion
        assert.equal(history[3].isDone, true);
        assert.equal(history[3].output, 'Found 2 orders for cust-101.');

        // Clean up
        await agent.cleanup();
    });

    test('2. Disabling server at conversation boundary drops tools from subsequent turns', async () => {
        const llm = new LLMService({ provider: 'fake-lazy-mcp' });
        const agent = new Agent(llm, { name: 'boundary-agent' });

        let mockSource;
        agent.registerMCPServer('temp_server', {}, {
            description: 'Temporary tools',
            sourceFactory: (opts) => {
                mockSource = createMockSource({
                    ...opts,
                    tools: [
                        { name: 'temp_tool', func: async () => 'temp_ok' },
                    ],
                });
                return mockSource;
            },
        });

        // Programmatic enable
        await agent.enableMCPServer('temp_server');
        assert.equal(agent.toolLoader.getToolDeclarations().length, 1);
        assert.ok(agent.toolLoader.findTool('temp_tool'));

        // Turn 1: Model calls disable_server
        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
            name: 'disable_server',
            args: { name: 'temp_server' },
            call_id: 'call_dis_1',
        }));
        // Turn 2: Confirmation
        fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('Server disabled.'));

        agent.addInput({ role: 'user', content: 'Disable temp_server please' });
        const history = await agent.run();

        assert.equal(history.length, 2);
        assert.equal(history[0].executedTools[0].name, 'disable_server');

        // Tools removed from agent's loader
        assert.equal(agent.toolLoader.getToolDeclarations().length, 0);
        assert.equal(agent.toolLoader.findTool('temp_tool'), null);

        // Underlying connection kept warm
        assert.equal(mockSource.isClosed(), false);

        // Disabling with disconnect: true programmatically closes connection
        await agent.disableMCPServer('temp_server', { disconnect: true });
        assert.ok(mockSource.isClosed());
    });

    test('3. Progressive exposure combined with lazy server connects and updates metaTools', async () => {
        // Turn 1: Model searches servers
        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
            name: 'search_servers',
            args: { query: 'math analytics' },
            call_id: 'call_p_1',
        }));

        // Turn 2: Model enables server
        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
            name: 'enable_server',
            args: { name: 'math_server' },
            call_id: 'call_p_2',
        }));

        // Turn 3: Model calls get_tool_details to inspect the newly loaded tool
        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
            name: 'get_tool_details',
            args: { names: ['math_server_sqrt'] },
            call_id: 'call_p_3',
        }));

        // Turn 4: Model executes discovered tool
        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
            name: 'math_server_sqrt',
            args: { n: 16 },
            call_id: 'call_p_4',
        }));

        // Turn 5: Final text
        fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('Square root of 16 is 4.'));

        const llm = new LLMService({ provider: 'fake-lazy-mcp' });
        const agent = new Agent(llm, {
            name: 'progressive-lazy-agent',
            toolExposure: 'progressive',
            toolExposureOptions: { mode: 'expand' },
        });

        agent.registerMCPServer('math_server', {}, {
            description: 'Advanced mathematics and analytics algorithms',
            sourceFactory: (opts) => createMockSource({
                ...opts,
                tools: [
                    {
                        name: 'math_server_sqrt',
                        description: 'Calculates square root',
                        parameters: {
                            type: 'object',
                            properties: { n: { type: 'number' } },
                            required: ['n'],
                        },
                        func: async ({ n }) => Math.sqrt(n),
                    },
                ],
            }),
        });

        agent.addInput({ role: 'user', content: 'What is sqrt(16)?' });
        const history = await agent.run();

        assert.equal(history.length, 5);
        assert.equal(history[0].executedTools[0].name, 'search_servers');
        assert.equal(history[1].executedTools[1].name, 'enable_server');
        assert.equal(history[2].executedTools[2].name, 'get_tool_details');
        assert.equal(history[3].executedTools[3].name, 'math_server_sqrt');
        assert.deepEqual(history[3].executedTools[3].args, { n: 16 });

        const messages = history[3].context.getMessages();
        const mathOutput = messages.find(m => m.type === 'function_call_output' && m.name === 'math_server_sqrt');
        assert.ok(mathOutput);
        assert.equal(mathOutput.output, 4);

        assert.equal(history[4].output, 'Square root of 16 is 4.');

        await agent.cleanup();
    });
});
