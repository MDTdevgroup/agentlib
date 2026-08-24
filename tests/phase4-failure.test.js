import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import EventEmitter from 'events';
import { Agent } from '../src/core/agent.js';
import { LLMService } from '../src/services/llm-service.js';
import { registerProvider } from '../src/providers/registry.js';
import * as FakeProvider from './helpers/fake-provider.js';
import { isToolResult } from '../src/memory/message.js';

describe('Phase 4: Survivable Errors & Tool Concurrency', () => {
    test('4a: Failing tool execution is captured in context without crashing agent', async () => {
        const fakeProvider = FakeProvider.createFakeProvider();
        registerProvider('fake-phase4-tool-fail', fakeProvider, 'Fake Phase 4 Provider');

        // Turn 1: Model calls crashing tool
        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
            name: 'database_query',
            args: { query: 'SELECT * FROM secrets' },
            call_id: 'call_db_1',
        }));

        // Turn 2: Model handles error and provides recovery message
        fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('I could not reach the database.'));

        const events = new EventEmitter();
        const emittedErrors = [];
        events.on('tool:error', (evt) => emittedErrors.push(evt));

        const llm = new LLMService({ provider: 'fake-phase4-tool-fail' });
        const agent = new Agent(llm, {
            name: 'TestAgent',
            eventEmitter: events,
            tools: [
                {
                    name: 'database_query',
                    func: async () => {
                        throw new Error('Connection refused: ECONNREFUSED');
                    },
                },
            ],
        });

        agent.addInput({ role: 'user', content: 'Query the secrets table' });

        const history = await agent.run();
        assert.equal(history.length, 2);
        assert.equal(history[1].isDone, true);
        assert.equal(history[1].output, 'I could not reach the database.');

        // Verify context contains error message
        const messages = agent.context.getMessages();
        const toolResultMsg = messages.find(isToolResult);
        assert.ok(toolResultMsg);
        assert.deepEqual(toolResultMsg.output, {
            error: 'Tool "database_query" execution failed: Connection refused: ECONNREFUSED',
        });

        // Verify telemetry emission
        assert.equal(emittedErrors.length, 1);
        assert.equal(emittedErrors[0].attributes.tool_name, 'database_query');
        assert.match(emittedErrors[0].attributes.error, /ECONNREFUSED/);
    });

    test('4b: Missing tool is captured as a survivable error result', async () => {
        const fakeProvider = FakeProvider.createFakeProvider();
        registerProvider('fake-phase4-missing-tool', fakeProvider, 'Fake Phase 4 Provider');

        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
            name: 'ghost_tool',
            args: { param: 1 },
            call_id: 'call_ghost',
        }));
        fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('Ghost tool does not exist.'));

        const llm = new LLMService({ provider: 'fake-phase4-missing-tool' });
        const agent = new Agent(llm, {
            name: 'GhostAgent',
            tools: [], // No tools registered
        });

        agent.addInput({ role: 'user', content: 'Call ghost tool' });

        const history = await agent.run();
        assert.equal(history.length, 2);
        assert.equal(history[1].isDone, true);
        assert.equal(history[1].output, 'Ghost tool does not exist.');

        const messages = agent.context.getMessages();
        const toolResultMsg = messages.find(isToolResult);
        assert.ok(toolResultMsg);
        assert.deepEqual(toolResultMsg.output, {
            error: 'Tool "ghost_tool" not found.',
        });
    });

    test('4c: Invalid JSON argument string produces survivable error', async () => {
        const fakeProvider = FakeProvider.createFakeProvider();
        registerProvider('fake-phase4-bad-args', fakeProvider, 'Fake Phase 4 Provider');

        // Malformed JSON arguments
        fakeProvider.enqueueResponse({
            output: 'I will call calculator',
            rawResponse: {
                output: [
                    {
                        type: 'function_call',
                        call_id: 'call_bad_args',
                        name: 'calculator',
                        arguments: '{ "broken: ',
                    },
                ],
            },
        });
        fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('Arguments were invalid.'));

        const llm = new LLMService({ provider: 'fake-phase4-bad-args' });
        const agent = new Agent(llm, {
            name: 'CalcAgent',
            tools: [
                {
                    name: 'calculator',
                    func: async () => 42,
                },
            ],
        });

        agent.addInput({ role: 'user', content: 'Calculate something' });

        const history = await agent.run();
        assert.equal(history.length, 2);
        assert.equal(history[1].isDone, true);
        assert.equal(history[1].output, 'Arguments were invalid.');

        const messages = agent.context.getMessages();
        const toolResultMsg = messages.find(isToolResult);
        assert.ok(toolResultMsg);
        assert.match(toolResultMsg.output.error, /Failed to parse tool arguments|not found|Tool/);
    });

    test('4d: onToolError: "throw" policy immediately rethrows error', async () => {
        const fakeProvider = FakeProvider.createFakeProvider();
        registerProvider('fake-phase4-throw-policy', fakeProvider, 'Fake Phase 4 Provider');

        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
            name: 'strict_tool',
            args: {},
            call_id: 'call_strict',
        }));

        const llm = new LLMService({ provider: 'fake-phase4-throw-policy' });
        const agent = new Agent(llm, {
            name: 'StrictAgent',
            onToolError: 'throw',
            tools: [
                {
                    name: 'strict_tool',
                    func: async () => {
                        throw new Error('Fatal invariant failure');
                    },
                },
            ],
        });

        agent.addInput({ role: 'user', content: 'Run strict' });

        await assert.rejects(
            async () => {
                await agent.run();
            },
            /Fatal invariant failure/
        );
    });

    test('4e: Parallel tool execution respects concurrency limit and preserves submission order', async () => {
        const fakeProvider = FakeProvider.createFakeProvider();
        registerProvider('fake-phase4-concurrent-tools', fakeProvider, 'Fake Phase 4 Provider');

        // Turn 1: Model requests 3 parallel tool calls
        fakeProvider.enqueueResponse({
            output: null,
            rawResponse: {
                output: [
                    { type: 'function_call', call_id: 'call_1', name: 'slow_task', arguments: '{"id":1,"delay":30}' },
                    { type: 'function_call', call_id: 'call_2', name: 'slow_task', arguments: '{"id":2,"delay":10}' },
                    { type: 'function_call', call_id: 'call_3', name: 'slow_task', arguments: '{"id":3,"delay":20}' },
                ],
            },
        });

        // Turn 2: Final response
        fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('All tasks completed.'));

        let activeCount = 0;
        let maxObservedConcurrency = 0;
        const executionOrder = [];

        const llm = new LLMService({ provider: 'fake-phase4-concurrent-tools' });
        const agent = new Agent(llm, {
            name: 'ParallelAgent',
            toolConcurrency: 2, // limit to 2
            tools: [
                {
                    name: 'slow_task',
                    func: async ({ id, delay }) => {
                        activeCount++;
                        maxObservedConcurrency = Math.max(maxObservedConcurrency, activeCount);
                        await new Promise((r) => setTimeout(r, delay));
                        activeCount--;
                        executionOrder.push(id);
                        return { id, completed: true };
                    },
                },
            ],
        });

        agent.addInput({ role: 'user', content: 'Run 3 tasks' });

        const history = await agent.run();
        assert.equal(history.length, 2);
        assert.equal(history[1].output, 'All tasks completed.');

        // Concurrency should never exceed toolConcurrency (2)
        assert.ok(maxObservedConcurrency <= 2, `Observed concurrency ${maxObservedConcurrency} exceeded limit 2`);

        // Message order in context must match submission order (call_1, call_2, call_3)
        const messages = agent.context.getMessages();
        const toolResults = messages.filter(isToolResult);
        assert.equal(toolResults.length, 3);
        assert.equal(toolResults[0].call_id, 'call_1');
        assert.deepEqual(toolResults[0].output, { id: 1, completed: true });
        assert.equal(toolResults[1].call_id, 'call_2');
        assert.deepEqual(toolResults[1].output, { id: 2, completed: true });
        assert.equal(toolResults[2].call_id, 'call_3');
        assert.deepEqual(toolResults[2].output, { id: 3, completed: true });
    });

    test('4f: Exceeding maxToolCalls terminates loop gracefully with stopReason: "step_limit"', async () => {
        const fakeProvider = FakeProvider.createFakeProvider();
        registerProvider('fake-phase4-step-limit', fakeProvider, 'Fake Phase 4 Provider');

        // Enqueue 5 loop iterations of tool calls
        for (let i = 1; i <= 5; i++) {
            fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
                name: 'loop_tool',
                args: { step: i },
                call_id: `call_${i}`,
            }));
        }

        const llm = new LLMService({ provider: 'fake-phase4-step-limit' });
        const agent = new Agent(llm, {
            name: 'LoopAgent',
            maxToolCalls: 2, // Stop after 2 steps
            tools: [
                {
                    name: 'loop_tool',
                    func: async ({ step }) => ({ step }),
                },
            ],
        });

        agent.addInput({ role: 'user', content: 'Start loop' });

        // Must not throw an unhandled Error
        const history = await agent.run();

        // Turn 1 (step 1), Turn 2 (step 2), Turn 3 (step 3 -> exceeds maxToolCalls of 2 -> terminates)
        assert.equal(history.length, 3);
        const finalTurn = history[history.length - 1];
        assert.equal(finalTurn.isDone, true);
        assert.equal(finalTurn.stopReason, 'step_limit');
        assert.equal(finalTurn.output, '');
    });
});
