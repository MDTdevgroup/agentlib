import { validateProviderName } from './providers/registry.js';

export class LLMService {
    constructor(provider, apiKey) {
        this.provider = validateProviderName(provider);
        this.apiKey = apiKey;
        this.client = null;  

        if (!apiKey) {
            throw new Error(`API key is required for provider: ${provider}`);
        }
    }

    async _getProviderClient() {

        if (!this.client) {
            const provider = await import(`./providers/${this.provider}.js`);
            this.client = provider.createClient(this.apiKey);
        }
        return this.client;
    }

    async chat(input, {inputSchema = null, outputSchema = null, ...options} = {}) {
        const client = await this._getProviderClient();
        const provider = await import(`./providers/${this.provider}.js`);
        
        return provider.chat(client, input, {
            inputSchema, 
            outputSchema, 
            ...options
        });
    }
}