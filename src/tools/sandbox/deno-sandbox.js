/**
 * @fileoverview Hardened Deno-based Sandbox adapter with OS-level capabilities.
 *
 * Spawns an external Deno process with strict permissions:
 * `deno run --no-prompt --deny-net --deny-read --deny-write`
 *
 * Provides a strong security boundary using OS-level isolation flags without
 * introducing any npm dependencies. Requires only the `deno` binary on PATH.
 */

import { spawn, spawnSync } from 'node:child_process';
import { makeException } from '../../util/exception.js';
import {
    getDefaultSandboxTimeoutMS,
    getDefaultMaxSandboxLogBytes,
} from '../../config.js';
import { truncateLogs, normalizeUserCode } from './worker-sandbox.js';

/**
 * Checks whether the 'deno' binary is available on PATH.
 * @returns {boolean}
 */
export function isDenoAvailable() {
    try {
        return spawnSync('deno', ['--version'], { stdio: 'ignore' }).status === 0;
    } catch {
        return false;
    }
}

function assertDenoInstalled() {
    if (!isDenoAvailable()) {
        throw makeException(
            'MissingDependency',
            "DenoSandbox requires the 'deno' executable to be installed on your system PATH.\nInstall with: curl -fsSL https://deno.land/install.sh | sh (or 'brew install deno')."
        );
    }
}

export class DenoSandbox {
    /**
     * @param {object} [defaultOptions={}]
     * @param {number} [defaultOptions.timeoutMS]
     * @param {number} [defaultOptions.maxLogBytes]
     */
    constructor({
        timeoutMS = getDefaultSandboxTimeoutMS(),
        maxLogBytes = getDefaultMaxSandboxLogBytes(),
    } = {}) {
        this.defaultTimeoutMS = timeoutMS;
        this.defaultMaxLogBytes = maxLogBytes;
    }

