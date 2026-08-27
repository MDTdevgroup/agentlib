import { BaseCompactor, estimateTokens, truncateToBudget, isSystemMessage, groupAtomicUnits } from './base.js';
import { getDefaultMaxContextTokens, getDefaultTruncateToTokens } from '../../config.js';

/**
 * Sliding Window Compactor.
 * Keeps system messages and the most recent non-system messages within a token budget
 * without ever splitting a tool call from its matching tool result.
 */
export class WindowCompactor extends BaseCompactor {
    /**
     * @param {object} [options={}]
     * @param {number} [options.maxTokens] - Trigger threshold for compaction.
     * @param {number} [options.truncateToTokens] - Target token budget when compacting.
     * @param {number} [options.maxMessages] - Optional maximum non-system message count ceiling.
     * @param {EventEmitter} [options.eventEmitter] - Optional event emitter for telemetry.
     */
    constructor(options = {}) {
        super();
        this.name = 'window_compactor';
        this.maxTokens = options.maxTokens || getDefaultMaxContextTokens();
        this.truncateToTokens = options.truncateToTokens || getDefaultTruncateToTokens();
        this.maxMessages = options.maxMessages || null;
        this.events = options.eventEmitter || null;
    }

    /**
     * Compacts an array of messages using a sliding window.
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

        let compacted = truncateToBudget(messages, this.truncateToTokens);

        // If maxMessages was also specified, enforce message count constraint on atomic units
        if (this.maxMessages !== null && compacted.length > this.maxMessages) {
            const systemMessages = compacted.filter(isSystemMessage);
            const nonSystemMessages = compacted.filter((m) => !isSystemMessage(m));
            const atomicUnits = groupAtomicUnits(nonSystemMessages);

            const allowedNonSystemCount = Math.max(1, this.maxMessages - systemMessages.length);
            const keptUnits = [];
            let totalKeptMessages = 0;

            for (let i = atomicUnits.length - 1; i >= 0; i--) {
                const unit = atomicUnits[i];
                if (totalKeptMessages + unit.length <= allowedNonSystemCount || keptUnits.length === 0) {
                    keptUnits.unshift(unit);
                    totalKeptMessages += unit.length;
                } else {
                    break;
                }
            }

            compacted = [...systemMessages, ...keptUnits.flat()];
        }

        const afterTokens = estimateTokens(compacted);
        const afterCount = compacted.length;

        if (this.events) {
            this.events.emit('compactor:compacted', {
                strategy: 'window',
                beforeTokens,
                afterTokens,
                beforeCount,
                afterCount,
            });
        }

        return compacted;
    }
}
