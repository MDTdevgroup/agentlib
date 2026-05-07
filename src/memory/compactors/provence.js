import { BaseCompactor } from './base.js';

export class ProvenceCompactor extends BaseCompactor {
    constructor(options = {}) {
        super();
        this.similarityThreshold = options.similarityThreshold || 0.75;
        this.embeddingService = options.embeddingService;
        this.name = 'provence_compactor';
    }

    async compact(messages) {
        if (!messages || messages.length <= 2) {
            return messages;
        }

        const systemMessages = messages.filter(m => m.role === 'system');
        const nonSystemMessages = messages.filter(m => m.role !== 'system');

        if (nonSystemMessages.length <= 2) {
             return messages;
        }

        if (!this.embeddingService) {
            console.warn("ProvenceCompactor requires an embeddingService for semantic pruning. Returning original messages.");
            return messages;
        }
        
        // Provence semantic pruning: Use the last message (usually the current user query) 
        // as the anchor for semantic similarity, and prune irrelevant prior messages.
        const currentQuery = nonSystemMessages[nonSystemMessages.length - 1];
        
        try {
            const queryEmbedding = await this.embeddingService.embed(currentQuery.content);

            const keptMessages = [];
            
            for (let i = 0; i < nonSystemMessages.length - 1; i++) {
                const msg = nonSystemMessages[i];
                
                // If content is not a simple string, we keep it to avoid pruning complex objects/function calls blindly
                if (typeof msg.content !== 'string' || msg.content.trim() === '') {
                    keptMessages.push(msg);
                    continue;
                }

                const msgEmbedding = await this.embeddingService.embed(msg.content);
                const similarity = this._cosineSimilarity(queryEmbedding, msgEmbedding);
                
                // Keep context that meets the similarity threshold
                if (similarity >= this.similarityThreshold) {
                    keptMessages.push(msg);
                }
            }
            
            // Always ensure the current query is appended at the end
            keptMessages.push(currentQuery);

            return [...systemMessages, ...keptMessages];
        } catch (error) {
            console.error("Error during semantic pruning in ProvenceCompactor:", error);
            return messages; // Fallback to uncompacted if embedding fails
        }
    }

    _cosineSimilarity(vecA, vecB) {
        if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        if (normA === 0 || normB === 0) return 0;
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }
}
