/**
 * @fileoverview Built-in Worker-based Sandbox for programmatic tool execution.
 *
 * THREAT MODEL & SECURITY BOUNDARY:
 * WorkerSandbox executes untrusted or model-generated scripts inside a dedicated
 * `node:worker_threads` Worker with memory limits set via `resourceLimits`, inside
 * an isolated `node:vm` context that withholds `require`, `import`, `process`, and `fetch`.
 *
 * CAUTION: `node:vm` is NOT a formal security boundary against determined adversaries,
 * and Node.js does not provide native OS-level network isolation flags.
 * WorkerSandbox reliably mitigates accidental damage, runaway infinite loops, memory
 * exhaustion, and casual prompt injection. It does NOT guarantee containment against
 * advanced VM-escape exploits. For high-security environments, use DenoSandbox with
 * strict OS-level sandbox flags (--deny-net, --deny-read, --deny-write).
 *
 * The message broker (`onToolCall`) is the WorkerSandbox's ONLY outward communication channel.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    getDefaultSandboxTimeoutMS,
    getDefaultSandboxMemoryMB,
    getDefaultMaxSandboxLogBytes,
} from '../../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKER_ENTRY_PATH = join(__dirname, 'worker-entry.js');

/**
 * Truncates log output string to maxBytes if needed.
 */
export function truncateLogs(logs = '', maxBytes = getDefaultMaxSandboxLogBytes()) {
    if (!logs || typeof logs !== 'string') return '';
    const byteLength = Buffer.byteLength(logs, 'utf8');
    if (byteLength <= maxBytes) return logs;
    return `${logs.slice(0, maxBytes)}\n[... truncated ${byteLength - maxBytes} bytes ...]`;
}

/**
 * Normalizes user script code so standalone async IIFEs return their promise result.
 */
export function normalizeUserCode(rawCode = '') {
    if (typeof rawCode !== 'string') return '';
    const stripped = rawCode.replace(/^(?:\s+|\/\/[^\n]*\n?|\/\*[\s\S]*?\*\/)+/, '').trim();
    return /^\(\s*async\b[\s\S]*\)\s*\(\s*\)\s*;?$/.test(stripped)
        ? `return await ${stripped}`
        : rawCode;
}

export class WorkerSandbox {
    /**
     * @param {object} [defaultOptions={}]
     * @param {number} [defaultOptions.timeoutMS]
     * @param {number} [defaultOptions.memoryMB]
     * @param {number} [defaultOptions.maxLogBytes]
     */
    constructor({
        timeoutMS = getDefaultSandboxTimeoutMS(),
        memoryMB = getDefaultSandboxMemoryMB(),
        maxLogBytes = getDefaultMaxSandboxLogBytes(),
    } = {}) {
        this.defaultTimeoutMS = timeoutMS;
        this.defaultMemoryMB = memoryMB;
        this.defaultMaxLogBytes = maxLogBytes;
    }

    /**
     * Executes JavaScript code inside the Worker thread sandbox.
     *
     * @param {string} code - The user script code to execute.
     * @param {object} [options={}]
     * @param {string} [options.stubs=''] - Generated tool stubs code.
     * @param {number} [options.timeoutMS] - Maximum execution time in milliseconds.
     * @param {number} [options.memoryMB] - Memory ceiling in megabytes.
     * @param {AbortSignal} [options.signal] - Optional cancellation signal.
     * @param {Function} [options.onToolCall] - Broker callback `async (name, args) => result`.
     * @param {number} [options.maxLogBytes] - Maximum log output bytes before truncation.
     * @returns {Promise<{ result: any, logs: string, error: Error | null }>}
     */
    async run(code, {
        stubs = '',
        timeoutMS = this.defaultTimeoutMS,
        memoryMB = this.defaultMemoryMB,
        signal = null,
        onToolCall = async () => {},
        maxLogBytes = this.defaultMaxLogBytes,
    } = {}) {
        signal?.throwIfAborted?.();

        return new Promise((resolve) => {
            let worker = null;
            let timer = null;
            let abortListener = null;
            let completed = false;

            const cleanup = async () => {
                completed = true;
                if (timer) clearTimeout(timer);
                if (signal && abortListener) {
                    signal.removeEventListener('abort', abortListener);
                }
                if (worker) {
                    try {
                        await worker.terminate();
                    } catch {
                        // ignore termination errors during cleanup
                    }
                    worker = null;
                }
            };

            const finish = async (result, logs, error) => {
                if (completed) return;
                await cleanup();
                const boundedLogs = truncateLogs(logs, maxLogBytes);
                resolve({
                    result,
                    logs: boundedLogs,
                    error: error ? (error instanceof Error ? error : new Error(String(error.message || error))) : null,
                });
            };

            try {
                worker = new Worker(WORKER_ENTRY_PATH, {
                    workerData: {
                        code,
                        stubsCode: stubs,
                        timeoutMS,
                    },
                    resourceLimits: {
                        maxOldGenerationSizeMb: memoryMB,
                        maxYoungGenerationSizeMb: Math.max(16, Math.floor(memoryMB / 4)),
                    },
                });
            } catch (spawnErr) {
                return finish(undefined, '', spawnErr);
            }

            // Arm execution timeout
            if (timeoutMS > 0) {
                timer = setTimeout(async () => {
                    await finish(
                        undefined,
                        '',
                        new Error(`Script execution timed out after ${timeoutMS}ms`)
                    );
                }, timeoutMS);
            }

            // Arm caller abort signal
            if (signal) {
                abortListener = async () => {
                    await finish(
                        undefined,
                        '',
                        signal.reason instanceof Error ? signal.reason : new Error("Script execution cancelled.")
                    );
                };
                signal.addEventListener('abort', abortListener, { once: true });
            }

            // Handle worker messages (tool calls, completion, errors)
            worker.on('message', async (msg) => {
                if (!msg || typeof msg !== 'object') return;

                if (msg.type === 'tool_call') {
                    const { id, name, args } = msg;
                    try {
                        const callResult = await onToolCall(name, args);
                        if (worker && !completed) {
                            worker.postMessage({ type: 'tool_result', id, result: callResult });
                        }
                    } catch (toolErr) {
                        if (worker && !completed) {
                            worker.postMessage({ type: 'tool_result', id, error: toolErr.message });
                        }
                    }
                    return;
                }

                if (msg.type === 'script_done') {
                    await finish(msg.result, msg.logs, null);
                    return;
                }

                if (msg.type === 'script_error') {
                    const err = new Error(msg.error?.message || 'Script execution failed');
                    err.name = msg.error?.name || 'ScriptError';
                    err.stack = msg.error?.stack;
                    await finish(undefined, msg.logs, err);
                }
            });

            worker.on('error', async (workerErr) => {
                await finish(undefined, '', workerErr);
            });

            worker.on('exit', async (exitCode) => {
                if (!completed) {
                    const err = exitCode === 0
                        ? null
                        : new Error(`Worker stopped prematurely with exit code ${exitCode}`);
                    await finish(undefined, '', err);
                }
            });
        });
    }
}
