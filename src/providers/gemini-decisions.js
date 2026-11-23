import { getDefaultGeminiDecisionModel } from '../config.js';

export const defaultDecisionModel = getDefaultGeminiDecisionModel();

const IMAGE_EXTENSION_MIME_TYPES = Object.freeze({
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
});

const OPENAI_DETAIL_TO_GEMINI_RESOLUTION = Object.freeze({
    low: 'low',
    high: 'high',
    original: 'ultra_high',
});

const NATIVE_GEMINI_BLOCK_TYPES = new Set(['image', 'audio', 'video', 'document']);
const MEDIA_PART_TYPES = new Set(['input_image', 'image_url', 'image', 'audio', 'video', 'document']);
const GEMINI_QUESTION_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function _hasControlChar(str) {
    for (let i = 0; i < str.length; i += 1) {
        const code = str.charCodeAt(i);
        if (code <= 0x1f || code === 0x7f) {
            return true;
        }
    }
    return false;
}

function _inferImageMimeType(urlStr) {
    const cleanPath = urlStr.split('?')[0].split('#')[0].toLowerCase();
    for (const [ext, mimeType] of Object.entries(IMAGE_EXTENSION_MIME_TYPES)) {
        if (cleanPath.endsWith(ext)) {
            return mimeType;
        }
    }
    return 'image/jpeg';
}

function _mapImageResolution(part) {
    if (part.resolution) {
        return part.resolution;
    }
    if (part.detail && Object.hasOwn(OPENAI_DETAIL_TO_GEMINI_RESOLUTION, part.detail)) {
        return OPENAI_DETAIL_TO_GEMINI_RESOLUTION[part.detail];
    }
    return undefined;
}

function _convertImagePart(part) {
    const rawUrl = part.type === 'image_url'
        ? (typeof part.image_url === 'string' ? part.image_url : part.image_url?.url)
        : part.image_url;

    if (!rawUrl || typeof rawUrl !== 'string') {
        throw new Error('Image content part requires a valid image_url string.');
    }

    const resolution = _mapImageResolution(part);

    if (rawUrl.startsWith('data:')) {
        const commaIndex = rawUrl.indexOf(',');
        const prefix = commaIndex >= 0 ? rawUrl.slice(0, commaIndex) : rawUrl;
        const data = commaIndex >= 0 ? rawUrl.slice(commaIndex + 1) : '';
        const mimeMatch = prefix.match(/:(.*?);/);
        const mimeType = part.mime_type || (mimeMatch ? mimeMatch[1] : 'image/jpeg');
        return {
            type: 'image',
            data,
            mime_type: mimeType,
            ...(resolution ? { resolution } : {}),
        };
    }

    return {
        type: 'image',
        uri: rawUrl,
        mime_type: part.mime_type || _inferImageMimeType(rawUrl),
        ...(resolution ? { resolution } : {}),
    };
}

function _pushTextBlock(blocks, text, separator = '\n') {
    const str = String(text ?? '');
    if (!str) return;
    const prev = blocks[blocks.length - 1];
    if (prev && prev.type === 'text') {
        const needsSep = !/\s$/.test(prev.text) && !/^\s/.test(str);
        blocks.push({ type: 'text', text: needsSep ? `${separator}${str}` : str });
        return;
    }
    blocks.push({ type: 'text', text: str });
}

function _convertContentPart(part, blocks) {
    if (!part || typeof part !== 'object') return;

    if (part.type === 'input_text' || part.type === 'text' || part.type === 'output_text') {
        _pushTextBlock(blocks, part.text ?? '');
    } else if (part.type === 'refusal') {
        _pushTextBlock(blocks, `[refusal]: ${part.refusal ?? ''}`);
    } else if (part.type === 'input_json') {
        _pushTextBlock(blocks, JSON.stringify(part.data));
    } else if (part.type === 'input_image' || part.type === 'image_url') {
        blocks.push(_convertImagePart(part));
    } else if (NATIVE_GEMINI_BLOCK_TYPES.has(part.type)) {
        blocks.push({ ...part });
    }
}

function _isDirectContentBlock(item) {
    if (!item || typeof item !== 'object' || item.role) return false;
    return (
        item.type === 'text'
        || item.type === 'input_text'
        || item.type === 'input_image'
        || item.type === 'image_url'
        || item.type === 'input_json'
        || NATIVE_GEMINI_BLOCK_TYPES.has(item.type)
    );
}

