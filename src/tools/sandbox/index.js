/**
 * @fileoverview Sandbox capability contract, validator, and factory for programmatic tool calling.
 */

import { WorkerSandbox } from './worker-sandbox.js';
import { DenoSandbox, isDenoAvailable } from './deno-sandbox.js';

/**
 * Validates that an object conforms to the Sandbox contract.
 *
 * A valid Sandbox must provide:
 * - run(code, options): Promise<{ result: any, logs: string, error: Error | null }>
 *
 * @param {object} sandbox - Candidate sandbox instance.
 * @throws {TypeError} If sandbox does not conform to the contract.
 */
export function assertSandbox(sandbox) {
    if (!sandbox || typeof sandbox !== 'object') {
        throw new TypeError("Sandbox must be a non-null object.");
    }
    if (typeof sandbox.run !== 'function') {
        throw new TypeError("Sandbox must implement 'run(code, options)' as a function.");
    }
}

/**
 * Factory to create a Sandbox instance.
 *
 * @param {object} [options={}]
 * @param {'worker'|'deno'} [options.type='worker'] - Sandbox type ('worker' for built-in WorkerSandbox, 'deno' for DenoSandbox).
 * @param {object} [options.sandboxOptions={}] - Additional options forwarded to sandbox constructor.
 * @returns {WorkerSandbox|DenoSandbox}
 */
export function createSandbox({ type = 'worker', ...sandboxOptions } = {}) {
    const normalized = String(type).trim().toLowerCase();
    if (normalized === 'deno') {
        return new DenoSandbox(sandboxOptions);
    }
    return new WorkerSandbox(sandboxOptions);
}

export { WorkerSandbox, DenoSandbox, isDenoAvailable };
