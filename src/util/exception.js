/**
 * Structured Exception hierarchy for AgentLib.
 * Built on native JavaScript Error, carrying structured error types and payloads.
 */
export class Exception extends Error {
    /**
     * @param {string} type - Machine-readable error type identifier (e.g. 'RetryExhausted', 'ToolNotFound')
     * @param {any} [payload] - Structured metadata or payload
     * @param {ErrorOptions} [options] - Native error options (e.g. { cause: error })
     */
    constructor(type, payload = null, options = undefined) {
        const message = typeof payload === 'string' ? `${type}: ${payload}` : `${type}`;
        super(message, options);
        this.name = 'Exception';
        this.type = type;
        this.payload = payload;
    }
}

export function makeException(type, payload = null, options = undefined) {
    return new Exception(type, payload, options);
}

export function signalException(type, payload = null, options = undefined) {
    throw makeException(type, payload, options);
}

export function isException(e) {
    return e instanceof Exception || (e !== null && typeof e === 'object' && e.name === 'Exception');
}

/**
 * Higher-order exception boundary: catches domain Exceptions and invokes handler.
 * Rethrows system errors and TypeErrors so internal bugs fail loudly.
 *
 * @param {Function|Promise} fnOrPromise - Async function or Promise to guard
 * @param {Function} handler - Callback invoked when an Exception is thrown
 * @returns {Promise<any>}
 */
export async function withExceptionHandler(fnOrPromise, handler) {
    try {
        if (typeof fnOrPromise === 'function') {
            return await fnOrPromise();
        }
        return await fnOrPromise;
    } catch (e) {
        if (isException(e)) {
            return await handler(e);
        }
        throw e;
    }
}
