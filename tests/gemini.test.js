import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
    createClient,
    defaultModel,
    getModelContextLimit,
    getModelLimits,
    _fetchModelLimits,
    isRetryable,
    toProvider,
    fromProvider,
    chat,
} from '../src/providers/gemini.js';
import { getDefaultGeminiModel } from '../src/config.js';
import { Agent } from '../src/core/agent.js';

describe('Gemini Provider (models.generateContent)', () => {
    describe('Module Interface & Metadata', () => {
        test('defaultModel matches config default Gemini model', () => {
            assert.equal(defaultModel, getDefaultGeminiModel());
            assert.ok(typeof defaultModel === 'string' && defaultModel.length > 0);
        });

        test('createClient instantiates GoogleGenAI client with apiKey', () => {
            const client = createClient({ apiKey: 'test-key-123' });
            assert.ok(client);
            assert.ok(client.models);
        });

        test('getModelContextLimit and getModelLimits return correct limits', () => {
            const contextLimit = getModelContextLimit('gemini-2.5-flash');
            assert.equal(contextLimit, 1048576);

            const limits = getModelLimits('gemini-2.5-flash');
            assert.equal(limits.inputTokenLimit, 1048576);
            assert.equal(limits.outputTokenLimit, 8192);
        });

        test('_fetchModelLimits queries client.models.list and updates registry', async () => {
            const mockClient = {
                models: {
                    list: async () => [
                        {
                            name: 'models/gemini-mock-3',
                            inputTokenLimit: 4000000,
                            outputTokenLimit: 16384,
                        },
                    ],
                },
            };

            const discovered = await _fetchModelLimits(mockClient);
            assert.equal(discovered['gemini-mock-3'].inputTokenLimit, 4000000);
            assert.equal(getModelContextLimit('gemini-mock-3'), 4000000);
        });
    });

    describe('isRetryable error classifier', () => {
        test('returns retryable: true for 429 and 5xx errors', () => {
            assert.deepEqual(isRetryable({ status: 429 }), { retryable: true });
            assert.deepEqual(isRetryable({ statusCode: 500 }), { retryable: true });
            assert.deepEqual(isRetryable({ response: { status: 503 } }), { retryable: true });
        });

        test('returns retryable: true for Gemini status text messages and network errors', () => {
            assert.deepEqual(isRetryable(new Error('RESOURCE_EXHAUSTED')), { retryable: true });
            assert.deepEqual(isRetryable(new Error('UNAVAILABLE')), { retryable: true });
            assert.deepEqual(isRetryable(new Error('DEADLINE_EXCEEDED')), { retryable: true });

            const netErr = new Error('Connection reset');
            netErr.code = 'ECONNRESET';
            assert.deepEqual(isRetryable(netErr), { retryable: true });

            const abortErr = new Error('The operation was aborted');
            abortErr.name = 'AbortError';
            assert.deepEqual(isRetryable(abortErr), { retryable: true });
        });

        test('returns retryable: false for 400, 401, 403, 404, null, and generic errors', () => {
            assert.deepEqual(isRetryable(null), { retryable: false });
            assert.deepEqual(isRetryable({ status: 400 }), { retryable: false });
            assert.deepEqual(isRetryable({ status: 401 }), { retryable: false });
            assert.deepEqual(isRetryable({ status: 403 }), { retryable: false });
            assert.deepEqual(isRetryable({ status: 404 }), { retryable: false });
            assert.deepEqual(isRetryable(new Error('Generic domain error')), { retryable: false });
        });
    });

    describe('toProvider Input Conversion', () => {
        test('throws when input is not an array or has no prompt contents', () => {
            assert.throws(() => toProvider(null), /User prompt not detected/);
            assert.throws(() => toProvider([]), /User prompt not detected/);
            assert.throws(() => toProvider([{ role: 'system', content: 'system only' }]), /User prompt not detected/);
        });

        test('converts basic user and system messages', () => {
            const input = [
                { role: 'system', content: 'You are an astronomer.' },
                { role: 'user', content: 'How far is Mars?' },
            ];

            const converted = toProvider(input);
            assert.deepEqual(converted.systemParts, [{ text: 'You are an astronomer.' }]);
            assert.equal(converted.contents.length, 1);
            assert.equal(converted.contents[0].role, 'user');
            assert.deepEqual(converted.contents[0].parts, [{ text: 'How far is Mars?' }]);
        });

        test('converts speaker prefix for user and assistant messages', () => {
            const input = [
                { role: 'user', text: 'Hello', speaker: 'Alice' },
                { role: 'assistant', text: 'Hi Alice', speaker: 'Bob' },
            ];

            const converted = toProvider(input);
            assert.equal(converted.contents.length, 2);
            assert.equal(converted.contents[0].role, 'user');
            assert.deepEqual(converted.contents[0].parts, [{ text: '[Alice]: Hello' }]);
            assert.equal(converted.contents[1].role, 'model');
            assert.deepEqual(converted.contents[1].parts, [{ text: '[Bob]: Hi Alice' }]);
        });

        test('converts function calls and function responses with object and string outputs', () => {
            const input = [
                { role: 'user', content: 'Compute distance' },
                {
                    type: 'function_call',
                    call_id: 'call_dist_1',
                    name: 'get_distance',
                    arguments: JSON.stringify({ target: 'Mars' }),
                    thoughtSignature: 'sig_call_1',
                },
                {
                    type: 'function_call_output',
                    call_id: 'call_dist_1',
                    output: { distance_km: 225000000 },
                    thoughtSignature: 'sig_resp_1',
                },
                {
                    type: 'function_call',
                    id: 'call_dist_2',
                    name: 'get_speed',
                    args: { unit: 'kmh' },
                },
                {
                    type: 'function_call_output',
                    id: 'call_dist_2',
                    output: JSON.stringify({ speed: 40000 }),
                },
            ];

            const converted = toProvider(input);
            assert.equal(converted.contents.length, 5);

            // User initial
            assert.equal(converted.contents[0].role, 'user');

            // Model function call 1
            assert.equal(converted.contents[1].role, 'model');
            assert.deepEqual(converted.contents[1].parts[0].functionCall, {
                name: 'get_distance',
                args: { target: 'Mars' },
            });
            assert.equal(converted.contents[1].parts[0].thoughtSignature, 'sig_call_1');

            // User function response 1 (object output preserved without JSON.parse crash)
            assert.equal(converted.contents[2].role, 'user');
            assert.deepEqual(converted.contents[2].parts[0].functionResponse, {
                name: 'get_distance',
                response: { result: { distance_km: 225000000 } },
            });
            assert.equal(converted.contents[2].parts[0].thoughtSignature, 'sig_resp_1');

            // Model function call 2
            assert.equal(converted.contents[3].role, 'model');
            assert.deepEqual(converted.contents[3].parts[0].functionCall, {
                name: 'get_speed',
                args: { unit: 'kmh' },
            });

            // User function response 2 (string JSON parsed)
            assert.equal(converted.contents[4].role, 'user');
            assert.deepEqual(converted.contents[4].parts[0].functionResponse, {
                name: 'get_speed',
                response: { result: { speed: 40000 } },
            });
        });

        test('converts multimodal image and text content', () => {
            const input = [
                {
                    role: 'user',
                    content: [
                        { type: 'input_text', text: 'Analyze this photo' },
                        { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' },
                    ],
                },
            ];

            const converted = toProvider(input);
            assert.equal(converted.contents.length, 1);
            assert.equal(converted.contents[0].role, 'user');
            assert.equal(converted.contents[0].parts.length, 2);
            assert.deepEqual(converted.contents[0].parts[0], { text: 'Analyze this photo' });
            assert.deepEqual(converted.contents[0].parts[1], {
                inlineData: {
                    mimeType: 'image/png',
                    data: 'iVBORw0KGgoAAAANSUhEUg==',
                },
            });
        });

        test('merges consecutive messages of the same role for API compliance', () => {
            const input = [
                { role: 'user', content: 'Part one.' },
                { role: 'user', content: 'Part two.' },
                { role: 'assistant', content: 'Model response 1.' },
                { role: 'assistant', content: 'Model response 2.' },
            ];

            const converted = toProvider(input);
            assert.equal(converted.contents.length, 2);
            assert.equal(converted.contents[0].role, 'user');
            assert.equal(converted.contents[0].parts.length, 2);
            assert.equal(converted.contents[1].role, 'model');
            assert.equal(converted.contents[1].parts.length, 2);
        });

        test('preserves thoughtSignature on functionCall parts from callId mapping and aliases', () => {
            const input = [
                { role: 'user', content: 'Run custom query' },
                {
                    type: 'function_call',
                    call_id: 'call_sql_42',
                    name: 'generate_custom_sql_query',
                    arguments: JSON.stringify({ query: 'SELECT 1' }),
                    thought_signature: 'sig_encrypted_thought_gemini_3',
                },
                {
                    type: 'function_call_output',
                    call_id: 'call_sql_42',
                    output: { rows: [{ result: 1 }] },
                },
            ];

            const converted = toProvider(input);
            assert.equal(converted.contents.length, 3);
            // Model turn: functionCall part must have thoughtSignature
            assert.equal(converted.contents[1].role, 'model');
            assert.equal(converted.contents[1].parts[0].thoughtSignature, 'sig_encrypted_thought_gemini_3');
            assert.deepEqual(converted.contents[1].parts[0].functionCall, {
                name: 'generate_custom_sql_query',
                args: { query: 'SELECT 1' },
            });

            // User turn: functionResponse part inherits signature from callId
            assert.equal(converted.contents[2].role, 'user');
            assert.equal(converted.contents[2].parts[0].thoughtSignature, 'sig_encrypted_thought_gemini_3');
            assert.deepEqual(converted.contents[2].parts[0].functionResponse, {
                name: 'generate_custom_sql_query',
                response: { result: { rows: [{ result: 1 }] } },
            });
        });
    });

    describe('fromProvider Output Normalization', () => {
        test('normalizes rawResponse.output array of messages, function calls, and reasoning', () => {
            const rawResponse = {
                output: [
                    { type: 'message', content: { text: 'Hello from model' } },
                    {
                        type: 'function_call',
                        name: 'weather',
                        arguments: '{"city":"Paris"}',
                        thoughtSignature: 'sig_fc',
                    },
                    {
                        type: 'reasoning',
                        summary: 'Thinking about weather...',
                        content: 'Check Paris API',
                    },
                ],
            };

            const items = fromProvider(rawResponse);
            assert.equal(items.length, 3);

            assert.equal(items[0].type, 'message');
            assert.equal(items[0].role, 'assistant');
            assert.equal(items[0].content, 'Hello from model');
            assert.equal(items[0].text, 'Hello from model');

            assert.equal(items[1].type, 'function_call');
            assert.equal(items[1].name, 'weather');
            assert.equal(items[1].arguments, '{"city":"Paris"}');
            assert.ok(items[1].id);
            assert.ok(items[1].call_id);
            assert.equal(items[1].thoughtSignature, 'sig_fc');

            assert.equal(items[2].type, 'reasoning');
            assert.equal(items[2].summary, 'Thinking about weather...');
            assert.equal(items[2].content, 'Check Paris API');
        });

        test('normalizes SDK candidate parts directly when passed', () => {
            const rawSdkResponse = {
                candidates: [
                    {
                        content: {
                            parts: [
                                { text: 'Candidate text' },
                                {
                                    functionCall: {
                                        name: 'calculate',
                                        args: { a: 1, b: 2 },
                                    },
                                    thoughtSignature: 'sig_calc',
                                },
                                {
                                    text: 'Reasoning thought',
                                    thought: true,
                                },
                            ],
                        },
                    },
                ],
            };

            const items = fromProvider(rawSdkResponse);
            assert.equal(items.length, 3);
            assert.equal(items[0].type, 'message');
            assert.equal(items[0].text, 'Candidate text');

            assert.equal(items[1].type, 'function_call');
            assert.equal(items[1].name, 'calculate');
            assert.equal(items[1].arguments, '{"a":1,"b":2}');
            assert.equal(items[1].thoughtSignature, 'sig_calc');

            assert.equal(items[2].type, 'reasoning');
            assert.equal(items[2].content, 'Reasoning thought');
        });

        test('returns empty array for empty or missing raw response', () => {
            assert.deepEqual(fromProvider(null), []);
            assert.deepEqual(fromProvider({}), []);
        });
    });

    describe('chat execution', () => {
        test('executes basic chat generation and returns output and rawResponse', async () => {
            let capturedArgs = null;
            const mockClient = {
                models: {
                    generateContent: async (args) => {
                        capturedArgs = args;
                        return {
                            modelVersion: 'gemini-2.5-flash',
                            responseId: 'resp-123',
                            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
                            candidates: [
                                {
                                    content: {
                                        parts: [{ text: 'Jupiter is the largest planet.' }],
                                    },
                                },
                            ],
                            text: () => 'Jupiter is the largest planet.',
                        };
                    },
                },
            };

            const result = await chat(mockClient, [
                { role: 'system', content: 'Answer concisely.' },
                { role: 'user', content: 'What is the largest planet?' },
            ], {
                model: 'gemini-2.5-flash',
            });

            assert.equal(result.output, 'Jupiter is the largest planet.');
            assert.equal(result.rawResponse.model, 'gemini-2.5-flash');
            assert.equal(result.rawResponse.id, 'resp-123');
            assert.deepEqual(result.rawResponse.usage, { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 });

            assert.equal(capturedArgs.model, 'gemini-2.5-flash');
            assert.deepEqual(capturedArgs.config.systemInstruction, {
                parts: [{ text: 'Answer concisely.' }],
            });
        });

        test('does not monkey-patch or mutate global console.warn', async () => {
            const originalWarn = console.warn;
            const mockClient = {
                models: {
                    generateContent: async () => ({
                        candidates: [{ content: { parts: [{ text: 'safe response' }] } }],
                        text: () => 'safe response',
                    }),
                },
            };

            await chat(mockClient, [{ role: 'user', content: 'test' }]);
            assert.equal(console.warn, originalWarn, 'console.warn must remain untouched');
        });

        test('formats custom and native tools properly', async () => {
            let capturedConfig = null;
            const mockClient = {
                models: {
                    generateContent: async (args) => {
                        capturedConfig = args.config;
                        return {
                            candidates: [{ content: { parts: [{ text: 'Done.' }] } }],
                        };
                    },
                },
            };

            const tools = [
                {
                    name: 'lookup_user',
                    description: 'Find user by ID',
                    parameters: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
                },
                {
                    googleSearch: {},
                },
            ];

            await chat(mockClient, [{ role: 'user', content: 'Find Alice' }], { tools });

            assert.ok(capturedConfig.tools);
            assert.equal(capturedConfig.tools.length, 2);

            // Custom function declaration tool
            assert.deepEqual(capturedConfig.tools[0], {
                functionDeclarations: [
                    {
                        name: 'lookup_user',
                        description: 'Find user by ID',
                        parameters: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
                    },
                ],
            });

            // Native tool preserved
            assert.deepEqual(capturedConfig.tools[1], { googleSearch: {} });
        });

        test('supports structured JSON generation with outputSchema', async () => {
            const mockClient = {
                models: {
                    generateContent: async (args) => {
                        assert.equal(args.config.responseMimeType, 'application/json');
                        assert.ok(args.config.responseJsonSchema);
                        return {
                            candidates: [
                                {
                                    content: {
                                        parts: [{ text: JSON.stringify({ name: 'Pluto', isPlanet: false, rank: 9 }) }],
                                    },
                                },
                            ],
                        };
                    },
                },
            };

            const schema = z.object({
                name: z.string(),
                isPlanet: z.boolean(),
                rank: z.number(),
            });

            const result = await chat(mockClient, [{ role: 'user', content: 'Classify Pluto' }], {
                outputSchema: schema,
            });

            assert.deepEqual(result.output, { name: 'Pluto', isPlanet: false, rank: 9 });
        });

        test('sets output to null when model returns functionCall even if outputSchema is requested', async () => {
            const mockClient = {
                models: {
                    generateContent: async () => ({
                        candidates: [
                            {
                                content: {
                                    parts: [
                                        {
                                            functionCall: {
                                                name: 'search_solar_system',
                                                args: { query: 'Pluto' },
                                            },
                                        },
                                    ],
                                },
                            },
                        ],
                    }),
                },
            };

            const schema = z.object({ answer: z.string() });
            const result = await chat(mockClient, [{ role: 'user', content: 'Search Pluto' }], {
                outputSchema: schema,
            });

            assert.equal(result.output, null);
            assert.equal(result.rawResponse.output[0].type, 'function_call');
            assert.equal(result.rawResponse.output[0].name, 'search_solar_system');
        });

        test('validates input with inputSchema when provided', async () => {
            const mockClient = {
                models: {
                    generateContent: async () => ({
                        candidates: [{ content: { parts: [{ text: 'Validated.' }] } }],
                    }),
                },
            };

            const schema = z.array(z.object({ role: z.string(), content: z.string() }));

            // Valid input passes schema validation
            const res = await chat(mockClient, [{ role: 'user', content: 'Valid' }], { inputSchema: schema });
            assert.equal(res.output, 'Validated.');

            // Invalid input throws validation error before calling model
            await assert.rejects(
                async () => {
                    await chat(mockClient, 'not an array', { inputSchema: schema });
                },
                /Expected array/
            );
        });

        test('passes abortSignal in config when signal option is provided', async () => {
            let capturedConfig = null;
            const mockClient = {
                models: {
                    generateContent: async (args) => {
                        capturedConfig = args.config;
                        return {
                            candidates: [{ content: { parts: [{ text: 'Done.' }] } }],
                        };
                    },
                },
            };

            const controller = new AbortController();
            await chat(mockClient, [{ role: 'user', content: 'Test signal' }], { signal: controller.signal });

            assert.equal(capturedConfig.abortSignal, controller.signal);
        });

        test('multi-turn tool loop preserves thoughtSignature in subsequent request contents', async () => {
            const requests = [];
            const mockClient = {
                models: {
                    generateContent: async (args) => {
                        requests.push(args);
                        if (requests.length === 1) {
                            // Turn 1: model returns tool call with thought signature (like Gemini 3)
                            return {
                                candidates: [
                                    {
                                        content: {
                                            parts: [
                                                {
                                                    functionCall: {
                                                        name: 'generate_custom_sql_query',
                                                        args: { query: 'SELECT name FROM artists LIMIT 1' },
                                                    },
                                                    thoughtSignature: 'encrypted_sig_turn1_step1',
                                                },
                                            ],
                                        },
                                    },
                                ],
                            };
                        }
                        // Turn 2: final answer
                        return {
                            candidates: [
                                {
                                    content: {
                                        parts: [{ text: 'The artist is AC/DC.' }],
                                    },
                                },
                            ],
                        };
                    },
                },
            };

            const llmService = {
                provider: 'gemini',
                chat: (input, opts) => chat(mockClient, input, opts),
                fromProvider,
            };

            const toolLoader = {
                getTools: () => [{ name: 'generate_custom_sql_query', description: 'query sql' }],
                findTool: (name) => {
                    if (name === 'generate_custom_sql_query') {
                        return {
                            name,
                            func: async () => ({ rows: [{ name: 'AC/DC' }] }),
                        };
                    }
                    return null;
                },
                getMCPInfo: () => ({ enabled: false }),
            };

            const agent = new Agent(llmService, {
                toolLoader,
                name: 'test-gemini-agent',
            });

            agent.addInput({ role: 'user', content: 'Who is the first artist?' });
            const history = await agent.run();

            assert.equal(history.length, 2);
            assert.equal(requests.length, 2);

            // Verify Turn 2 contents sent to Gemini API
            const secondCallContents = requests[1].contents;
            // Position 0: user "Who is the first artist?"
            assert.equal(secondCallContents[0].role, 'user');
            // Position 1: model function call with thoughtSignature preserved
            assert.equal(secondCallContents[1].role, 'model');
            assert.equal(secondCallContents[1].parts[0].functionCall.name, 'generate_custom_sql_query');
            assert.equal(secondCallContents[1].parts[0].thoughtSignature, 'encrypted_sig_turn1_step1');
            // Position 2: user function response
            assert.equal(secondCallContents[2].role, 'user');
            assert.equal(secondCallContents[2].parts[0].functionResponse.name, 'generate_custom_sql_query');
        });
    });
});
