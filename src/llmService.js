import * as registry from './providers/registry.js';

export class LLMService {
    constructor(provider, apiKey) {
        this.provider = validateProviderName(provider);
        this.providerNamespace = registry.getAllowedProviders()[this.provider].namespace;
        this.apiKey = apiKey;
        this.client = _getProviderClient();

        if (!apiKey) {
            throw new Error(`API key is required for provider: ${provider}`);
        }
    }

    // Instead of using a dynamic import here, we use the imported registry namespace
    async _getProviderClient() {
        // Returns the client instance for the specified provider
        return this.providerNamespace.createClient(this.apiKey);
    }

    async chat(input, {inputSchema = null, outputSchema = null, ...options} = {}) {        
        return this.providerNamespace.chat(this.client, input, {
            inputSchema, 
            outputSchema, 
            ...options
        });
    }
}