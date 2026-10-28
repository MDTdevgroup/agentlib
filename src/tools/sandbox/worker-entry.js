/**
 * @fileoverview Worker thread entrypoint for WorkerSandbox.
 * Evaluates user scripts inside an isolated node:vm context and brokers tool calls.
 */

import { parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';

if (!parentPort) {
    throw new Error("worker-entry must be executed as a Worker thread.");
}

function formatArg(val) {
    if (val === null) return 'null';
    if (val === undefined) return 'undefined';
    if (typeof val === 'object') {
        try {
            return JSON.stringify(val);
        } catch {
            return String(val);
        }
    }
    return String(val);
}

function normalizeUserCode(rawCode = '') {
    if (typeof rawCode !== 'string') return '';
    // Strip leading whitespace and comments to inspect whether the script is a standalone async IIFE
    const stripped = rawCode.replace(/^(?:\s+|\/\/[^\n]*\n?|\/\*[\s\S]*?\*\/)+/, '').trim();
    if (/^\(\s*async\b[\s\S]*\)\s*\(\s*\)\s*;?$/.test(stripped)) {
        return `return await ${stripped}`;
    }
    return rawCode;
}

async function main() {
    const { code, stubsCode = '', timeoutMS = 30000 } = workerData || {};

    const logs = [];
    const consoleShim = {
        log: (...args) => logs.push(args.map(formatArg).join(' ')),
        info: (...args) => logs.push(args.map(formatArg).join(' ')),
        warn: (...args) => logs.push(args.map(formatArg).join(' ')),
        error: (...args) => logs.push(args.map(formatArg).join(' ')),
    };

    const pendingCalls = new Map();
    const drainListeners = new Set();
    let callCounter = 0;

    parentPort.on('message', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'tool_result' && pendingCalls.has(msg.id)) {
            const { resolve, reject } = pendingCalls.get(msg.id);
            pendingCalls.delete(msg.id);
            if (msg.error) {
                reject(new Error(msg.error));
            } else {
                resolve(msg.result);
            }
            if (pendingCalls.size === 0 && drainListeners.size > 0) {
                for (const notify of drainListeners) {
                    notify();
                }
                drainListeners.clear();
            }
        }
    });

    async function waitForPendingCalls() {
        while (pendingCalls.size > 0) {
            await new Promise((resolve) => drainListeners.add(resolve));
            // Yield microtasks so continuations after tool_result can enqueue follow-up calls
            await new Promise((resolve) => setImmediate(resolve));
        }
    }

    async function __callTool(name, args) {
        const id = `call_${++callCounter}_${Date.now()}`;
        return new Promise((resolve, reject) => {
            pendingCalls.set(id, { resolve, reject });
            parentPort.postMessage({ type: 'tool_call', id, name, args });
        });
    }

    const sandboxGlobals = {
        console: consoleShim,
        __callTool,
        JSON,
        Math,
        Date,
        Array,
        Object,
        String,
        Number,
        Boolean,
        RegExp,
        Map,
        Set,
        Promise,
        Error,
        TypeError,
        RangeError,
        SyntaxError,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
    };
    sandboxGlobals.globalThis = sandboxGlobals;

    const context = vm.createContext(sandboxGlobals);

    try {
        if (stubsCode && typeof stubsCode === 'string') {
            vm.runInContext(stubsCode, context, { filename: 'tool-stubs.js' });
        }

        const normalizedCode = normalizeUserCode(code);
        const wrappedCode = `(async () => {\n${normalizedCode}\n})()`;
        const script = new vm.Script(wrappedCode, { filename: 'user-script.js' });
        const resultPromise = script.runInContext(context, { timeout: timeoutMS });
        const result = await resultPromise;
        await waitForPendingCalls();

        parentPort.postMessage({
            type: 'script_done',
            result,
            logs: logs.join('\n'),
        });
    } catch (err) {
        parentPort.postMessage({
            type: 'script_error',
            error: {
                message: err.message,
                name: err.name,
                stack: err.stack,
            },
            logs: logs.join('\n'),
        });
    }
}

main().catch((fatal) => {
    parentPort.postMessage({
        type: 'script_error',
        error: {
            message: fatal.message,
            name: fatal.name,
            stack: fatal.stack,
        },
        logs: '',
    });
});
