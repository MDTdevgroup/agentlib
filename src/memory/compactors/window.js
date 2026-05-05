import { BaseCompactor } from './base.js';

export class WindowCompactor extends BaseCompactor {
    constructor(options = {}) {
        super();
        this.maxMessages = options.maxMessages || 10;
        this.name = 'window_compactor';
    }

    async compact(messages) {
        if (!messages || messages.length <= this.maxMessages) {
            return messages;
        }

        // Always preserve system messages, they are critical for agent behavior
        const systemMessages = messages.filter(m => m.role === 'system');
        const nonSystemMessages = messages.filter(m => m.role !== 'system');

        // Slice the most recent non-system messages
        const amountToKeep = Math.max(0, this.maxMessages - systemMessages.length);
        const recentMessages = nonSystemMessages.slice(-amountToKeep);

        return [...systemMessages, ...recentMessages];
    }
}
