class LLMService {
    constructor(provider) {
        this.provider = provider;
    }

    async chat(input, {responseFormat = null, inputSchema = null, outputSchema = null, options = {}} = {}) {
        const provider = await import(`./providers/${this.provider}.js`);
        return provider.chat(input, {
            responseFormat: responseFormat, 
            inputSchema: inputSchema, 
            outputSchema: outputSchema, 
            options: options
        });
    }
}

export default LLMService; 