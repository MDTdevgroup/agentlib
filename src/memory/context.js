import { defaultMaxContextTokens, defaultTruncateToTokens } from '../config.js';

/**
 * A data container for episodic and semantic memory.
 * Manages context window size via token approximation and truncation.
 */
export class Context {
    constructor(messages = [], summary = null, options = {}) {
        this.messages = Object.freeze([...messages]);
        this.summary = summary;
        this.maxTokens = options.maxTokens || defaultMaxContextTokens;
        this.truncateToTokens = options.truncateToTokens || defaultTruncateToTokens;
    }

    addInput(input) {
        const inputArr = Array.isArray(input) ? input : [input];
        return new Context([...this.messages, ...inputArr], this.summary, {
            maxTokens: this.maxTokens,
            truncateToTokens: this.truncateToTokens
        });
    }

    getMessages() {
        return this.messages;
    }
    /**
     * Returns an isolated, deep-cloned instance of this Context.
     */
    clone() {
        return new Context(
            structuredClone(this.messages),
            structuredClone(this.summary),
            {
                maxTokens: this.maxTokens,
                truncateToTokens: this.truncateToTokens
            }
        );
    }
}