import dns from 'node:dns';
import net from 'node:net';
import { createMiddleware, applyMiddlewares } from '@modelcontextprotocol/client';
import {
    getStdioEnvAllowlist,
    getAllowedUrlSchemes,
    getBlockedIPRanges,
} from '../config.js';

const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * Normalizes a hook return value into `{ allow: boolean, reason?: string }`.
 * Returning `undefined`, `null`, or `true` means allow.
 * Returning `false` or `{ allow: false, reason }` means deny.
 */
export function normalizeDecision(decision, defaultReason = 'Denied by security policy.') {
    if (decision === undefined || decision === null || decision === true) {
        return { allow: true };
    }
    if (decision === false) {
        return { allow: false, reason: defaultReason };
    }
    if (typeof decision === 'object') {
        if (decision.allow === false) {
            return {
                allow: false,
                reason: decision.reason || defaultReason,
            };
        }
        return {
            allow: true,
            ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
        };
    }
    return {
        allow: Boolean(decision),
        ...(!decision ? { reason: defaultReason } : {}),
    };
}

/**
 * Composes multiple security policy objects into one policy.
 * - `approveServer`, `approveToolCall`, `allowUrl`: run in order; first explicit deny wins; `undefined` means allow.
 * - `inspectResult`: chains in order so each policy transforms the value handed to the next.
 * - `filterTools`: chains in order so each policy filters the tool catalog before ranking.
 * - `elicit`: only defined on the composed policy when at least one constituent policy supplies an `elicit` handler.
 */
export function composePolicy(...policies) {
    const active = policies.flat(Infinity).filter(Boolean);

    async function approveServer(descriptor) {
        for (const policy of active) {
            if (typeof policy.approveServer !== 'function') continue;
            const raw = await policy.approveServer(descriptor);
            if (raw === undefined) continue;
            const decision = normalizeDecision(
                raw,
                `Server '${descriptor?.id || 'unknown'}' was rejected by security policy.`
            );
            if (!decision.allow) {
                return decision;
            }
        }
        return { allow: true };
    }

    async function approveToolCall(call) {
        for (const policy of active) {
            if (typeof policy.approveToolCall !== 'function') continue;
            const raw = await policy.approveToolCall(call);
            if (raw === undefined) continue;
            const decision = normalizeDecision(
                raw,
                `Tool call '${call?.name || 'unknown'}' was denied by security policy.`
            );
            if (!decision.allow) {
                return decision;
            }
        }
        return { allow: true };
    }

    async function inspectResult(result, call) {
        let current = result;
        for (const policy of active) {
            if (typeof policy.inspectResult !== 'function') continue;
            const next = await policy.inspectResult(current, call);
            if (next === undefined) continue;
            if (
                next &&
                typeof next === 'object' &&
                next.allow === false &&
                !('error' in next)
            ) {
                current = {
                    error: next.reason || `Tool result from '${call?.name || 'unknown'}' was rejected by security policy.`,
                };
            } else {
                current = next;
            }
        }
        return current;
    }

    async function allowUrl(url, purpose) {
        for (const policy of active) {
            if (typeof policy.allowUrl !== 'function') continue;
            const raw = await policy.allowUrl(url, purpose);
            if (raw === undefined) continue;
            const decision = normalizeDecision(
                raw,
                `Outbound URL '${String(url)}' (${purpose || 'unknown'}) was denied by security policy.`
            );
            if (!decision.allow) {
                return decision;
            }
        }
        return { allow: true };
    }

    async function filterTools(catalog, context) {
        let current = Array.isArray(catalog) ? [...catalog] : [];
        for (const policy of active) {
            if (typeof policy.filterTools !== 'function') continue;
            const next = await policy.filterTools(current, context);
            if (Array.isArray(next)) {
                current = next;
            }
        }
        return current;
    }

    const elicitHandlers = active
        .map(p => (typeof p.elicit === 'function' ? p.elicit.bind(p) : (typeof p.onElicitation === 'function' ? p.onElicitation.bind(p) : null)))
        .filter(Boolean);

    const composed = {
        approveServer,
        approveToolCall,
        inspectResult,
        allowUrl,
        filterTools,
    };

    if (elicitHandlers.length > 0) {
        composed.elicit = async function elicit(request, context) {
            let accepted = null;
            for (const handler of elicitHandlers) {
                const response = await handler(request, context);
                if (response === undefined) continue;
                if (response === false || (response && typeof response === 'object' && response.allow === false)) {
                    return { action: 'decline' };
                }
                if (response && typeof response === 'object' && typeof response.action === 'string') {
                    if (response.action === 'decline' || response.action === 'cancel') {
                        return response;
                    }
                    if (response.action === 'accept') {
                        accepted = response;
                    }
                }
            }
            return accepted || { action: 'decline' };
        };
    }

    return Object.freeze(composed);
}

