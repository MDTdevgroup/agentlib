import { defaultMaxContextTokens, defaultTruncateToTokens } from '../config.js';

/**
 * A data container for episodic and semantic memory.
 * Manages context window size via token approximation and truncation.
 */
export class Context {
    constructor(messages = [], summary = null, options = {}) {
        this.messages = [...messages];
        this.summary = summary;
        this.maxTokens = options.maxTokens || defaultMaxContextTokens;
        this.truncateToTokens = options.truncateToTokens || defaultTruncateToTokens;
    }

    addInput(input) {
        if (Array.isArray(input)) {
            this.messages.push(...input);
        } else {
            this.messages.push(input);
        }
        this._manageContextSize();
        return this;
    }

    getMessages() {
        return this.messages;
    }

    _estimateTokens(text) {
        if (!text) return 0;
        return typeof text === 'string' ? Math.ceil(text.length / 4) : Math.ceil(JSON.stringify(text).length / 4);
    }

    _manageContextSize() {
        // Approximate the entire context size. 
        // We sum 'content' and stringified 'arguments' of function calls.
        let totalTokens = this.messages.reduce((acc, msg) => {
            const contentTokens = this._estimateTokens(msg.content);
            const callTokens = msg.arguments ? this._estimateTokens(msg.arguments) : 0;
            return acc + contentTokens + callTokens;
        }, 0);

        if (totalTokens > this.maxTokens) {
            // Important: Preserve system messages
            const sysMessages = this.messages.filter(m => m.role === 'system');
            let otherMessages = this.messages.filter(m => m.role !== 'system');

            while (totalTokens > this.truncateToTokens && otherMessages.length > 0) {
                const removed = otherMessages.shift();
                totalTokens -= (this._estimateTokens(removed.content) + (removed.arguments ? this._estimateTokens(removed.arguments) : 0));
            }

            this.messages = [...sysMessages, ...otherMessages];
        }
    }

    clone() {
        return new Context(JSON.parse(JSON.stringify(this.messages)), this.summary, {
            maxTokens: this.maxTokens,
            truncateToTokens: this.truncateToTokens
        });
    }
}