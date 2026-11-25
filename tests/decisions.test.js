import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import EventEmitter from 'node:events';
import { z } from 'zod';
import { LLMService } from '../src/services/llm-service.js';
import * as OpenAIProvider from '../src/providers/openai.js';
import * as GeminiProvider from '../src/providers/gemini.js';
import * as GeminiInteractionsProvider from '../src/providers/gemini-interactions.js';
import {
    getDefaultDecisionModel,
    registerProvider,
} from '../src/providers/registry.js';
import {
    getDefaultOpenaiDecisionModel,
    getDefaultGeminiDecisionModel,
    getDefaultDecisionModel as getConfigDefaultDecisionModel,
} from '../src/config.js';

/**
 * Shared swappable-adapter contract suite: both OpenAI and Gemini must accept
 * identical OpenAI-syntax requests and return identical OpenAI-syntax answers.
 */
function decisionsProviderContract(providerName, { decide, makeMockClient }) {
    describe(`${providerName} Decisions Contract`, () => {
        test('evaluates predicate, choice, and score questions in one pass and returns OpenAI-syntax answers in order', async () => {
            const client = makeMockClient({
                predicate: 0.94,
                choice: {
                    winner: 'billing',
                    probs: { billing: 0.91, technical: 0.05, shipping: 0.02, other: 0.02 },
                    confidence: 0.91,
                },
                score: {
                    score: 1.15,
                    probs: { 0: 0.05, 1: 0.75, 2: 0.2 },
                    confidence: 0.75,
                },
            });

            const questions = [
                {
                    type: 'predicate',
                    name: 'is_duplicate_charge',
                    instructions: 'Is the customer reporting a duplicate charge?',
                },
                {
                    type: 'choice',
                    name: 'department',
                    instructions: 'Which department should handle this complaint?',
                    choices: [
                        { value: 'billing', description: 'Payments, invoices, and refunds.' },
                        { value: 'technical', description: 'Problems using the product.' },
                        { value: 'shipping', description: 'Delivery and tracking.' },
                        { value: 'other', description: 'Requests outside these categories.' },
                    ],
                },
                {
                    type: 'score',
                    name: 'severity',
                    instructions: 'How severe is this issue?',
                    levels: [
                        { label: 'Cosmetic', description: 'Appearance only; no lost functionality.' },
                        { label: 'Workaround available', description: 'A task fails, but another way works.' },
                        { label: 'Fully blocked', description: 'A task fails with no workaround.' },
                    ],
                },
            ];

            const result = await decide(client, 'I was charged twice for my order.', questions);

            assert.equal(result.answers.length, 3);
            assert.deepEqual(result.answers[0], {
                type: 'predicate',
                name: 'is_duplicate_charge',
                probability: 0.94,
            });
            assert.deepEqual(result.answers[1], {
                type: 'choice',
                name: 'department',
                choice: 'billing',
                probabilities: [
                    { value: 'billing', probability: 0.91 },
                    { value: 'technical', probability: 0.05 },
                    { value: 'shipping', probability: 0.02 },
                    { value: 'other', probability: 0.02 },
                ],
                confidence: 0.91,
            });
            assert.deepEqual(result.answers[2], {
                type: 'score',
                name: 'severity',
                score: 1.15,
                probabilities: [
                    { value: 0, label: 'Cosmetic', probability: 0.05 },
                    { value: 1, label: 'Workaround available', probability: 0.75 },
                    { value: 2, label: 'Fully blocked', probability: 0.2 },
                ],
                confidence: 0.75,
            });

            assert.equal(typeof result.model, 'string');
            assert.equal(result.usage.input_tokens, 120);
            assert.equal(result.usage.output_tokens, 0);
            assert.equal(result.usage.total_tokens, 120);
            assert.ok(result.rawResponse);
        });

        test('preserves unnamed questions as name: null and supports boolean choice values', async () => {
            const client = makeMockClient({
                predicate: 0.8,
                boolChoice: {
                    winner: true,
                    probs: { true: 0.88, false: 0.12 },
                    confidence: 0.88,
                },
            });

            const questions = [
                {
                    type: 'predicate',
                    instructions: 'Is this urgent?',
                },
                {
                    type: 'choice',
                    name: 'escalate',
                    instructions: 'Should this escalate?',
                    choices: [
                        { value: true, description: 'Escalate immediately' },
                        { value: false, description: 'Handle normally' },
                    ],
                },
            ];

            const result = await decide(client, 'Production is down!', questions);

            assert.equal(result.answers[0].name, null);
            assert.equal(result.answers[0].type, 'predicate');
            assert.equal(result.answers[1].type, 'choice');
            assert.strictEqual(result.answers[1].choice, true);
            assert.strictEqual(result.answers[1].probabilities[0].value, true);
            assert.strictEqual(result.answers[1].probabilities[1].value, false);
        });

        test('validates questions and input at the boundary before calling SDK', async () => {
            let called = false;
            const guardClient = {
                decisions: {
                    create: async () => {
                        called = true;
                        throw new Error('Should not be called');
                    },
                },
            };

            await assert.rejects(() => decide(guardClient, null, [{ type: 'predicate', instructions: 'ok?' }]), TypeError);
            await assert.rejects(() => decide(guardClient, 'hi', []), TypeError);
            await assert.rejects(() => decide(guardClient, 'hi', [{ type: 'unknown', instructions: 'ok?' }]), /Unsupported decision question type/);
            await assert.rejects(
                () => decide(guardClient, 'hi', [{ type: 'choice', instructions: 'pick', choices: [{ value: 'only_one' }] }]),
                /at least 2 choices/
            );
            await assert.rejects(
                () => decide(guardClient, 'hi', [{ type: 'score', instructions: 'rate', levels: [{ label: 'only_one' }] }]),
                /at least 2 levels/
            );
            assert.equal(called, false);
        });

        test('validates input with inputSchema when provided', async () => {
            const client = makeMockClient({ predicate: 0.5 });
            const schema = z.string().min(5);

            const ok = await decide(client, 'Valid text', [{ type: 'predicate', name: 'p', instructions: 'Valid?' }], { inputSchema: schema });
            assert.equal(ok.answers[0].probability, 0.5);

            await assert.rejects(
                () => decide(client, 'no', [{ type: 'predicate', name: 'p', instructions: 'Valid?' }], { inputSchema: schema }),
                /at least 5/
            );
        });
    });
}

