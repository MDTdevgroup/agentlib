import { BaseCompactor, estimateTokens, truncateToBudget, isSystemMessage, groupAtomicUnits } from './base.js';
import {
    isToolCall,
    isToolResult,
    isReasoning,
    toolCallName,
    toolCallArgs,
    messageText,
    makeTextMessage,
} from '../message.js';
import { getDefaultMaxContextTokens, getDefaultTruncateToTokens } from '../../config.js';

/**
 * Summarizer Compactor.
 * Condenses older conversation history into an incremental summary system message
 * while preserving recent turns verbatim and keeping tool call/result pairs atomic.
 */
export class SummarizerCompactor extends BaseCompactor {
    /**
     * @param {object} [options={}]
     * @param {object} [options.llmService] - LLMService instance for generating summaries.
     * @param {string} [options.model] - Model identifier for summarization.
     * @param {number} [options.maxTokens] - Trigger threshold for compaction.
     * @param {number} [options.truncateToTokens] - Target token budget when compacting.
     * @param {number} [options.maxMessages] - Optional maximum message count threshold.
     * @param {EventEmitter} [options.eventEmitter] - Optional event emitter for telemetry.
     */
    constructor(options = {}) {
        super();
        this.name = 'summarizer_compactor';
        this.llmService = options.llmService || null;
        this.model = options.model || undefined;
        this.maxTokens = options.maxTokens || getDefaultMaxContextTokens();
        this.truncateToTokens = options.truncateToTokens || getDefaultTruncateToTokens();
        this.maxMessages = options.maxMessages || null;
        this.events = options.eventEmitter || null;
    }

    /**
     * Formats an array of canonical message items into human-readable text.
     *
     * @param {Array<object>} messages
     * @returns {string}
     */
    _renderMessagesAsText(messages) {
        const lines = [];
        for (const msg of messages) {
            if (!msg) continue;
            if (isToolCall(msg)) {
                const name = toolCallName(msg) || 'unknown';
                let args;
                try {
                    args = toolCallArgs(msg);
                } catch {
                    args = msg.arguments;
                }
                lines.push(`[Tool Call: ${name}] Arguments: ${typeof args === 'string' ? args : JSON.stringify(args ?? {})}`);
            } else if (isToolResult(msg)) {
                const name = msg.name || msg.call_id || 'unknown';
                const output = msg.output !== undefined ? msg.output : msg.value;
                const outputStr = typeof output === 'string' ? output : JSON.stringify(output ?? null);
                lines.push(`[Tool Result: ${name}] Output: ${outputStr}`);
            } else if (isReasoning(msg)) {
                lines.push(`[Thinking / Reasoning]: ${msg.content || msg.summary || ''}`);
            } else {
                const role = msg.role || 'user';
                const speaker = msg.speaker ? ` (${msg.speaker})` : '';
                const text = messageText(msg);
                lines.push(`[${role}${speaker}]: ${text}`);
            }
        }
        return lines.join('\n');
    }

