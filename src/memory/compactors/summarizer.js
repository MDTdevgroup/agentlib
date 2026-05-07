import { BaseCompactor } from './base.js';

export class SummarizerCompactor extends BaseCompactor {
    constructor(options = {}) {
        super();
        this.llmService = options.llmService;
        this.model = options.model;
        this.maxMessages = options.maxMessages || 10;
        this.name = 'summarizer_compactor';
    }

    async compact(messages) {
        if (!messages || messages.length <= this.maxMessages) {
            return messages;
        }

        // Always preserve system messages
        const systemMessages = messages.filter(m => m.role === 'system');
        const nonSystemMessages = messages.filter(m => m.role !== 'system');
        
        if (nonSystemMessages.length <= this.maxMessages) {
            return messages;
        }

        if (!this.llmService) {
            console.warn("SummarizerCompactor requires an llmService to summarize messages. Returning original messages.");
            return messages;
        }

        // Summarize all non-system messages except the most recent half of the max window
        const keepCount = Math.max(1, Math.floor(this.maxMessages / 2));
        const amountToSummarize = nonSystemMessages.length - keepCount;
        
        if (amountToSummarize <= 0) {
            return messages;
        }

        const messagesToSummarize = nonSystemMessages.slice(0, amountToSummarize);
        const recentMessages = nonSystemMessages.slice(amountToSummarize);

        const summaryPrompt = [
            { role: 'system', content: 'You are a helpful assistant that summarizes conversation history. Create a concise summary of the following messages, capturing all important facts, decisions, and context. Do not add any new information.' },
            { role: 'user', content: JSON.stringify(messagesToSummarize) }
        ];

        let response;
        try {
            response = await this.llmService.chat(summaryPrompt, { model: this.model });
        } catch (error) {
            console.error("Failed to summarize messages:", error);
            return messages; // Fallback to uncompacted if summary fails
        }

        const summaryMessage = {
            role: 'assistant',
            content: `[Conversation Summary]: ${response.output}`
        };

        return [...systemMessages, summaryMessage, ...recentMessages];
    }
}
