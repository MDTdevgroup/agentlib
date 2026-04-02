import { getAllowedProviders, validateProviderName } from './providers/registry.js';
import { defaultOpenaiModel, defaultGeminiModel } from './config.js';
import { withRetries } from './utilities/retry.js';

export class LLMService {
    constructor(auth = { provider, apiKey }) {
        this.auth = auth;
        this.provider = validateProviderName(auth.provider);
        this.providerNamespace = getAllowedProviders()[this.provider]?.namespace;
        this.client = this._getProviderClient();
    }

    // Instead of using a dynamic import here, we use the imported registry namespace
    _getProviderClient() {
        // Returns the client instance for the specified provider
        return this.providerNamespace.createClient(this.auth);
    }

    async chat(input, {
        model = this.provider === 'openai' ? defaultOpenaiModel : defaultGeminiModel,
        inputSchema = null,
        outputSchema = null,
        maxRetries = 3,
        baseDelay = 500,
        incrementalDelay = 500,
        maxDelay = 30000,
        timeout = 60000,
        ...options
    } = {}) {
        return withRetries(
            // Thunk: zero-argument function wrapping the actual LLM call
            () => this.providerNamespace.chat(this.client, input, {
                model,
                inputSchema,
                outputSchema,
                ...options
            }),
            {
                maxRetries,
                baseDelay,
                incrementalDelay,
                maxDelay,
                timeout,
                shouldRetry: (error) => {
                    // Don't retry auth or client errors (4xx)
                    const status = error?.status || error?.response?.status;
                    if (status && status >= 400 && status < 500) {
                        return false;
                    }
                    return true;
                },
                onRetry: (attempt, error, delay) => {
                    console.warn(
                        `LLM call failed (attempt ${attempt}/${maxRetries}). ` +
                        `Retrying in ${delay}ms... Error: ${error.message}`
                    );
                }
            }
        );
    }
}