export class BaseCompactor {
    /**
     * Compacts an array of messages according to the specific strategy.
     * @param {Array} messages - The array of message objects.
     * @returns {Promise<Array>} The compacted array of messages.
     */
    async compact(messages) {
        throw new Error("Method 'compact()' must be implemented.");
    }
}
