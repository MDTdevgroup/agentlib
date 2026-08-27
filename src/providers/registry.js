import * as OpenAIProvider from './openai.js';
import * as GeminiProvider from './gemini.js';
import * as VllmProvider from './vllm.js';
import {
    getModelLimits as resolveModelLimits,
    getModelContextLimit as resolveModelContextLimit,
    registerModelLimit as registerLimit,
    loadModelLimitsFromFile,
    saveModelLimitsToFile,
} from './model-limits.js';

const ALLOWED_PROVIDERS = {
    openai: { name: 'OpenAI', namespace: OpenAIProvider },
    gemini: { name: 'Gemini', namespace: GeminiProvider },
    vllm: { name: 'vLLM', namespace: VllmProvider },
};

export function registerProvider(key, namespace, name = key) {
    if (typeof key !== 'string' || !key.trim()) {
        throw new TypeError('Provider key must be a non-empty string.');
    }
    const normalizedKey = key.trim().toLowerCase();
    ALLOWED_PROVIDERS[normalizedKey] = {
        name: name || key,
        namespace,
    };
    return normalizedKey;
}

export function getAllowedProviders() {
    // Procedure that returns the object
    return ALLOWED_PROVIDERS;
}

export function validateProviderName(providerName) {
    // Checks if a valid provider name has been passed and returns normalized name
    if (typeof providerName !== 'string') {
        throw new TypeError('Provider name must be a string.');
    }

    const normalize = text => text.trim().toLowerCase();
    const normalized = normalize(providerName);
    const providers = getAllowedProviders();

    // Check direct key match (e.g. 'openai', 'gemini', 'vllm', 'fake')
    if (Object.hasOwn(providers, normalized)) {
        return normalized;
    }

    // Check display name match (e.g. 'OpenAI' -> 'openai')
    for (const [key, provider] of Object.entries(providers)) {
        if (provider.name && normalize(provider.name) === normalized) {
            return key;
        }
    }

    const allowed = Object.keys(providers);
    throw new Error(`Unsupported provider. Allowed providers: ${allowed.join(', ')}`);
}

export function getDefaultModel(providerName) {
    const key = validateProviderName(providerName);
    const provider = ALLOWED_PROVIDERS[key];
    if (provider?.namespace?.defaultModel) {
        return provider.namespace.defaultModel;
    }
    return 'default';
}

export function getModelContextLimit(providerName, modelName) {
    if (!providerName) return 128000;
    try {
        const key = validateProviderName(providerName);
        const provider = ALLOWED_PROVIDERS[key];
        if (typeof provider?.namespace?.getModelContextLimit === 'function') {
            return provider.namespace.getModelContextLimit(modelName);
        }
        return resolveModelContextLimit(key, modelName);
    } catch {
        return resolveModelContextLimit(providerName, modelName);
    }
}

export function getModelLimits(providerName, modelName) {
    if (!providerName) return { inputTokenLimit: 128000, outputTokenLimit: 4096 };
    try {
        const key = validateProviderName(providerName);
        const provider = ALLOWED_PROVIDERS[key];
        if (typeof provider?.namespace?.getModelLimits === 'function') {
            return provider.namespace.getModelLimits(modelName);
        }
        return resolveModelLimits(key, modelName);
    } catch {
        return resolveModelLimits(providerName, modelName);
    }
}

export const registerModelLimit = registerLimit;
export { loadModelLimitsFromFile, saveModelLimitsToFile };