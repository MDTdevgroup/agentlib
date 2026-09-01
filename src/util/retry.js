/**
 * Retry with backoff, jitter, Retry-After support, and AbortController request cancellation.
 */

import { sleep } from './async.js';
import { makeException } from './exception.js';

/**
 * Calculates exponential backoff delay with additive randomized jitter.
 *
 * @param {number} attempt - Current attempt index (0-based).
 * @param {object} retry - Retry specification.
 * @param {number} [retry.baseDelayMS=1000] - Base delay.
 * @param {number} [retry.exprDelayMS=500] - Exponential scaling factor.
 * @param {number} [retry.maxDelayMS=60000] - Maximum ceiling delay.
 * @param {number} [retry.jitterMaxMS=1000] - Maximum randomized jitter.
 * @returns {number} Delay in milliseconds.
 */
export function backoffDelay(attempt, retry = {}) {
    const base = retry.baseDelayMS ?? 1000;
    const factor = retry.exprDelayMS ?? 500;
    const max = retry.maxDelayMS ?? 60000;
    const jitterMax = retry.jitterMaxMS ?? 1000;

    const exponentialDelay = (Math.pow(2, attempt) * factor) + base;
    const jitter = Math.floor(Math.random() * jitterMax);
    return Math.min(exponentialDelay + jitter, max);
}

/**
 * Default predicate identifying fatal HTTP / API status codes that will never succeed on retry.
 * 400 (Bad Request), 401 (Unauthorized), 403 (Forbidden), 404 (Not Found).
 *
 * @param {any} err - Error object.
 * @returns {boolean} True if the error is a hard failure.
 */
export function defaultHardFailPredicate(err) {
    if (!err) return false;
    const status = err.status || err.statusCode || err.response?.status;
    return status === 400 || status === 401 || status === 403 || status === 404;
}

/**
 * Executes a thunk with retries, request cancellation via AbortController, and error classification.
 *
 * @param {object} retrySpec - Retry configuration.
 * @param {Function} thunk - Procedure to execute ({ signal, attempt }) => Promise<any>.
 * @param {Function} [isRetryableClassifier] - Optional classifier returning { retryable, retryAfterMs }.
 * @param {object} [options={}] - Additional execution options (e.g. { signal, onEvent }).
 * @returns {Promise<any>} Result of the thunk.
 */
export async function withRetries(retrySpec = {}, thunk, isRetryableClassifier = undefined, options = {}) {
    const retry = {
        maxRetries: 3,
        timeoutMS: 300000,
        baseDelayMS: 1000,
        exprDelayMS: 500,
        maxDelayMS: 60000,
        ...retrySpec,
    };

    let attempts = 0;

    while (attempts <= retry.maxRetries) {
        const controller = new AbortController();
        let timeoutId = undefined;

        if (retry.timeoutMS && retry.timeoutMS > 0) {
            timeoutId = setTimeout(() => {
                controller.abort(makeException('Timeout', `Call timed out after ${retry.timeoutMS}ms`));
            }, retry.timeoutMS);
        }

        const onParentAbort = () => {
            if (options.signal) {
                controller.abort(options.signal.reason);
            }
        };

        if (options.signal) {
            if (options.signal.aborted) {
                controller.abort(options.signal.reason);
                if (typeof options.signal.throwIfAborted === 'function') {
                    options.signal.throwIfAborted();
                }
                throw options.signal.reason || makeException('AbortError', 'Operation aborted by caller');
            } else {
                options.signal.addEventListener('abort', onParentAbort, { once: true });
            }
        }

        try {
            return await thunk({ signal: controller.signal, attempt: attempts });
        } catch (e) {
            if (options.signal?.aborted) {
                throw e;
            }

            const isTimeout = e.name === 'AbortError' || e.type === 'Timeout' || controller.signal.aborted;

            let retryInfo;
            if (isTimeout) {
                retryInfo = { retryable: true, retryAfterMs: undefined };
            } else if (typeof isRetryableClassifier === 'function') {
                retryInfo = isRetryableClassifier(e) || { retryable: false };
            } else {
                const hardFail = defaultHardFailPredicate(e);
                retryInfo = { retryable: !hardFail };
            }

            // Fatal non-retryable error: fail instantly without delay
            if (!retryInfo.retryable) {
                throw e;
            }

            const nextDelay = retryInfo.retryAfterMs ?? backoffDelay(attempts, retry);

            // Last failure: wait before throwing so caller doesn't immediately slam service
            if (attempts >= retry.maxRetries) {
                if (nextDelay > 0) {
                    await sleep(nextDelay);
                }
                throw makeException('RetryExhausted', `Exhausted all ${retry.maxRetries} retries`, { cause: e });
            }

            attempts += 1;

            if (options.onEvent) {
                options.onEvent({
                    type: 'retry',
                    attempt: attempts,
                    maxRetries: retry.maxRetries,
                    delayMs: nextDelay,
                    error: e,
                });
            }

            if (nextDelay > 0) {
                await sleep(nextDelay);
            }
        } finally {
            if (timeoutId !== undefined) {
                clearTimeout(timeoutId);
            }
            if (options.signal) {
                options.signal.removeEventListener('abort', onParentAbort);
            }
        }
    }

    throw makeException('RetryExhausted', 'Retry loop terminated unexpectedly without result');
}
