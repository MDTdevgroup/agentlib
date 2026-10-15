/**
 * @fileoverview Manages disk-backed archiving of large tool outputs.
 * Follows the "Summarize, Archive & Alias" pattern used by Pi:
 * - Active turn sees full raw output with 100% precision.
 * - Prior turns have large outputs offloaded to disk under short handles (t1, t2).
 * - History preserves a concise structural summary and reference pointer.
 * - Raw data can be retrieved on demand via retrieve_tool_output.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

/**
 * Generates a concise human-readable structural summary for tool output.
 * @param {any} data
 * @param {number} [maxLength=300]
 * @returns {string}
 */
export function generateOutputSummary(data, maxLength = 300) {
    if (data === null || data === undefined) {
        return 'null';
    }

    if (Array.isArray(data)) {
        const count = data.length;
        if (count === 0) return 'Empty array []';
        const sample = JSON.stringify(data[0]);
        const samplePreview = sample.length > 80 ? sample.slice(0, 80) + '...' : sample;
        return `Array of ${count} items. Sample item: ${samplePreview}`;
    }

    if (typeof data === 'object') {
        const keys = Object.keys(data);
        const keysPreview = keys.slice(0, 8).join(', ') + (keys.length > 8 ? `, ... (+${keys.length - 8} more)` : '');
        return `Object with fields: [${keysPreview}]`;
    }

    const str = String(data).trim();
    const lines = str.split('\n');
    if (lines.length > 1) {
        const firstLine = lines[0].slice(0, 100);
        return `Multiline text (${lines.length} lines). Starts: "${firstLine}"`;
    }

    return str.length > maxLength ? str.slice(0, maxLength) + '...' : str;
}

export class ToolOutputArchive {
    /**
     * @param {object} [options={}]
     * @param {string} [options.storageDir] - Directory where raw outputs are stored. Defaults to OS tmp dir.
     * @param {number} [options.thresholdBytes=1024] - Size threshold triggering offload to disk (default: 1KB).
     */
    constructor({
        storageDir = null,
        thresholdBytes = 1024,
    } = {}) {
        this.thresholdBytes = thresholdBytes;
        this.storageDir = storageDir || join(tmpdir(), `agentlib-archive-${randomUUID().slice(0, 8)}`);
        this.index = new Map(); // id -> { id, path, toolName, byteLength, summary, createdAt }
        this.counter = 0;
        this.initialized = false;
    }

    /**
     * Ensures the disk directory exists.
     */
    async _ensureDir() {
        if (!this.initialized) {
            await fs.mkdir(this.storageDir, { recursive: true });
            this.initialized = true;
        }
    }

    /**
     * Determines if a payload exceeds the threshold to be archived.
     * @param {any} data
     * @returns {{ shouldArchive: boolean, byteLength: number, rawString: string }}
     */
    checkSize(data) {
        const rawString = typeof data === 'string' ? data : JSON.stringify(data ?? null);
        const byteLength = Buffer.byteLength(rawString, 'utf8');
        return {
            shouldArchive: byteLength >= this.thresholdBytes,
            byteLength,
            rawString,
        };
    }

    /**
     * Archives a raw output payload to disk and returns an archived summary reference.
     *
     * @param {string} toolName - Name of the tool that produced the output.
     * @param {any} data - Raw output value.
     * @returns {Promise<{ archived: boolean, id?: string, output: any, summary?: string, byteLength?: number }>}
     */
    async archive(toolName, data) {
        const { shouldArchive, byteLength } = this.checkSize(data);
        if (!shouldArchive) {
            return { archived: false, output: data };
        }

        await this._ensureDir();

        const id = `t${++this.counter}`;
        const filePath = join(this.storageDir, `${id}.json`);
        const summary = generateOutputSummary(data);

        const record = {
            id,
            toolName,
            byteLength,
            summary,
            createdAt: Date.now(),
            raw: data,
        };

        await fs.writeFile(filePath, JSON.stringify(record, null, 2), 'utf8');
        this.index.set(id, { id, filePath, toolName, byteLength, summary });

        const humanSize = byteLength > 1024 * 1024
            ? `${(byteLength / (1024 * 1024)).toFixed(1)}MB`
            : `${(byteLength / 1024).toFixed(1)}KB`;

        const archivedPayload = {
            _archived: true,
            id,
            tool: toolName,
            size: humanSize,
            byteLength,
            summary,
            notice: `[Tool Output ${id} archived to disk (${humanSize})]. Full raw data was preserved. Call retrieve_tool_output({ id: "${id}" }) to search or view specific lines.`,
        };

        return {
            archived: true,
            id,
            output: archivedPayload,
            summary,
            byteLength,
        };
    }

    /**
     * Retrieves an archived raw tool output from disk with optional filtering.
     *
     * @param {string} id - Archive identifier (e.g. 't1').
     * @param {object} [options={}]
     * @param {string} [options.query] - Substring or regex to filter lines.
     * @param {number} [options.offset=0] - 0-indexed line start.
     * @param {number} [options.limit=100] - Max lines to return.
     * @returns {Promise<object>} Retrieved slice and metadata.
     */
    async retrieve(id, { query = null, offset = 0, limit = 100 } = {}) {
        await this._ensureDir();
        const entry = this.index.get(id);
        const filePath = entry?.filePath || join(this.storageDir, `${id}.json`);

        let record;
        try {
            const rawContent = await fs.readFile(filePath, 'utf8');
            record = JSON.parse(rawContent);
        } catch {
            return {
                id,
                error: `Archived tool output "${id}" not found on disk.`,
            };
        }

        const raw = record.raw;
        const textRepresentation = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
        const allLines = textRepresentation.split('\n');

        let filteredLines = allLines;
        if (query && typeof query === 'string' && query.trim()) {
            const pattern = query.trim().toLowerCase();
            filteredLines = allLines.filter(line => line.toLowerCase().includes(pattern));
        }

        const totalLines = filteredLines.length;
        const start = Math.max(0, offset);
        const end = Math.min(totalLines, start + Math.max(1, limit));
        const sliced = filteredLines.slice(start, end);

        return {
            id,
            toolName: record.toolName,
            totalLines,
            returnedLines: sliced.length,
            offset: start,
            limit,
            hasMore: end < totalLines,
            content: sliced.join('\n'),
            summary: record.summary,
        };
    }

    /**
     * Checks if an ID has been archived.
     * @param {string} id
     * @returns {boolean}
     */
    has(id) {
        return this.index.has(id);
    }

    /**
     * Cleans up temporary storage directory on process exit.
     */
    async cleanup() {
        try {
            await fs.rm(this.storageDir, { recursive: true, force: true });
        } catch {
            // ignore cleanup errors on shutdown
        }
    }
}
