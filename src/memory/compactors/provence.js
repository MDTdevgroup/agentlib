import { BaseCompactor, estimateTokens, truncateToBudget, isSystemMessage, groupAtomicUnits } from './base.js';
import { messageText, isToolCall, isToolResult, toolCallName, toolCallArgs } from '../message.js';
import { asyncForceAll } from '../../util/async.js';
import { defaultMaxContextTokens, defaultTruncateToTokens } from '../../config.js';

/**
 * Semantic Pruning Compactor (Provence).
 * Uses text embeddings and cosine similarity against the active anchor query
 * to retain the most semantically relevant conversation history up to a token budget.
 *
 * Implements:
 * 1. In-memory embedding cache across compaction runs.
 * 2. Bounded concurrency for embedding generation via asyncForceAll.
 * 3. Indivisible atomic tool-pair retention.
 * 4. Token budget guarantee.
 * 5. Safe fallback on embedding failure.
 */
export class ProvenceCompactor extends BaseCompactor {
    /**
     * @param {object} [options={}]
     * @param {object} [options.embeddingService] - Service implementing embed(text) -> Promise<number[]>.
     * @param {number} [options.similarityThreshold=0.75] - Minimum cosine similarity score.
     * @param {number} [options.maxTokens] - Trigger threshold for compaction.
     * @param {number} [options.truncateToTokens] - Target token budget when compacting.
     * @param {number} [options.concurrency=5] - Maximum concurrency limit for embedding calls.
     * @param {number} [options.maxMessages] - Optional maximum message count threshold.
     * @param {EventEmitter} [options.eventEmitter] - Optional event emitter for telemetry.
     */
    constructor(options = {}) {
        super();
        this.name = 'provence_compactor';
        this.embeddingService = options.embeddingService || null;
        this.similarityThreshold = options.similarityThreshold ?? 0.75;
        this.maxTokens = options.maxTokens || defaultMaxContextTokens;
        this.truncateToTokens = options.truncateToTokens || defaultTruncateToTokens;
        this.concurrency = options.concurrency || 5;
        this.maxMessages = options.maxMessages || null;
        this.events = options.eventEmitter || null;

        // In-memory cache for message embeddings keyed by text content
        this.embeddingCache = new Map();
    }

    /**
     * Extracts readable text content from an atomic unit of messages.
     *
     * @param {Array<object>} unit
     * @returns {string}
     */
    _extractUnitText(unit) {
        if (!Array.isArray(unit)) return '';
        const parts = [];
        for (const msg of unit) {
            if (isToolCall(msg)) {
                const name = toolCallName(msg);
                let args;
                try {
                    args = toolCallArgs(msg);
                } catch {
                    args = msg.arguments;
                }
                parts.push(`Tool Call: ${name} ${typeof args === 'string' ? args : JSON.stringify(args ?? {})}`);
            } else if (isToolResult(msg)) {
                const out = msg.output !== undefined ? msg.output : msg.value;
                parts.push(`Tool Output: ${typeof out === 'string' ? out : JSON.stringify(out ?? null)}`);
            } else {
                const txt = messageText(msg);
                if (txt) parts.push(txt);
            }
        }
        return parts.join(' ').trim();
    }

    /**
     * Retrieves or generates the vector embedding for a given text.
     *
     * @param {string} text
     * @returns {Promise<number[]>}
     */
    async _getEmbedding(text) {
        if (!text) {
            return [];
        }
        if (this.embeddingCache.has(text)) {
            return this.embeddingCache.get(text);
        }
        const vec = await this.embeddingService.embed(text);
        this.embeddingCache.set(text, vec);
        return vec;
    }

