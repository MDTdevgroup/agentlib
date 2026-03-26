import * as OpenAIProvider from './openai.js';
import * as GeminiProvider from './gemini.js';
import * as VllmProvider from './vllm.js';

const ALLOWED_PROVIDERS = {
    openai: { name: 'OpenAI', namespace: OpenAIProvider },
    gemini: { name: 'Gemini', namespace: GeminiProvider },
    vllm: { name: 'vLLM', namespace: VllmProvider },
};

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

    const allowedProviders = Object.values(getAllowedProviders()).map(provider => normalize(provider.name));
    const normalizedName = normalize(providerName);

    if (!allowedProviders.includes(normalizedName)) {
        throw new Error(`Unsupported provider. Allowed providers: ${allowedProviders.join(', ')}`);
    }

    return normalizedName;
}