import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/core/agent.js';
import { LLMService } from '../src/services/llm-service.js';
import { registerProvider } from '../src/providers/registry.js';
import * as FakeProvider from './helpers/fake-provider.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import {
    getModelLimits,
    getModelContextLimit,
    registerModelLimit,
    loadModelLimitsFromFile,
    saveModelLimitsToFile,
} from '../src/providers/model-limits.js';
import { _fetchModelLimits } from '../src/providers/gemini.js';

describe('Model Context Limits Resolution & Dynamic Fetching', () => {
    describe('Canonical Table Resolution & Pattern Matching', () => {
        test('resolves known OpenAI model context limits with pattern matching', () => {
            assert.equal(getModelContextLimit('openai', 'gpt-5'), 256000);
            assert.equal(getModelContextLimit('openai', 'gpt-5.4'), 256000);
            assert.equal(getModelContextLimit('openai', 'gpt-5-nano'), 128000);
            assert.equal(getModelContextLimit('openai', 'gpt-4.5'), 128000);
            assert.equal(getModelContextLimit('openai', 'gpt-4.5-preview'), 128000);
            assert.equal(getModelContextLimit('openai', 'gpt-4o'), 128000);
            assert.equal(getModelContextLimit('openai', 'gpt-4o-2024-08-06'), 128000);
            assert.equal(getModelContextLimit('openai', 'gpt-4o-mini'), 128000);
            assert.equal(getModelContextLimit('openai', 'gpt-4-turbo-2024-04-09'), 128000);
            assert.equal(getModelContextLimit('openai', 'gpt-4-0613'), 8192);
            assert.equal(getModelContextLimit('openai', 'gpt-3.5-turbo-0125'), 16385);
            assert.equal(getModelContextLimit('openai', 'o1'), 200000);
            assert.equal(getModelContextLimit('openai', 'o3-mini'), 200000);
        });

        test('resolves known Gemini model context limits', () => {
            assert.equal(getModelContextLimit('gemini', 'gemini-1.5-pro'), 2097152);
            assert.equal(getModelContextLimit('gemini', 'gemini-1.5-pro-002'), 2097152);
            assert.equal(getModelContextLimit('gemini', 'gemini-1.5-flash'), 1048576);
            assert.equal(getModelContextLimit('gemini', 'gemini-2.0-flash'), 1048576);
            assert.equal(getModelContextLimit('gemini', 'gemini-3-pro-preview'), 2097152);
            assert.equal(getModelContextLimit('gemini', 'gemini-1.0-pro'), 32768);
        });

        test('falls back gracefully to provider default for unrecognized models', () => {
            assert.equal(getModelContextLimit('openai', 'novel-unseen-model'), 256000);
            assert.equal(getModelContextLimit('gemini', 'unreleased-gemini-x'), 1048576);
            assert.equal(getModelContextLimit('vllm', 'my-local-llama'), 32768);
        });

        test('supports runtime registration of custom model limits', () => {
            registerModelLimit('openai', 'gpt-5-preview', {
                inputTokenLimit: 500000,
                outputTokenLimit: 32000,
            });

            const limits = getModelLimits('openai', 'gpt-5-preview');
            assert.equal(limits.inputTokenLimit, 500000);
            assert.equal(limits.outputTokenLimit, 32000);
            assert.equal(getModelContextLimit('openai', 'gpt-5-preview'), 500000);
        });

        test('loadModelLimitsFromFile returns active limits when called without path', async () => {
            const table = await loadModelLimitsFromFile();
            assert.ok(table.openai);
            assert.ok(table.gemini);
            assert.ok(table.vllm);
            assert.equal(table.gemini['gemini-1.5-pro'].inputTokenLimit, 2097152);
        });

        test('saveModelLimitsToFile and loadModelLimitsFromFile work with custom path', async () => {
            const tempFile = join(tmpdir(), `limits-${Date.now()}.json`);
            try {
                registerModelLimit('openai', 'custom-temp-model', { inputTokenLimit: 99999, outputTokenLimit: 8888 });
                await saveModelLimitsToFile(tempFile);
                const loaded = await loadModelLimitsFromFile(tempFile);
                assert.equal(loaded.openai['custom-temp-model'].inputTokenLimit, 99999);
            } finally {
                await rm(tempFile, { force: true }).catch(() => {});
            }
        });

        test('saveModelLimitsToFile throws when filePath is missing to protect package install directory', async () => {
            await assert.rejects(
                async () => {
                    await saveModelLimitsToFile();
                },
                /requires an explicit target filePath/
            );
        });
    });

    describe('Gemini Dynamic API Limits Fetching', () => {
        test('fetchModelLimits queries client.models.list and updates registry', async () => {
            const mockClient = {
                models: {
                    list: async () => [
                        {
                            name: 'models/gemini-dynamic-pro',
                            inputTokenLimit: 3000000,
                            outputTokenLimit: 16000,
                        },
                        {
                            name: 'models/gemini-dynamic-flash',
                            inputTokenLimit: 1500000,
                            outputTokenLimit: 8000,
                        },
                    ],
                },
            };

            const discovered = await _fetchModelLimits(mockClient, { updateFile: false });
            assert.equal(discovered['gemini-dynamic-pro'].inputTokenLimit, 3000000);
            assert.equal(discovered['gemini-dynamic-flash'].inputTokenLimit, 1500000);

            // Verify registry resolution
            assert.equal(getModelContextLimit('gemini', 'gemini-dynamic-pro'), 3000000);
            assert.equal(getModelContextLimit('gemini', 'gemini-dynamic-flash'), 1500000);
        });
    });

    describe('Agent Dynamic Context Budget Derivation', () => {
        test('Agent with Gemini model derives 75% trigger and 50% target token limits by default', () => {
            const fakeProvider = FakeProvider.createFakeProvider();
            registerProvider('fake-gemini-provider', fakeProvider, 'Fake Gemini');

            const llm = new LLMService({ provider: 'fake-gemini-provider' });
            // Override fake provider's getModelContextLimit
            fakeProvider.getModelContextLimit = () => 2000000;

            const agent = new Agent(llm, {
                model: 'gemini-1.5-pro',
            });

            assert.equal(agent.maxContextTokens, 1500000); // 75% of 2M
            assert.equal(agent.truncateToTokens, 1000000); // 50% of 2M
        });

        test('Agent with OpenAI model derives 75% trigger and 50% target token limits by default', () => {
            const fakeProvider = FakeProvider.createFakeProvider();
            registerProvider('fake-openai-provider', fakeProvider, 'Fake OpenAI');

            const llm = new LLMService({ provider: 'fake-openai-provider' });
            fakeProvider.getModelContextLimit = () => 128000;

            const agent = new Agent(llm, {
                model: 'gpt-4o',
            });

            assert.equal(agent.maxContextTokens, 96000); // 75% of 128k
            assert.equal(agent.truncateToTokens, 64000); // 50% of 128k
        });

        test('Explicit user options override dynamic default calculations', () => {
            const fakeProvider = FakeProvider.createFakeProvider();
            registerProvider('fake-custom-provider', fakeProvider, 'Fake Custom');

            const llm = new LLMService({ provider: 'fake-custom-provider' });
            const agent = new Agent(llm, {
                model: 'gpt-4o',
                maxContextTokens: 40000,
                truncateToTokens: 30000,
            });

            assert.equal(agent.maxContextTokens, 40000);
            assert.equal(agent.truncateToTokens, 30000);
        });
    });
});