function _convertDecisionInput(input) {
    if (typeof input === 'string') {
        if (input.length === 0) {
            throw new Error('Decision input cannot be empty.');
        }
        return input;
    }

    if (input && typeof input === 'object' && !Array.isArray(input) && _isDirectContentBlock(input)) {
        const blocks = [];
        _convertContentPart(input, blocks);
        if (blocks.length === 0) {
            throw new Error('Decision input cannot be empty.');
        }
        return blocks;
    }

    if (!Array.isArray(input)) {
        throw new TypeError('Decision input must be a string or an array of input items.');
    }

    const items = input.filter(item => item && typeof item === 'object' && item.type !== 'reasoning');
    if (items.length === 0) {
        throw new Error('Decision input cannot be empty.');
    }

    // Direct content block array (e.g. Gemini-native document/audio/video/image/text blocks)
    if (items.every(_isDirectContentBlock)) {
        const blocks = [];
        for (const part of items) {
            _convertContentPart(part, blocks);
        }
        if (blocks.length === 0) {
            throw new Error('Decision input cannot be empty.');
        }
        return blocks;
    }

    // Single plain user message without speaker: unwrap directly without role prefix
    if (
        items.length === 1
        && (items[0].type === 'message' || items[0].role === 'user' || (!items[0].type && !items[0].role))
        && (!items[0].role || items[0].role === 'user')
        && !items[0].speaker
    ) {
        const only = items[0];
        const content = only.content !== undefined ? only.content : (only.text ?? '');
        if (typeof content === 'string') {
            if (content.length === 0) {
                throw new Error('Decision input cannot be empty.');
            }
            return content;
        }
        if (Array.isArray(content)) {
            const blocks = [];
            for (const part of content) {
                _convertContentPart(part, blocks);
            }
            if (blocks.length === 0) {
                throw new Error('Decision input cannot be empty.');
            }
            return blocks;
        }
    }

    // Multi-turn conversation / non-user roles / tool calls & outputs:
    // Gemini Decisions does not support conversation or tool-call blocks natively,
    // so serialize turns as labeled text blocks while preserving inline media parts.
    const blocks = [];
    for (const item of items) {
        if (item.type === 'function_call') {
            const callId = item.call_id || item.id || '';
            const argsStr = typeof item.arguments === 'string'
                ? item.arguments
                : JSON.stringify(item.arguments ?? {});
            const label = callId ? `[function_call ${item.name} (${callId})]: ` : `[function_call ${item.name}]: `;
            _pushTextBlock(blocks, `${label}${argsStr}`);
            continue;
        }

        if (item.type === 'function_call_output') {
            const callId = item.call_id || item.id || '';
            const label = callId ? `[function_call_output (${callId})]: ` : '[function_call_output]: ';
            if (Array.isArray(item.output)) {
                _pushTextBlock(blocks, label.trimEnd());
                for (const part of item.output) {
                    _convertContentPart(part, blocks);
                }
            } else {
                const outStr = typeof item.output === 'string'
                    ? item.output
                    : JSON.stringify(item.output ?? null);
                _pushTextBlock(blocks, `${label}${outStr}`);
            }
            continue;
        }

        if (item.type === 'custom_tool_call') {
            const callId = item.call_id || item.id || '';
            const inputStr = typeof item.input === 'string'
                ? item.input
                : JSON.stringify(item.input ?? '');
            const label = callId ? `[custom_tool_call ${item.name} (${callId})]: ` : `[custom_tool_call ${item.name}]: `;
            _pushTextBlock(blocks, `${label}${inputStr}`);
            continue;
        }

        if (item.type === 'custom_tool_call_output') {
            const callId = item.call_id || item.id || '';
            const label = callId ? `[custom_tool_call_output (${callId})]: ` : '[custom_tool_call_output]: ';
            if (Array.isArray(item.output)) {
                _pushTextBlock(blocks, label.trimEnd());
                for (const part of item.output) {
                    _convertContentPart(part, blocks);
                }
            } else {
                const outStr = typeof item.output === 'string'
                    ? item.output
                    : JSON.stringify(item.output ?? null);
                _pushTextBlock(blocks, `${label}${outStr}`);
            }
            continue;
        }

        const role = item.speaker || item.role || 'user';
        const content = item.content !== undefined ? item.content : (item.text ?? '');
        if (typeof content === 'string') {
            const prefix = `[${role}]: `;
            const line = content.startsWith(prefix) ? content : `${prefix}${content}`;
            _pushTextBlock(blocks, line);
        } else if (Array.isArray(content)) {
            _pushTextBlock(blocks, `[${role}]:`);
            for (const part of content) {
                _convertContentPart(part, blocks);
            }
        }
    }

    if (blocks.length === 0) {
        throw new Error('Decision input cannot be empty.');
    }

    return blocks;
}

