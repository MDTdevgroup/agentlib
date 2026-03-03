import { getAllowedProviders, validateProviderName } from './providers/registry.js';

/** Returns a Promise that resolves after the specified delay (ms). */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export class LLMService {
    constructor(provider, apiKey) {
        this.provider = validateProviderName(provider);
        this.providerNamespace = getAllowedProviders()[this.provider]?.namespace;
        this.apiKey = apiKey;
        this.client = this._getProviderClient();

        if (!apiKey) {
            throw new Error(`API key is required for provider: ${provider}`);
        }
    }

    _getProviderClient() {
        return this.providerNamespace.createClient(this.apiKey);
    }

    /**
     * Sends input to the provider with retry logic, per-request timeout, and
     * exponential backoff with jitter.
     *
     * Each attempt gets a fresh AbortController whose signal is forwarded to
     * the provider.  A setTimeout schedules controller.abort() after `timeout`
     * ms — if it fires the SDK rejects with AbortError, which is always
     * retryable.  clearTimeout in `finally` prevents timer leaks.
     *
     * Error classification is delegated to the provider's optional
     * isRetryable(error) function, which returns { retryable, retryAfterMs }.
     * If the provider doesn't export one, all non-timeout errors default to
     * retryable.  A 429 retryAfterMs (from the Retry-After header) overrides
     * the exponential backoff for that attempt.
     */
    async chat(input, {
        inputSchema = null,
        outputSchema = null,
        maxRetries = 3,
        initialDelay = 1000,
        timeout = 5 * 60 * 1000,
        backoffMultiplier = 2,
        jitterMax = 1000,
        ...options
    } = {}) {
        let delay = initialDelay;

        // attempt 0 = first try, attempts 1..maxRetries = retries
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);

            try {
                const result = await this.providerNamespace.chat(this.client, input, {
                    inputSchema,
                    outputSchema,
                    signal: controller.signal,
                    ...options
                });
                return result;

            } catch (error) {
                // AbortError comes from our timeout triggering controller.abort().
                // Some SDKs (e.g. Gemini) wrap it in their own Error type, so
                // we also check the message string as a fallback.
                const isTimeout = error.name === 'AbortError'
                    || error.message?.includes('AbortError');
                const retryInfo = isTimeout
                    ? { retryable: true }
                    : (typeof this.providerNamespace.isRetryable === 'function'
                        ? this.providerNamespace.isRetryable(error)
                        : { retryable: true });

                if (!retryInfo.retryable || attempt === maxRetries) {
                    console.error(`[LLM] Fatal error after ${attempt + 1} attempt(s):`, error);
                    throw error;
                }

                // Prefer server's Retry-After (e.g. 429) over our own backoff
                const effectiveDelay = retryInfo.retryAfterMs
                    || (delay + Math.floor(Math.random() * jitterMax));

                console.warn(
                    `[LLM] Retry ${attempt + 1}/${maxRetries} in ${effectiveDelay}ms. Error: ${error.message}`
                );
                await sleep(effectiveDelay);
                delay *= backoffMultiplier;

            } finally {
                clearTimeout(timeoutId);
            }
        }
    }
}