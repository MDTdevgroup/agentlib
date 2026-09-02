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
import { toProvider as openAIToProvider, fromProvider as openAIFromProvider, chat as openAIChat } from '../src/providers/openai.js';
import { toProvider as geminiToProvider, fromProvider as geminiFromProvider, chat as geminiChat } from '../src/providers/gemini.js';
import { toProvider as vllmToProvider, fromProvider as vllmFromProvider } from '../src/providers/vllm.js';
import { z } from 'zod';

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
            assert.equal(getDefaultModel('gemini'), 'gemini-3.1-pro-preview');
            assert.equal(getDefaultModel('vllm'), 'default');
        });
    });

    describe('Provider Adapters Format Conversion', () => {
        test('Gemini toProvider formats multi-turn messages, function calls, and function responses per Gemini Interactions API spec', () => {
            const messages = [
                makeTextMessage({ role: 'system', text: 'You are an astronomer.' }),
                makeTextMessage({ role: 'user', text: 'Where is Mars?' }),
                makeToolCall({ name: 'lookup_planet', args: { planet: 'Mars' }, callId: 'call_gemini_1' }),
                makeToolResult({ callId: 'call_gemini_1', name: 'lookup_planet', value: { distance_au: 1.52 } }),
                makeTextMessage({ role: 'assistant', text: 'Mars is 1.52 AU away.' }),
            ];

            const geminiInput = geminiToProvider(messages);
            assert.equal(geminiInput.system_instruction, 'You are an astronomer.');
            assert.equal(geminiInput.steps.length, 4);

            // User turn
            assert.equal(geminiInput.steps[0].type, 'user_input');
            assert.deepEqual(geminiInput.steps[0].content, [{ type: 'text', text: 'Where is Mars?' }]);

            // Model tool call turn
            assert.equal(geminiInput.steps[1].type, 'function_call');
            assert.equal(geminiInput.steps[1].name, 'lookup_planet');
            assert.deepEqual(geminiInput.steps[1].arguments, { planet: 'Mars' });
            assert.equal(geminiInput.steps[1].id, 'call_gemini_1');

            // User function response turn
            assert.equal(geminiInput.steps[2].type, 'function_result');
            assert.equal(geminiInput.steps[2].name, 'lookup_planet');
            assert.deepEqual(geminiInput.steps[2].result, { distance_au: 1.52 });
            assert.equal(geminiInput.steps[2].call_id, 'call_gemini_1');

            // Model assistant turn
            assert.equal(geminiInput.steps[3].type, 'model_output');
            assert.deepEqual(geminiInput.steps[3].content, [{ type: 'text', text: 'Mars is 1.52 AU away.' }]);
        });

        test('Gemini fromProvider handles function calls, thoughts, and text parts from steps', () => {
            const raw = {
                steps: [
                    {
                        type: 'thought',
                        summary: [{ type: 'text', text: 'Calculating orbit...' }],
                    },
                    {
                        type: 'function_call',
                        id: 'call_123',
                        name: 'orbit_calc',
                        arguments: { step: 1 },
                    },
                    {
                        type: 'model_output',
                        content: [{ type: 'text', text: 'Ready to calculate.' }],
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

    describe('OpenAI Responses API & Gemini Interactions API Chat Methods', () => {
        test('openAIChat formats tools, calls client.responses.create and normalizes rawResponse', async () => {
            let capturedPayload = null;
            const fakeClient = {
                responses: {
                    create: async (payload) => {
                        capturedPayload = payload;
                        return {
                            id: 'resp_123',
                            model: 'gpt-4o-mini',
                            output_text: 'Paris is the capital of France.',
                            output: [
                                {
                                    type: 'message',
                                    role: 'assistant',
                                    content: 'Paris is the capital of France.',
                                },
                            ],
                            usage: {
                                input_tokens: 12,
                                output_tokens: 8,
                                total_tokens: 20,
                            },
                        };
                    },
                },
            };

            const tools = [
                {
                    name: 'lookup_city',
                    description: 'Lookup city details',
                    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
                },
            ];

            const result = await openAIChat(fakeClient, [{ role: 'user', content: 'What is the capital of France?' }], {
                model: 'gpt-4o-mini',
                tools,
            });

            assert.equal(result.output, 'Paris is the capital of France.');
            assert.equal(capturedPayload.model, 'gpt-4o-mini');
            assert.equal(capturedPayload.tools[0].type, 'function');
            assert.equal(capturedPayload.tools[0].name, 'lookup_city');
            assert.equal(result.rawResponse.id, 'resp_123');
            assert.equal(result.rawResponse.usage.total_tokens, 20);
        });

        test('openAIChat with outputSchema calls client.responses.parse with zodTextFormat', async () => {
            let capturedPayload = null;
            const fakeClient = {
                responses: {
                    parse: async (payload) => {
                        capturedPayload = payload;
                        return {
                            id: 'resp_456',
                            output_parsed: { answer: 'Mercury', confidence: 0.99 },
                            output: [],
                        };
                    },
                },
            };

            const schema = z.object({
                answer: z.string(),
                confidence: z.number(),
            });

            const result = await openAIChat(fakeClient, [{ role: 'user', content: 'Closest planet to Sun?' }], {
                outputSchema: schema,
            });

            assert.deepEqual(result.output, { answer: 'Mercury', confidence: 0.99 });
            assert.ok(capturedPayload.text.format);
        });

        test('geminiChat formats tools, calls client.interactions.create with steps and normalizes rawResponse', async () => {
            let capturedPayload = null;
            const fakeClient = {
                interactions: {
                    create: async (payload) => {
                        capturedPayload = payload;
                        return {
                            id: 'interaction_abc',
                            model: 'gemini-2.5-flash',
                            status: 'completed',
                            steps: [
                                {
                                    type: 'thought',
                                    signature: 'sig_123',
                                    summary: [{ type: 'text', text: 'Locating Tokyo coordinates...' }],
                                },
                                {
                                    type: 'model_output',
                                    content: [{ type: 'text', text: 'Tokyo is in Japan.' }],
                                },
                            ],
                            usage: {
                                total_input_tokens: 15,
                                total_output_tokens: 10,
                                total_tokens: 25,
                            },
                        };
                    },
                },
            };

            const tools = [
                {
                    name: 'get_geo',
                    description: 'Get geo info',
                    parameters: { type: 'object', properties: { place: { type: 'string' } } },
                },
            ];

            const result = await geminiChat(fakeClient, [
                { role: 'system', text: 'Be concise.' },
                { role: 'user', text: 'Where is Tokyo?' },
            ], {
                model: 'gemini-2.5-flash',
                tools,
            });

            assert.equal(result.output, 'Tokyo is in Japan.');
            assert.equal(capturedPayload.model, 'gemini-2.5-flash');
            assert.equal(capturedPayload.system_instruction, 'Be concise.');
            assert.equal(capturedPayload.input.length, 1);
            assert.equal(capturedPayload.input[0].type, 'user_input');
            assert.equal(capturedPayload.tools[0].type, 'function');
            assert.equal(capturedPayload.tools[0].name, 'get_geo');

            assert.equal(result.rawResponse.id, 'interaction_abc');
            assert.equal(result.rawResponse.output.length, 2);
            assert.equal(result.rawResponse.output[0].type, 'reasoning');
            assert.equal(result.rawResponse.output[0].thoughtSignature, 'sig_123');
            assert.equal(result.rawResponse.output[1].type, 'message');
            assert.equal(result.rawResponse.output[1].content, 'Tokyo is in Japan.');
        });

        test('geminiChat with outputSchema enforces response_format and parses structured output', async () => {
            let capturedPayload = null;
            const fakeClient = {
                interactions: {
                    create: async (payload) => {
                        capturedPayload = payload;
                        return {
                            id: 'interaction_schema',
                            steps: [
                                {
                                    type: 'model_output',
                                    content: [{ type: 'text', text: JSON.stringify({ score: 98, passed: true }) }],
                                },
                            ],
                        };
                    },
                },
            };

            const schema = z.object({
                score: z.number(),
                passed: z.boolean(),
            });

            const result = await geminiChat(fakeClient, [{ role: 'user', content: 'Grade the exam' }], {
                outputSchema: schema,
            });

            assert.deepEqual(result.output, { score: 98, passed: true });
            assert.ok(capturedPayload.response_format);
        });
    });
});
