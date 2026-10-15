/**
 * @fileoverview Replaces bulky tool results in context with disk-backed archive references.
 */

import { isToolResult, makeToolResult } from '../../memory/message.js';
import { Context } from '../../memory/context.js';

/**
 * Transforms context messages by archiving completed tool outputs that exceed threshold to disk.
 *
 * @param {Context|Array<object>} contextOrMessages
 * @param {import('./tool-output-archive.js').ToolOutputArchive} archive
 * @returns {Promise<Context|Array<object>>} Updated context with archived references.
 */
export async function archiveContextToolOutputs(contextOrMessages, archive) {
    if (!archive) return contextOrMessages;

    const isContextInstance = contextOrMessages instanceof Context;
    const messages = isContextInstance ? contextOrMessages.getMessages() : contextOrMessages;
    if (!Array.isArray(messages) || messages.length === 0) {
        return contextOrMessages;
    }

    let modified = false;
    const updatedMessages = [];

    for (const msg of messages) {
        if (!isToolResult(msg)) {
            updatedMessages.push(msg);
            continue;
        }

        const output = msg.output !== undefined ? msg.output : msg.value;
        // Skip if already archived
        if (output && typeof output === 'object' && output._archived) {
            updatedMessages.push(msg);
            continue;
        }

        const toolName = msg.name || 'unknown';
        const archiveResult = await archive.archive(toolName, output);

        if (archiveResult.archived) {
            modified = true;
            const updatedResult = makeToolResult({
                callId: msg.call_id || msg.id,
                name: msg.name,
                value: archiveResult.output,
                thoughtSignature: msg.thoughtSignature || msg.signature,
            });
            updatedMessages.push(updatedResult);
        } else {
            updatedMessages.push(msg);
        }
    }

    if (!modified) {
        return contextOrMessages;
    }

    if (isContextInstance) {
        return new Context(updatedMessages, contextOrMessages.summary, {
            maxTokens: contextOrMessages.maxTokens,
            truncateToTokens: contextOrMessages.truncateToTokens,
        });
    }

    return updatedMessages;
}
