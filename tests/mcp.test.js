import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import EventEmitter from 'node:events';
import { McpServer, InMemoryTransport, createMcpHandler, fromJsonSchema } from '@modelcontextprotocol/server';
import MCPClient, { DEFAULT_CLIENT_INFO } from '../src/mcp/mcp-client.js';
import { Agent } from '../src/core/agent.js';
import { LLMService } from '../src/services/llm-service.js';
import { registerProvider } from '../src/providers/registry.js';
import * as FakeProvider from './helpers/fake-provider.js';
import { isException } from '../src/util/exception.js';

describe('Model Context Protocol (MCP) Integration & Error Routing (SDK v2)', () => {
    test('MCPClient reports library identity and accessor', () => {
        const client = new MCPClient();
        assert.deepEqual(client.getClientInfo(), DEFAULT_CLIENT_INFO);
        assert.equal(client.getClientInfo().name, '@peebles-group/agentlib-js');
        assert.equal(client.getClientInfo().version, '4.1.0');
    });

    test('MCPClient validates transport URLs and schemes', async () => {
        const client = new MCPClient();

        await assert.rejects(
            async () => client.connectToServer({ type: 'streamableHttp', url: 'file:///etc/passwd' }),
            /Invalid Streamable HTTP URL protocol 'file:'/
        );

        await assert.rejects(
            async () => client.connectToServer({ type: 'streamableHttp', url: 'ftp://example.com' }),
            /Invalid Streamable HTTP URL protocol 'ftp:'/
        );

        await assert.rejects(
            async () => client.connectToServer({ type: 'streamableHttp', url: '' }),
            /Streamable HTTP transport requires a valid server URL/
        );

        await assert.rejects(
            async () => client.connectToServer({ type: 'sse', url: 'https://example.com' }),
            /Invalid server type: sse/
        );
    });

    test('MCPClient enforces re-entrancy protection', async () => {
        const server = new McpServer({ name: 'reentrant-test', version: '1.0.0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);

        const client = new MCPClient();
        await client.connectToServer({ type: 'inMemory', transport: clientTransport });

        await assert.rejects(
            async () => client.connectToServer({ type: 'inMemory', transport: clientTransport }),
            /MCPClient is already connected/
        );

        await client.disconnect();
        await server.close();
    });

    test('ToolLoader and Agent propagate eventEmitter to MCPManager and emit mcp:error on failure', async () => {
        const fakeProvider = FakeProvider.createFakeProvider();
        registerProvider('fake-mcp-test', fakeProvider);
        const llm = new LLMService({ provider: 'fake-mcp-test' });

        const mcpErrors = [];
        const eventEmitter = new EventEmitter();
        eventEmitter.on('mcp:error', (evt) => mcpErrors.push(evt));

        const agent = new Agent(llm, { name: 'mcp-agent', eventEmitter, enableMCP: true });
        assert.equal(agent.toolLoader.events, eventEmitter);
        assert.equal(agent.toolLoader.mcpManager.events, eventEmitter);

        await assert.rejects(
            async () => {
                await agent.addMCPServer('bad-server', { type: 'invalid_transport' });
            }
        );

        assert.ok(mcpErrors.length >= 1, 'mcp:error must be emitted on connection failure');
        assert.equal(mcpErrors[0].serverName, 'bad-server');
        assert.equal(mcpErrors[0].action, 'connect');
    });

    test('InMemory MCP server contract: tools, structuredContent, instructions, and error mapping', async () => {
        const server = new McpServer(
            { name: 'in-memory-service', version: '1.2.3' },
            { instructions: 'Use calculate-tax for tax operations.' }
        );

        server.registerTool(
            'calculate_tax',
            {
                description: 'Calculates tax for an amount',
                inputSchema: fromJsonSchema({
                    type: 'object',
                    properties: {
                        amount: { type: 'number' },
                        rate: { type: 'number' },
                    },
                    required: ['amount', 'rate'],
                }),
                outputSchema: fromJsonSchema({
                    type: 'object',
                    properties: {
                        tax: { type: 'number' },
                        total: { type: 'number' },
                    },
                    required: ['tax', 'total'],
                }),
            },
            async ({ amount, rate }) => {
                if (rate < 0) {
                    return {
                        content: [{ type: 'text', text: 'Tax rate cannot be negative' }],
                        isError: true,
                    };
                }
                const tax = amount * rate;
                return {
                    content: [{ type: 'text', text: `Tax: $${tax}, Total: $${amount + tax}` }],
                    structuredContent: { tax, total: amount + tax },
                };
            }
        );

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);

        const client = new MCPClient();
        await client.connectToServer({ type: 'inMemory', transport: clientTransport });

        // 1. Check declarations and names
        const names = client.listNames();
        assert.deepEqual(names, ['calculate_tax']);
        const declarations = client.listDeclarations();
        assert.equal(declarations.length, 1);
        assert.equal(declarations[0].name, 'calculate_tax');
        assert.equal(declarations[0].description, 'Calculates tax for an amount');
        assert.ok(declarations[0].parameters);
        assert.ok(declarations[0].outputSchema);

        // 2. Check instructions
        assert.equal(client.getInstructions(), 'Use calculate-tax for tax operations.');

        // 3. Happy path execution with structuredContent
        const result = await client.executeTool('calculate_tax', { amount: 100, rate: 0.15 });
        assert.ok(Array.isArray(result.content));
        assert.equal(result.content[0].text, 'Tax: $15, Total: $115');
        assert.deepEqual(result.structuredContent, { tax: 15, total: 115 });

        // 4. Error path (isError: true) mapped to structured Exception
        await assert.rejects(
            async () => client.executeTool('calculate_tax', { amount: 100, rate: -0.05 }),
            (err) => {
                assert.ok(isException(err), 'Must be structured Exception');
                assert.equal(err.type, 'ToolExecutionFailed');
                assert.equal(err.payload.toolName, 'calculate_tax');
                assert.equal(err.payload.isError, true);
                assert.match(err.message, /Tax rate cannot be negative/);
                return true;
            }
        );

        await client.disconnect();
        await server.close();
    });

    test('Cancellation signal aborts in-flight tool execution', async () => {
        const server = new McpServer({ name: 'hang-server', version: '1.0.0' });
        server.registerTool(
            'hang_tool',
            {
                description: 'Hangs until aborted',
                inputSchema: fromJsonSchema({ type: 'object' }),
            },
            async (args, ctx) => {
                await new Promise((_, reject) => {
                    ctx.mcpReq.signal.addEventListener('abort', () => reject(new Error('Server side aborted')));
                });
                return { content: [] };
            }
        );

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);

        const client = new MCPClient();
        await client.connectToServer({ type: 'inMemory', transport: clientTransport });

        const controller = new AbortController();
        setTimeout(() => controller.abort(), 40);

        await assert.rejects(
            async () => client.executeTool('hang_tool', {}, { signal: controller.signal }),
            (err) => {
                assert.match(err.name, /SdkError|AbortError/);
                return true;
            }
        );

        await client.disconnect();
        await server.close();
    });

    test('Streamable HTTP in-process test negotiates modern 2026-07-28 era', async () => {
        const handler = createMcpHandler(() => {
            const server = new McpServer({ name: 'http-in-process-server', version: '1.0.0' });
            server.registerTool(
                'status_check',
                {
                    description: 'Checks server status',
                    inputSchema: fromJsonSchema({ type: 'object' }),
                },
                async () => ({
                    content: [{ type: 'text', text: 'System OK' }],
                    structuredContent: { status: 'healthy', timestamp: Date.now() },
                })
            );
            return server;
        });

        const client = new MCPClient();
        await client.connectToServer({
            type: 'streamableHttp',
            url: 'http://test.local/mcp',
            fetch: (url, init) => handler.fetch(new Request(url, init)),
        });

        assert.equal(client.getNegotiatedProtocolVersion(), '2026-07-28');
        assert.deepEqual(client.listNames(), ['status_check']);

        const res = await client.executeTool('status_check', {});
        assert.equal(res.content[0].text, 'System OK');
        assert.equal(res.structuredContent.status, 'healthy');

        await client.disconnect();
        await handler.close();
    });
});
