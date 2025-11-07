export * as OpenAIProvider from './providers/openai.js';
export * as GeminiProvider from './providers/gemini.js';
// Need to export namespaces when adding new providers here

const ALOWED_PROVIDERS = {
    openai: {name: 'OpenAI', namespace: 'OpenAIProvider'},
    gemini: {name: 'Gemini', namespace: 'GeminiProvider'},
};
// Need to add new providers to this object in this format

export function getAllowedProviders() {
    // Procedure that returns the object
    return ALOWED_PROVIDERS;
}

export function validateProviderName(providerName) {
    // Checks if a valid provider name has been passed and returns normalized name
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