/**
 * Builds the environment object for a spawned stdio MCP server.
 * Includes only variables named in `getStdioEnvAllowlist(platform)` plus any
 * variables the caller explicitly supplies in `callerEnv`.
 */
export function buildStdioEnv(callerEnv, hostEnv = process.env, platform = process.platform) {
    const allowlist = getStdioEnvAllowlist(platform);
    const env = {};

    if (hostEnv && typeof hostEnv === 'object') {
        for (const key of allowlist) {
            if (hostEnv[key] !== undefined) {
                env[key] = String(hostEnv[key]);
            }
        }
    }

    if (callerEnv && typeof callerEnv === 'object') {
        for (const [key, value] of Object.entries(callerEnv)) {
            if (value !== undefined) {
                env[key] = String(value);
            }
        }
    }

    return env;
}

const SHELL_METACHAR_PATTERN = /[;&|`$<>()\n\r]/;
const PRIVILEGE_BIN_PATTERN = /(?:^|[\\/])(sudo|doas|su)(?:\.exe)?$/i;
const SHELL_BIN_PATTERN = /(?:^|[\\/])(sh|bash|zsh|dash|ksh|cmd|powershell|pwsh)(?:\.exe)?$/i;
const RM_BIN_PATTERN = /(?:^|[\\/])rm(?:\.exe)?$/i;
const DESTRUCTIVE_RM_ARG_PATTERN = /(?:^|\s)rm\s+-[a-zA-Z]*[rf][a-zA-Z]*\b/i;

/**
 * Inspects a stdio command and argument list for patterns that merit a warning
 * on the server descriptor (`sudo`, `rm -rf`, shell metacharacters in `command`,
 * or shell `-c` execution). Returns a warning string or `undefined`.
 */
export function detectCommandWarnings(command, args = []) {
    if (typeof command !== 'string' || command.length === 0) {
        return undefined;
    }

    const warnings = [];
    const safeArgs = Array.isArray(args) ? args.map(a => String(a)) : [];
    const trimmedCommand = command.trim();

    if (PRIVILEGE_BIN_PATTERN.test(trimmedCommand) || safeArgs.some(a => a === 'sudo' || a === 'doas')) {
        warnings.push('Command invokes privilege escalation (sudo/doas/su)');
    }

    if (SHELL_METACHAR_PATTERN.test(command)) {
        warnings.push('Command contains shell metacharacters');
    }

    const isRmBinary = RM_BIN_PATTERN.test(trimmedCommand) || safeArgs.some(a => RM_BIN_PATTERN.test(a));
    const hasRecursiveForceFlags = safeArgs.some(a => /^-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*$/i.test(a) || /^-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*$/i.test(a)) ||
        (safeArgs.some(a => /^-[a-zA-Z]*r/i.test(a) || a === '--recursive') && safeArgs.some(a => /^-[a-zA-Z]*f/i.test(a) || a === '--force'));

    if (
        (isRmBinary && hasRecursiveForceFlags) ||
        DESTRUCTIVE_RM_ARG_PATTERN.test(command) ||
        safeArgs.some(a => DESTRUCTIVE_RM_ARG_PATTERN.test(a))
    ) {
        warnings.push('Command contains destructive removal pattern (rm -rf)');
    }

    if (SHELL_BIN_PATTERN.test(trimmedCommand) && safeArgs.some(a => a === '-c' || a === '/c' || a === '-Command')) {
        warnings.push('Command spawns a subshell with inline script execution');
    }

    return warnings.length > 0 ? warnings.join('; ') : undefined;
}

/**
 * Constructs the normalized server descriptor passed to `policy.approveServer(descriptor)`
 * and emitted on `mcp:server_launch`.
 */
export function buildServerDescriptor(id, serverConfig = {}, kind = 'mcp') {
    const transport = serverConfig.type || (serverConfig.command ? 'stdio' : 'http');
    const command = serverConfig.command !== undefined ? String(serverConfig.command) : undefined;
    const args = Array.isArray(serverConfig.args) ? serverConfig.args.map(a => String(a)) : (transport === 'stdio' ? [] : undefined);
    const url = serverConfig.url !== undefined ? String(serverConfig.url) : undefined;
    const warning = transport === 'stdio' ? detectCommandWarnings(command, args) : undefined;

    return Object.freeze({
        id: id || 'default',
        kind,
        transport,
        command,
        args,
        url,
        warning,
    });
}

/**
 * Builds a `node:net.BlockList` populated with private, loopback, link-local,
 * CGNAT, multicast, and reserved IPv4/IPv6 ranges from `getBlockedIPRanges()`.
 */
export function createIpBlockList(ranges = getBlockedIPRanges()) {
    const blockList = new net.BlockList();
    for (const entry of ranges) {
        if (!entry || !entry.network) continue;
        const family = entry.family || (net.isIP(entry.network) === 6 ? 'ipv6' : 'ipv4');
        if (typeof entry.prefix === 'number') {
            blockList.addSubnet(entry.network, entry.prefix, family);
        } else if (entry.end) {
            blockList.addRange(entry.network, entry.end, family);
        } else {
            blockList.addAddress(entry.network, family);
        }
    }
    return blockList;
}

/**
 * Extracts the raw hostname as written in the URL string before WHATWG URL normalization
 * converts octal (`0177.0.0.1`), hex (`0x7f000001`), or integer (`2130706433`) IPv4 forms
 * into `127.0.0.1`.
 */
function extractRawHostFromUrlString(rawUrl) {
    if (typeof rawUrl !== 'string') return null;
    const match = rawUrl.trim().match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^/@?#]*@)?(\[[^\]]+\]|[^/:?#]+)/);
    return match ? match[1].toLowerCase() : null;
}

/**
 * Normalizes DNS lookup results into an array of `{ address: string, family: 'ipv4' | 'ipv6' }`.
 */
function normalizeLookupRecords(records) {
    const list = Array.isArray(records) ? records : (records ? [records] : []);
    const normalized = [];

    for (const item of list) {
        if (!item) continue;
        const rawAddress = typeof item === 'string' ? item : item.address;
        if (typeof rawAddress !== 'string' || rawAddress.length === 0) continue;
        const cleanAddress = rawAddress.split('%')[0];
        const ipVersion = net.isIP(cleanAddress);
        if (ipVersion === 4) {
            normalized.push({ address: cleanAddress, family: 'ipv4' });
        } else if (ipVersion === 6) {
            normalized.push({ address: cleanAddress, family: 'ipv6' });
        }
    }

    return normalized;
}

function isLoopbackIpAddress(address) {
    const clean = String(address).split('%')[0].toLowerCase();
    if (clean === '::1' || clean === '0:0:0:0:0:0:0:1') return true;
    if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(clean)) return true;
    return false;
}

/**
 * Validates an outbound URL against the default scheme, loopback, and `node:net.BlockList` rules.
 * Returns `{ allow: true }` or `{ allow: false, reason: string }`.
 */
export async function validateUrl(url, purpose = 'outbound', options = {}) {
    const rawUrlString = url instanceof URL ? url.href : String(url ?? '');
    let parsed;
    try {
        parsed = url instanceof URL ? new URL(url.href) : new URL(rawUrlString);
    } catch {
        return {
            allow: false,
            reason: `Invalid URL '${rawUrlString}' for ${purpose}.`,
        };
    }

    const allowedSchemes = options.allowedSchemes || getAllowedUrlSchemes();
    if (!allowedSchemes.includes(parsed.protocol)) {
        return {
            allow: false,
            reason: `Disallowed URL scheme '${parsed.protocol}' for ${purpose} (${parsed.href}).`,
        };
    }

    const rawHostInInput = url instanceof URL ? parsed.hostname.toLowerCase() : extractRawHostFromUrlString(rawUrlString);
    const parsedHost = parsed.hostname.toLowerCase();
    const unbracketedHost = parsedHost.startsWith('[') && parsedHost.endsWith(']')
        ? parsedHost.slice(1, -1)
        : parsedHost;

    // Only treat as literal loopback if the caller wrote 'localhost', '127.0.0.1', or '[::1]' directly
    // (not octal '0177.0.0.1', hex '0x7f000001', integer '2130706433', or IPv4-mapped '[::ffff:127.0.0.1]').
    const isCanonicalLoopbackHost =
        ( parsedHost === 'localhost' || parsedHost === '127.0.0.1' || parsedHost === '[::1]' || unbracketedHost === '::1' ) &&
        ( rawHostInInput === null || rawHostInInput === 'localhost' || rawHostInInput === '127.0.0.1' || rawHostInInput === '[::1]' );

    const allowLoopback = options.isRedirect ? false : (options.allowLoopback ?? true);

    if (parsed.protocol === 'http:') {
        if (!isCanonicalLoopbackHost || !allowLoopback) {
            return {
                allow: false,
                reason: `Insecure HTTP URL '${parsed.href}' is not allowed for ${purpose}; only HTTPS or loopback HTTP is permitted.`,
            };
        }
    }

    const blockList = options.blockList || createIpBlockList(options.blockedIPRanges);
    const literalIpVersion = net.isIP(unbracketedHost);

    if (literalIpVersion === 4 || literalIpVersion === 6) {
        const family = literalIpVersion === 6 ? 'ipv6' : 'ipv4';
        if (isCanonicalLoopbackHost && allowLoopback) {
            return { allow: true };
        }
        if (blockList.check(unbracketedHost, family)) {
            return {
                allow: false,
                reason: `URL '${parsed.href}' targets a blocked IP range (${unbracketedHost}) for ${purpose}.`,
            };
        }
        return { allow: true };
    }

    const lookupFn = options.lookup || ((hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true }));
    let resolvedRecords;
    try {
        const rawRecords = await lookupFn(unbracketedHost, { all: true, verbatim: true });
        resolvedRecords = normalizeLookupRecords(rawRecords);
    } catch (error) {
        return {
            allow: false,
            reason: `DNS lookup failed for host '${unbracketedHost}' (${purpose}): ${error?.message || String(error)}`,
        };
    }

    if (resolvedRecords.length === 0) {
        return {
            allow: false,
            reason: `DNS lookup returned no valid IP addresses for host '${unbracketedHost}' (${purpose}).`,
        };
    }

    for (const record of resolvedRecords) {
        if (isCanonicalLoopbackHost && allowLoopback && isLoopbackIpAddress(record.address)) {
            continue;
        }
        if (blockList.check(record.address, record.family)) {
            return {
                allow: false,
                reason: `Host '${unbracketedHost}' resolved to blocked IP address '${record.address}' for ${purpose}.`,
            };
        }
    }

    return { allow: true };
}

/**
 * Checks an outbound URL using both the built-in scheme/DNS/BlockList checks and any
 * configured `policy.allowUrl(url, purpose)` hook. Throws an Error if rejected.
 */
export async function checkUrl(url, purpose = 'outbound', options = {}) {
    const { policy, skipDefaultValidation = false, ...validationOptions } = options;

    if (!skipDefaultValidation) {
        const validation = await validateUrl(url, purpose, validationOptions);
        if (!validation.allow) {
            const error = new Error(validation.reason || `URL rejected: ${String(url)}`);
            error.code = 'ERR_URL_BLOCKED';
            throw error;
        }
    }

    if (policy && typeof policy.allowUrl === 'function') {
        const rawDecision = await policy.allowUrl(String(url), purpose);
        const decision = normalizeDecision(
            rawDecision,
            `Outbound URL '${String(url)}' (${purpose}) was denied by security policy.`
        );
        if (!decision.allow) {
            const error = new Error(decision.reason);
            error.code = 'ERR_POLICY_DENIED';
            throw error;
        }
    }

    return { allow: true };
}

function inferUrlPurpose(urlString, defaultPurpose = 'mcp:http') {
    try {
        const parsed = new URL(urlString);
        if (
            parsed.pathname.includes('/.well-known/oauth-') ||
            parsed.pathname.includes('/.well-known/openid-configuration')
        ) {
            return 'oauth:discovery';
        }
    } catch {
        // Ignore parse failure here; checkUrl will surface it.
    }
    return defaultPurpose;
}

/**
 * Creates a fetch middleware (using `@modelcontextprotocol/client`'s `createMiddleware`)
 * that validates every outbound request and redirect hop via `checkUrl`.
 *
 * Open limits documented in place per AGENTS.md:
 * 1. Time-of-check to time-of-use (DNS TOCTOU): `checkUrl` resolves DNS via `dns.promises.lookup`
 *    and validates every returned IP against `node:net.BlockList`, after which `fetch` resolves
 *    the hostname again when opening the socket. Closing that window in-process requires an
 *    `undici` Agent/Dispatcher with a pinned `connect.lookup` callback, and Node.js does not
 *    expose `undici` as a `node:` built-in module, so `agentlib` cannot close it without adding
 *    a dependency. Keep the `fetch` option pluggable so deployments can inject a pinned
 *    dispatcher, and use a dedicated egress proxy in production as recommended by the MCP
 *    Security Best Practices guide.
 * 2. Redirects: Node's built-in `fetch` follows HTTP 3xx redirects internally without re-running
 *    application hooks on intermediate hops. To validate every hop against scheme and `BlockList`
 *    rules, this middleware forces `redirect: 'manual'` and follows redirects in an explicit loop
 *    capped at `maxRedirects` (default 5), rejecting any hop that targets a disallowed scheme
 *    or blocked IP range (including loopback on redirect hops).
 */
export function createUrlCheckMiddleware(options = {}) {
    const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    const basePurpose = options.purpose || 'mcp:http';

    return createMiddleware(async (next, input, init) => {
        let currentInput = input;
        let currentUrl = input instanceof Request ? input.url : String(input);
        let currentInit = init ? { ...init } : {};

        if (input instanceof Request && !init) {
            currentInit = {
                method: input.method,
                headers: input.headers,
                signal: input.signal,
            };
        }

        let hops = 0;

        while (true) {
            const isRedirect = hops > 0;
            const purpose = isRedirect ? 'redirect' : inferUrlPurpose(currentUrl, basePurpose);

            await checkUrl(currentUrl, purpose, {
                ...options,
                isRedirect,
                allowLoopback: isRedirect ? false : (options.allowLoopback ?? true),
            });

            const requestInit = {
                ...currentInit,
                redirect: 'manual',
            };

            const target = hops === 0 ? currentInput : currentUrl;
            const response = await next(target, requestInit);

            if (!REDIRECT_STATUS_CODES.has(response?.status)) {
                return response;
            }

            const location = response.headers?.get?.('location');
            if (!location) {
                return response;
            }

            hops += 1;
            if (hops > maxRedirects) {
                const error = new Error(`Maximum redirects (${maxRedirects}) exceeded while fetching '${currentUrl}'.`);
                error.code = 'ERR_TOO_MANY_REDIRECTS';
                throw error;
            }

            const previousOrigin = new URL(currentUrl).origin;
            const resolvedNextUrl = new URL(location, currentUrl);
            currentUrl = resolvedNextUrl.href;
            currentInput = currentUrl;

            const headers = new Headers(currentInit?.headers || undefined);
            if (resolvedNextUrl.origin !== previousOrigin) {
                headers.delete('authorization');
                headers.delete('cookie');
                headers.delete('dpop');
            }

            const method = (currentInit?.method || 'GET').toUpperCase();
            if (
                response.status === 303 ||
                ((response.status === 301 || response.status === 302) && method === 'POST')
            ) {
                headers.delete('content-type');
                headers.delete('content-length');
                currentInit = {
                    ...currentInit,
                    method: 'GET',
                    body: undefined,
                    headers,
                };
            } else {
                currentInit = {
                    ...currentInit,
                    headers,
                };
            }
        }
    });
}

/**
 * Wraps a `fetch` implementation with the URL validation middleware pipeline
 * using `applyMiddlewares` from `@modelcontextprotocol/client`.
 */
export function createSafeFetch(baseFetch = globalThis.fetch, options = {}) {
    const middleware = createUrlCheckMiddleware(options);
    return applyMiddlewares(middleware)(baseFetch);
}

/**
 * Validates the `url`, `additionalInterfaces`, and `supportedInterfaces` entries inside an
 * A2A agent card before the client connects to any endpoint advertised by the card.
 */
export async function validateAgentCardUrls(agentCard, options = {}) {
    if (!agentCard || typeof agentCard !== 'object') {
        throw new Error('Invalid A2A agent card: expected an object.');
    }

    if (typeof agentCard.url === 'string' && agentCard.url.trim().length > 0) {
        await checkUrl(agentCard.url, 'a2a:card_url', options);
    }

    if (Array.isArray(agentCard.additionalInterfaces)) {
        for (const iface of agentCard.additionalInterfaces) {
            if (iface && typeof iface.url === 'string' && iface.url.trim().length > 0) {
                await checkUrl(iface.url, 'a2a:additional_interface', options);
            }
        }
    }

    if (Array.isArray(agentCard.supportedInterfaces)) {
        for (const iface of agentCard.supportedInterfaces) {
            if (iface && typeof iface.url === 'string' && iface.url.trim().length > 0) {
                await checkUrl(iface.url, 'a2a:supported_interface', options);
            }
        }
    }

    return agentCard;
}

/**
 * Factory returning a strict security policy aligned with the MCP Security Best Practices recommendations:
 * - `approveServer`: refuses stdio servers whose command/args carry a `warning` (`sudo`, `rm -rf`,
 *   shell metacharacters, or inline subshell execution) unless `allowWarnedServers: true`, and
 *   validates remote server URLs via `allowUrl`.
 * - `allowUrl`: enforces HTTPS (or HTTP only on literal loopback), rejects `file:`, `javascript:`,
 *   `data:`, and other schemes, and blocks private/reserved IP ranges via `node:net.BlockList` over
 *   `dns.promises.lookup`.
 * - `approveToolCall`: allows by default unless a custom `approveToolCall` or `denySandboxTools: true` is passed.
 * - `inspectResult`: passes results through (or delegates to `options.inspectResult`).
 * - `elicit`: only attached when `options.elicit` is provided so `elicitation` capability is only
 *   advertised when the host supplies a consent handler.
 */
export function strictPolicy(options = {}) {
    const allowWarnedServers = Boolean(options.allowWarnedServers);
    const denySandboxTools = Boolean(options.denySandboxTools);

    async function allowUrl(url, purpose) {
        return validateUrl(url, purpose, options);
    }

    async function approveServer(descriptor) {
        if (descriptor?.warning && !allowWarnedServers) {
            return {
                allow: false,
                reason: `Server '${descriptor.id || 'unknown'}' blocked by strictPolicy: ${descriptor.warning}`,
            };
        }
        if (descriptor?.url) {
            return allowUrl(descriptor.url, `${descriptor.kind || 'mcp'}:server`);
        }
        return { allow: true };
    }

    async function approveToolCall(call) {
        if (denySandboxTools && call?.origin === 'sandbox') {
            return {
                allow: false,
                reason: `Sandbox-originated tool call '${call.name}' denied by strictPolicy.`,
            };
        }
        if (typeof options.approveToolCall === 'function') {
            return options.approveToolCall(call);
        }
        return { allow: true };
    }

    async function inspectResult(result, call) {
        if (typeof options.inspectResult === 'function') {
            return options.inspectResult(result, call);
        }
        return result;
    }

    const policyObj = {
        approveServer,
        approveToolCall,
        inspectResult,
        allowUrl,
    };

    if (typeof options.filterTools === 'function') {
        policyObj.filterTools = options.filterTools;
    }

    if (typeof options.elicit === 'function') {
        policyObj.elicit = options.elicit;
    }

    return Object.freeze(policyObj);
}

/**
 * Determines whether a tool call should be flagged as sensitive and why.
 * Checks explicit `sensitive: true` on the tool definition, MCP tool `annotations`
 * (`destructiveHint: true` or `readOnlyHint: false`), sandbox execution origin
 * (`origin === 'sandbox'`), an optional `sensitiveTools` list/Set, and an optional
 * `isSensitive(call)` predicate.
 *
 * @param {object} call - Tool call descriptor `{ name, args, source, origin, annotations, sensitive }`.
 * @param {object} [options={}]
 * @param {Iterable<string>} [options.sensitiveTools] - Tool names always treated as sensitive.
 * @param {boolean} [options.treatSandboxAsSensitive=true] - Whether `origin === 'sandbox'` is sensitive.
 * @param {Function} [options.isSensitive] - Optional custom predicate `(call) => boolean`.
 * @returns {{ sensitive: boolean, reasons: Array<string>, warning: string | null }}
 */
export function isSensitiveToolCall(call = {}, options = {}) {
    const reasons = [];
    const treatSandboxAsSensitive = options.treatSandboxAsSensitive !== false;
    const sensitiveSet = options.sensitiveTools
        ? (options.sensitiveTools instanceof Set ? options.sensitiveTools : new Set(options.sensitiveTools))
        : null;

    if (call?.sensitive === true) {
        reasons.push(`Tool '${call.name}' is marked sensitive.`);
    }
    if (call?.annotations?.destructiveHint === true) {
        reasons.push(`Tool '${call.name}' has MCP annotation destructiveHint: true.`);
    }
    if (call?.annotations?.readOnlyHint === false) {
        reasons.push(`Tool '${call.name}' has MCP annotation readOnlyHint: false.`);
    }
    if (treatSandboxAsSensitive && call?.origin === 'sandbox') {
        reasons.push(`Tool '${call.name}' was invoked from a sandbox script (origin: 'sandbox').`);
    }
    if (sensitiveSet && call?.name && sensitiveSet.has(call.name)) {
        reasons.push(`Tool '${call.name}' is in the sensitiveTools list.`);
    }
    if (typeof options.isSensitive === 'function' && options.isSensitive(call)) {
        reasons.push(`Tool '${call.name}' matched custom isSensitive predicate.`);
    }

    return {
        sensitive: reasons.length > 0,
        reasons,
        warning: reasons.length > 0 ? reasons.join(' ') : null,
    };
}

/**
 * Creates a tool-call approval policy for the chosen security level:
 * - `'auto'` (or `'none'`): auto-accepts all tool calls.
 * - `'sensitive'` (default): auto-accepts non-sensitive calls and invokes `confirm(call)`
 *   only for sensitive tool calls (see `isSensitiveToolCall`).
 * - `'all'` (or `'always'`): invokes `confirm(call)` for every tool call.
 *
 * Can be used standalone or layered with `strictPolicy()` via `composePolicy(strictPolicy(), createApprovalPolicy(...))`.
 *
 * @param {object} [options={}]
 * @param {'auto'|'none'|'sensitive'|'all'|'always'} [options.level='sensitive'] - Approval level.
 * @param {Function} [options.confirm] - Async callback `(call) => boolean | { allow: boolean, reason?: string }`.
 * @param {Iterable<string>} [options.sensitiveTools] - Tool names to treat as sensitive.
 * @param {boolean} [options.treatSandboxAsSensitive=true] - Whether `origin === 'sandbox'` is sensitive.
 * @param {Function} [options.isSensitive] - Optional custom sensitivity predicate `(call) => boolean`.
 * @returns {object} Frozen policy object with `approveToolCall`.
 */
export function createApprovalPolicy(options = {}) {
    const rawLevel = String(options.level || options.mode || 'sensitive').toLowerCase().trim();
    const confirmFn = typeof options.confirm === 'function'
        ? options.confirm
        : (typeof options.onApprove === 'function' ? options.onApprove : null);

    if (!['auto', 'none', 'sensitive', 'all', 'always'].includes(rawLevel)) {
        throw new Error(`Invalid approval level '${rawLevel}'. Expected 'auto', 'sensitive', or 'all'.`);
    }

    async function approveToolCall(call) {
        if (rawLevel === 'auto' || rawLevel === 'none') {
            return { allow: true };
        }

        const assessment = isSensitiveToolCall(call, options);
        const enrichedCall = {
            ...call,
            sensitive: assessment.sensitive,
            reasons: assessment.reasons,
            warning: call?.warning || assessment.warning,
        };

        if (rawLevel === 'sensitive' && !assessment.sensitive) {
            return { allow: true };
        }

        if (!confirmFn) {
            const detail = assessment.warning ? ` (${assessment.warning})` : '';
            return {
                allow: false,
                reason: `Tool call '${call?.name || 'unknown'}' requires confirmation under '${rawLevel}' approval policy${detail}, but no confirm handler was provided.`,
            };
        }

        const result = await confirmFn(enrichedCall);
        return normalizeDecision(
            result,
            `Tool call '${call?.name || 'unknown'}' was denied by user confirmation.`
        );
    }

    return Object.freeze({ approveToolCall });
}
