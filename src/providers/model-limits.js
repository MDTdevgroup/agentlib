import { readFile, writeFile } from 'node:fs/promises';

// Built-in baseline model limits table
const DEFAULT_LIMITS = {
    openai: {
        'gpt-5': { inputTokenLimit: 256000, outputTokenLimit: 32768 },
        'gpt-5.4': { inputTokenLimit: 256000, outputTokenLimit: 32768 },
        'gpt-5-nano': { inputTokenLimit: 128000, outputTokenLimit: 16384 },
        'gpt-4.5': { inputTokenLimit: 128000, outputTokenLimit: 16384 },
        'gpt-4o': { inputTokenLimit: 128000, outputTokenLimit: 16384 },
        'gpt-4o-mini': { inputTokenLimit: 128000, outputTokenLimit: 16384 },
        'gpt-4-turbo': { inputTokenLimit: 128000, outputTokenLimit: 4096 },
        'gpt-4': { inputTokenLimit: 8192, outputTokenLimit: 8192 },
        'gpt-3.5-turbo': { inputTokenLimit: 16385, outputTokenLimit: 4096 },
        'o1': { inputTokenLimit: 200000, outputTokenLimit: 100000 },
        'o1-mini': { inputTokenLimit: 128000, outputTokenLimit: 65536 },
        'o1-preview': { inputTokenLimit: 128000, outputTokenLimit: 32768 },
        'o3-mini': { inputTokenLimit: 200000, outputTokenLimit: 100000 },
        default: { inputTokenLimit: 256000, outputTokenLimit: 16384 },
    },
    gemini: {
        'gemini-2.0-flash': { inputTokenLimit: 1048576, outputTokenLimit: 8192 },
        'gemini-2.0-flash-lite': { inputTokenLimit: 1048576, outputTokenLimit: 8192 },
        'gemini-2.0-pro-exp': { inputTokenLimit: 2097152, outputTokenLimit: 8192 },
        'gemini-1.5-pro': { inputTokenLimit: 2097152, outputTokenLimit: 8192 },
        'gemini-1.5-flash': { inputTokenLimit: 1048576, outputTokenLimit: 8192 },
        'gemini-1.5-flash-8b': { inputTokenLimit: 1048576, outputTokenLimit: 8192 },
        'gemini-3-pro-preview': { inputTokenLimit: 2097152, outputTokenLimit: 8192 },
        'gemini-1.0-pro': { inputTokenLimit: 32768, outputTokenLimit: 8192 },
        default: { inputTokenLimit: 1048576, outputTokenLimit: 8192 },
    },
    vllm: {
        default: { inputTokenLimit: 32768, outputTokenLimit: 4096 },
    },
};

// In-memory active table initialized from defaults
let activeLimits = JSON.parse(JSON.stringify(DEFAULT_LIMITS));

/**
 * Loads model limits from a JSON file into the active registry.
 *
 * @param {string} filePath - Path to JSON file.
 * @returns {Promise<object>} Active limits
 */
export async function loadModelLimitsFromFile(filePath) {
    if (!filePath) {
        return activeLimits;
    }
    try {
        const content = await readFile(filePath, 'utf-8');
        const parsed = JSON.parse(content);
        activeLimits = { ...DEFAULT_LIMITS, ...parsed };
        return activeLimits;
    } catch {
        return activeLimits;
    }
}

/**
 * Saves current active model limits to a JSON file.
 * Requires an explicit filePath to prevent mutating internal package files.
 *
 * @param {string} filePath - Path to JSON file.
 * @returns {Promise<void>}
 */
export async function saveModelLimitsToFile(filePath) {
    if (!filePath) {
        throw new Error('saveModelLimitsToFile requires an explicit target filePath to prevent mutating package contents.');
    }
    await writeFile(filePath, JSON.stringify(activeLimits, null, 2), 'utf-8');
}

/**
 * Registers or overrides limits for a specific provider and model.
 *
 * @param {string} provider
 * @param {string} model
 * @param {object} limits
 * @param {number} limits.inputTokenLimit
 * @param {number} [limits.outputTokenLimit]
 */
export function registerModelLimit(provider, model, limits) {
    if (!provider || !model || !limits) return;
    const p = provider.trim().toLowerCase();
    const m = model.trim().toLowerCase();

    if (!activeLimits[p]) {
        activeLimits[p] = {};
    }

    activeLimits[p][m] = {
        inputTokenLimit: Number(limits.inputTokenLimit) || 128000,
        outputTokenLimit: Number(limits.outputTokenLimit) || 4096,
    };
}

/**
 * Resolves the context specifications for a given provider and model.
 * Uses exact match followed by longest prefix / keyword matching.
 *
 * @param {string} provider
 * @param {string} [model]
 * @returns {{ inputTokenLimit: number, outputTokenLimit: number }}
 */
export function getModelLimits(provider, model) {
    const p = (provider || 'openai').trim().toLowerCase();
    const m = (model || 'default').trim().toLowerCase();

    const providerLimits = activeLimits[p] || DEFAULT_LIMITS[p] || {};

    // 1. Exact match
    if (providerLimits[m]) {
        return { ...providerLimits[m] };
    }

    // 2. Longest prefix / key match
    const keys = Object.keys(providerLimits).filter((k) => k !== 'default');
    // Sort keys by length descending to match most specific pattern first (e.g. 'gpt-4o-mini' before 'gpt-4o')
    keys.sort((a, b) => b.length - a.length);

    for (const key of keys) {
        if (m.startsWith(key) || m.includes(key)) {
            return { ...providerLimits[key] };
        }
    }

    // 3. Provider default
    if (providerLimits.default) {
        return { ...providerLimits.default };
    }

    // 4. Global default
    return { inputTokenLimit: 128000, outputTokenLimit: 4096 };
}

/**
 * Resolves the maximum input context token limit for a provider and model.
 *
 * @param {string} provider
 * @param {string} [model]
 * @returns {number} Maximum input token limit
 */
export function getModelContextLimit(provider, model) {
    return getModelLimits(provider, model).inputTokenLimit;
}
