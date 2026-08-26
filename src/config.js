export function getDefaultProvider() {
    return 'openai';
}

export function getDefaultOpenaiModel() {
    return 'gpt-5';
}

export function getDefaultGeminiModel() {
    return 'gemini-3-pro-preview';
}

export function getDefaultModel(provider = getDefaultProvider()) {
    if (!provider) return 'default';
    const normalized = String(provider).trim().toLowerCase();
    if (normalized === 'gemini') return getDefaultGeminiModel();
    if (normalized === 'openai' || normalized === 'vllm') return getDefaultOpenaiModel();
    return 'default';
}

export function getDefaultMaxContextTokens() {
    return 64000;
}

export function getDefaultTruncateToTokens() {
    return 48000;
}

export function getDefaultMaxToolCalls() {
    return 15;
}

export function getDefaultMaxTurns() {
    return 5;
}

export function getDefaultToolConcurrency() {
    return 5;
}

export function getDefaultRetrySpec() {
    return {
        maxRetries: 3,
        timeoutMS: 300000,
        baseDelayMS: 1000,
        exprDelayMS: 500,
        maxDelayMS: 60000,
    };
}