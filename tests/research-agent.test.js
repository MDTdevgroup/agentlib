import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_MODEL,
    DEFAULT_PROVIDER,
    PlanOutputSchema,
    SynthesisOutputSchema,
    CitationOutputSchema,
    geminiWebSearchTool,
    askUserTool,
    ResearchMemory,
    parseJsonFromText,
    extractGroundingSources,
    createResearchSystem,
} from '../examples/research_agent/index.js';

describe('Research Agent Example', () => {
    describe('Constants & Configuration', () => {
        test('default model is gemini-3.8-flash', () => {
            assert.equal(DEFAULT_MODEL, 'gemini-3.8-flash');
        });

        test('default provider is gemini-interactions', () => {
            assert.equal(DEFAULT_PROVIDER, 'gemini-interactions');
        });
    });

    describe('Zod Schemas', () => {
        test('PlanOutputSchema validates aspects array', () => {
            const valid = { aspects_to_research: ['Aspect 1', 'Aspect 2'] };
            const parsed = PlanOutputSchema.parse(valid);
            assert.deepEqual(parsed.aspects_to_research, ['Aspect 1', 'Aspect 2']);

            assert.throws(() => PlanOutputSchema.parse({ aspects_to_research: 'not-an-array' }));
        });

        test('SynthesisOutputSchema validates structured synthesis output', () => {
            const valid = {
                query_intent: ['Understand quantum advances'],
                rules: ['Must have verified hardware tests'],
                entities: ['Google Quantum AI', 'IBM'],
                assertions: ['Qubit fidelity reached 99.9%'],
                clarification: null,
                more_research_needed: false,
            };
            const parsed = SynthesisOutputSchema.parse(valid);
            assert.equal(parsed.more_research_needed, false);
            assert.equal(parsed.entities.length, 2);

            assert.throws(() => SynthesisOutputSchema.parse({ more_research_needed: 'invalid' }));
        });

        test('CitationOutputSchema validates model with source references', () => {
            const valid = {
                query_intent: ['Find quantum hardware'],
                rules: null,
                entities: ['Rigetti'],
                assertions: ['Benchmarked at 84 qubits [https://example.com/quantum]'],
                clarification: null,
            };
            const parsed = CitationOutputSchema.parse(valid);
            assert.equal(parsed.entities[0], 'Rigetti');
            assert.equal(parsed.rules, null);
        });
    });

    describe('Tools Specifications', () => {
        test('geminiWebSearchTool is configured as native google_search tool', () => {
            assert.equal(geminiWebSearchTool.type, 'google_search');
        });

        test('askUserTool has valid schema and name', () => {
            assert.equal(askUserTool.name, 'ask_user');
            assert.equal(askUserTool.parameters.type, 'object');
            assert.deepEqual(askUserTool.parameters.required, ['questions']);
            assert.equal(typeof askUserTool.func, 'function');
        });
    });

    describe('parseJsonFromText Helper', () => {
        test('parses direct JSON strings', () => {
            const json = '{"aspects_to_research": ["A", "B"]}';
            const parsed = parseJsonFromText(json);
            assert.deepEqual(parsed, { aspects_to_research: ['A', 'B'] });
        });

        test('parses markdown code fenced JSON', () => {
            const text = 'Here is the plan:\n```json\n{"aspects_to_research": ["Topic 1"]}\n```\nDone.';
            const parsed = parseJsonFromText(text);
            assert.deepEqual(parsed, { aspects_to_research: ['Topic 1'] });
        });

        test('parses bracketed JSON within conversational text', () => {
            const text = 'Plan: {"aspects_to_research": ["Test"]} let me know what you think.';
            const parsed = parseJsonFromText(text);
            assert.deepEqual(parsed, { aspects_to_research: ['Test'] });
        });

        test('returns objects directly if already parsed', () => {
            const obj = { ok: true };
            assert.equal(parseJsonFromText(obj), obj);
        });

        test('throws descriptive error on unparseable text', () => {
            assert.throws(() => parseJsonFromText('completely invalid plain text without json'), /Could not extract valid JSON/);
        });
    });

    describe('ResearchMemory', () => {
        test('stores and retrieves raw content and concise insight', () => {
            const mockLLM = { chat: async () => ({ output: 'summary' }) };
            const memory = new ResearchMemory(mockLLM);

            memory.save(1, 'Full detailed findings 1', 'Concise insight 1');
            memory.save(2, 'Full detailed findings 2', 'Concise insight 2');

            assert.equal(memory.getInsight(1), 'Concise insight 1');
            assert.equal(memory.getFullContent(1), 'Full detailed findings 1');
            assert.equal(memory.getInsight(2), 'Concise insight 2');
            assert.equal(memory.getInsight(3), null);
        });

        test('getSummary returns full content for detailLevel="full" without calling LLM', async () => {
            let called = false;
            const mockLLM = {
                chat: async () => {
                    called = true;
                    return { output: 'summary' };
                },
            };
            const memory = new ResearchMemory(mockLLM);
            memory.save(1, 'Raw content', 'Short insight');

            const result = await memory.getSummary(1, 'full');
            assert.equal(result, 'Raw content');
            assert.equal(called, false);
        });

        test('getSummary calls LLM for granular summary and falls back gracefully on error', async () => {
            const failingLLM = {
                chat: async () => {
                    throw new Error('LLM rate limit');
                },
            };
            const memory = new ResearchMemory(failingLLM);
            memory.save(1, 'Raw content fallback', 'Insight');

            const result = await memory.getSummary(1, 'short');
            assert.equal(result, 'Raw content fallback');
        });
    });

    describe('extractGroundingSources Helper', () => {
        test('extracts URLs from Gemini interaction step annotations', async () => {
            const turn = {
                rawResponse: {
                    steps: [
                        {
                            type: 'model_output',
                            content: [
                                {
                                    type: 'text',
                                    text: 'Superconducting circuits improved.',
                                    annotations: [
                                        {
                                            type: 'url_citation',
                                            url: 'https://example.com/paper1',
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            };

            const sources = await extractGroundingSources(turn);
            assert.deepEqual(sources, ['https://example.com/paper1']);
        });

        test('extracts URLs from groundingChunks', async () => {
            const turn = {
                rawResponse: {
                    originalFormat: {
                        candidates: [
                            {
                                groundingMetadata: {
                                    groundingChunks: [
                                        { web: { uri: 'https://example.com/chunk-source' } },
                                    ],
                                },
                            },
                        ],
                    },
                },
            };

            const sources = await extractGroundingSources(turn);
            assert.deepEqual(sources, ['https://example.com/chunk-source']);
        });

        test('extracts plain markdown links from text as fallback', async () => {
            const turn = {
                output: 'See details at https://example.com/markdown-link and https://example.com/markdown-link2',
            };

            const sources = await extractGroundingSources(turn);
            assert.ok(sources.includes('https://example.com/markdown-link'));
            assert.ok(sources.includes('https://example.com/markdown-link2'));
        });
    });

    describe('createResearchSystem Factory', () => {
        test('instantiates ResearchSystem with default configurations', () => {
            const system = createResearchSystem();
            assert.equal(system.model, 'gemini-3.8-flash');
            assert.equal(system.provider, 'gemini-interactions');
            assert.equal(system.maxIterations, 3);
            assert.equal(system.maxAspects, 5);
        });
    });
});
