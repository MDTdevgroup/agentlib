import { getAllowedProviders, validateProviderName, getDefaultModel } from '../providers/registry.js';
import { getDefaultRetrySpec } from '../config.js';
import { withRetries } from '../util/retry.js';

export class LLMService {
    constructor(auth = {}, { eventEmitter = null } = {}) {
        this.auth = auth;
        this.events = eventEmitter;
        this.provider = validateProviderName(auth.provider);
        this.providerNamespace = getAllowedProviders()[this.provider]?.namespace;
        this.client = this._getProviderClient();
    }

    // Instead of using a dynamic import here, we use the imported registry namespace
    _getProviderClient() {
        // Returns the client instance for the specified provider
        return this.providerNamespace.createClient(this.auth);
    }

    setEventEmitter(eventEmitter) {
        this.events = eventEmitter;
    }

    fromProvider(rawResponse) {
        if (typeof this.providerNamespace?.fromProvider === 'function') {
            return this.providerNamespace.fromProvider(rawResponse);
        }
        return Array.isArray(rawResponse?.output) ? rawResponse.output : [];
    }

    async chat(input, {
        model = getDefaultModel(this.provider),
        retry = getDefaultRetrySpec(),
        signal,
        maxRetries,
        initialDelay,
        ...options
    } = {}) {
        const retrySpec = { ...getDefaultRetrySpec(), ...(typeof retry === 'object' ? retry : {}) };
        if (maxRetries !== undefined) retrySpec.maxRetries = maxRetries;
        if (initialDelay !== undefined) retrySpec.baseDelayMS = initialDelay;

        const isRetryable = typeof this.providerNamespace?.isRetryable === 'function'
            ? (err) => this.providerNamespace.isRetryable(err)
            : undefined;

        return withRetries(
            retrySpec,
            ({ signal: attemptSignal }) => {
                return this.providerNamespace.chat(this.client, input, {
                    model,
                    signal: attemptSignal,
                    ...options,
                });
            },
            isRetryable,
            {
                signal,
                onEvent: (event) => {
                    if (this.events) {
                        this.events.emit('llm:retry', event);
                    }
                },
            }
        );
    }
}