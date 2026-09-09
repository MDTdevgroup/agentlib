import {
    isToolCall,
    isToolResult,
    isTextMessage,
    toolCallId,
} from '../message.js';

/**
 * Heuristically estimates the token count for a message, array of messages, or string.
 * Approximates 1 token ~= 4 characters.
 *
 * @param {string|object|Array<object>} input
 * @returns {number} Estimated token count
 */
export function estimateTokens(input) {
    if (!input) return 0;
    if (typeof input === 'string') {
        return Math.max(1, Math.ceil(input.length / 4));
    }
    if (Array.isArray(input)) {
        return input.reduce((acc, item) => acc + estimateTokens(item), 0);
    }
    if (typeof input === 'object') {
        let chars = 0;
        if (input.role) chars += input.role.length;
        if (input.name) chars += input.name.length;
        if (input.type) chars += input.type.length;
        if (input.content !== undefined) {
            if (typeof input.content === 'string') {
                chars += input.content.length;
            } else if (Array.isArray(input.content)) {
                for (const part of input.content) {
                    if (typeof part === 'string') chars += part.length;
                    else if (part?.text) chars += part.text.length;
                    else chars += JSON.stringify(part).length;
                }
            } else {
                chars += JSON.stringify(input.content).length;
            }
        }
        if (input.arguments !== undefined) {
            chars += typeof input.arguments === 'string' ? input.arguments.length : JSON.stringify(input.arguments).length;
        }
        if (input.output !== undefined) {
            chars += typeof input.output === 'string' ? input.output.length : JSON.stringify(input.output).length;
        }
        if (input.summary) chars += input.summary.length;
        if (input.speaker) chars += input.speaker.length;

        // Framing overhead per message: ~4 tokens (16 chars)
        return Math.max(1, Math.ceil((chars + 16) / 4));
    }
    return 1;
}

/**
 * Checks whether a message item is a system prompt or instruction.
 *
 * @param {object} item
 * @returns {boolean}
 */
export function isSystemMessage(item) {
    if (!item || typeof item !== 'object') return false;
    return item.role === 'system';
}

/**
 * Groups messages into atomic units so that related tool calls and tool outputs
 * are never separated across compaction boundaries.
 *
 * @param {Array<object>} messages
 * @returns {Array<Array<object>>} Array of atomic message groups
 */
export function groupAtomicUnits(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return [];
    }

    const units = [];
    let currentToolGroup = [];
    const pendingCallIds = new Set();

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg) continue;

        if (isSystemMessage(msg)) {
            if (currentToolGroup.length > 0) {
                units.push(currentToolGroup);
                currentToolGroup = [];
                pendingCallIds.clear();
            }
            units.push([msg]);
            continue;
        }

        if (isToolCall(msg)) {
            const callId = toolCallId(msg);
            if (callId) pendingCallIds.add(callId);
            currentToolGroup.push(msg);
            continue;
        }

        if (isToolResult(msg)) {
            const callId = msg.call_id || msg.id;
            if (callId) pendingCallIds.delete(callId);
            currentToolGroup.push(msg);

            // If all tool calls in the active batch have been fulfilled and next message is not another tool result/call
            if (pendingCallIds.size === 0) {
                const nextMsg = messages[i + 1];
                if (!nextMsg || (!isToolResult(nextMsg) && !isToolCall(nextMsg))) {
                    units.push(currentToolGroup);
                    currentToolGroup = [];
                }
            }
            continue;
        }

        // Standard message (user or assistant text or reasoning)
        if (currentToolGroup.length > 0) {
            units.push(currentToolGroup);
            currentToolGroup = [];
            pendingCallIds.clear();
        }
        units.push([msg]);
    }

    if (currentToolGroup.length > 0) {
        units.push(currentToolGroup);
    }

    return units;
}

/**
 * Clamps an oversized atomic unit down to fit within a maximum token budget.
 * Applies character-level truncation to tool outputs and large text content as a last resort.
 *
 * @param {Array<object>} unit - Atomic unit of messages
 * @param {number} maxTokens - Token budget for this unit
 * @returns {Array<object>}
 */
