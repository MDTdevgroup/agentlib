/**
 * Concurrency and asynchronous orchestration utilities for AgentLib.
 */

import { makeException } from './exception.js';

/**
 * Returns a Promise that resolves after `ms` milliseconds, or rejects if `signal` is aborted.
 * If ms is falsy or non-positive, returns immediately without a timer tick.
 *
 * @param {number} ms - Milliseconds to sleep.
 * @param {AbortSignal} [signal] - Optional abort signal to cancel the sleep immediately.
 * @returns {Promise<void>}
 */
export function sleep(ms, signal = undefined) {
    if (!ms || ms <= 0) return Promise.resolve();
    if (signal?.aborted) {
        return Promise.reject(signal.reason || makeException('AbortError', 'Sleep aborted by caller'));
    }
    return new Promise((resolve, reject) => {
        let timerId;
        const onAbort = () => {
            clearTimeout(timerId);
            reject(signal.reason || makeException('AbortError', 'Sleep aborted by caller'));
        };
        timerId = setTimeout(() => {
            if (signal) {
                signal.removeEventListener('abort', onAbort);
            }
            resolve();
        }, ms);
        if (signal) {
            signal.addEventListener('abort', onAbort, { once: true });
        }
    });
}

/**
 * Creates a Promise that rejects with a Timeout exception after `ms` milliseconds.
 * Includes a `.cancel()` thunk to clear the timer and prevent Node event-loop hangs.
 *
 * @param {number} ms - Timeout duration in milliseconds.
 * @returns {Promise<never> & { cancel: () => void }}
 */
export function createTimeout(ms) {
    let timerID;
    const receiver = (resolve, reject) => {
        timerID = setTimeout(() => {
            reject(makeException('Timeout', `Timed out after ${ms}ms`));
        }, ms);
    };
    const cancelThunk = () => {
        if (timerID) {
            clearTimeout(timerID);
            timerID = undefined;
        }
    };

    const timerPromise = new Promise(receiver);
    timerPromise.cancel = cancelThunk;
    return timerPromise;
}

/**
 * Runs an array of thunks with bounded concurrency.
 * Results are returned in original submission order.
 *
 * @param {Array<Function|{label?: string, thunk: Function}>} thunks - Array of thunk functions.
 * @param {number} [limit=Infinity] - Maximum number of concurrent executions.
 * @param {number} [step=0] - Delay between starting consecutive tasks.
 * @param {object} [options={}] - Configuration options.
 * @param {Function} [options.onEvent] - Optional event callback (e.g., for tracing).
 * @returns {Promise<Array<any>>}
 */
export async function asyncForceAll(thunks, limit = Infinity, step = 0, options = {}) {
    const results = [];
    const executing = new Set();
    const concurrencyLimit = limit && limit > 0 ? limit : Infinity;

    for (const item of thunks) {
        const thunk = typeof item === 'function' ? item : item.thunk;
        const label = typeof item === 'object' ? item.label : undefined;

        if (options.onEvent && label) {
            options.onEvent({ type: 'job:start', label });
        }

        // Defer start by one microtask and uniformize sync/async throws
        const promise = Promise.resolve().then(() => thunk());
        results.push(promise);

        // Guard the race tracker so a rejection does not break the scheduling loop or cause unhandled rejections
        const settlement = promise.then(
            () => { },
            () => { }
        );
        executing.add(settlement);

        settlement.finally(() => {
            executing.delete(settlement);
            if (options.onEvent && label) {
                options.onEvent({ type: 'job:end', label });
            }
        });

        if (executing.size >= concurrencyLimit) {
            await Promise.race(executing);
        }

        if (step && step > 0) {
            await sleep(step);
        }
    }

    return Promise.all(results);
}

/**
 * Runs an array of thunks with bounded concurrency and Promise.allSettled semantics.
 * One failing task does not discard successful results or abort scheduling remaining tasks.
 * Results are returned in original submission order as SettledResult objects.
 *
 * @param {Array<Function|{label?: string, thunk: Function}>} thunks - Array of thunk functions.
 * @param {number} [limit=Infinity] - Maximum number of concurrent executions.
 * @param {number} [step=0] - Delay between starting consecutive tasks.
 * @param {object} [options={}] - Configuration options.
 * @returns {Promise<Array<PromiseSettledResult<any>>>}
 */
export async function asyncSettleAll(thunks, limit = Infinity, step = 0, options = {}) {
    const results = [];
    const executing = new Set();
    const concurrencyLimit = limit && limit > 0 ? limit : Infinity;

    for (const item of thunks) {
        const thunk = typeof item === 'function' ? item : item.thunk;
        const label = typeof item === 'object' ? item.label : undefined;

        if (options.onEvent && label) {
            options.onEvent({ type: 'job:start', label });
        }

        const promise = Promise.resolve().then(() => thunk());
        results.push(promise);

        // Guard the race tracker so a rejection does not break the scheduling loop
        const settlement = promise.then(
            () => { },
            () => { }
        );
        executing.add(settlement);

        settlement.finally(() => {
            executing.delete(settlement);
            if (options.onEvent && label) {
                options.onEvent({ type: 'job:end', label });
            }
        });

        if (executing.size >= concurrencyLimit) {
            await Promise.race(executing);
        }

        if (step && step > 0) {
            await sleep(step);
        }
    }

    return Promise.allSettled(results);
}