describe('Decisions API Support', () => {
    describe('Configuration, Registry, and Model Limits', () => {
        test('default decision models are configured for OpenAI and Gemini', () => {
            assert.equal(getDefaultOpenaiDecisionModel(), 'gpt-6-luna');
            assert.equal(getDefaultGeminiDecisionModel(), 'gemini-decision-1');
            assert.equal(getConfigDefaultDecisionModel('openai'), 'gpt-6-luna');
            assert.equal(getConfigDefaultDecisionModel('gemini'), 'gemini-decision-1');
            assert.equal(getConfigDefaultDecisionModel('gemini-interactions'), 'gemini-decision-1');

            assert.equal(OpenAIProvider.defaultDecisionModel, 'gpt-6-luna');
            assert.equal(GeminiProvider.defaultDecisionModel, 'gemini-decision-1');
            assert.equal(GeminiInteractionsProvider.defaultDecisionModel, 'gemini-decision-1');

            assert.equal(getDefaultDecisionModel('openai'), 'gpt-6-luna');
            assert.equal(getDefaultDecisionModel('gemini'), 'gemini-decision-1');
            assert.equal(getDefaultDecisionModel('gemini-interactions'), 'gemini-decision-1');
        });

        test('model limits include gpt-6-luna and gemini-decision-1', () => {
            assert.deepEqual(OpenAIProvider.getModelLimits('gpt-6-luna'), {
                inputTokenLimit: 922000,
                outputTokenLimit: 128000,
            });
            assert.deepEqual(GeminiProvider.getModelLimits('gemini-decision-1'), {
                inputTokenLimit: 262144,
                outputTokenLimit: 0,
            });
        });
    });

    // Run identical contract suite against OpenAI and Gemini providers
    decisionsProviderContract('OpenAI', {
        decide: OpenAIProvider.decide,
        makeMockClient: (spec) => ({
            decisions: {
                create: async (payload) => {
                    const answers = payload.questions.map((q) => {
                        const name = q.name ?? null;
                        if (q.type === 'predicate') {
                            return { type: 'predicate', name, probability: spec.predicate ?? 0.5 };
                        }
                        if (q.type === 'choice') {
                            const cfg = typeof q.choices[0].value === 'boolean' ? spec.boolChoice : spec.choice;
                            return {
                                type: 'choice',
                                name,
                                choice: cfg.winner,
                                probabilities: q.choices.map(c => ({
                                    value: c.value,
                                    probability: cfg.probs[String(c.value)],
                                })),
                                confidence: cfg.confidence,
                            };
                        }
                        return {
                            type: 'score',
                            name,
                            score: spec.score.score,
                            probabilities: q.levels.map((l, idx) => ({
                                value: idx,
                                label: l.label,
                                probability: spec.score.probs[idx],
                            })),
                            confidence: spec.score.confidence,
                        };
                    });
                    return {
                        model: payload.model,
                        answers,
                        usage: {
                            input_tokens: 120,
                            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
                            output_tokens: 0,
                            output_tokens_details: { reasoning_tokens: 0 },
                            total_tokens: 120,
                        },
                    };
                },
            },
        }),
    });

    decisionsProviderContract('Gemini', {
        decide: GeminiProvider.decide,
        makeMockClient: (spec) => ({
            decisions: {
                create: async (payload) => {
                    const answers = {};
                    for (const [key, q] of Object.entries(payload.questions)) {
                        if (q.type === 'noul') {
                            const p = spec.predicate ?? 0.5;
                            answers[key] = { type: 'noul', noul: p, confidence: Math.max(p, 1 - p) };
                        } else if (q.type === 'choice') {
                            const isBool = Object.hasOwn(q.criteria, 'true');
                            const cfg = isBool ? spec.boolChoice : spec.choice;
                            answers[key] = {
                                type: 'choice',
                                choice: String(cfg.winner),
                                probabilities: { ...cfg.probs },
                                confidence: cfg.confidence,
                            };
                        } else if (q.type === 'score') {
                            const legend = {};
                            const probs = {};
                            q.criteria.forEach((desc, idx) => {
                                legend[String(idx)] = desc;
                                probs[String(idx)] = spec.score.probs[idx];
                            });
                            answers[key] = {
                                type: 'score',
                                score: spec.score.score,
                                legend,
                                probabilities: probs,
                                confidence: spec.score.confidence,
                            };
                        }
                    }
                    return {
                        answers,
                        usage: {
                            total_input_tokens: 120,
                            input_tokens_by_modality: [{ modality: 'text', tokens: 120 }],
                            total_output_tokens: 0,
                            total_tokens: 120,
                        },
                    };
                },
            },
        }),
    });

    describe('OpenAI Provider Decisions Specifics', () => {
        test('forwards OpenAI-specific options, multimodal inputs, JSON parts, question images, and AbortSignal', async () => {
            let capturedPayload = null;
            let capturedReqOptions = null;

            const mockClient = {
                decisions: {
                    create: async (payload, reqOptions) => {
                        capturedPayload = payload;
                        capturedReqOptions = reqOptions;
                        return {
                            model: payload.model,
                            answers: [{ type: 'predicate', name: 'matches_ref', probability: 0.97 }],
                            usage: {
                                input_tokens: 200,
                                input_tokens_details: { cached_tokens: 100, cache_write_tokens: 0 },
                                output_tokens: 0,
                                output_tokens_details: { reasoning_tokens: 0 },
                                total_tokens: 200,
                            },
                        };
                    },
                },
            };

            const controller = new AbortController();
            const input = [
                {
                    role: 'user',
                    content: [
                        { type: 'input_text', text: 'Reference item', prompt_cache_breakpoint: { mode: 'explicit' } },
                        { type: 'input_image', image_url: 'https://example.com/ref.png', detail: 'high' },
                        { type: 'input_json', data: { sku: 'ABC-123' } },
                    ],
                },
                { type: 'reasoning', summary: 'ignored reasoning item', content: 'hidden' },
            ];
            const questions = [
                {
                    type: 'predicate',
                    name: 'matches_ref',
                    instructions: [
                        { type: 'input_text', text: 'Does this candidate match the reference?' },
                        { type: 'input_image', image_url: 'https://example.com/candidate.png' },
                    ],
                },
            ];

            const result = await OpenAIProvider.decide(mockClient, input, questions, {
                signal: controller.signal,
                prompt_cache_key: 'catalog-v1',
                prompt_cache_options: { mode: 'explicit', ttl: '30m' },
                safety_identifier: 'user-hash-42',
            });

            assert.equal(capturedPayload.model, 'gpt-6-luna');
            assert.equal(capturedPayload.input.length, 1); // reasoning filtered out
            assert.equal(capturedPayload.input[0].role, 'user');
            assert.deepEqual(capturedPayload.input[0].content[0].prompt_cache_breakpoint, { mode: 'explicit' });
            assert.deepEqual(capturedPayload.input[0].content[2], { type: 'input_json', data: { sku: 'ABC-123' } });
            assert.equal(capturedPayload.questions[0].instructions.length, 2);
            assert.equal(capturedPayload.prompt_cache_key, 'catalog-v1');
            assert.deepEqual(capturedPayload.prompt_cache_options, { mode: 'explicit', ttl: '30m' });
            assert.equal(capturedPayload.safety_identifier, 'user-hash-42');
            assert.equal(capturedReqOptions.signal, controller.signal);

            assert.equal(result.answers[0].probability, 0.97);
            assert.equal(result.usage.input_tokens_details.cached_tokens, 100);
        });

        test('normalizes conversation history with function calls and custom tool calls', () => {
            const { input } = OpenAIProvider.toDecisionProvider(
                [
                    { role: 'system', content: 'Check policy compliance.' },
                    { role: 'user', content: 'Refund order 42' },
                    { type: 'function_call', call_id: 'call_1', name: 'get_order', arguments: { id: 42 } },
                    { type: 'function_call_output', call_id: 'call_1', output: { paid: 49, charges: [49, 49] } },
                    { type: 'custom_tool_call', call_id: 'ct_1', name: 'sql', input: 'SELECT 1' },
                    { type: 'custom_tool_call_output', call_id: 'ct_1', output: '1' },
                    { role: 'assistant', content: 'Refund approved.', phase: 'final_answer' },
                ],
                [{ type: 'predicate', name: 'compliant', instructions: 'Was the agent compliant?' }]
            );

            assert.equal(input.length, 7);
            assert.equal(input[2].arguments, '{"id":42}');
            assert.equal(input[3].output, '{"paid":49,"charges":[49,49]}');
            assert.equal(input[4].type, 'custom_tool_call');
            assert.equal(input[5].type, 'custom_tool_call_output');
            assert.equal(input[6].phase, 'final_answer');
        });

        test('throws descriptive error when client lacks decisions.create', async () => {
            await assert.rejects(
                () => OpenAIProvider.decide({}, 'hello', [{ type: 'predicate', instructions: 'hi?' }]),
                /OpenAI Decisions API requires openai/
            );
        });
    });

    describe('Gemini Provider Decisions Translation', () => {
        test('translates multimodal user message (text, base64 image, HTTPS image, JSON) into Gemini blocks', () => {
            const converted = GeminiProvider.toDecisionProvider(
                [
                    {
                        role: 'user',
                        content: [
                            { type: 'input_text', text: 'Inspect the product.' },
                            { type: 'input_json', data: { order_id: '8821', charges: [49, 49] } },
                            { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'low' },
                            { type: 'input_image', image_url: 'https://example.com/photo.webp?sig=abc', detail: 'original' },
                        ],
                    },
                ],
                [
                    {
                        type: 'predicate',
                        name: 'visible_damage',
                        instructions: 'Is there visible damage?',
                    },
                ]
            );

            assert.deepEqual(converted.input, [
                { type: 'text', text: 'Inspect the product.' },
                { type: 'text', text: '\n{"order_id":"8821","charges":[49,49]}' },
                { type: 'image', data: 'iVBORw0KGgo=', mime_type: 'image/png', resolution: 'low' },
                { type: 'image', uri: 'https://example.com/photo.webp?sig=abc', mime_type: 'image/webp', resolution: 'ultra_high' },
            ]);
            assert.deepEqual(converted.questions, {
                visible_damage: {
                    type: 'noul',
                    instructions: 'Is there visible damage?',
                },
            });
        });

        test('serializes multi-turn conversations and tool calls as labeled text blocks while preserving inline images', () => {
            const converted = GeminiProvider.toDecisionProvider(
                [
                    { role: 'system', content: 'Support policy: refund duplicate charges.' },
                    { role: 'user', content: 'I was billed twice.' },
                    { type: 'function_call', call_id: 'call_1', name: 'lookup_order', arguments: { id: '8821' } },
                    {
                        type: 'function_call_output',
                        call_id: 'call_1',
                        output: [
                            { type: 'input_text', text: 'Receipt attached' },
                            { type: 'input_image', image_url: 'https://example.com/receipt.png' },
                        ],
                    },
                    { role: 'assistant', content: 'I can help with that.' },
                ],
                [{ type: 'predicate', name: 'valid_claim', instructions: 'Is the claim supported?' }]
            );

            assert.equal(converted.input.length, 7);
            assert.equal(converted.input[0].text, '[system]: Support policy: refund duplicate charges.');
            assert.ok(converted.input[1].text.includes('[user]: I was billed twice.'));
            assert.ok(converted.input[2].text.includes('[function_call lookup_order (call_1)]: {"id":"8821"}'));
            assert.ok(converted.input[3].text.includes('[function_call_output (call_1)]:'));
            assert.ok(converted.input[4].text.includes('Receipt attached'));
            assert.deepEqual(converted.input[5], {
                type: 'image',
                uri: 'https://example.com/receipt.png',
                mime_type: 'image/png',
            });
            assert.equal(converted.input[6].text, '[assistant]: I can help with that.');
        });

        test('handles multi-turn assistant message after tool output image cleanly', () => {
            const converted = GeminiProvider.toDecisionProvider(
                [
                    { role: 'user', content: 'Check image' },
                    {
                        type: 'function_call_output',
                        call_id: 'call_1',
                        output: [{ type: 'input_image', image_url: 'https://example.com/pic.jpg' }],
                    },
                    { role: 'assistant', content: 'Looks damaged.' },
                ],
                [{ type: 'predicate', name: 'damaged', instructions: 'Damaged?' }]
            );

            assert.equal(converted.input[0].text, '[user]: Check image');
            assert.equal(converted.input[1].text, '\n[function_call_output (call_1)]:');
            assert.deepEqual(converted.input[2], {
                type: 'image',
                uri: 'https://example.com/pic.jpg',
                mime_type: 'image/jpeg',
            });
            assert.equal(converted.input[3].text, '[assistant]: Looks damaged.');
        });

        test('sanitizes invalid/duplicate/unnamed question names for Gemini keys and restores exact OpenAI names & order', () => {
            const converted = GeminiProvider.toDecisionProvider('Order #42', [
                { type: 'predicate', name: 'Has Damage?', instructions: 'Damaged?' },
                { type: 'predicate', name: 'Has Damage?', instructions: 'Really damaged?' },
                { type: 'predicate', instructions: 'Unnamed check?' },
            ]);

            const keys = Object.keys(converted.questions);
            assert.equal(keys.length, 3);
            for (const key of keys) {
                assert.match(key, /^[A-Za-z0-9_-]{1,64}$/);
            }

            // Simulate Gemini returning answers in a different object key order (e.g. reversed)
            const rawGeminiResponse = {
                answers: {
                    [keys[2]]: { type: 'noul', noul: 0.3, confidence: 0.7 },
                    [keys[0]]: { type: 'noul', noul: 0.9, confidence: 0.9 },
                    // keys[1] intentionally missing -> normalized to refusal
                },
                usage: { total_input_tokens: 50, total_output_tokens: 0, total_tokens: 50 },
            };

            const normalized = GeminiProvider.fromDecisionProvider(rawGeminiResponse, converted.questionSpecs, 'gemini-decision-1');
            assert.deepEqual(normalized.answers, [
                { type: 'predicate', name: 'Has Damage?', probability: 0.9 },
                { type: 'refusal', name: 'Has Damage?' },
                { type: 'predicate', name: null, probability: 0.3 },
            ]);
            assert.equal(normalized.rawResponse.originalFormat, rawGeminiResponse);
        });

        test('passes through Gemini-native media blocks (PDF document, audio, video)', () => {
            const converted = GeminiProvider.toDecisionProvider(
                [
                    { type: 'document', data: 'JVBERi0xLjQ=', mime_type: 'application/pdf' },
                    { type: 'audio', uri: 'https://example.com/call.wav', mime_type: 'audio/wav' },
                ],
                [{ type: 'predicate', name: 'has_po', instructions: 'Has PO number?' }]
            );

            assert.deepEqual(converted.input, [
                { type: 'document', data: 'JVBERi0xLjQ=', mime_type: 'application/pdf' },
                { type: 'audio', uri: 'https://example.com/call.wav', mime_type: 'audio/wav' },
            ]);
        });

        test('rejects images in question instructions, empty input, and invalid Gemini choice keys', () => {
            assert.throws(
                () => GeminiProvider.toDecisionProvider('ref', [
                    {
                        type: 'predicate',
                        name: 'compare',
                        instructions: [
                            { type: 'input_text', text: 'Matches?' },
                            { type: 'input_image', image_url: 'https://example.com/candidate.jpg' },
                        ],
                    },
                ]),
                /does not support images or other media in question instructions/
            );

            assert.throws(
                () => GeminiProvider.toDecisionProvider('', [{ type: 'predicate', instructions: 'Ok?' }]),
                /Decision input cannot be empty/
            );

            assert.throws(
                () => GeminiProvider.toDecisionProvider('text', [
                    {
                        type: 'choice',
                        name: 'bad_space',
                        instructions: 'Pick',
                        choices: [
                            { value: ' leading', description: 'bad' },
                            { value: 'ok', description: 'good' },
                        ],
                    },
                ]),
                /leading\/trailing whitespace/
            );

            assert.throws(
                () => GeminiProvider.toDecisionProvider('text', [
                    {
                        type: 'choice',
                        name: 'dup',
                        instructions: 'Pick',
                        choices: [
                            { value: true, description: 'bool true' },
                            { value: 'true', description: 'str true' },
                        ],
                    },
                ]),
                /Duplicate choice key/
            );
        });

        test('passes api_version v1beta, forwards AbortSignal via fetchOptions, and strips OpenAI-only options', async () => {
            let capturedPayload = null;
            let capturedReqOptions = null;

            const mockClient = {
                decisions: {
                    create: async (payload, reqOptions) => {
                        capturedPayload = payload;
                        capturedReqOptions = reqOptions;
                        return {
                            answers: {
                                check: { type: 'noul', noul: 0.85, confidence: 0.85 },
                            },
                            usage: { total_input_tokens: 42, total_output_tokens: 0, total_tokens: 42 },
                        };
                    },
                },
            };

            const controller = new AbortController();
            const result = await GeminiProvider.decide(
                mockClient,
                'Hello world',
                [{ type: 'predicate', name: 'check', instructions: 'Is this a greeting?' }],
                {
                    signal: controller.signal,
                    prompt_cache_key: 'openai-only-key',
                    prompt_cache_options: { mode: 'explicit' },
                    safety_identifier: 'openai-only-id',
                }
            );

            assert.equal(capturedPayload.model, 'gemini-decision-1');
            assert.equal(capturedPayload.api_version, 'v1beta');
            assert.equal(capturedPayload.prompt_cache_key, undefined);
            assert.equal(capturedPayload.prompt_cache_options, undefined);
            assert.equal(capturedPayload.safety_identifier, undefined);
            assert.equal(capturedReqOptions.fetchOptions.signal, controller.signal);
            assert.equal(result.answers[0].probability, 0.85);
            assert.equal(GeminiInteractionsProvider.decide, GeminiProvider.decide);
        });

        test('throws descriptive error when Gemini client lacks decisions.create', async () => {
            await assert.rejects(
                () => GeminiProvider.decide({}, 'hello', [{ type: 'predicate', instructions: 'hi?' }]),
                /Gemini Decisions API requires @google\/genai/
            );
        });
    });

    describe('LLMService.decide Integration', () => {
        test('retries transient failures, emits llm:retry, and strips internal retry options', async () => {
            let attempts = 0;
            let receivedOptions = null;

            registerProvider('fake-decisions-retry', {
                defaultDecisionModel: 'fake-decision-model',
                createClient: () => ({}),
                isRetryable: (err) => ({ retryable: err.status === 503 }),
                decide: async (_client, input, questions, options) => {
                    attempts += 1;
                    receivedOptions = options;
                    if (attempts === 1) {
                        const err = new Error('Service Unavailable');
                        err.status = 503;
                        throw err;
                    }
                    return {
                        answers: [{ type: 'predicate', name: questions[0].name ?? null, probability: 0.99 }],
                        model: options.model,
                        usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 },
                        rawResponse: { ok: true },
                    };
                },
            });

            const events = [];
            const emitter = new EventEmitter();
            emitter.on('llm:retry', e => events.push(e));

            const llm = new LLMService({ provider: 'fake-decisions-retry' }, { eventEmitter: emitter });
            const res = await llm.decide(
                'Order arrived broken',
                [{ type: 'predicate', name: 'damaged', instructions: 'Damaged?' }],
                { retry: { maxRetries: 2, baseDelayMS: 5, exprDelayMS: 0 }, maxRetries: 2, initialDelay: 5, prompt_cache_key: 'k1' }
            );

            assert.equal(attempts, 2);
            assert.equal(events.length, 1);
            assert.equal(res.model, 'fake-decision-model');
            assert.equal(res.answers[0].probability, 0.99);
            assert.equal(receivedOptions.maxRetries, undefined);
            assert.equal(receivedOptions.initialDelay, undefined);
            assert.equal(receivedOptions.prompt_cache_key, 'k1');
        });

        test('does not retry non-retryable 400 safety errors', async () => {
            let attempts = 0;
            registerProvider('fake-decisions-safety', {
                defaultDecisionModel: 'fake-decision-model',
                createClient: () => ({}),
                isRetryable: GeminiProvider.isRetryable,
                decide: async () => {
                    attempts += 1;
                    const err = new Error('Request blocked due to safety violations');
                    err.status = 400;
                    throw err;
                },
            });

            const llm = new LLMService({ provider: 'fake-decisions-safety' });
            await assert.rejects(
                () => llm.decide('unsafe', [{ type: 'predicate', instructions: 'ok?' }], { maxRetries: 3, initialDelay: 5 }),
                /safety violations/
            );
            assert.equal(attempts, 1);
        });

        test('throws descriptive error when provider does not support decisions (e.g. vllm)', async () => {
            const llm = new LLMService({ provider: 'vllm' });
            await assert.rejects(
                () => llm.decide('hello', [{ type: 'predicate', instructions: 'greeting?' }]),
                /Provider "vllm" does not support decisions/
            );
        });
    });
});
