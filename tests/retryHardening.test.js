import { LLMService } from '../src/llmService.js';
import { isRetryable } from '../src/providers/gemini.js';
import { readFileSync } from 'fs';

// Load .env manually to avoid dotenv dependency
const envContent = readFileSync(new URL('../.env', import.meta.url), 'utf8');
for (const line of envContent.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
}

const GEMINI_KEY = process.env.GEMINI_API_KEY;
let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition, label) {
    if (condition) {
        console.log(`  PASS: ${label}`);
        passed++;
    } else {
        console.error(`  FAIL: ${label}`);
        failed++;
    }
}

function skip(label, reason) {
    console.log(`  SKIP: ${label} (${reason})`);
    skipped++;
}

// ---------------------------------------------------------------------------
// 1. isRetryable unit tests (pure, no API calls)
// ---------------------------------------------------------------------------
console.log('\n--- isRetryable unit tests ---');

assert(
    isRetryable({ status: 400 }).retryable === false,
    '400 (bad request) is NOT retryable'
);
assert(
    isRetryable({ status: 401 }).retryable === false,
    '401 (unauthorized) is NOT retryable'
);
assert(
    isRetryable({ status: 403 }).retryable === false,
    '403 (forbidden) is NOT retryable'
);
assert(
    isRetryable({ status: 404 }).retryable === false,
    '404 (not found) is NOT retryable'
);
assert(
    isRetryable({ status: 500 }).retryable === true,
    '500 (server error) IS retryable'
);
assert(
    isRetryable({ status: 429 }).retryable === true,
    '429 (rate limit) IS retryable'
);
assert(
    isRetryable({ status: 429 }).retryAfterMs === null,
    '429 without Retry-After header yields null retryAfterMs'
);
assert(
    isRetryable({ message: 'network fail' }).retryable === true,
    'Unknown error (no status) IS retryable'
);

// Simulate a 429 error with a Retry-After header (plain object style)
const error429 = { status: 429, headers: { 'retry-after': '5' } };
const info429 = isRetryable(error429);
assert(
    info429.retryable === true && info429.retryAfterMs === 5000,
    '429 with Retry-After: 5 yields retryAfterMs = 5000'
);

// Simulate a 429 error with headers.get() (Headers-like object)
const error429get = {
    status: 429,
    headers: { get(key) { return key === 'retry-after' ? '10' : null; } }
};
const info429get = isRetryable(error429get);
assert(
    info429get.retryable === true && info429get.retryAfterMs === 10000,
    '429 with headers.get("retry-after") = "10" yields retryAfterMs = 10000'
);

// ---------------------------------------------------------------------------
// 2. Happy path -- basic Gemini call succeeds through the retry loop
//    May fail with 429 if the free-tier quota is exhausted.
// ---------------------------------------------------------------------------
console.log('\n--- Happy path (live Gemini call) ---');

try {
    const llm = new LLMService('gemini', GEMINI_KEY);
    const response = await llm.chat(
        [{ role: 'user', content: 'Reply with exactly the word "pong" and nothing else.' }],
        { maxRetries: 0 }
    );
    assert(response.output !== null && response.output !== undefined, 'Response has output');
    assert(typeof response.output === 'string', 'Output is a string');
    assert(response.output.toLowerCase().includes('pong'), 'Output contains "pong"');
    assert(response.rawResponse !== undefined, 'Response has rawResponse');
} catch (e) {
    if (e.status === 429) {
        skip('Happy path', 'free-tier quota exhausted (429)');
    } else {
        console.error('  FAIL: Happy path threw unexpectedly:', e.message);
        failed++;
    }
}

// ---------------------------------------------------------------------------
// 3. Timeout test -- very short timeout triggers AbortError and retries
//    timeout=1ms so every attempt times out, maxRetries=1 so it gives up fast.
//    Verifies: (a) it throws, (b) error relates to abort, (c) retry was logged.
// ---------------------------------------------------------------------------
console.log('\n--- Timeout + retry (timeout=1ms, maxRetries=1) ---');

const origWarn = console.warn;
const origError = console.error;
const warnings = [];
console.warn = (...args) => warnings.push(args.join(' '));
console.error = () => {};

