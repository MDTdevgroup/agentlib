import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    makeTextMessage,
    makeToolCall,
    makeToolResult,
    makeReasoning,
    isToolCall,
    isToolResult,
    isTextMessage,
    isReasoning,
    toolCallName,
    toolCallId,
    toolCallArgs,
    messageText,
    messageSpeaker,
    messageRole,
} from '../src/memory/message.js';
import { Context } from '../src/memory/context.js';
import { Agent } from '../src/core/agent.js';
import { LLMService } from '../src/services/llm-service.js';
import { registerProvider, getDefaultModel } from '../src/providers/registry.js';
import * as FakeProvider from './helpers/fake-provider.js';
import { toProvider as openAIToProvider, fromProvider as openAIFromProvider } from '../src/providers/openai.js';
import { toProvider as geminiToProvider, fromProvider as geminiFromProvider } from '../src/providers/gemini.js';
import { toProvider as vllmToProvider, fromProvider as vllmFromProvider } from '../src/providers/vllm.js';

describe('Canonical Message Format & Abstraction Barrier', () => {
    describe('Constructors & Selectors', () => {
        test('makeTextMessage creates frozen canonical message with speaker', () => {
            const msg = makeTextMessage({ role: 'assistant', text: 'Hello world', speaker: 'AgentAlpha' });

            assert.equal(isTextMessage(msg), true);
            assert.equal(isToolCall(msg), false);
            assert.equal(messageText(msg), 'Hello world');
            assert.equal(messageSpeaker(msg), 'AgentAlpha');
            assert.equal(messageRole(msg), 'assistant');

            // Verify deep freeze
            assert.throws(() => {
                msg.content = 'Mutated';
            }, /Cannot assign to read only property/);
        });

        test('makeToolCall creates frozen tool call with parsed args selector', () => {
            const tc = makeToolCall({ name: 'calculator', args: { a: 1, b: 2 }, callId: 'call_123' });

            assert.equal(isToolCall(tc), true);
            assert.equal(toolCallName(tc), 'calculator');
            assert.equal(toolCallId(tc), 'call_123');
            assert.deepEqual(toolCallArgs(tc), { a: 1, b: 2 });

            assert.throws(() => {
                tc.name = 'other';
            }, /Cannot assign to read only property/);
        });

        test('makeToolResult stores structured value without double encoding', () => {
            const rawValue = { temperature: 22, unit: 'celsius' };
            const result = makeToolResult({ callId: 'call_123', name: 'get_weather', value: rawValue });

            assert.equal(isToolResult(result), true);
            assert.deepEqual(result.output, rawValue);

            // Test OpenAI toProvider serialization: must serialize exactly once
            const providerFormatted = openAIToProvider([result]);
            assert.equal(providerFormatted[0].output, '{"temperature":22,"unit":"celsius"}');
            // Ensure not double encoded (not "\"{\"temperature\":22}\"")
            assert.doesNotMatch(providerFormatted[0].output, /^"\{/);
        });

        test('makeReasoning creates reasoning item', () => {
            const r = makeReasoning({ summary: 'Thinking step', details: 'Let X be 5' });
            assert.equal(isReasoning(r), true);
            assert.equal(r.summary, 'Thinking step');
            assert.equal(r.content, 'Let X be 5');
        });
    });

    describe('Context Deep Immutability', () => {
        test('Context deep freezes messages on addition', () => {
            const ctx = new Context();
            const next = ctx.addInput({ role: 'user', content: 'test', meta: { count: 1 } });

            const msg = next.getMessages()[0];
            assert.throws(() => {
                msg.meta.count = 2;
            }, /Cannot assign to read only property/);
        });
    });

    describe('Default Model Resolution', () => {
        test('getDefaultModel queries provider namespaces cleanly', () => {
            assert.equal(getDefaultModel('openai'), 'gpt-5');
            assert.equal(getDefaultModel('gemini'), 'gemini-3-pro-preview');
            assert.equal(getDefaultModel('vllm'), 'default');
        });
    });

    describe('Provider Adapters Format Conversion', () => {
        test('Gemini toProvider formats multi-turn messages, function calls, and function responses per Gemini API spec', () => {
            const messages = [
                makeTextMessage({ role: 'system', text: 'You are an astronomer.' }),
                makeTextMessage({ role: 'user', text: 'Where is Mars?' }),
                makeToolCall({ name: 'lookup_planet', args: { planet: 'Mars' }, callId: 'call_gemini_1' }),
                makeToolResult({ callId: 'call_gemini_1', name: 'lookup_planet', value: { distance_au: 1.52 } }),
                makeTextMessage({ role: 'assistant', text: 'Mars is 1.52 AU away.' }),
            ];

            const geminiInput = geminiToProvider(messages);
            assert.deepEqual(geminiInput.systemParts, [{ text: 'You are an astronomer.' }]);
            assert.equal(geminiInput.contents.length, 4);

            // User turn
            assert.equal(geminiInput.contents[0].role, 'user');
            assert.deepEqual(geminiInput.contents[0].parts, [{ text: 'Where is Mars?' }]);

            // Model tool call turn
            assert.equal(geminiInput.contents[1].role, 'model');
            assert.equal(geminiInput.contents[1].parts[0].functionCall.name, 'lookup_planet');
            assert.deepEqual(geminiInput.contents[1].parts[0].functionCall.args, { planet: 'Mars' });
            assert.equal(geminiInput.contents[1].parts[0].functionCall.id, 'call_gemini_1');

            // User function response turn
            assert.equal(geminiInput.contents[2].role, 'user');
            assert.equal(geminiInput.contents[2].parts[0].functionResponse.name, 'lookup_planet');
            assert.deepEqual(geminiInput.contents[2].parts[0].functionResponse.response, { distance_au: 1.52 });
            assert.equal(geminiInput.contents[2].parts[0].functionResponse.id, 'call_gemini_1');

            // Model assistant turn
            assert.equal(geminiInput.contents[3].role, 'model');
            assert.deepEqual(geminiInput.contents[3].parts, [{ text: 'Mars is 1.52 AU away.' }]);
        });

        test('Gemini fromProvider handles function calls, thoughts, and text parts', () => {
            const raw = {
                output: [
                    {
                        type: 'reasoning',
                        content: 'Calculating orbit...',
                    },
                    {
                        type: 'function_call',
                        call_id: 'call_123',
                        name: 'orbit_calc',
                        arguments: '{"step":1}',
                    },
                    {
                        type: 'message',
                        role: 'assistant',
                        content: 'Ready to calculate.',
                    },
                ],
            };

            const items = geminiFromProvider(raw);
            assert.equal(items.length, 3);
            assert.equal(isReasoning(items[0]), true);
            assert.equal(isToolCall(items[1]), true);
            assert.equal(toolCallName(items[1]), 'orbit_calc');
            assert.equal(isTextMessage(items[2]), true);
            assert.equal(messageText(items[2]), 'Ready to calculate.');
        });

        test('OpenAI toProvider and fromProvider handle canonical message roundtrip', () => {
            const messages = [
                makeTextMessage({ role: 'user', text: 'Hello', speaker: 'UserA' }),
                makeToolCall({ name: 'calc', args: { x: 10 }, callId: 'call_calc_1' }),
                makeToolResult({ callId: 'call_calc_1', name: 'calc', value: { ans: 20 } }),
            ];

            const wire = openAIToProvider(messages);
            assert.equal(wire[0].role, 'user');
            assert.equal(wire[0].content, '[UserA]: Hello');
            assert.equal(wire[0].speaker, undefined);
            assert.equal(wire[1].type, 'function_call');
            assert.equal(wire[1].call_id, 'call_calc_1');
            assert.equal(wire[2].type, 'function_call_output');
            assert.equal(wire[2].output, '{"ans":20}');

            const fromWire = openAIFromProvider({
                output: [
                    { type: 'message', role: 'assistant', content: 'Result is 20' },
                ],
            });
            assert.equal(fromWire.length, 1);
            assert.equal(messageText(fromWire[0]), 'Result is 20');
        });

        test('vLLM toProvider and fromProvider handle chat completion message conversions including tool calls and speaker', () => {
            const messages = [
                makeTextMessage({ role: 'user', text: 'Run tool', speaker: 'Alice' }),
                makeToolCall({ name: 'calc', args: { x: 10 }, callId: 'call_calc_1' }),
                makeToolResult({ callId: 'call_vllm_1', name: 'test', value: { ok: true } }),
            ];

            const vllmInput = vllmToProvider(messages);
            assert.equal(vllmInput[0].role, 'user');
            assert.equal(vllmInput[0].content, '[Alice]: Run tool');
            assert.equal(vllmInput[1].role, 'assistant');
            assert.deepEqual(vllmInput[1].tool_calls, [{
                id: 'call_calc_1',
                type: 'function',
                function: {
                    name: 'calc',
                    arguments: '{"x":10}',
                },
            }]);
            assert.equal(vllmInput[2].role, 'tool');
            assert.equal(vllmInput[2].tool_call_id, 'call_vllm_1');
            assert.equal(vllmInput[2].content, '{"ok":true}');

            const vllmResponse = vllmFromProvider({
                id: 'chatcmpl-123',
                created: 1234567,
                choices: [{
                    finish_reason: 'stop',
                    message: { role: 'assistant', content: 'vLLM done' },
                }],
            });
            assert.equal(vllmResponse.output.length, 1);
            assert.equal(isTextMessage(vllmResponse.output[0]), true);
            assert.equal(messageText(vllmResponse.output[0]), 'vLLM done');
        });
    });

    describe('Full Agent Loop with Canonical Messages', () => {
        test('Agent executes tool loop using canonical messages without double-encoding or in-place mutations', async () => {
            const fakeProvider = FakeProvider.createFakeProvider();
            registerProvider('fake-canonical-test', fakeProvider, 'Fake Canonical Provider');

            // Turn 1: Model requests tool call
            fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
                name: 'get_user',
                args: { id: 42 },
                call_id: 'call_user_42',
            }));

            // Turn 2: Model gives final text response
            fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('User 42 is Alice'));

            const llm = new LLMService({ provider: 'fake-canonical-test' });
            const agent = new Agent(llm, {
                name: 'AliceAgent',
                tools: [
                    {
                        name: 'get_user',
                        func: async ({ id }) => ({ id, name: 'Alice' }),
                    },
                ],
            });

            agent.addInput({ role: 'user', content: 'Who is user 42?' });

            const history = await agent.run();
            assert.equal(history.length, 2);

            const finalTurn = history[1];
            assert.equal(finalTurn.isDone, true);
            assert.equal(finalTurn.output, 'User 42 is Alice');

            // Inspect conversation context messages
            const messages = agent.context.getMessages();
            // Expected sequence: User input, Assistant tool call, Function tool output, Assistant final answer
            assert.equal(messages.length, 4);

            const toolOutputMsg = messages[2];
            assert.equal(isToolResult(toolOutputMsg), true);
            assert.deepEqual(toolOutputMsg.output, { id: 42, name: 'Alice' });

            const finalMsg = messages[3];
            assert.equal(isTextMessage(finalMsg), true);
            assert.equal(messageText(finalMsg), 'User 42 is Alice');
            assert.equal(messageSpeaker(finalMsg), 'AliceAgent');
            // Clean text without bracket prefix
            assert.equal(finalMsg.content, 'User 42 is Alice');
        });
    });
});
