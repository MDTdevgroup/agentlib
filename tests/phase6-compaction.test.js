import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import EventEmitter from 'events';
import { Agent } from '../src/core/agent.js';
import { AgentRunner } from '../src/core/agent-runner.js';
import { LLMService } from '../src/services/llm-service.js';
import { registerProvider } from '../src/providers/registry.js';
import * as FakeProvider from './helpers/fake-provider.js';
import {
    makeTextMessage,
    makeToolCall,
    makeToolResult,
    isToolCall,
    isToolResult,
    messageText,
} from '../src/memory/message.js';
import {
    WindowCompactor,
    SummarizerCompactor,
    ProvenceCompactor,
    estimateTokens,
    truncateToBudget,
    groupAtomicUnits,
} from '../src/memory/compactors/index.js';

describe('Phase 6: Bound the Cost (Compaction & Run Budgeting)', () => {
    describe('6a: Base Utilities & Atomic Tool Grouping', () => {
        test('estimateTokens calculates reasonable token approximations for strings and canonical messages', () => {
            const shortMsg = makeTextMessage({ role: 'user', text: 'Hello world' }); // 11 chars + role + overhead
            const tokens = estimateTokens(shortMsg);
            assert.ok(tokens > 0 && tokens < 20);

            const longText = 'a'.repeat(400);
            assert.equal(estimateTokens(longText), 100);
        });

        test('groupAtomicUnits keeps tool calls and their results in indivisible groups', () => {
            const messages = [
                makeTextMessage({ role: 'system', text: 'You are an assistant.' }),
                makeTextMessage({ role: 'user', text: 'Calculate 2+2 and 3+3' }),
                makeToolCall({ name: 'calc', args: { expr: '2+2' }, callId: 'call_1' }),
                makeToolCall({ name: 'calc', args: { expr: '3+3' }, callId: 'call_2' }),
                makeToolResult({ callId: 'call_1', name: 'calc', value: 4 }),
                makeToolResult({ callId: 'call_2', name: 'calc', value: 6 }),
                makeTextMessage({ role: 'assistant', text: 'The results are 4 and 6.' }),
            ];

            const groups = groupAtomicUnits(messages);
            assert.equal(groups.length, 4);

            // Group 0: system message
            assert.equal(groups[0].length, 1);
            assert.equal(groups[0][0].role, 'system');

            // Group 1: user query
            assert.equal(groups[1].length, 1);
            assert.equal(groups[1][0].role, 'user');

            // Group 2: atomic tool batch (2 tool calls + 2 tool results)
            assert.equal(groups[2].length, 4);
            assert.ok(isToolCall(groups[2][0]));
            assert.ok(isToolCall(groups[2][1]));
            assert.ok(isToolResult(groups[2][2]));
            assert.ok(isToolResult(groups[2][3]));

            // Group 3: final assistant answer
            assert.equal(groups[3].length, 1);
            assert.equal(groups[3][0].role, 'assistant');
        });

        test('truncateToBudget preserves all system messages and fits recent units within token ceiling', () => {
            const sysMsg = makeTextMessage({ role: 'system', text: 'System Instruction' });
            const longUser1 = makeTextMessage({ role: 'user', text: 'Message 1: ' + 'x'.repeat(400) });
            const longUser2 = makeTextMessage({ role: 'user', text: 'Message 2: ' + 'y'.repeat(400) });
            const longUser3 = makeTextMessage({ role: 'user', text: 'Message 3: ' + 'z'.repeat(400) });

            const messages = [sysMsg, longUser1, longUser2, longUser3];
            // Each long message is ~100 tokens. Set budget to 150 tokens.
            const truncated = truncateToBudget(messages, 150);

            // Must preserve sysMsg and the most recent message(s) that fit
            assert.ok(truncated.length >= 2);
            assert.equal(truncated[0].role, 'system');
            assert.equal(messageText(truncated[0]), 'System Instruction');
            assert.equal(messageText(truncated[truncated.length - 1]), messageText(longUser3));
        });
    });

    describe('6b: WindowCompactor', () => {
        test('WindowCompactor never splits a tool call from its result', async () => {
            const compactor = new WindowCompactor({
                maxTokens: 100, // Small trigger threshold
                truncateToTokens: 80,
            });

            const messages = [
                makeTextMessage({ role: 'system', text: 'System prompt' }),
                makeTextMessage({ role: 'user', text: 'Old query: ' + 'old '.repeat(50) }),
                makeTextMessage({ role: 'assistant', text: 'Old response: ' + 'res '.repeat(50) }),
                makeToolCall({ name: 'search', args: { q: 'agentlib' }, callId: 'call_search_1' }),
                makeToolResult({ callId: 'call_search_1', name: 'search', value: { found: true } }),
                makeTextMessage({ role: 'assistant', text: 'I found agentlib.' }),
            ];

            const compacted = await compactor.compact(messages);

            // System prompt must always be preserved
            assert.equal(compacted[0].role, 'system');

            // Find if tool call or result exists
            const hasToolCall = compacted.some(isToolCall);
            const hasToolResult = compacted.some(isToolResult);

            // Either BOTH survive together, or NEITHER does (never orphaned)
            assert.equal(hasToolCall, hasToolResult);
            if (hasToolCall) {
                const call = compacted.find(isToolCall);
                const result = compacted.find(isToolResult);
                assert.equal(call.call_id, result.call_id);
            }
        });

        test('WindowCompactor respects maxMessages constraint when provided', async () => {
            const compactor = new WindowCompactor({
                maxTokens: 50000,
                truncateToTokens: 40000,
                maxMessages: 4,
            });

            const messages = [
                makeTextMessage({ role: 'system', text: 'System' }),
                makeTextMessage({ role: 'user', text: '1' }),
                makeTextMessage({ role: 'assistant', text: '2' }),
                makeTextMessage({ role: 'user', text: '3' }),
                makeTextMessage({ role: 'assistant', text: '4' }),
                makeTextMessage({ role: 'user', text: '5' }),
                makeTextMessage({ role: 'assistant', text: '6' }),
            ];

            const compacted = await compactor.compact(messages);
            assert.ok(compacted.length <= 4);
            assert.equal(compacted[0].role, 'system');
        });
    });

    describe('6c: SummarizerCompactor', () => {
        test('SummarizerCompactor shortens history and uses LLMService correctly', async () => {
            const fakeProvider = FakeProvider.createFakeProvider();
            registerProvider('fake-summarizer-test', fakeProvider, 'Fake Summarizer Provider');

            fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('User discussed astronomy facts and planets.'));

            const llm = new LLMService({ provider: 'fake-summarizer-test' });
            const compactor = new SummarizerCompactor({
                llmService: llm,
                maxTokens: 100,
                truncateToTokens: 80,
            });

            const messages = [
                makeTextMessage({ role: 'system', text: 'Astronomy System' }),
                makeTextMessage({ role: 'user', text: 'What is Mars? ' + 'Mars is red. '.repeat(20) }),
                makeTextMessage({ role: 'assistant', text: 'Mars is the 4th planet. '.repeat(20) }),
                makeTextMessage({ role: 'user', text: 'What is Jupiter? ' + 'Jupiter is big. '.repeat(20) }),
                makeTextMessage({ role: 'assistant', text: 'Jupiter is the largest planet.' }),
            ];

            const compacted = await compactor.compact(messages);

            // Verify system message preserved
            assert.equal(compacted[0].role, 'system');
            assert.equal(messageText(compacted[0]), 'Astronomy System');

            // Verify summary message injected with role 'system'
            const summaryMsg = compacted.find((m) => messageText(m).startsWith('[Conversation Summary]:'));
            assert.ok(summaryMsg, 'Summary message should be injected');
            assert.equal(summaryMsg.role, 'system');
            assert.match(messageText(summaryMsg), /astronomy facts and planets/i);

            // Recent message must be preserved
            assert.equal(messageText(compacted[compacted.length - 1]), 'Jupiter is the largest planet.');
        });

        test('SummarizerCompactor folds previous summary into the new summary prompt incrementally', async () => {
            const fakeProvider = FakeProvider.createFakeProvider();
            registerProvider('fake-folding-test', fakeProvider, 'Fake Folding Provider');

            let capturedPrompt = null;
            fakeProvider.setHandler((input) => {
                capturedPrompt = input;
                return FakeProvider.fakeTextResponse('Updated comprehensive summary: User discussed math and physics.');
            });

            const llm = new LLMService({ provider: 'fake-folding-test' });
            const compactor = new SummarizerCompactor({
                llmService: llm,
                maxTokens: 50,
                truncateToTokens: 40,
            });

            const messages = [
                makeTextMessage({ role: 'system', text: 'System Core' }),
                makeTextMessage({ role: 'system', text: '[Conversation Summary]: User solved 2+2=4 previously.' }),
                makeTextMessage({ role: 'user', text: 'Now solve quantum mechanics equations ' + 'E=mc^2 '.repeat(25) }),
                makeTextMessage({ role: 'assistant', text: 'Here are the physics formulas ' + 'h_bar '.repeat(25) }),
                makeTextMessage({ role: 'user', text: 'Great, thanks!' }),
            ];

            const compacted = await compactor.compact(messages);

            // Verify that the prompt sent to the LLM included the previous summary
            assert.ok(capturedPrompt);
            const userMsgInPrompt = capturedPrompt.find((m) => m.role === 'user');
            assert.match(messageText(userMsgInPrompt), /Previous Summary:/);
            assert.match(messageText(userMsgInPrompt), /User solved 2\+2=4 previously/);

            // Verify there is only one summary message in the output (no stacking)
            const summaryMessages = compacted.filter((m) => messageText(m).startsWith('[Conversation Summary]:'));
            assert.equal(summaryMessages.length, 1);
            assert.match(messageText(summaryMessages[0]), /math and physics/);
        });

        test('SummarizerCompactor degrades gracefully to sliding window on LLM failure without crashing', async () => {
            const fakeProvider = FakeProvider.createFakeProvider();
            registerProvider('fake-summarizer-fail', fakeProvider, 'Fake Failing Provider');

            // Force failure across all retry attempts with a hard error
            fakeProvider.setHandler(() => {
                const err = new Error('LLM Quota Exceeded');
                err.status = 400; // non-retryable hard fail
                throw err;
            });

            const events = new EventEmitter();
            const errors = [];
            events.on('compactor:error', (e) => errors.push(e));

            const llm = new LLMService({ provider: 'fake-summarizer-fail' });
            const compactor = new SummarizerCompactor({
                llmService: llm,
                maxTokens: 100,
                truncateToTokens: 80,
                eventEmitter: events,
            });

            const messages = [
                makeTextMessage({ role: 'system', text: 'System' }),
                makeTextMessage({ role: 'user', text: 'Message ' + 'x'.repeat(400) }),
                makeTextMessage({ role: 'assistant', text: 'Message ' + 'y'.repeat(400) }),
                makeTextMessage({ role: 'user', text: 'Latest query' }),
            ];

            // Must NOT throw
            const compacted = await compactor.compact(messages);

            assert.ok(compacted.length > 0);
            assert.equal(compacted[0].role, 'system');
            assert.equal(errors.length, 1);
            assert.match(errors[0].error, /LLM Quota Exceeded/);
        });
    });

    describe('6d: ProvenceCompactor (Semantic Pruning)', () => {
        test('ProvenceCompactor caches embeddings and avoids re-embedding identical text across turns', async () => {
            let embedCallCount = 0;
            const fakeEmbeddingService = {
                embed: async (_text) => {
                    embedCallCount++;
                    // Return a 4-dimensional unit vector
                    return [0.5, 0.5, 0.5, 0.5];
                },
            };

            const compactor = new ProvenceCompactor({
                embeddingService: fakeEmbeddingService,
                maxTokens: 50,
                truncateToTokens: 40,
                similarityThreshold: 0.7,
            });

            const messages = [
                makeTextMessage({ role: 'system', text: 'System' }),
                makeTextMessage({ role: 'user', text: 'Database query: ' + 'data '.repeat(30) }),
                makeTextMessage({ role: 'assistant', text: 'Database result: ' + 'rows '.repeat(30) }),
                makeTextMessage({ role: 'user', text: 'Database follow-up' }),
            ];

            // Turn 1 compaction
            await compactor.compact(messages);
            const callsAfterFirst = embedCallCount;
            assert.ok(callsAfterFirst > 0);

            // Turn 2 compaction with the same messages + 1 new message
            const messagesTurn2 = [
                ...messages,
                makeTextMessage({ role: 'assistant', text: 'Answer for database follow-up' }),
                makeTextMessage({ role: 'user', text: 'Another query' }),
            ];

            await compactor.compact(messagesTurn2);
            const newCalls = embedCallCount - callsAfterFirst;

            // Only the 2 new messages should have been embedded; prior ones served from cache
            assert.ok(newCalls <= 2, `Expected at most 2 new embeddings, got ${newCalls}`);
        });

        test('ProvenceCompactor bounds token budget and preserves most semantically relevant messages', async () => {
            const fakeEmbeddingService = {
                embed: async (text) => {
                    if (text.includes('database') || text.includes('SQL')) {
                        return [1, 0, 0, 0]; // High similarity to anchor [1, 0, 0, 0]
                    }
                    if (text.includes('cooking') || text.includes('recipe')) {
                        return [0, 1, 0, 0]; // Low similarity (orthogonal)
                    }
                    return [0.7, 0.7, 0, 0];
                },
            };

            const compactor = new ProvenceCompactor({
                embeddingService: fakeEmbeddingService,
                maxTokens: 100,
                truncateToTokens: 80,
                similarityThreshold: 0.5,
            });

            const messages = [
                makeTextMessage({ role: 'system', text: 'System Agent' }),
                makeTextMessage({ role: 'user', text: 'How do I cook pasta? Delicious cooking recipes ' + 'pasta '.repeat(20) }),
                makeTextMessage({ role: 'assistant', text: 'Boil water for cooking recipes ' + 'water '.repeat(20) }),
                makeTextMessage({ role: 'user', text: 'How do I index a database table? PostgreSQL SQL query ' + 'sql '.repeat(20) }),
                makeTextMessage({ role: 'assistant', text: 'Use CREATE INDEX on SQL database ' + 'index '.repeat(20) }),
                makeTextMessage({ role: 'user', text: 'Show me more about database optimization and SQL' }), // Anchor query
            ];

            const compacted = await compactor.compact(messages);

            assert.equal(compacted[0].role, 'system');
            const compactedText = compacted.map((m) => messageText(m)).join(' ');

            // Database/SQL context should be preserved, cooking recipe context should be pruned
            assert.match(compactedText, /database/i);
            assert.doesNotMatch(compactedText, /cook pasta/i);
        });
    });

    describe('6e: End-to-End Agent Loop & Invariant Protection', () => {
        test('Agent maintains full uncompacted history in Context while sending compacted payload to LLM', async () => {
            const fakeProvider = FakeProvider.createFakeProvider();
            registerProvider('fake-phase6-agent-test', fakeProvider, 'Fake Phase 6 Provider');

            let receivedPayloadSizes = [];
            fakeProvider.setHandler((input) => {
                receivedPayloadSizes.push(input.length);
                return FakeProvider.fakeTextResponse('Acknowledged step.');
            });

            const llm = new LLMService({ provider: 'fake-phase6-agent-test' });
            const agent = new Agent(llm, {
                name: 'CompactedAgent',
                pruningStrategy: 'window',
                pruningOptions: {
                    maxTokens: 50,
                    truncateToTokens: 40,
                },
            });

            // Add multiple turns
            agent.addInput(makeTextMessage({ role: 'system', text: 'System Role' }));
            for (let i = 1; i <= 6; i++) {
                agent.addInput(makeTextMessage({ role: 'user', text: `Turn ${i}: ` + 'content '.repeat(15) }));
            }

            const history = await agent.run();
            assert.equal(history.length, 1);
            assert.equal(history[0].isDone, true);

            // Invariant 1: Stored context in agent has ALL 7 messages (System + 6 user messages)
            const storedMessages = agent.context.getMessages();
            assert.equal(storedMessages.length, 8); // System + 6 user inputs + 1 assistant answer

            // Invariant 2: Wire payload received by LLM was compacted to fewer messages
            assert.ok(receivedPayloadSizes.length > 0);
            assert.ok(receivedPayloadSizes[0] < storedMessages.length, 'Wire payload should be compacted');
        });

        test('Agent constructor correctly passes llmService and model to SummarizerCompactor', () => {
            const llm = new LLMService({ provider: 'fake-summarizer-test' });
            const agent = new Agent(llm, {
                name: 'ConstructorOrderAgent',
                model: 'custom-model-123',
                pruningStrategy: 'summarizer',
            });

            assert.ok(agent.compactor instanceof SummarizerCompactor);
            assert.equal(agent.compactor.llmService, llm);
            assert.equal(agent.compactor.model, 'custom-model-123');
        });

        test('Agent terminates gracefully with stopReason: "budget_exhausted" when maxRunTokens is exceeded', async () => {
            const fakeProvider = FakeProvider.createFakeProvider();
            registerProvider('fake-budget-test', fakeProvider, 'Fake Budget Provider');

            // Turn 1: tool call
            fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
                name: 'search',
                args: { q: '1' },
                call_id: 'call_b1',
            }));

            // Turn 2: tool call
            fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
                name: 'search',
                args: { q: '2' },
                call_id: 'call_b2',
            }));

            const llm = new LLMService({ provider: 'fake-budget-test' });
            const agent = new Agent(llm, {
                name: 'BudgetAgent',
                maxRunTokens: 15, // Extremely small token budget
                tools: [
                    {
                        name: 'search',
                        func: async () => ({ status: 'ok' }),
                    },
                ],
            });

            agent.addInput(makeTextMessage({ role: 'user', text: 'Run tasks within budget' }));

            const history = await agent.run();
            const lastTurn = history[history.length - 1];

            assert.equal(lastTurn.isDone, true);
            assert.equal(lastTurn.stopReason, 'budget_exhausted');
        });

        test('AgentRunner executes multi-turn agents smoothly without defensive cloning bottlenecks', async () => {
            const fakeProvider = FakeProvider.createFakeProvider();
            registerProvider('fake-runner-phase6', fakeProvider, 'Fake Runner Phase 6 Provider');

            fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('Turn 1 complete'));
            fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('Turn 2 complete'));

            const llm = new LLMService({ provider: 'fake-runner-phase6' });
            const agent = new Agent(llm, { name: 'RunnerAgent' });

            const runner = new AgentRunner(agent, {
                maxTurns: 3,
                turnStrategy: async (agents, agentContexts, turn) => {
                    const ag = agents.RunnerAgent;
                    const res = await ag.run(agentContexts[ag.name] || null);
                    const finalTurn = res[res.length - 1];
                    return {
                        isSatisfied: turn >= 2,
                        output: finalTurn.output,
                        executedTools: finalTurn.executedTools,
                        rawResponse: finalTurn.rawResponse,
                        context: { ...agentContexts, [ag.name]: finalTurn.context },
                    };
                },
            });
            const history = await runner.run('Start task');

            assert.equal(history.length, 2);
            assert.equal(history[1].isDone, true);
        });
    });
});
