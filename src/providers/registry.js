export * as OpenAIProvider from './providers/openai.js';
export * as GeminiProvider from './providers/gemini.js';

export const ALOWED_PROVIDERS = {
    openai: {name: 'OpenAI', namespace: 'OpenAIProvider'},
    gemini: {name: 'Gemini', namespace: 'GeminiProvider'},
};

export function validateProviderName(providerName) {
    if (typeof providerName !== 'string') {
        throw new TypeError('Provider name must be a string.');
    }

    const normalize = name => name.trim().toLowerCase();

    const allowed\-

    if (!ALLOWED_PROVIDERS.includes(normalizedName)) {
        throw new Error(`Unsupported provider. Allowed providers: ${ALLOWED_PROVIDERS.join(', ')}`);
    }

    return normalizedName;
}