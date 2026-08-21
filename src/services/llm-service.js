import { getAllowedProviders, validateProviderName } from '../providers/registry.js';
import { defaultOpenaiModel, defaultGeminiModel, getDefaultRetrySpec } from '../config.js';
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

    async chat(input, {
        model = this.provider === 'openai' ? defaultOpenaiModel : defaultGeminiModel,
        retry = getDefaultRetrySpec(),
        signal,
        ...options
    } = {}) {
        const retrySpec = { ...getDefaultRetrySpec(), ...(typeof retry === 'object' ? retry : {}) };
        if (options.maxRetries !== undefined) retrySpec.maxRetries = options.maxRetries;
        if (options.initialDelay !== undefined) retrySpec.baseDelayMS = options.initialDelay;

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