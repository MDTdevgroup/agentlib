import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DenoSandbox, isDenoAvailable } from '../src/tools/sandbox/deno-sandbox.js';
import { assertSandbox } from '../src/tools/sandbox/index.js';
import { isException } from '../src/util/exception.js';

describe('DenoSandbox Adapter', () => {

    test('conforms to the Sandbox capability contract', () => {
        const sandbox = new DenoSandbox();
        assert.doesNotThrow(() => assertSandbox(sandbox));
    });

    test('isDenoAvailable returns a boolean', () => {
        const available = isDenoAvailable();
        assert.equal(typeof available, 'boolean');
    });

    test('throws structured MissingDependency Exception when deno executable is absent', async () => {
        const sandbox = new DenoSandbox();

        if (!isDenoAvailable()) {
            await assert.rejects(
                async () => sandbox.run('return 1;'),
                (err) => {
                    assert.ok(isException(err));
                    assert.equal(err.type, 'MissingDependency');
                    assert.match(err.message, /deno/i);
                    assert.match(err.message, /install/i);
                    return true;
                }
            );
        } else {
            // If Deno is installed in the test environment, verify actual isolated execution
            const res = await sandbox.run('console.log("hello deno"); return 21 * 2;');
            assert.equal(res.result, 42);
            assert.match(res.logs, /hello deno/);
            assert.equal(res.error, null);
        }
    });

    test('fails immediately if passed an already-aborted signal', async () => {
        const sandbox = new DenoSandbox();
        const controller = new AbortController();
        controller.abort(new Error("Pre-aborted"));

        await assert.rejects(
            async () => sandbox.run('return 1;', { signal: controller.signal }),
            /Pre-aborted|cancelled|aborted/i
        );
    });
});
