import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '../src/memory/context.js';

describe('Context', () => {
    test('Context immutability: adding input does not modify original instance', () => {
        const initialMessages = [{ role: 'user', content: 'hello' }];
        const ctx1 = new Context(initialMessages);

        const ctx2 = ctx1.addInput({ role: 'assistant', content: 'world' });

        assert.notEqual(ctx1, ctx2, 'addInput should return a new Context instance');
        assert.equal(ctx1.getMessages().length, 1, 'Original context should remain unchanged');
        assert.equal(ctx2.getMessages().length, 2, 'New context should have appended message');
        assert.deepEqual(ctx1.getMessages()[0], { role: 'user', content: 'hello' });
    });

    test('addInput accepts arrays of messages immutably', () => {
        const ctx1 = new Context();
        const ctx2 = ctx1.addInput([
            { role: 'user', content: 'msg1' },
            { role: 'user', content: 'msg2' }
        ]);

        assert.equal(ctx1.getMessages().length, 0);
        assert.equal(ctx2.getMessages().length, 2);
    });

    test('clone returns an isolated context copy', () => {
        const ctx1 = new Context([{ role: 'user', content: 'hello' }], 'Initial summary');
        const ctx2 = ctx1.clone();

        assert.notEqual(ctx1, ctx2);
        assert.deepEqual(ctx1.getMessages(), ctx2.getMessages());
        assert.equal(ctx1.summary, ctx2.summary);
    });
});
