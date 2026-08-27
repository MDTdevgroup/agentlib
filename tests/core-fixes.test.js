import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getDefaultGeminiModel } from '../src/config.js';
import * as GeminiProvider from '../src/providers/gemini.js';
import MCPClient from '../src/mcp/mcp-client.js';
import { startA2AServer } from '../src/a2a/a2a-server.js';
import { AgentExecutorAdapter } from '../src/a2a/agent-executor-adapter.js';
import { Agent } from '../src/core/agent.js';
import { LLMService } from '../src/services/llm-service.js';
import { registerProvider, validateProviderName } from '../src/providers/registry.js';
import * as FakeProvider from './helpers/fake-provider.js';

describe('Core Bug Fixes & Regressions', () => {
    test('Gemini provider default model is defined and does not throw ReferenceError', () => {
        assert.ok(getDefaultGeminiModel(), 'getDefaultGeminiModel must be exported by config.js');
        assert.equal(typeof GeminiProvider.chat, 'function');
    });

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

    test('startA2AServer is an async function with dynamic express import', () => {
        assert.equal(startA2AServer.constructor.name, 'AsyncFunction', 'startA2AServer must be async');
    });

    test('Gemini chat does not replace or mutate global console.warn', async () => {
        const originalWarn = console.warn;
        let fakeClient = {
            models: {
                generateContent: async () => ({
                    candidates: [{ content: { parts: [{ text: 'response' }] } }],
                    text: () => 'response'
                })
            }
        };

        await GeminiProvider.chat(fakeClient, [{ role: 'user', content: 'hello' }], {});

        assert.equal(console.warn, originalWarn, 'console.warn must not be monkey-patched');
    });

    test('Provider registry separates key from display name', () => {
        registerProvider('anthropic', { createClient: () => ({}), chat: async () => {} }, 'Anthropic Claude');
        assert.equal(validateProviderName('anthropic'), 'anthropic');
        assert.equal(validateProviderName('Anthropic Claude'), 'anthropic');
    });

    test('AgentExecutorAdapter accesses agent context without TypeError', async () => {
        const fakeProvider = FakeProvider.createFakeProvider();
        fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('A2A response'));
        registerProvider('fake', fakeProvider);

        const llm = new LLMService({ provider: 'fake' });
        const agent = new Agent(llm, { name: 'a2a-test-agent' });
        const adapter = new AgentExecutorAdapter(agent);

        const publishedEvents = [];
        const mockEventBus = {
            publish: (event) => publishedEvents.push(event),
            finished: () => {}
        };

        const mockRequestContext = {
            taskId: 'task-1',
            contextId: 'ctx-1',
            userMessage: { parts: [{ kind: 'text', text: 'Hello A2A' }] },
            task: null
        };

        await adapter.execute(mockRequestContext, mockEventBus);

        const messageEvent = publishedEvents.find(e => e.kind === 'message');
        assert.ok(messageEvent, 'Should publish message event');
        assert.ok(messageEvent.parts[0].text.includes('A2A response'));
    });

    test('Agent trace metadata reads mcpInfo via toolLoader.getMCPInfo()', () => {
        const fakeProvider = FakeProvider.createFakeProvider();
        registerProvider('fake', fakeProvider);
        const llm = new LLMService({ provider: 'fake' });

        const traces = [];
        const eventEmitter = {
            emit: (name, payload) => traces.push({ name, payload })
        };

        const agent = new Agent(llm, { name: 'mcp-trace-agent', eventEmitter, enableMCP: false });
        agent.addInput({ role: 'user', content: 'hi' });

        // Trigger start
        agent.start();

        const startTrace = traces.find(t => t.name === 'agent:start');
        assert.ok(startTrace, 'agent:start trace must be emitted');
        assert.equal(startTrace.payload.attributes.mcp_enabled, false);
    });
});
