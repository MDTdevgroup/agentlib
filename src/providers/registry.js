import * as OpenAIProvider from './openai.js';
import * as GeminiProvider from './gemini.js';
// Need to import namespaces when adding new providers here

const ALOWED_PROVIDERS = {
    openai: {name: 'OpenAI', namespace: OpenAIProvider},
    gemini: {name: 'Gemini', namespace: GeminiProvider},
};
// Need to add new providers to this object in this format

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

    const allowedProviders = getAllowedProviders;
    const normalizedName = normalize(providerName);

    if (!normalize(allowedProviders).includes(normalizedName)) {
        throw new Error(`Unsupported provider. Allowed providers: ${allowedProvidersNames.join(', ')}`);
    }

    return normalizedName;
}