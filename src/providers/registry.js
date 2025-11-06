export * as OpenAIProvider from './providers/openai.js';
export * as GeminiProvider from './providers/gemini.js';

const ALOWED_PROVIDERS = {
    openai: {name: 'OpenAI', namespace: 'OpenAIProvider'},
    gemini: {name: 'Gemini', namespace: 'GeminiProvider'},
};

export function getAllowedProviders() {
    return Object.values(ALOWED_PROVIDERS).map(p => p.name);
}

export function validateProviderName(providerName) {
    if (typeof providerName !== 'string') {
        throw new TypeError('Provider name must be a string.');
    }

    const normalize = text => text.trim().toLowerCase();

    const allowedProvidersNames = getAllowedProviders;
    const normalizedName = normalize(providerName);

    if (!normalize(allowedProvidersNames).includes(normalizedName)) {
        throw new Error(`Unsupported provider. Allowed providers: ${allowedProvidersNames.join(', ')}`);
    }

    return normalizedName;
}