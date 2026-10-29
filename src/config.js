export function getDefaultProvider() {
    return 'openai';
}

export function getDefaultOpenaiModel() {
    return 'gpt-5';
}

export function getDefaultGeminiModel() {
    return 'gemini-3.1-pro-preview';
}

export function getDefaultModel(provider = getDefaultProvider()) {
    if (!provider) return 'default';
    const normalized = String(provider).trim().toLowerCase();
    if (normalized === 'gemini' || normalized === 'gemini-interactions' || normalized.startsWith('gemini')) return getDefaultGeminiModel();
    if (normalized === 'openai' || normalized === 'vllm') return getDefaultOpenaiModel();
    return 'default';
}

export function getDefaultMaxContextTokens() {
    return 64000;
}

export function getDefaultTruncateToTokens() {
    return 48000;
}

export function getDefaultMaxToolCalls() {
    return 15;
}

export function getDefaultMaxTurns() {
    return 5;
}

export function getDefaultToolConcurrency() {
    return 5;
}

export function getDefaultToolExposure() {
    return 'all';
}

export function getDefaultToolExposureThreshold() {
    return 0.05;
}

export function getDefaultToolExposureMode() {
    return 'expand';
}

export function getDefaultMaxSandboxLogBytes() {
    return 16384;
}

export function getDefaultSandboxTimeoutMS() {
    return 30000;
}

export function getDefaultSandboxMemoryMB() {
    return 128;
}

export function getMCPToolNameSeparator() {
    return '_';
}

export function getDefaultMCPCallTimeoutMS() {
    return 60000;
}

export function getDefaultMCPListMaxPages() {
    return 64;
}

export function getMCPClientIdentity() {
    return Object.freeze({
        name: '@peebles-group/agentlib-js',
        version: '4.1.0',
    });
}

export function getStdioEnvAllowlist(platform = process.platform) {
    const base = ['PATH', 'HOME', 'TMPDIR', 'SHELL'];
    if (platform === 'win32') {
        return [...base, 'SystemRoot', 'APPDATA', 'LOCALAPPDATA', 'TEMP'];
    }
    return base;
}

export function getAllowedUrlSchemes() {
    return ['https:', 'http:'];
}

export function getBlockedIPRanges() {
    return [
        { network: '0.0.0.0', prefix: 8, family: 'ipv4' },
        { network: '10.0.0.0', prefix: 8, family: 'ipv4' },
        { network: '100.64.0.0', prefix: 10, family: 'ipv4' },
        { network: '127.0.0.0', prefix: 8, family: 'ipv4' },
        { network: '169.254.0.0', prefix: 16, family: 'ipv4' },
        { network: '172.16.0.0', prefix: 12, family: 'ipv4' },
        { network: '192.0.0.0', prefix: 24, family: 'ipv4' },
        { network: '192.0.2.0', prefix: 24, family: 'ipv4' },
        { network: '192.168.0.0', prefix: 16, family: 'ipv4' },
        { network: '198.18.0.0', prefix: 15, family: 'ipv4' },
        { network: '198.51.100.0', prefix: 24, family: 'ipv4' },
        { network: '203.0.113.0', prefix: 24, family: 'ipv4' },
        { network: '224.0.0.0', prefix: 4, family: 'ipv4' },
        { network: '240.0.0.0', prefix: 4, family: 'ipv4' },
        { network: '::', prefix: 128, family: 'ipv6' },
        { network: '::1', prefix: 128, family: 'ipv6' },
        { network: '100::', prefix: 64, family: 'ipv6' },
        { network: '2001:db8::', prefix: 32, family: 'ipv6' },
        { network: 'fc00::', prefix: 7, family: 'ipv6' },
        { network: 'fe80::', prefix: 10, family: 'ipv6' },
        { network: 'ff00::', prefix: 8, family: 'ipv6' },
    ];
}

export function getDefaultMaxToolResultTokens() {
    return 8192;
}

export function getMaxToolDescriptionChars() {
    return 1024;
}

export function capDescription(description, maxChars = getMaxToolDescriptionChars()) {
    if (typeof description !== 'string') return description;
    return maxChars > 0 && description.length > maxChars ? description.slice(0, maxChars) : description;
}

export function getDefaultRetrySpec() {
    return {
        maxRetries: 3,
        timeoutMS: 300000,
        baseDelayMS: 1000,
        exprDelayMS: 500,
        maxDelayMS: 60000,
    };
}