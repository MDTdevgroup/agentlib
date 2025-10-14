const ALLOWED_PROVIDERS = Object.freeze(['openai', 'gemini']);

export function getAllowedProviders() {
    return [...ALLOWED_PROVIDERS];
}

export function validateProviderName(providerName) {
    if (typeof providerName !== 'string') {
        throw new TypeError('Provider name must be a string.');
    }

    const normalizedName = providerName.trim().toLowerCase();

    if (!ALLOWED_PROVIDERS.includes(normalizedName)) {
        throw new Error(`Unsupported provider. Allowed providers: ${ALLOWED_PROVIDERS.join(', ')}`);
    }

    return normalizedName;
}