import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    startA2AServer,
    buildAgentCard,
    createRemoteAgentTool,
    A2AToolSource,
    createA2ASource,
} from '../src/a2a/index.js';
import { MCPToolSource } from '../src/tools/sources/index.js';
import { ToolLoader } from '../src/loaders/tool-loader.js';
import { exposeProgressive } from '../src/tools/exposure.js';
import { isException } from '../src/util/exception.js';
import { Agent } from '../src/core/agent.js';
import { LLMService } from '../src/services/llm-service.js';
import { registerProvider } from '../src/providers/registry.js';
import * as FakeProvider from './helpers/fake-provider.js';

describe('Phase 5: A2A Cohesion (tests/a2a-cohesion.test.js)', () => {
    let fakeProvider;

    beforeEach(() => {
        fakeProvider = FakeProvider.createFakeProvider();
        registerProvider('fake-a2a-cohesion', fakeProvider, 'Fake A2A Cohesion Provider');
    });

    describe('1. createRemoteAgentTool rebuilt on defineTool & withValidation', () => {
        test('returns a defineTool-shaped record and validates arguments with ToolArgumentInvalid', async () => {
            const mockClient = {
                sendMessage: async ({ message }) => ({
                    kind: 'message',
                    parts: [{ kind: 'text', text: `Echo: ${message.parts[0].text}` }],
                }),
            };

            const tool = await createRemoteAgentTool(
                'http://localhost:4000',
                'helper_agent',
                'Remote helper agent',
                { client: mockClient }
            );

            assert.equal(tool.name, 'helper_agent');
            assert.equal(tool.type, 'function');
            assert.equal(tool.description, 'Remote helper agent');
            assert.equal(typeof tool.func, 'function');
            assert.equal(tool.source.kind, 'a2a');

            // Compatible with ToolLoader.addTool
            const loader = new ToolLoader();
            assert.doesNotThrow(() => loader.addTool(tool));

            // Valid invocation
            const response = await tool.func({ request: 'Summarize Q3 earnings' });
            assert.equal(response, 'Echo: Summarize Q3 earnings');

            // Invalid arguments throw ToolArgumentInvalid Exception (from withValidation)
            await assert.rejects(
                async () => tool.func({}),
                (err) => {
                    assert.ok(isException(err));
                    assert.equal(err.type, 'ToolArgumentInvalid');
                    assert.match(err.message, /non-empty 'request' string/);
                    return true;
                }
            );

            await assert.rejects(
                async () => tool.func({ request: '   ' }),
                (err) => {
                    assert.ok(isException(err));
                    assert.equal(err.type, 'ToolArgumentInvalid');
                    return true;
                }
            );

            await assert.rejects(
                async () => tool.func(null),
                (err) => {
                    assert.ok(isException(err));
                    assert.equal(err.type, 'ToolArgumentInvalid');
                    return true;
                }
            );
        });
    });

    describe('2. Task Completion Polling & Streaming with Timeout', () => {
        test('polls non-terminal task (submitted -> working -> completed) and returns final output', async () => {
            let pollCount = 0;
            const mockClient = {
                sendMessage: async () => ({
                    kind: 'task',
                    id: 'task-101',
                    contextId: 'ctx-101',
                    status: { state: 'submitted' },
                }),
                getTask: async ({ id }) => {
                    assert.equal(id, 'task-101');
                    pollCount++;
                    if (pollCount < 3) {
                        return {
                            kind: 'task',
                            id: 'task-101',
                            contextId: 'ctx-101',
                            status: { state: 'working' },
                        };
                    }
                    return {
                        kind: 'task',
                        id: 'task-101',
                        contextId: 'ctx-101',
                        status: { state: 'completed' },
                        artifacts: [
                            {
                                parts: [{ kind: 'text', text: 'Completed report from remote agent.' }],
                            },
                        ],
                    };
                },
            };

            const tool = await createRemoteAgentTool(
                'http://localhost:4000',
                'report_agent',
                'Generates reports',
                { client: mockClient, pollIntervalMs: 15, timeoutMs: 2000 }
            );

            const output = await tool.func({ request: 'Generate annual report' });
            assert.equal(output, 'Completed report from remote agent.');
            assert.equal(pollCount, 3);
        });

        test('extracts completed task text from history when artifacts are absent', async () => {
            const mockClient = {
                sendMessage: async () => ({
                    kind: 'task',
                    id: 'task-hist-1',
                    status: { state: 'working' },
                }),
                getTask: async () => ({
                    kind: 'task',
                    id: 'task-hist-1',
                    status: { state: 'completed' },
                    history: [
                        { role: 'user', parts: [{ kind: 'text', text: 'Question' }] },
                        { role: 'agent', parts: [{ kind: 'text', text: 'Answer from task history' }] },
                    ],
                }),
            };

            const source = new A2AToolSource({
                remoteUrl: 'http://localhost:4000',
                toolName: 'hist_agent',
                client: mockClient,
                pollIntervalMs: 10,
                timeoutMs: 1000,
            });

            const res = await source.invoke('hist_agent', { request: 'Question' });
            assert.equal(res, 'Answer from task history');
        });

        test('returns structured pending result when task polling exceeds timeoutMs', async () => {
            let polls = 0;
            const mockClient = {
                sendMessage: async () => ({
                    kind: 'task',
                    id: 'task-slow-99',
                    contextId: 'ctx-slow-99',
                    status: { state: 'submitted' },
                }),
                getTask: async ({ id }) => {
                    polls++;
                    return {
                        kind: 'task',
                        id,
                        contextId: 'ctx-slow-99',
                        status: { state: 'working' },
                    };
                },
            };

            const tool = await createRemoteAgentTool(
                'http://localhost:4000',
                'slow_agent',
                'Slow remote agent',
                { client: mockClient, pollIntervalMs: 20, timeoutMs: 75 }
            );

            const result = await tool.func({ request: 'Long running computation' });
            assert.equal(typeof result, 'object');
            assert.equal(result.status, 'pending');
            assert.equal(result.taskId, 'task-slow-99');
            assert.equal(result.id, 'task-slow-99');
            assert.equal(result.state, 'working');
            assert.equal(result.contextId, 'ctx-slow-99');
            assert.match(result.message, /task-slow-99/);
            assert.ok(polls >= 1);
        });

        test('throws descriptive error when polled task transitions to failed state', async () => {
            const mockClient = {
                sendMessage: async () => ({
                    kind: 'task',
                    id: 'task-err-1',
                    status: { state: 'working' },
                }),
                getTask: async () => ({
                    kind: 'task',
                    id: 'task-err-1',
                    status: {
                        state: 'failed',
                        details: 'Upstream database connection refused',
                    },
                }),
            };

            const tool = await createRemoteAgentTool(
                'http://localhost:4000',
                'failing_agent',
                'Failing agent',
                { client: mockClient, pollIntervalMs: 10, timeoutMs: 1000 }
            );

            await assert.rejects(
                async () => tool.func({ request: 'Trigger failure' }),
                (err) => {
                    assert.match(err.message, /Upstream database connection refused/);
                    assert.equal(err.taskId, 'task-err-1');
                    assert.equal(err.state, 'failed');
                    return true;
                }
            );
        });

        test('supports streaming task completion via sendMessageStream', async () => {
            const mockClient = {
                async *sendMessageStream() {
                    yield {
                        kind: 'task',
                        id: 'task-stream-1',
                        contextId: 'ctx-s1',
                        status: { state: 'submitted' },
                    };
                    yield {
                        kind: 'status-update',
                        taskId: 'task-stream-1',
                        contextId: 'ctx-s1',
                        status: { state: 'working' },
                        final: false,
                    };
                    yield {
                        kind: 'message',
                        role: 'agent',
                        parts: [{ kind: 'text', text: 'Streamed response payload' }],
                    };
                    yield {
                        kind: 'status-update',
                        taskId: 'task-stream-1',
                        contextId: 'ctx-s1',
                        status: { state: 'completed' },
                        final: true,
                    };
                },
            };

            const source = createA2ASource('http://localhost:4000', {
                id: 'stream_peer',
                client: mockClient,
                timeoutMs: 1000,
            });

            const result = await source.invoke('stream_peer', { request: 'Stream test' });
            assert.equal(result, 'Streamed response payload');
        });
    });

    describe('3. createA2ASource Skill Derivation, search_tools & Lazy enable_server', () => {
        const peerAgentCard = {
            name: 'Financial Intelligence Peer',
            description: 'Provides stock market quotes, SEC filings, and portfolio risk metrics.',
            skills: [
                {
                    id: 'stock_quote',
                    name: 'Stock Quote Lookup',
                    description: 'Fetch real-time equity stock ticker price and volume.',
                    tags: ['finance', 'stocks'],
                },
                {
                    id: 'sec_filings',
                    name: 'SEC Filings Search',
                    description: 'Search 10-K and 10-Q regulatory filings for public companies.',
                    tags: ['finance', 'sec', 'regulatory'],
                },
            ],
        };

        test('createA2ASource.list() derives tool declarations from peer Agent Card skills', async () => {
            const mockClient = {
                getAgentCard: async () => peerAgentCard,
                sendMessage: async ({ message }) => ({
                    kind: 'message',
                    parts: [{ kind: 'text', text: `Skill [${message.metadata?.skillId}]: ${message.parts[0].text}` }],
                }),
            };

            const source = createA2ASource('http://localhost:4000', {
                id: 'fin_peer',
                client: mockClient,
            });

            const declarations = await source.list();
            assert.equal(declarations.length, 2);

            assert.equal(declarations[0].name, 'fin_peer_stock_quote');
            assert.match(declarations[0].description, /real-time equity stock ticker/);
            assert.equal(declarations[0].source.kind, 'a2a');
            assert.equal(declarations[0].source.serverName, 'fin_peer');
            assert.equal(declarations[0].source.remoteName, 'stock_quote');

            assert.equal(declarations[1].name, 'fin_peer_sec_filings');
            assert.match(declarations[1].description, /10-K and 10-Q/);

            // Invoke derived skill by qualified name
            const quoteRes = await source.invoke('fin_peer_stock_quote', { request: 'Check AAPL' });
            assert.equal(quoteRes, 'Skill [stock_quote]: Check AAPL');

            // Invoke derived skill by raw skill id
            const secRes = await source.invoke('sec_filings', { request: 'AAPL 10-K' });
            assert.equal(secRes, 'Skill [sec_filings]: AAPL 10-K');
        });

        test('remote agent skills appear alongside MCP tools in search_tools', async () => {
            const loader = new ToolLoader();

            // 1. Add an MCP source
            const mcpSource = new MCPToolSource({
                serverName: 'weather_mcp',
                tools: [
                    {
                        name: 'forecast',
                        description: 'Get 7-day meteorological weather forecast for a city',
                        func: async () => 'Sunny 22C',
                    },
                ],
            });
            loader.addSource(mcpSource);

            // 2. Add an A2A source with Agent Card skills
            const a2aSource = createA2ASource('http://localhost:4000', {
                id: 'fin_peer',
                agentCard: peerAgentCard,
                client: {
                    getAgentCard: async () => peerAgentCard,
                    sendMessage: async () => ({
                        kind: 'message',
                        parts: [{ kind: 'text', text: 'AAPL: $195.00' }],
                    }),
                },
            });
            loader.addSource(a2aSource);

            const fullCatalog = loader.getToolDeclarations();
            assert.equal(fullCatalog.length, 3); // 1 MCP + 2 A2A skills

            const exposure = await exposeProgressive(fullCatalog, {}, { toolLoader: loader });

            // Search for financial stock skill -> finds A2A skill
            const stockSearch = await exposure.resolve('search_tools', { query: 'equity stock ticker price' }, { toolLoader: loader });
            assert.equal(stockSearch.handled, true);
            assert.ok(stockSearch.result.results.some(m => m.name === 'fin_peer_stock_quote'));

            // Search for weather -> finds MCP tool
            const weatherSearch = await exposure.resolve('search_tools', { query: 'meteorological weather forecast' }, { toolLoader: loader });
            assert.equal(weatherSearch.handled, true);
            assert.ok(weatherSearch.result.results.some(m => m.name === 'weather_mcp_forecast'));
        });

        test('lazy createA2ASource connects on enable_server and exposes skills to Agent', async () => {
            let connectCalls = 0;

            const lazyA2A = createA2ASource('http://localhost:4050', {
                id: 'legal_peer',
                lazy: true,
                description: 'Contract compliance and patent law specialist agent',
                clientFactory: async () => {
                    connectCalls++;
                    return {
                        getAgentCard: async () => ({
                            name: 'Legal Peer',
                            description: 'Contract compliance and patent law specialist agent',
                            skills: [
                                {
                                    id: 'review_nda',
                                    name: 'Review NDA Clause',
                                    description: 'Analyze non-disclosure agreement clauses for risk',
                                },
                            ],
                        }),
                        sendMessage: async () => ({
                            kind: 'task',
                            id: 'legal-task-1',
                            status: { state: 'working' },
                        }),
                        getTask: async () => ({
                            kind: 'task',
                            id: 'legal-task-1',
                            status: { state: 'completed' },
                            artifacts: [
                                { parts: [{ kind: 'text', text: 'NDA Clause 4 is standard mutual confidentiality.' }] },
                            ],
                        }),
                    };
                },
                pollIntervalMs: 10,
            });

            // Turn 1: Model searches dormant servers
            fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
                name: 'search_servers',
                args: { query: 'contract compliance legal' },
                call_id: 'call_a2a_1',
            }));

            // Turn 2: Model enables legal_peer via enable_server
            fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
                name: 'enable_server',
                args: { name: 'legal_peer' },
                call_id: 'call_a2a_2',
            }));

            // Turn 3: Model searches tools and finds legal_peer_review_nda
            fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
                name: 'search_tools',
                args: { query: 'non-disclosure agreement NDA' },
                call_id: 'call_a2a_3',
            }));

            // Turn 4: Model invokes legal_peer_review_nda
            fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
                name: 'legal_peer_review_nda',
                args: { request: 'Check Clause 4' },
                call_id: 'call_a2a_4',
            }));

            // Turn 5: Final answer
            fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('Clause 4 is safe.'));

            const llm = new LLMService({ provider: 'fake-a2a-cohesion' });
            const agent = new Agent(llm, {
                name: 'orchestrator-agent',
                toolExposure: 'progressive',
                sources: [lazyA2A],
            });

            // Must not be connected before enable_server
            assert.equal(connectCalls, 0);
            assert.equal(agent.toolLoader.getToolDeclarations().length, 0);

            agent.addInput({ role: 'user', content: 'Please review Clause 4 of our NDA.' });
            const history = await agent.run();

            assert.equal(history.length, 5);
            assert.equal(connectCalls, 1, 'Lazy A2A peer connected exactly once during enable_server');

            // Verify Turn 4 tool result came from polled A2A task completion
            const turn4Messages = history[3].context.getMessages();
            const ndaOutput = turn4Messages.find(m => m.type === 'function_call_output' && m.name === 'legal_peer_review_nda');
            assert.ok(ndaOutput);
            assert.equal(ndaOutput.output, 'NDA Clause 4 is standard mutual confidentiality.');

            assert.equal(history[4].output, 'Clause 4 is safe.');
            await agent.cleanup();
        });
    });

    describe('4. startA2AServer & buildAgentCard Full Catalog Advertisement', () => {
        test('advertises the full tool catalog even when agent uses progressive exposure', async () => {
            const llm = new LLMService({ provider: 'fake-a2a-cohesion' });
            const agent = new Agent(llm, {
                name: 'progressive-specialist',
                toolExposure: 'progressive',
                tools: [
                    {
                        name: 'compute_var',
                        description: 'Compute Value at Risk for a portfolio',
                        parameters: {
                            type: 'object',
                            properties: { confidence: { type: 'number' } },
                        },
                        func: async () => ({ var95: 0.042 }),
                    },
                    {
                        name: 'stress_test',
                        description: 'Run macroeconomic stress test scenarios',
                        func: async () => ({ passed: true }),
                    },
                ],
            });

            // Even if getToolDeclarations were stubbed to return only revealed subset,
            // buildAgentCard / startA2AServer queries the full catalog.
            agent.toolLoader.getToolDeclarations = () => [];

            const card = await buildAgentCard(agent, { port: 4123, name: 'Risk Agent' });
            assert.equal(card.name, 'Risk Agent');
            assert.equal(card.skills.length, 2);
            assert.deepEqual(
                card.skills.map(s => s.id),
                ['compute_var', 'stress_test']
            );
            assert.equal(card.skills[0].description, 'Compute Value at Risk for a portfolio');
            assert.equal(card.skills[1].description, 'Run macroeconomic stress test scenarios');
        });

        test('end-to-end HTTP loopback: startA2AServer serves full catalog card and executes task for createA2ASource', async () => {
            // Configure remote peer agent
            fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('Portfolio VaR is 4.2% at 95% confidence.'));

            const llm = new LLMService({ provider: 'fake-a2a-cohesion' });
            const remoteAgent = new Agent(llm, {
                name: 'remote-risk-server',
                toolExposure: 'progressive',
                tools: [
                    {
                        name: 'compute_var',
                        description: 'Compute Value at Risk for a portfolio',
                        func: async () => 'VaR=4.2%',
                    },
                    {
                        name: 'rebalance_weights',
                        description: 'Optimize asset allocation weights',
                        func: async () => 'Rebalanced',
                    },
                ],
            });

            const server = await startA2AServer(remoteAgent, { port: 0, name: 'Remote Risk Server' });
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : 4000;
            const baseUrl = `http://localhost:${port}`;

            try {
                // Connect to the live A2A server using createA2ASource
                const a2aSource = createA2ASource(baseUrl, {
                    id: 'risk_peer',
                    timeoutMs: 5000,
                    pollIntervalMs: 25,
                });

                const declarations = await a2aSource.list();
                assert.equal(declarations.length, 2);
                assert.deepEqual(
                    declarations.map(d => d.name),
                    ['risk_peer_compute_var', 'risk_peer_rebalance_weights']
                );

                // Invoke the remote skill over HTTP JSON-RPC and wait for task completion
                const responseText = await a2aSource.invoke('risk_peer_compute_var', {
                    request: 'Calculate VaR for tech portfolio',
                });
                assert.equal(responseText, 'Portfolio VaR is 4.2% at 95% confidence.');

                await a2aSource.close();
            } finally {
                await new Promise((resolve) => server.close(resolve));
                await remoteAgent.cleanup();
            }
        });
    });
});
