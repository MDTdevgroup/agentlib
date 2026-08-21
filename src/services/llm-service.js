import { getAllowedProviders, validateProviderName } from '../providers/registry.js';
import { defaultOpenaiModel, defaultGeminiModel } from '../config.js';

export class LLMService {
    constructor(auth = {}) {
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

    async chat(input, { model = this.provider === 'openai' ? defaultOpenaiModel : defaultGeminiModel, inputSchema = null, outputSchema = null, maxRetries = 3, initialDelay = 1000, ...options } = {}) {
        let attempt = 0;
        let delay = initialDelay;

        while (true) {
            try {
                return await this.providerNamespace.chat(this.client, input, {
                    model,
                    inputSchema,
                    outputSchema,
                    ...options
                });
            } catch (error) {
                attempt++;
                if (attempt > maxRetries) {
                    throw error;
                }
                console.warn(`LLM call failed (attempt ${attempt}/${maxRetries}). Retrying in ${delay}ms... Error: ${error.message}`);
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 2; // Exponential backoff
            }
        }
    }
}