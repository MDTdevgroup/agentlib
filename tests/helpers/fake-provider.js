/**
 * Fake Provider for unit testing without live network connections or API keys.
 * Implements the Provider contract: createClient(auth) and chat(client, input, options).
 */

export function fakeTextResponse(text = '') {
    return {
        output: text,
        rawResponse: {
            output: [
                {
                    type: 'message',
                    role: 'assistant',
                    content: text,
                },
            ],
            usage: { total_tokens: 10 },
        },
    };
}

export function fakeToolCallResponse(toolCalls) {
    const calls = Array.isArray(toolCalls) ? toolCalls : [toolCalls];
    return {
        output: '',
        rawResponse: {
            output: calls.map((tc, idx) => ({
                type: 'function_call',
                name: tc.name,
                call_id: tc.call_id || `call_${idx + 1}`,
                arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args || {}),
            })),
            usage: { total_tokens: 10 },
        },
    };
}

export function fakeError(error) {
    return typeof error === 'string' ? new Error(error) : error;
}

export function isRetryable(error) {
    if (!error) return { retryable: false };
    const status = error.status || error.statusCode;
    if (status === 400 || status === 401 || status === 403 || status === 404) {
        return { retryable: false };
    }
    if (status === 429 || (status >= 500 && status <= 599)) {
        return { retryable: true, retryAfterMs: error.retryAfterMs };
    }
    if (error.retryable !== undefined) {
        return { retryable: Boolean(error.retryable), retryAfterMs: error.retryAfterMs };
    }
    return { retryable: true };
}

class FakeClient {
    constructor(auth = {}) {
        this.auth = auth;
        this.responses = [];
        this.calls = [];
        this.handler = null;
    }

    enqueueResponse(response) {
        this.responses.push(response);
        return this;
    }

    setHandler(fn) {
        this.handler = fn;
        return this;
    }

    getCalls() {
        return this.calls;
    }

    reset() {
        this.responses = [];
        this.calls = [];
        this.handler = null;
    }
}

// Global scripted response queue for simple use cases
let globalResponses = [];
let globalCalls = [];
let globalHandler = null;

export function setGlobalResponses(responses) {
    globalResponses = [...responses];
}

export function setGlobalHandler(fn) {
    globalHandler = fn;
}

export function getGlobalCalls() {
    return globalCalls;
}

export function resetGlobalFakeProvider() {
    globalResponses = [];
    globalCalls = [];
    globalHandler = null;
}

export function createClient(auth = {}) {
    return new FakeClient(auth);
}

export async function chat(client, input, options = {}) {
    const callRecord = { input, options, timestamp: Date.now() };

    if (client && client.calls) {
        client.calls.push(callRecord);
    }
    globalCalls.push(callRecord);

    // 1. Client-specific handler
    if (client && typeof client.handler === 'function') {
        const res = await client.handler(input, options);
        if (res instanceof Error) throw res;
        return res;
    }

    // 2. Global handler
    if (typeof globalHandler === 'function') {
        const res = await globalHandler(input, options);
        if (res instanceof Error) throw res;
        return res;
    }

    // 3. Client-specific queue
    if (client && client.responses && client.responses.length > 0) {
        const res = client.responses.shift();
        if (res instanceof Error) throw res;
        if (typeof res === 'function') {
            const computed = await res(input, options);
            if (computed instanceof Error) throw computed;
            return computed;
        }
        return res;
    }

    // 4. Global queue
    if (globalResponses.length > 0) {
        const res = globalResponses.shift();
        if (res instanceof Error) throw res;
        if (typeof res === 'function') {
            const computed = await res(input, options);
            if (computed instanceof Error) throw computed;
            return computed;
        }
        return res;
    }

    // Default fallback if no responses are scripted
    return fakeTextResponse('Default fake response');
}

/**
 * Creates an isolated FakeProvider namespace instance for test isolation.
 */
export function createFakeProvider() {
    const instanceResponses = [];
    const instanceCalls = [];
    let instanceHandler = null;

    return {
        createClient(auth = {}) {
            return new FakeClient(auth);
        },
        async chat(client, input, options = {}) {
            const callRecord = { input, options, timestamp: Date.now() };
            if (client && client.calls) client.calls.push(callRecord);
            instanceCalls.push(callRecord);

            if (client && typeof client.handler === 'function') {
                const res = await client.handler(input, options);
                if (res instanceof Error) throw res;
                return res;
            }

            if (typeof instanceHandler === 'function') {
                const res = await instanceHandler(input, options);
                if (res instanceof Error) throw res;
                return res;
            }

            if (client && client.responses && client.responses.length > 0) {
                const res = client.responses.shift();
                if (res instanceof Error) throw res;
                return res;
            }

            if (instanceResponses.length > 0) {
                const res = instanceResponses.shift();
                if (res instanceof Error) throw res;
                return res;
            }

            return fakeTextResponse('Default fake response');
        },
        enqueueResponse(response) {
            instanceResponses.push(response);
        },
        setHandler(fn) {
            instanceHandler = fn;
        },
        getCalls() {
            return instanceCalls;
        },
        isRetryable(error) {
            return isRetryable(error);
        },
        reset() {
            instanceResponses.length = 0;
            instanceCalls.length = 0;
            instanceHandler = null;
        },
    };
}
