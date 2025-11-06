import * as registry from './providers/registry.js';

export class LLMService {
    constructor(provider, apiKey) {
        this.provider = validateProviderName(provider);
        this.apiKey = apiKey;
        this.client = _getProviderClient();

        if (!apiKey) {
            throw new Error(`API key is required for provider: ${provider}`);
        }
    }

    // TODO: Clean up dynamic import here since registry now imports each provider with own namespace
    async _getProviderClient() {
        const provider = await import(`./providers/${this.provider}.js`);
        this.client = provider.createClient(this.apiKey);
        return this.client;
    }

    async chat(input, {inputSchema = null, outputSchema = null, ...options} = {}) {        
        return provider.chat(this.client, input, {
            inputSchema, 
            outputSchema, 
            ...options
        });
    }
}