export function clampUnitToBudget(unit, maxTokens) {
    if (!Array.isArray(unit) || unit.length === 0) return unit;
    const maxChars = Math.max(100, Math.floor((maxTokens - (unit.length * 4)) * 4));

    return unit.map((msg) => {
        if (!msg || typeof msg !== 'object') return msg;

        if (isToolResult(msg)) {
            const rawOutput = typeof msg.output === 'string' ? msg.output : JSON.stringify(msg.output ?? null);
            if (rawOutput && rawOutput.length > maxChars) {
                const truncatedText = rawOutput.slice(0, Math.max(20, maxChars - 25)) + '... [truncated]';
                let parsedOutput = truncatedText;
                if (typeof msg.output === 'object' && msg.output !== null) {
                    parsedOutput = {
                        _truncated: true,
                        preview: truncatedText,
                    };
                }
                return {
                    ...msg,
                    output: parsedOutput,
                };
            }
        } else if (isTextMessage(msg)) {
            const rawContent = typeof msg.content === 'string' ? msg.content : (msg.text || '');
            if (rawContent && rawContent.length > maxChars) {
                const truncatedText = rawContent.slice(0, Math.max(20, maxChars - 25)) + '... [truncated]';
                return {
                    ...msg,
                    content: truncatedText,
                    text: truncatedText,
                };
            }
        }
        return msg;
    });
}

/**
 * Truncates an array of messages to fit within a token budget while:
 * 1. Preserving all system messages at the start.
 * 2. Keeping the most recent atomic units intact.
 * 3. Never splitting a tool call from its result.
 * 4. Clamping oversized individual units as a hard ceiling floor.
 *
 * @param {Array<object>} messages
 * @param {number} budgetTokens
 * @returns {Array<object>}
 */
export function truncateToBudget(messages, budgetTokens) {
    if (!Array.isArray(messages) || messages.length === 0) return [];
    const totalEst = estimateTokens(messages);
    if (totalEst <= budgetTokens) {
        return messages;
    }

    const systemMessages = messages.filter(isSystemMessage);
    const nonSystemMessages = messages.filter((m) => !isSystemMessage(m));

    if (nonSystemMessages.length === 0) {
        return systemMessages;
    }

    const systemTokens = estimateTokens(systemMessages);
    const availableForNonSystem = Math.max(0, budgetTokens - systemTokens);

    const atomicUnits = groupAtomicUnits(nonSystemMessages);
    const keptUnits = [];
    let accumulatedTokens = 0;

    // Walk backwards from most recent atomic units
    for (let i = atomicUnits.length - 1; i >= 0; i--) {
        const unit = atomicUnits[i];
        const unitTokens = estimateTokens(unit);

        if (accumulatedTokens + unitTokens <= availableForNonSystem) {
            keptUnits.unshift(unit);
            accumulatedTokens += unitTokens;
        } else if (keptUnits.length === 0) {
            // Hard clamp floor: even the single most recent atomic unit exceeds available budget.
            // Rather than blowing past the model limits with an oversized payload (e.g. 200k-token tool output),
            // clamp individual payloads within this unit to fit the available budget.
            const clamped = clampUnitToBudget(unit, availableForNonSystem);
            keptUnits.unshift(clamped);
            accumulatedTokens += estimateTokens(clamped);
            break;
        } else {
            break;
        }
    }

    return [...systemMessages, ...keptUnits.flat()];
}

/**
 * Abstract Base Compactor class.
 */
export class BaseCompactor {
    /**
     * Compacts an array of messages according to the specific compaction strategy.
     *
     * @param {Array<object>} messages - Full message history.
     * @returns {Promise<Array<object>>} Compacted messages to send over the wire.
     */
    async compact(_messages) {
        throw new Error("Method 'compact()' must be implemented by subclass.");
    }
}