    /**
     * Compacts messages by summarizing older turns with an LLM.
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

        if (!this.llmService) {
            if (this.events) {
                this.events.emit('compactor:error', {
                    strategy: 'summarizer',
                    error: 'SummarizerCompactor requires an llmService instance. Falling back to sliding window truncation.',
                });
            }
            return truncateToBudget(messages, this.truncateToTokens);
        }

        // Separate system messages vs non-system messages
        const systemMessages = messages.filter(isSystemMessage);
        const nonSystemMessages = messages.filter((m) => !isSystemMessage(m));

        const atomicUnits = groupAtomicUnits(nonSystemMessages);
        if (atomicUnits.length <= 1) {
            return messages;
        }

        // Extract any existing conversation summary from prior system messages for incremental folding
        let previousSummary = '';
        const filteredSystemMessages = [];

        for (const sysMsg of systemMessages) {
            const txt = messageText(sysMsg);
            if (txt && txt.startsWith('[Conversation Summary]:')) {
                previousSummary = txt.replace(/^\[Conversation Summary\]:\s*/, '').trim();
            } else {
                filteredSystemMessages.push(sysMsg);
            }
        }

        // Determine how many atomic units to keep verbatim vs summarize
        // Keep recent units that take up roughly half the target budget
        const targetRecentTokens = Math.max(1, Math.floor(this.truncateToTokens / 2));
        const recentUnits = [];
        let accumulatedRecentTokens = 0;

        for (let i = atomicUnits.length - 1; i >= 0; i--) {
            const unit = atomicUnits[i];
            const unitTokens = estimateTokens(unit);
            if (recentUnits.length === 0 || accumulatedRecentTokens + unitTokens <= targetRecentTokens) {
                recentUnits.unshift(unit);
                accumulatedRecentTokens += unitTokens;
            } else {
                break;
            }
        }

        const summarizeUnitsCount = atomicUnits.length - recentUnits.length;
        if (summarizeUnitsCount <= 0) {
            return truncateToBudget(messages, this.truncateToTokens);
        }

        const unitsToSummarize = atomicUnits.slice(0, summarizeUnitsCount);
        const messagesToSummarize = unitsToSummarize.flat();
        const renderedText = this._renderMessagesAsText(messagesToSummarize);

        const summaryPrompt = [
            makeTextMessage({
                role: 'system',
                text: 'You are a helpful assistant that summarizes conversation history. Create a concise summary of the conversation events, capturing all key user requests, tool executions, outputs, and conclusions. Do not add speculative information.',
            }),
            makeTextMessage({
                role: 'user',
                text: previousSummary
                    ? `Previous Summary:\n${previousSummary}\n\nNew Conversation Events to incorporate:\n${renderedText}`
                    : `Conversation Events:\n${renderedText}`,
            }),
        ];

        let summaryText = '';
        let summarizerUsageTokens = 0;
        const compactorSpanId = 'llm_compactor_' + Date.now();

        if (this.events) {
            this.events.emit('llm:start', {
                spanId: compactorSpanId,
                name: 'llm_summarizer_compact',
                attributes: {
                    llm_provider: this.llmService.provider,
                    model: this.model,
                    input: summaryPrompt,
                    input_length: summaryPrompt.length,
                    purpose: 'compaction_summary',
                },
            });
        }

        try {
            const response = await this.llmService.chat(summaryPrompt, { model: this.model });
            summaryText = messageText(response) || (typeof response.output === 'string' ? response.output : '');
            summarizerUsageTokens = response.rawResponse?.usage?.total_tokens
                ?? response.rawResponse?.usage?.totalTokens
                ?? (estimateTokens(summaryPrompt) + estimateTokens(summaryText));
            this.lastCompactionTokens = (this.lastCompactionTokens || 0) + summarizerUsageTokens;

            if (this.events) {
                this.events.emit('llm:complete', {
                    spanId: compactorSpanId,
                    name: 'llm_summarizer_compact',
                    attributes: {
                        model: this.model,
                        usage: response.rawResponse?.usage || { total_tokens: summarizerUsageTokens },
                        response,
                    },
                });
            }
        } catch (err) {
            if (this.events) {
                this.events.emit('llm:error', {
                    spanId: compactorSpanId,
                    name: 'llm_summarizer_compact',
                    error: err.message,
                });
                this.events.emit('compactor:error', {
                    strategy: 'summarizer',
                    error: `LLM summarization failed: ${err.message}. Falling back to sliding window truncation.`,
                });
            }
            return truncateToBudget(messages, this.truncateToTokens);
        }

        const summaryMessage = makeTextMessage({
            role: 'system',
            text: `[Conversation Summary]: ${summaryText.trim()}`,
        });

        const compacted = [
            ...filteredSystemMessages,
            summaryMessage,
            ...recentUnits.flat(),
        ];

        // Ensure resulting compacted message list is strictly within target budget
        const boundedResult = truncateToBudget(compacted, this.truncateToTokens);

        const afterTokens = estimateTokens(boundedResult);
        const afterCount = boundedResult.length;

        if (this.events) {
            this.events.emit('compactor:compacted', {
                strategy: 'summarizer',
                beforeTokens,
                afterTokens,
                beforeCount,
                afterCount,
            });
        }

        return boundedResult;
    }
}
