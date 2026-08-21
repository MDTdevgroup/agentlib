export const defaultProvider = 'openai';
export const defaultOpenaiModel = 'gpt-5';
export const defaultGeminiModel = 'gemini-3-pro-preview';
export const defaultMaxContextTokens = 64000;
export const defaultTruncateToTokens = 48000;
export const defaultMaxToolCalls = 100;
export const defaultMaxTurns = 100;

export function getDefaultRetrySpec() {
    return {
        maxRetries: 3,
        timeoutMS: 300000,
        baseDelayMS: 1000,
        exprDelayMS: 500,
        maxDelayMS: 60000,
    };
}