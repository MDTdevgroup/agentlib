export class LLMService {
    constructor(provider) {
        this.provider = provider;
    }

    async chat(input, {inputSchema = null, outputSchema = null, ...options} = {}) {
        const provider = await import(`./providers/${this.provider}.js`);
        return provider.chat(input, {
            inputSchema, 
            outputSchema, 
            ...options
        });
    }
}