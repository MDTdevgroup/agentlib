import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getAllowedProviders, validateProviderName, registerProvider } from '../src/providers/registry.js';
import * as FakeProvider from './helpers/fake-provider.js';

describe('Provider Registry', () => {
    test('getAllowedProviders returns standard built-in providers', () => {
        const providers = getAllowedProviders();
        assert.ok(providers.openai, 'OpenAI provider should exist');
        assert.ok(providers.gemini, 'Gemini provider should exist');
        assert.ok(providers.vllm, 'vLLM provider should exist');
    });

    test('validateProviderName validates standard provider keys and display names', () => {
        assert.equal(validateProviderName('openai'), 'openai');
        assert.equal(validateProviderName('OpenAI'), 'openai');
        assert.equal(validateProviderName('gemini'), 'gemini');
        assert.equal(validateProviderName('Gemini'), 'gemini');
        assert.equal(validateProviderName('vllm'), 'vllm');
    });

    test('registerProvider dynamically registers a new provider', () => {
        const customNamespace = {
            createClient: () => ({}),
            chat: async () => ({ output: 'custom', rawResponse: { output: [] } }),
        };

        const registeredKey = registerProvider('custom-gateway', customNamespace, 'Custom Gateway');
        assert.equal(registeredKey, 'custom-gateway');

        const providers = getAllowedProviders();
        assert.ok(providers['custom-gateway']);
        assert.equal(providers['custom-gateway'].name, 'Custom Gateway');
        assert.equal(providers['custom-gateway'].namespace, customNamespace);

        assert.equal(validateProviderName('custom-gateway'), 'custom-gateway');
        assert.equal(validateProviderName('Custom Gateway'), 'custom-gateway');
    });

    test('registerProvider supports FakeProvider registration', () => {
        registerProvider('fake', FakeProvider, 'FakeProvider');
        assert.equal(validateProviderName('fake'), 'fake');
    });

    test('validateProviderName throws for invalid or unsupported providers', () => {
        assert.throws(() => validateProviderName(123), TypeError);
        assert.throws(() => validateProviderName('unsupported-provider-xyz'), /Unsupported provider/);
    });
});