    /**
     * Calculates cosine similarity between two vectors.
     *
     * @param {number[]} vecA
     * @param {number[]} vecB
     * @returns {number}
     */
    _cosineSimilarity(vecA, vecB) {
        if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length === 0 || vecA.length !== vecB.length) {
            return 0;
        }
        let dot = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dot += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        if (normA === 0 || normB === 0) return 0;
        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    /**
     * Compacts messages by ranking historical turns by semantic similarity to the anchor query.
     *
     * @param {Array<object>} messages
     * @returns {Promise<Array<object>>}
     */
    async compact(messages) {
        if (!Array.isArray(messages) || messages.length === 0) {
            return messages || [];
        }

        const beforeTokens = estimateTokens(messages);
        const beforeCount = messages.length;

        const exceedsTokens = beforeTokens > this.maxTokens;
        const exceedsMessages = this.maxMessages !== null && beforeCount > this.maxMessages;

        if (!exceedsTokens && !exceedsMessages) {
            return messages;
        }

        if (!this.embeddingService || typeof this.embeddingService.embed !== 'function') {
            if (this.events) {
                this.events.emit('compactor:error', {
                    strategy: 'provence',
                    error: 'ProvenceCompactor requires an embeddingService implementing embed(). Falling back to sliding window truncation.',
                });
            }
            return truncateToBudget(messages, this.truncateToTokens);
        }

        const systemMessages = messages.filter(isSystemMessage);
        const nonSystemMessages = messages.filter((m) => !isSystemMessage(m));

        const atomicUnits = groupAtomicUnits(nonSystemMessages);
        if (atomicUnits.length <= 2) {
            return messages;
        }

        try {
            // Anchor unit is the most recent atomic unit (current query)
            const anchorUnit = atomicUnits[atomicUnits.length - 1];
            const anchorText = this._extractUnitText(anchorUnit);
            const candidateUnits = atomicUnits.slice(0, atomicUnits.length - 1);

            // Build thunks for concurrent embedding resolution
            const allTexts = [anchorText, ...candidateUnits.map((u) => this._extractUnitText(u))];
            const thunks = allTexts.map((text) => () => this._getEmbedding(text));
            const embeddings = await asyncForceAll(thunks, this.concurrency, 0);

            const anchorEmbedding = embeddings[0];
            const candidateEmbeddings = embeddings.slice(1);

            // Score and filter candidate units
            const scoredCandidates = [];
            for (let i = 0; i < candidateUnits.length; i++) {
                const unit = candidateUnits[i];
                const unitText = allTexts[i + 1];
                const emb = candidateEmbeddings[i];

                // If unit text is empty (e.g. empty message), keep with default baseline score
                const similarity = unitText ? this._cosineSimilarity(anchorEmbedding, emb) : 1.0;

                scoredCandidates.push({
                    unit,
                    index: i,
                    similarity,
                    tokens: estimateTokens(unit),
                });
            }

            // Filter by similarity threshold
            const relevantCandidates = scoredCandidates.filter((sc) => sc.similarity >= this.similarityThreshold);

            // Sort by similarity descending to prioritize highest relevance
            relevantCandidates.sort((a, b) => b.similarity - a.similarity);

            // Calculate budget available for candidates
            const systemTokens = estimateTokens(systemMessages);
            const anchorTokens = estimateTokens(anchorUnit);
            const availableTokens = Math.max(0, this.truncateToTokens - systemTokens - anchorTokens);

            const chosenCandidates = [];
            let accumulatedTokens = 0;

            for (const candidate of relevantCandidates) {
                if (accumulatedTokens + candidate.tokens <= availableTokens || chosenCandidates.length === 0) {
                    chosenCandidates.push(candidate);
                    accumulatedTokens += candidate.tokens;
                } else {
                    break;
                }
            }

            // Restore original chronological order
            chosenCandidates.sort((a, b) => a.index - b.index);

            const compacted = [
                ...systemMessages,
                ...chosenCandidates.flatMap((c) => c.unit),
                ...anchorUnit,
            ];

            const boundedResult = truncateToBudget(compacted, this.truncateToTokens);

            const afterTokens = estimateTokens(boundedResult);
            const afterCount = boundedResult.length;

            if (this.events) {
                this.events.emit('compactor:compacted', {
                    strategy: 'provence',
                    beforeTokens,
                    afterTokens,
                    beforeCount,
                    afterCount,
                });
            }

            return boundedResult;
        } catch (err) {
            if (this.events) {
                this.events.emit('compactor:error', {
                    strategy: 'provence',
                    error: `Embedding failed in ProvenceCompactor: ${err.message}. Falling back to sliding window truncation.`,
                });
            }
            return truncateToBudget(messages, this.truncateToTokens);
        }
    }
}
