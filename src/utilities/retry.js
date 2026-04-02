/**
 * Retry wrapper with exponential backoff, timeout, and max delay cap.
 *
 * @param {() => Promise<any>} thunk - A zero-argument async function to execute.
 * @param {Object} [options]
 * @param {number} [options.maxRetries=3] - Maximum number of retry attempts.
 * @param {number} [options.baseDelay=500] - Fixed base delay in ms added to every wait.
 * @param {number} [options.incrementalDelay=500] - Incremental delay in ms used in the exponential calculation.
 * @param {number} [options.maxDelay=30000] - Maximum delay cap in ms to prevent runaway waits.
 * @param {number} [options.timeout=60000] - Per-attempt timeout in ms. Set to 0 to disable.
 * @param {boolean} [options.jitter=true] - Add random jitter (±25%) to prevent thundering herd.
 * @param {(error: Error) => boolean} [options.shouldRetry] - Predicate to decide if an error is retryable.
 * @param {(attempt: number, error: Error, delay: number) => void} [options.onRetry] - Callback fired before each retry wait.
 * @returns {Promise<any>} The result of the thunk.
 */
export async function withRetries(thunk, {
    maxRetries = 3,
    baseDelay = 500,
    incrementalDelay = 500,
    maxDelay = 30000,
    timeout = 60000,
    jitter = true,
    shouldRetry = () => true,
    onRetry = null
} = {}) {
    let attempt = 0;

    while (true) {
        let timeoutId;

        try {
            let result;

            if (timeout > 0) {
                // Race the thunk against a timeout
                result = await Promise.race([
                    thunk(),
                    new Promise((_, reject) => {
                        timeoutId = setTimeout(
                            () => reject(new Error(`Operation timed out after ${timeout}ms`)),
                            timeout
                        );
                    })
                ]);
            } else {
                result = await thunk();
            }

            return result;
        } catch (error) {
            attempt++;

            // Check if we've exhausted retries or the error isn't retryable
            if (attempt > maxRetries || !shouldRetry(error)) {
                throw error;
            }

            // Calculate delay: base + incremental * 2^attempt, capped at maxDelay
            let delay = baseDelay + incrementalDelay * Math.pow(2, attempt);
            delay = Math.min(delay, maxDelay);

            // Add jitter (±25%) to spread out retry storms
            if (jitter) {
                const jitterRange = delay * 0.25;
                delay += Math.random() * jitterRange * 2 - jitterRange;
                delay = Math.max(0, Math.round(delay));
            }

            if (onRetry) {
                onRetry(attempt, error, delay);
            }

            await new Promise(resolve => setTimeout(resolve, delay));
        } finally {
            // Always clear timeout to avoid dangling timers
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
        }
    }
}
