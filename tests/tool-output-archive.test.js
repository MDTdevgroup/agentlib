import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    ToolOutputArchive,
    generateOutputSummary,
    createRetrieveTool,
    archiveContextToolOutputs,
} from '../src/tools/archive/index.js';
import { makeToolResult, makeTextMessage, messageText } from '../src/memory/message.js';
import { Context } from '../src/memory/context.js';

describe('Tool Output Archive (Pi-style Summarize, Archive & Alias)', () => {
    let archive;

    afterEach(async () => {
        if (archive) {
            await archive.cleanup();
            archive = null;
        }
    });

    describe('generateOutputSummary', () => {
        test('summarizes array with item count and sample preview', () => {
            const arr = [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }];
            const summary = generateOutputSummary(arr);
            assert.match(summary, /Array of 2 items/);
            assert.match(summary, /Alice/);
        });

        test('summarizes object with keys list', () => {
            const obj = { id: 123, status: 'success', latency: 45, extra: 'data' };
            const summary = generateOutputSummary(obj);
            assert.match(summary, /Object with fields: \[id, status, latency, extra\]/);
        });

        test('summarizes multiline text with line count and head preview', () => {
            const text = 'Line 1: Log started\nLine 2: Processing...\nLine 3: Finished';
            const summary = generateOutputSummary(text);
            assert.match(summary, /Multiline text \(3 lines\)/);
            assert.match(summary, /Starts: "Line 1: Log started"/);
        });
    });

    describe('ToolOutputArchive', () => {
        test('skips payloads below thresholdBytes', async () => {
            archive = new ToolOutputArchive({ thresholdBytes: 1000 });
            const small = { status: 'ok', count: 1 };
            const res = await archive.archive('small_tool', small);

            assert.equal(res.archived, false);
            assert.deepEqual(res.output, small);
        });

        test('archives payloads exceeding thresholdBytes and assigns sequential IDs', async () => {
            archive = new ToolOutputArchive({ thresholdBytes: 50 });
            const largeData = Array.from({ length: 50 }, (_, i) => ({ id: i, value: `item-${i}` }));

            const res1 = await archive.archive('query_users', largeData);
            assert.equal(res1.archived, true);
            assert.equal(res1.id, 't1');
            assert.ok(res1.output._archived);
            assert.equal(res1.output.id, 't1');
            assert.match(res1.output.notice, /retrieve_tool_output\(\{ id: "t1" \}\)/);

            const res2 = await archive.archive('query_logs', 'A'.repeat(200));
            assert.equal(res2.archived, true);
            assert.equal(res2.id, 't2');
        });

        test('retrieves full raw data from disk by ID', async () => {
            archive = new ToolOutputArchive({ thresholdBytes: 20 });
            const data = { user: 'charlie', roles: ['admin', 'billing'] };
            await archive.archive('user_tool', data);

            const retrieved = await archive.retrieve('t1');
            assert.equal(retrieved.id, 't1');
            assert.equal(retrieved.toolName, 'user_tool');
            assert.match(retrieved.content, /charlie/);
            assert.match(retrieved.content, /admin/);
        });

        test('retrieves specific lines matching query keyword', async () => {
            archive = new ToolOutputArchive({ thresholdBytes: 10 });
            const logs = [
                '2026-10-14 06:00:00 INFO Server started',
                '2026-10-14 06:01:00 ERROR Database connection failed',
                '2026-10-14 06:02:00 INFO Retry scheduled',
                '2026-10-14 06:03:00 ERROR Disk quota exceeded',
            ].join('\n');

            await archive.archive('fetch_logs', logs);

            const queryResult = await archive.retrieve('t1', { query: 'ERROR' });
            assert.equal(queryResult.totalLines, 2);
            assert.match(queryResult.content, /Database connection failed/);
            assert.match(queryResult.content, /Disk quota exceeded/);
            assert.doesNotMatch(queryResult.content, /Server started/);
        });

        test('supports offset and limit line slicing', async () => {
            archive = new ToolOutputArchive({ thresholdBytes: 10 });
            const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n');
            await archive.archive('test_tool', lines);

            const sliced = await archive.retrieve('t1', { offset: 5, limit: 3 });
            assert.equal(sliced.returnedLines, 3);
            assert.equal(sliced.content, 'line-5\nline-6\nline-7');
            assert.equal(sliced.hasMore, true);
        });

        test('returns descriptive error when ID is not found on disk', async () => {
            archive = new ToolOutputArchive();
            const res = await archive.retrieve('non_existent');
            assert.match(res.error, /not found on disk/i);
        });
    });

    describe('createRetrieveTool', () => {
        test('defines retrieve_tool_output and executes retrieval', async () => {
            archive = new ToolOutputArchive({ thresholdBytes: 10 });
            await archive.archive('db_tool', 'Database record payload');

            const tool = createRetrieveTool(archive);
            assert.equal(tool.name, 'retrieve_tool_output');
            assert.equal(tool.type, 'function');

            const res = await tool.func({ id: 't1' });
            assert.match(res.content, /Database record payload/);
        });

        test('supports custom tool name alias like context_tree_query', async () => {
            archive = new ToolOutputArchive({ thresholdBytes: 10 });
            await archive.archive('db_tool', 'Sample data');

            const tool = createRetrieveTool(archive, 'context_tree_query');
            assert.equal(tool.name, 'context_tree_query');

            const res = await tool.func({ id: 't1' });
            assert.match(res.content, /Sample data/);
        });

        test('returns error when id argument is omitted', async () => {
            archive = new ToolOutputArchive();
            const tool = createRetrieveTool(archive);
            const res = await tool.func({});
            assert.match(res.error, /requires a valid "id"/);
        });
    });

    describe('archiveContextToolOutputs', () => {
        test('replaces completed tool outputs exceeding threshold in Context with archive records', async () => {
            archive = new ToolOutputArchive({ thresholdBytes: 50 });

            const smallResult = makeToolResult({ callId: 'c1', name: 'small', value: { x: 1 } });
            const largeResult = makeToolResult({
                callId: 'c2',
                name: 'large_query',
                value: { records: Array.from({ length: 100 }, (_, i) => `item_${i}`) },
            });
            const userMsg = makeTextMessage({ role: 'user', text: 'Hello' });

            const initialContext = new Context([userMsg, smallResult, largeResult]);
            const updatedContext = await archiveContextToolOutputs(initialContext, archive);

            assert.ok(updatedContext instanceof Context);
            const msgs = updatedContext.getMessages();
            assert.equal(msgs.length, 3);

            // User message intact
            assert.equal(messageText(msgs[0]), 'Hello');

            // Small tool result intact
            assert.deepEqual(msgs[1].output, { x: 1 });

            // Large tool result archived to disk
            assert.equal(msgs[2].output._archived, true);
            assert.equal(msgs[2].output.id, 't1');
            assert.match(msgs[2].output.notice, /t1/);

            // Calling archiveContextToolOutputs again on already archived context is a no-op (idempotent)
            const secondPass = await archiveContextToolOutputs(updatedContext, archive);
            assert.equal(secondPass, updatedContext);
        });
    });
});