try {
    const llm = new LLMService('gemini', GEMINI_KEY);
    await llm.chat(
        [{ role: 'user', content: 'Hello' }],
        { timeout: 1, maxRetries: 1, initialDelay: 50, jitterMax: 0 }
    );
    console.warn = origWarn;
    console.error = origError;
    console.error('  FAIL: Should have thrown on timeout');
    failed++;
} catch (e) {
    console.warn = origWarn;
    console.error = origError;
    // The Gemini SDK wraps AbortError in its own Error type, so check the
    // message for "AbortError" rather than the error name directly.
    const isAbortRelated = e.name === 'AbortError' || e.message?.includes('AbortError');
    assert(isAbortRelated, `Thrown error relates to AbortError (name: ${e.name}, msg includes AbortError: ${e.message?.includes('AbortError')})`);
    const retryLogged = warnings.some(w => w.includes('[LLM] Retry'));
    assert(retryLogged, 'Retry warning was logged before giving up');
}

// ---------------------------------------------------------------------------
// 4. Hard fail -- bad API key should NOT retry (400 from Gemini)
//    maxRetries=2 but expect exactly 1 attempt (0 retries).
// ---------------------------------------------------------------------------
console.log('\n--- Hard fail (bad API key, should not retry) ---');

const origWarn2 = console.warn;
const origError2 = console.error;
const warnings2 = [];
console.warn = (...args) => warnings2.push(args.join(' '));
console.error = () => {};

const startTime = Date.now();
try {
    const badLlm = new LLMService('gemini', 'INVALID_KEY_12345');
    await badLlm.chat(
        [{ role: 'user', content: 'Hello' }],
        { maxRetries: 2, initialDelay: 5000 }
    );
    console.warn = origWarn2;
    console.error = origError2;
    console.error('  FAIL: Should have thrown with bad key');
    failed++;
} catch (e) {
    console.warn = origWarn2;
    console.error = origError2;
    const elapsed = Date.now() - startTime;
    const retryLogged = warnings2.some(w => w.includes('[LLM] Retry'));
    assert(!retryLogged, 'No retry warnings logged (hard fail exits immediately)');
    assert(elapsed < 4000, `Completed quickly (${elapsed}ms), did not waste time retrying`);
    assert(e.status === 400, `Error status is 400 (got: ${e.status})`);
}

// ---------------------------------------------------------------------------
// 5. Custom backoff parameters -- verify they are accepted and don't break
// ---------------------------------------------------------------------------
console.log('\n--- Custom parameters (backoffMultiplier, jitterMax, timeout) ---');

try {
    const llm = new LLMService('gemini', GEMINI_KEY);
    const response = await llm.chat(
        [{ role: 'user', content: 'Reply with exactly the word "ok".' }],
        { maxRetries: 0, initialDelay: 500, timeout: 60000, backoffMultiplier: 3, jitterMax: 200 }
    );
    assert(response.output !== null, 'Custom params: call succeeded');
} catch (e) {
    if (e.status === 429) {
        skip('Custom params', 'free-tier quota exhausted (429)');
    } else {
        console.error('  FAIL: Custom params call threw:', e.message);
        failed++;
    }
}

// ---------------------------------------------------------------------------
// 6. Retry-After respected -- verify the delay logic uses retryAfterMs when
//    the provider returns it. We mock the provider to control this.
// ---------------------------------------------------------------------------
console.log('\n--- retryAfterMs overrides backoff (mocked provider) ---');

{
    let callCount = 0;
    const mockNamespace = {
        createClient() { return {}; },
        isRetryable() { return { retryable: true, retryAfterMs: 100 }; },
        async chat() {
            callCount++;
            if (callCount <= 2) {
                const err = new Error('rate limited');
                err.status = 429;
                throw err;
            }
            return { output: 'ok', rawResponse: { output: [] } };
        }
    };

    const llm = new LLMService('gemini', GEMINI_KEY);
    // Replace internals with mock
    llm.providerNamespace = mockNamespace;
    llm.client = {};

    const start = Date.now();
    const origWarnM = console.warn;
    const origErrorM = console.error;
    console.warn = () => {};
    console.error = () => {};
    const result = await llm.chat(
        [{ role: 'user', content: 'test' }],
        { maxRetries: 3, initialDelay: 5000, jitterMax: 0 }
    );
    console.warn = origWarnM;
    console.error = origErrorM;
    const elapsed = Date.now() - start;

    assert(callCount === 3, `Provider called 3 times (got: ${callCount})`);
    assert(result.output === 'ok', 'Eventually returned success');
    // 2 retries * 100ms retryAfterMs ≈ 200ms. With initialDelay=5000 the
    // exponential backoff would have taken >5s, so elapsed < 1s proves
    // retryAfterMs overrode the backoff.
    assert(elapsed < 1000, `retryAfterMs used instead of backoff (elapsed: ${elapsed}ms < 1000ms)`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n=== Results: ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
process.exit(failed > 0 ? 1 : 0);