function _convertQuestionInstructions(instructions, questionIndex) {
    if (typeof instructions === 'string') {
        return instructions;
    }
    if (!Array.isArray(instructions) || instructions.length === 0) {
        throw new TypeError(`Decision question at index ${questionIndex} requires instructions as a string or non-empty array of text parts.`);
    }

    const textBlocks = [];
    for (const part of instructions) {
        if (!part || typeof part !== 'object') continue;
        if (MEDIA_PART_TYPES.has(part.type)) {
            throw new Error(
                'Gemini Decisions API does not support images or other media in question instructions; place shared media in input instead.'
            );
        }
        if (part.type === 'input_text' || part.type === 'text') {
            _pushTextBlock(textBlocks, part.text ?? '');
        } else if (part.type === 'input_json') {
            _pushTextBlock(textBlocks, JSON.stringify(part.data));
        }
    }

    if (textBlocks.length === 0) {
        throw new TypeError(`Decision question at index ${questionIndex} requires non-empty text instructions.`);
    }

    return textBlocks.length === 1 ? textBlocks[0].text : textBlocks;
}

function _makeGeminiQuestionKey(name, index, usedKeys) {
    if (typeof name === 'string' && GEMINI_QUESTION_KEY_PATTERN.test(name) && !usedKeys.has(name)) {
        usedKeys.add(name);
        return name;
    }

    const sanitized = typeof name === 'string'
        ? name.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50)
        : '';
    const base = sanitized || `q_${index}`;
    let candidate = base;
    let suffix = index;
    while (usedKeys.has(candidate) || !GEMINI_QUESTION_KEY_PATTERN.test(candidate)) {
        const tail = `_${suffix}`;
        candidate = `${base.slice(0, 64 - tail.length)}${tail}`;
        suffix += 1;
    }
    usedKeys.add(candidate);
    return candidate;
}

function _convertDecisionQuestions(questions) {
    if (!Array.isArray(questions) || questions.length === 0) {
        throw new TypeError('Decision questions must be a non-empty array.');
    }

    const geminiQuestions = {};
    const questionSpecs = [];
    const usedKeys = new Set();

    for (let i = 0; i < questions.length; i += 1) {
        const question = questions[i];
        if (!question || typeof question !== 'object') {
            throw new TypeError(`Decision question at index ${i} must be an object.`);
        }

        const { type, name, instructions, choices, levels, criteria } = question;
        const originalName = name !== undefined ? name : null;
        const key = _makeGeminiQuestionKey(name, i, usedKeys);
        const convertedInstructions = _convertQuestionInstructions(instructions, i);

        if (type === 'predicate') {
            geminiQuestions[key] = {
                type: 'noul',
                instructions: convertedInstructions,
                ...(criteria ? { criteria } : {}),
            };
            questionSpecs.push({ key, originalName, type: 'predicate' });
        } else if (type === 'choice') {
            if (!Array.isArray(choices) || choices.length < 2) {
                throw new Error(`Choice question "${originalName ?? i}" requires at least 2 choices.`);
            }
            const choiceCriteria = {};
            const choiceList = [];
            const keyToValue = new Map();

            for (const option of choices) {
                if (!option || (typeof option.value !== 'string' && typeof option.value !== 'boolean')) {
                    throw new TypeError(`Choice option in question "${originalName ?? i}" must have a string or boolean value.`);
                }
                const optionKey = String(option.value);
                if (!optionKey || optionKey !== optionKey.trim() || _hasControlChar(optionKey)) {
                    throw new Error(
                        `Invalid choice option value "${optionKey}" for Gemini Decisions API: option keys must be non-empty without leading/trailing whitespace or control characters.`
                    );
                }
                if (keyToValue.has(optionKey)) {
                    throw new Error(
                        `Duplicate choice key "${optionKey}" in question "${originalName ?? i}". Gemini Decisions requires distinct string option keys.`
                    );
                }
                keyToValue.set(optionKey, option.value);
                choiceList.push({ key: optionKey, value: option.value });
                choiceCriteria[optionKey] = option.description ?? '';
            }

            geminiQuestions[key] = {
                type: 'choice',
                instructions: convertedInstructions,
                criteria: choiceCriteria,
            };
            questionSpecs.push({
                key,
                originalName,
                type: 'choice',
                choices: choiceList,
                keyToValue,
            });
        } else if (type === 'score') {
            if (!Array.isArray(levels) || levels.length < 2) {
                throw new Error(`Score question "${originalName ?? i}" requires at least 2 levels.`);
            }
            const scoreCriteria = [];
            const levelSpecs = [];

            for (let idx = 0; idx < levels.length; idx += 1) {
                const level = levels[idx];
                const label = level?.label ?? '';
                const description = level?.description ?? '';
                const criterion = label && description
                    ? `${label}: ${description}`
                    : (label || description);
                if (!criterion || !criterion.trim()) {
                    throw new Error(`Score level ${idx} in question "${originalName ?? i}" requires a non-empty label or description.`);
                }
                scoreCriteria.push(criterion);
                levelSpecs.push({ value: idx, label });
            }

            geminiQuestions[key] = {
                type: 'score',
                instructions: convertedInstructions,
                criteria: scoreCriteria,
            };
            questionSpecs.push({
                key,
                originalName,
                type: 'score',
                levels: levelSpecs,
            });
        } else {
            throw new Error(`Unsupported decision question type "${type}" at index ${i}. Expected "predicate", "choice", or "score".`);
        }
    }

    return { questions: geminiQuestions, questionSpecs };
}

