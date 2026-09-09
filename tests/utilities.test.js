import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import EventEmitter from 'node:events';
import { sleep, createTimeout, asyncForceAll, asyncSettleAll } from '../src/util/async.js';
import { backoffDelay, withRetries } from '../src/util/retry.js';
import { makeException, isException, withExceptionHandler } from '../src/util/exception.js';
import { LLMService } from '../src/services/llm-service.js';
import { registerProvider } from '../src/providers/registry.js';
import * as FakeProvider from './helpers/fake-provider.js';

describe('Concurrency, Retry & Exception Utilities', () => {
    describe('Async Orchestration (async.js)', () => {
        test('sleep resolves immediately when ms is falsy or 0', async () => {
            const start = Date.now();
            await sleep(0);
            await sleep(-10);
            await sleep(null);
            assert.ok(Date.now() - start < 50);
        });

        test('sleep rejects immediately if passed an already-aborted signal or aborts mid-sleep', async () => {
            const preAborted = new AbortController();
            preAborted.abort(new Error('Already aborted'));
            await assert.rejects(
                () => sleep(5000, preAborted.signal),
                /Already aborted/
            );

            const midAborted = new AbortController();
            setTimeout(() => midAborted.abort(new Error('Cancelled mid-sleep')), 10);
            const start = Date.now();
            await assert.rejects(
                () => sleep(5000, midAborted.signal),
                /Cancelled mid-sleep/
            );
            assert.ok(Date.now() - start < 100);
        });

        test('createTimeout rejects after duration and cancels cleanly', async () => {
            const timeoutPromise = createTimeout(20);
            await assert.rejects(timeoutPromise, (err) => {
                assert.ok(isException(err));
                assert.equal(err.type, 'Timeout');
                return true;
            });

            // Test cancel thunk
            const cancelablePromise = createTimeout(500);
            cancelablePromise.cancel();
            // Should not keep event loop busy or cause unhandled rejection
        });

        test('asyncForceAll never exceeds concurrency limit', async () => {
            let active = 0;
            let maxActive = 0;

            const thunks = Array.from({ length: 10 }, (_, i) => async () => {
                active++;
                maxActive = Math.max(maxActive, active);
                await sleep(15);
                active--;
                return i;
            });

            const results = await asyncForceAll(thunks, 3, 0);

            assert.equal(maxActive, 3, 'Peak concurrent executions should equal limit of 3');
            assert.equal(results.length, 10);
        });

        test('asyncForceAll returns results in submission order, not completion order', async () => {
            // Task 0 finishes in 30ms, Task 1 in 5ms, Task 2 in 10ms
            const thunks = [
                async () => { await sleep(30); return 'first'; },
                async () => { await sleep(5); return 'second'; },
                async () => { await sleep(10); return 'third'; },
            ];

            const results = await asyncForceAll(thunks, 5, 0);
            assert.deepEqual(results, ['first', 'second', 'third']);
        });

        test('asyncSettleAll returns successes alongside failures without breaking loop', async () => {
            const thunks = [
                async () => { await sleep(5); return 'success-1'; },
                async () => { await sleep(5); throw new Error('fail-2'); },
                async () => { await sleep(5); return 'success-3'; },
            ];

            const results = await asyncSettleAll(thunks, 2, 0);
            assert.equal(results.length, 3);
            assert.equal(results[0].status, 'fulfilled');
            assert.equal(results[0].value, 'success-1');
            assert.equal(results[1].status, 'rejected');
            assert.equal(results[1].reason.message, 'fail-2');
            assert.equal(results[2].status, 'fulfilled');
            assert.equal(results[2].value, 'success-3');
        });

        test('asyncForceAll schedules all tasks and rejects cleanly with error if a thunk fails', async () => {
            const executed = [];
            const thunks = [
                async () => {
                    await sleep(10);
                    executed.push('task-1');
                    throw new Error('fail-task-1');
                },
                async () => {
                    await sleep(10);
                    executed.push('task-2');
                    return 'success-2';
                },
                async () => {
                    await sleep(10);
                    executed.push('task-3');
                    return 'success-3';
                },
            ];

            await assert.rejects(
                async () => {
                    await asyncForceAll(thunks, 2, 0);
                },
                (err) => {
                    assert.equal(err.message, 'fail-task-1');
                    return true;
                }
            );
            
            await sleep(30);
            assert.equal(executed.length, 3);
            assert.ok(executed.includes('task-1'));
            assert.ok(executed.includes('task-2'));
            assert.ok(executed.includes('task-3'));
        });
    });

    describe('Retry Logic (retry.js)', () => {
        test('backoffDelay grows exponentially and never exceeds maxDelayMS', () => {
            const retry = { baseDelayMS: 100, exprDelayMS: 50, maxDelayMS: 500, jitterMaxMS: 0 };
            const d0 = backoffDelay(0, retry); // 2^0 * 50 + 100 = 150
            const d1 = backoffDelay(1, retry); // 2^1 * 50 + 100 = 200
            const d2 = backoffDelay(2, retry); // 2^2 * 50 + 100 = 300
            const d5 = backoffDelay(5, retry); // 2^5 * 50 + 100 = 1700 -> capped at 500

            assert.equal(d0, 150);
            assert.equal(d1, 200);
            assert.equal(d2, 300);
            assert.equal(d5, 500);
        });

        test('withRetries returns immediately on first success', async () => {
            let calls = 0;
            const result = await withRetries(
                { maxRetries: 3, timeoutMS: 1000 },
                async () => {
                    calls++;
                    return 'ok';
                }
            );

            assert.equal(result, 'ok');
            assert.equal(calls, 1);
        });

        test('withRetries retries a 500 and then succeeds', async () => {
            let attempts = 0;
            const retryEvents = [];

            const result = await withRetries(
                { maxRetries: 3, timeoutMS: 1000, baseDelayMS: 5, exprDelayMS: 5, jitterMaxMS: 0 },
                async () => {
                    attempts++;
                    if (attempts < 3) {
                        const err = new Error('Internal Server Error');
                        err.status = 500;
                        throw err;
                    }
                    return 'recovered';
                },
                (err) => ({ retryable: err.status === 500 }),
                { onEvent: (e) => retryEvents.push(e) }
            );

            assert.equal(result, 'recovered');
            assert.equal(attempts, 3);
            assert.equal(retryEvents.length, 2);
            assert.equal(retryEvents[0].attempt, 1);
            assert.equal(retryEvents[1].attempt, 2);
        });

        test('withRetries does not retry a 401 (instant hard fail)', async () => {
            let attempts = 0;
            const start = Date.now();

            await assert.rejects(
                async () => {
                    await withRetries(
                        { maxRetries: 3, timeoutMS: 1000, baseDelayMS: 500, exprDelayMS: 500 },
                        async () => {
                            attempts++;
                            const err = new Error('Unauthorized');
                            err.status = 401;
                            throw err;
                        },
                        (err) => ({ retryable: err.status !== 401 })
                    );
                },
                (err) => {
                    assert.equal(err.status, 401);
                    return true;
                }
            );

            assert.equal(attempts, 1, 'Must fail immediately on attempt 1 without retrying');
            assert.ok(Date.now() - start < 100, 'Must not wait or backoff on hard failure');
        });

        test('withRetries honours retryAfterMs in preference to computed backoff', async () => {
            let attempts = 0;
            const retryEvents = [];

            await withRetries(
                { maxRetries: 1, timeoutMS: 1000, baseDelayMS: 500, exprDelayMS: 500, jitterMaxMS: 0 },
                async () => {
                    attempts++;
                    if (attempts === 1) {
                        const err = new Error('Rate Limited');
                        err.status = 429;
                        throw err;
                    }
                    return 'done';
                },
                (_err) => ({ retryable: true, retryAfterMs: 15 }),
                { onEvent: (e) => retryEvents.push(e) }
            );

            assert.equal(attempts, 2);
            assert.equal(retryEvents[0].delayMs, 15, 'Should use retryAfterMs of 15ms instead of computed delay');
        });

        test('withRetries aborts a hanging call at timeoutMS via signal', async () => {
            let signalAborted = false;

            await assert.rejects(
                async () => {
                    await withRetries(
                        { maxRetries: 0, timeoutMS: 20, baseDelayMS: 0, exprDelayMS: 0, jitterMaxMS: 0 },
                        async ({ signal }) => {
                            return new Promise((_, reject) => {
                                signal.addEventListener('abort', () => {
                                    signalAborted = true;
                                    reject(makeException('Timeout', 'Aborted by timeout'));
                                });
                            });
                        }
                    );
                },
                (err) => {
                    assert.ok(isException(err));
                    return true;
                }
            );

            assert.equal(signalAborted, true, 'AbortSignal must be triggered when timeout expires');
        });

        test('withRetries aborts immediately on caller-initiated cancellation without retrying', async () => {
            const callerController = new AbortController();
            let attempts = 0;

            await assert.rejects(
                async () => {
                    await withRetries(
                        { maxRetries: 3, timeoutMS: 2000, baseDelayMS: 500, exprDelayMS: 500 },
                        async ({ signal }) => {
                            attempts++;
                            setTimeout(() => {
                                callerController.abort(new Error('Caller cancelled'));
                            }, 5);
                            return new Promise((_, reject) => {
                                if (signal.aborted) {
                                    reject(signal.reason);
                                    return;
                                }
                                signal.addEventListener('abort', () => {
                                    reject(signal.reason);
                                });
                            });
                        },
                        undefined,
                        { signal: callerController.signal }
                    );
                },
                (err) => {
                    assert.match(err.message, /Caller cancelled/);
                    return true;
                }
            );

            assert.equal(attempts, 1, 'Caller cancellation must abort immediately without retry attempts');
        });

        test('withRetries aborts immediately if passed an already-aborted signal', async () => {
            const callerController = new AbortController();
            callerController.abort(new Error('Pre-aborted'));
            let attempts = 0;

            await assert.rejects(
                async () => {
                    await withRetries(
                        { maxRetries: 3, timeoutMS: 1000 },
                        async () => {
                            attempts++;
                            return 'ok';
                        },
                        undefined,
                        { signal: callerController.signal }
                    );
                },
                (err) => {
                    assert.match(err.message, /Pre-aborted/);
                    return true;
                }
            );

            assert.equal(attempts, 0, 'Must not execute any attempt if signal was already aborted');
        });

        test('withRetries does not arm timers or keep event loop open when passed an already-aborted signal with default timeoutMS', async () => {
            const callerController = new AbortController();
            callerController.abort(new Error('Pre-aborted'));
            let attempts = 0;

            const startActiveTimeouts = (process.getActiveResourcesInfo ? process.getActiveResourcesInfo().filter(r => r === 'Timeout').length : 0);

            await assert.rejects(
                async () => {
                    await withRetries(
                        { maxRetries: 3, timeoutMS: 300000 },
                        async () => {
                            attempts++;
                            return 'ok';
                        },
                        undefined,
                        { signal: callerController.signal }
                    );
                },
                (err) => {
                    assert.match(err.message, /Pre-aborted/);
                    return true;
                }
            );

            assert.equal(attempts, 0, 'Must not execute any attempt if signal was already aborted');
            if (process.getActiveResourcesInfo) {
                const endActiveTimeouts = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
                assert.equal(endActiveTimeouts, startActiveTimeouts, 'Must not leak armed timers into event loop');
            }
        });

        test('withRetries throws RetryExhausted immediately on final attempt without terminal backoff sleep', async () => {
            let attempts = 0;
            const start = Date.now();

            await assert.rejects(
                async () => {
                    await withRetries(
                        { maxRetries: 0, baseDelayMS: 5000, exprDelayMS: 5000 },
                        async () => {
                            attempts++;
                            throw new Error('transient-failure');
                        },
                        () => ({ retryable: true, retryAfterMs: 10000 })
                    );
                },
                (err) => {
                    assert.equal(err.type, 'RetryExhausted');
                    assert.equal(err.payload?.retryAfterMs, 10000);
                    return true;
                }
            );

            const elapsed = Date.now() - start;
            assert.equal(attempts, 1);
            assert.ok(elapsed < 100, `Must fail instantly without terminal 10s sleep, took ${elapsed}ms`);
        });

        test('withRetries cancels immediately if caller aborts during inter-attempt backoff sleep', async () => {
            const controller = new AbortController();
            let attempts = 0;
            const start = Date.now();

            await assert.rejects(
                async () => {
                    await withRetries(
                        { maxRetries: 3, baseDelayMS: 5000, exprDelayMS: 0, jitterMaxMS: 0 },
                        async () => {
                            attempts++;
                            setTimeout(() => {
                                controller.abort(new Error('Aborted mid-sleep'));
                            }, 20);
                            throw new Error('transient');
                        },
                        () => ({ retryable: true }),
                        { signal: controller.signal }
                    );
                },
                (err) => {
                    assert.match(err.message, /Aborted mid-sleep/);
                    return true;
                }
            );

            const elapsed = Date.now() - start;
            assert.equal(attempts, 1);
            assert.ok(elapsed < 200, `Must cancel sleep immediately on abort, took ${elapsed}ms`);
        });
    });

    describe('Exception Handling (exception.js)', () => {
        test('Exception carries type, payload, and cause', () => {
            const cause = new Error('root cause');
            const ex = makeException('ToolNotFound', { toolName: 'sql_query' }, { cause });

            assert.ok(ex instanceof Error);
            assert.ok(isException(ex));
            assert.equal(ex.type, 'ToolNotFound');
            assert.deepEqual(ex.payload, { toolName: 'sql_query' });
            assert.equal(ex.cause, cause);
        });

        test('withExceptionHandler handles Exception and rethrows TypeError', async () => {
            let handledType = null;

            // 1. Exception gets handled
            const result = await withExceptionHandler(
                async () => {
                    throw makeException('ToolFailed', { reason: 'bad input' });
                },
                (e) => {
                    handledType = e.type;
                    return 'fallback_value';
                }
            );

            assert.equal(result, 'fallback_value');
            assert.equal(handledType, 'ToolFailed');

            // 2. TypeError is NOT swallowed and rethrows
            await assert.rejects(
                async () => {
                    await withExceptionHandler(
                        async () => {
                            throw new TypeError('Cannot read property of undefined');
                        },
                        () => 'should_not_reach_here'
                    );
                },
                TypeError
            );
        });
    });

    describe('LLMService & Provider Integration', () => {
        test('LLMService uses withRetries and emits llm:retry events', async () => {
            const fakeProvider = FakeProvider.createFakeProvider();
            let callCount = 0;

            fakeProvider.setHandler(async () => {
                callCount++;
                if (callCount === 1) {
                    const err = new Error('Temporary 503');
                    err.status = 503;
                    throw err;
                }
                return FakeProvider.fakeTextResponse('Recovered from 503');
            });

            registerProvider('fake-retry', fakeProvider, 'Fake Retry Provider');

            const eventEmitter = new EventEmitter();
            const retryEvents = [];
            eventEmitter.on('llm:retry', (e) => retryEvents.push(e));

            const llm = new LLMService({ provider: 'fake-retry' }, { eventEmitter });

            const res = await llm.chat([{ role: 'user', content: 'test' }], {
                retry: { maxRetries: 2, baseDelayMS: 5, exprDelayMS: 5, jitterMaxMS: 0 }
            });

            assert.equal(res.output, 'Recovered from 503');
            assert.equal(callCount, 2);
            assert.equal(retryEvents.length, 1);
            assert.equal(retryEvents[0].attempt, 1);
        });

        test('LLMService does not leak maxRetries, initialDelay, or internal options into provider options', async () => {
            const fakeProvider = FakeProvider.createFakeProvider();
            let receivedOptions = null;

            fakeProvider.setHandler(async (_input, options) => {
                receivedOptions = options;
                return FakeProvider.fakeTextResponse('Options checked');
            });

            registerProvider('fake-clean-options', fakeProvider, 'Fake Clean Options');

            const llm = new LLMService({ provider: 'fake-clean-options' });
            await llm.chat([{ role: 'user', content: 'test' }], {
                maxRetries: 2,
                initialDelay: 10,
                temperature: 0.7,
            });

            assert.ok(receivedOptions);
            assert.equal(receivedOptions.maxRetries, undefined, 'maxRetries must not leak to provider');
            assert.equal(receivedOptions.initialDelay, undefined, 'initialDelay must not leak to provider');
            assert.equal(receivedOptions.temperature, 0.7, 'Allowed options pass through');
            assert.ok(receivedOptions.signal instanceof AbortSignal, 'Attempt signal must be passed');
        });

        test('LLMService setEventEmitter attaches event emitter cleanly', () => {
            const llm = new LLMService({ provider: 'fake-retry' });
            const emitter = new EventEmitter();
            llm.setEventEmitter(emitter);
            assert.equal(llm.events, emitter);
        });
    });
});
