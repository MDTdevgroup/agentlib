import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import EventEmitter from 'node:events';
import MCPClient from '../src/mcp/mcp-client.js';
import { Agent } from '../src/core/agent.js';
import { LLMService } from '../src/services/llm-service.js';
import { registerProvider } from '../src/providers/registry.js';
import * as FakeProvider from './helpers/fake-provider.js';

describe('Model Context Protocol (MCP) Integration & Error Routing', () => {
    test('MCPClient handles SSE transport routing without ReferenceError', async () => {
        const client = new MCPClient();
        // Connecting to a mock SSE server config will fail with connection error or url error,
        // but must NOT fail with "ReferenceError: SSEClientTransport is not defined"
        try {
            await client.connectToServer({ type: 'sse', url: 'http://localhost:9999/sse' });
        } catch (err) {
            assert.notEqual(err.name, 'ReferenceError', `Should not throw ReferenceError, got: ${err.message}`);
        }
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

        // Attempt invalid MCP connection
        await assert.rejects(
            async () => {
                await agent.addMCPServer('bad-server', { type: 'invalid_transport' });
            }
        );

        assert.ok(mcpErrors.length >= 1, 'mcp:error must be emitted on connection failure');
        assert.equal(mcpErrors[0].serverName, 'bad-server');
        assert.equal(mcpErrors[0].action, 'connect');
    });
});