    /**
     * Runs code in a hardened Deno subprocess communicating over stdio.
     *
     * @param {string} code
     * @param {object} [options={}]
     * @param {string} [options.stubs='']
     * @param {number} [options.timeoutMS]
     * @param {AbortSignal} [options.signal]
     * @param {Function} [options.onToolCall]
     * @param {number} [options.maxLogBytes]
     * @returns {Promise<{ result: any, logs: string, error: Error | null }>}
     */
    async run(code, {
        stubs = '',
        timeoutMS = this.defaultTimeoutMS,
        signal = null,
        onToolCall = async () => {},
        maxLogBytes = this.defaultMaxLogBytes,
    } = {}) {
        signal?.throwIfAborted?.();
        assertDenoInstalled();

        const normalizedCode = normalizeUserCode(code);

        // Runner harness executed by Deno
        const runnerScript = `
import { TextLineStream } from "jsr:@std/streams/text-line-stream";

const logs = [];
const consoleShim = {
    log: (...args) => logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')),
    info: (...args) => logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')),
    warn: (...args) => logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')),
    error: (...args) => logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')),
};

let callCounter = 0;
const pendingCalls = new Map();

// Listen to stdin messages
(async () => {
    const lines = Deno.stdin.readable
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new TextLineStream());

    for await (const line of lines) {
        if (!line.trim()) continue;
        try {
            const msg = JSON.parse(line);
            if (msg.type === 'tool_result' && pendingCalls.has(msg.id)) {
                const { resolve, reject } = pendingCalls.get(msg.id);
                pendingCalls.delete(msg.id);
                if (msg.error) reject(new Error(msg.error));
                else resolve(msg.result);
            }
        } catch {}
    }
})();

function sendMsg(obj) {
    const json = JSON.stringify(obj) + "\\n";
    Deno.stdout.writeSync(new TextEncoder().encode(json));
}

async function __callTool(name, args) {
    const id = "deno_call_" + (++callCounter) + "_" + Date.now();
    return new Promise((resolve, reject) => {
        pendingCalls.set(id, { resolve, reject });
        sendMsg({ type: 'tool_call', id, name, args });
    });
}

// Stubs:
${stubs}

// User Code:
try {
    const userResult = await (async () => {
        ${normalizedCode}
    })();
    sendMsg({ type: 'script_done', result: userResult, logs: logs.join('\\n') });
} catch (err) {
    sendMsg({ type: 'script_error', error: { message: err.message, name: err.name, stack: err.stack }, logs: logs.join('\\n') });
}
`;

        const encodedScript = `data:application/javascript;base64,${Buffer.from(runnerScript).toString('base64')}`;

        return new Promise((resolve) => {
            let proc = null;
            let timer = null;
            let abortListener = null;
            let completed = false;
            let buffer = '';

            const cleanup = () => {
                completed = true;
                if (timer) clearTimeout(timer);
                if (signal && abortListener) {
                    signal.removeEventListener('abort', abortListener);
                }
                if (proc) {
                    try {
                        proc.kill('SIGKILL');
                    } catch {
                        // ignore termination errors during process cleanup
                    }
                    proc = null;
                }
            };

            const finish = (result, logs, error) => {
                if (completed) return;
                cleanup();
                const boundedLogs = truncateLogs(logs, maxLogBytes);
                resolve({
                    result,
                    logs: boundedLogs,
                    error: error ? (error instanceof Error ? error : new Error(String(error.message || error))) : null,
                });
            };

            try {
                proc = spawn('deno', [
                    'run',
                    '--no-prompt',
                    '--deny-net',
                    '--deny-read',
                    '--deny-write',
                    encodedScript,
                ], {
                    stdio: ['pipe', 'pipe', 'pipe'],
                });
            } catch (spawnErr) {
                return finish(undefined, '', spawnErr);
            }

            if (timeoutMS > 0) {
                timer = setTimeout(() => {
                    finish(undefined, '', new Error(`Deno script execution timed out after ${timeoutMS}ms`));
                }, timeoutMS);
            }

            if (signal) {
                abortListener = () => {
                    finish(undefined, '', signal.reason instanceof Error ? signal.reason : new Error("Script execution cancelled."));
                };
                signal.addEventListener('abort', abortListener, { once: true });
            }

            proc.stdout.setEncoding('utf8');
            proc.stdout.on('data', async (chunk) => {
                buffer += chunk;
                const lines = buffer.split('\n');
                buffer = lines.pop(); // Keep trailing incomplete line in buffer

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const msg = JSON.parse(line);
                        if (msg.type === 'tool_call') {
                            const { id, name, args } = msg;
                            try {
                                const toolResult = await onToolCall(name, args);
                                if (proc && !completed) {
                                    proc.stdin.write(JSON.stringify({ type: 'tool_result', id, result: toolResult }) + '\n');
                                }
                            } catch (toolErr) {
                                if (proc && !completed) {
                                    proc.stdin.write(JSON.stringify({ type: 'tool_result', id, error: toolErr.message }) + '\n');
                                }
                            }
                        } else if (msg.type === 'script_done') {
                            finish(msg.result, msg.logs, null);
                        } else if (msg.type === 'script_error') {
                            const err = new Error(msg.error?.message || 'Script execution failed');
                            err.name = msg.error?.name || 'ScriptError';
                            finish(undefined, msg.logs, err);
                        }
                    } catch {
                        // ignore JSON parse errors on partial or non-JSON stream chunks
                    }
                }
            });

            proc.stderr.setEncoding('utf8');
            let stderrOutput = '';
            proc.stderr.on('data', (c) => { stderrOutput += c; });

            proc.on('error', (err) => {
                finish(undefined, '', err);
            });

            proc.on('close', (codeExit) => {
                if (!completed) {
                    const err = codeExit === 0 ? null : new Error(`Deno exited with code ${codeExit}: ${stderrOutput}`);
                    finish(undefined, '', err);
                }
            });
        });
    }
}