function _convertDecisionUsage(geminiUsage) {
    if (!geminiUsage) return null;
    const inputTokens = geminiUsage.total_input_tokens ?? geminiUsage.input_tokens ?? 0;
    const outputTokens = geminiUsage.total_output_tokens ?? geminiUsage.output_tokens ?? 0;
    const totalTokens = geminiUsage.total_tokens ?? (inputTokens + outputTokens);
    return {
        input_tokens: inputTokens,
        input_tokens_details: {
            cached_tokens: geminiUsage.total_cached_tokens ?? 0,
            cache_write_tokens: 0,
        },
        output_tokens: outputTokens,
        output_tokens_details: {
            reasoning_tokens: geminiUsage.total_thought_tokens ?? 0,
        },
        total_tokens: totalTokens,
    };
}

function _convertSingleAnswer(geminiAnswer, spec) {
    const name = spec.originalName;
    if (!geminiAnswer || typeof geminiAnswer !== 'object') {
        return { type: 'refusal', name };
    }

    if (geminiAnswer.type === 'noul') {
        return {
            type: 'predicate',
            name,
            probability: geminiAnswer.noul,
        };
    }

    if (geminiAnswer.type === 'choice') {
        const probabilities = spec.choices
            ? spec.choices.map(({ key, value }) => ({
                value,
                probability: geminiAnswer.probabilities?.[key] ?? 0,
            }))
            : Object.entries(geminiAnswer.probabilities || {}).map(([value, probability]) => ({
                value,
                probability,
            }));

        const winningChoice = spec.keyToValue?.has(geminiAnswer.choice)
            ? spec.keyToValue.get(geminiAnswer.choice)
            : geminiAnswer.choice;

        return {
            type: 'choice',
            name,
            choice: winningChoice,
            probabilities,
            confidence: geminiAnswer.confidence,
        };
    }

    if (geminiAnswer.type === 'score') {
        const probabilities = spec.levels
            ? spec.levels.map(({ value, label }) => ({
                value,
                label,
                probability: geminiAnswer.probabilities?.[String(value)] ?? 0,
            }))
            : Object.entries(geminiAnswer.probabilities || {}).map(([indexKey, probability]) => ({
                value: Number(indexKey),
                label: geminiAnswer.legend?.[indexKey] ?? indexKey,
                probability,
            }));

        return {
            type: 'score',
            name,
            score: geminiAnswer.score,
            probabilities,
            confidence: geminiAnswer.confidence,
        };
    }

    return { type: 'refusal', name };
}

export function toDecisionProvider(input, questions) {
    const convertedInput = _convertDecisionInput(input);
    const { questions: convertedQuestions, questionSpecs } = _convertDecisionQuestions(questions);
    return {
        input: convertedInput,
        questions: convertedQuestions,
        questionSpecs,
    };
}

export function fromDecisionProvider(rawResponse, questionSpecs = null, model = defaultDecisionModel) {
    const rawAnswers = rawResponse?.answers || {};
    let answers;

    if (Array.isArray(questionSpecs)) {
        answers = questionSpecs.map(spec => _convertSingleAnswer(rawAnswers[spec.key], spec));
    } else {
        answers = Object.entries(rawAnswers).map(([key, ans]) =>
            _convertSingleAnswer(ans, { key, originalName: key })
        );
    }

    const usage = _convertDecisionUsage(rawResponse?.usage);

    return {
        answers,
        model,
        usage,
        rawResponse: {
            answers,
            model,
            usage,
            originalFormat: rawResponse ?? null,
        },
    };
}

export async function decide(
    client,
    input,
    questions,
    {
        model = defaultDecisionModel,
        inputSchema,
        signal,
        api_version = 'v1beta',
        prompt_cache_key: _promptCacheKey,
        prompt_cache_options: _promptCacheOptions,
        safety_identifier: _safetyIdentifier,
        ...options
    } = {}
) {
    if (!client?.decisions || typeof client.decisions.create !== 'function') {
        throw new Error('Gemini Decisions API requires @google/genai >= 3.2.0 with client.decisions.create support.');
    }

    if (inputSchema) {
        input = inputSchema.parse(input);
    }

    const converted = toDecisionProvider(input, questions);
    const payload = {
        model,
        input: converted.input,
        questions: converted.questions,
        api_version,
        ...options,
    };

    const requestOptions = signal ? { fetchOptions: { signal } } : undefined;
    const response = await client.decisions.create(payload, requestOptions);
    return fromDecisionProvider(response, converted.questionSpecs, model);
}
