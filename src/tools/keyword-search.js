/**
 * Tokenizes text into normalized lowercase word terms.
 * @param {string} text
 * @returns {Array<string>}
 */
function tokenize(text) {
    if (!text || typeof text !== 'string') return [];
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_]+/gu, ' ')
        .split(/\s+/)
        .filter(t => t.length > 1);
}

/**
 * Extracts searchable text terms from a tool declaration.
 * Includes name, description, and parameter property names and descriptions.
 *
 * @param {object} declaration - Tool declaration metadata.
 * @returns {{ nameTokens: Array<string>, descTokens: Array<string>, paramTokens: Array<string>, totalTokens: number }}
 */
function extractDeclarationTokens(declaration) {
    const nameTokens = tokenize(declaration.name || declaration.title || '');
    const descTokens = tokenize(declaration.description || '');

    const paramTokens = [];
    if (declaration.parameters && typeof declaration.parameters === 'object') {
        const props = declaration.parameters.properties;
        if (props && typeof props === 'object') {
            for (const [key, prop] of Object.entries(props)) {
                paramTokens.push(...tokenize(key));
                if (prop && typeof prop === 'object') {
                    if (prop.description) paramTokens.push(...tokenize(prop.description));
                    if (prop.title) paramTokens.push(...tokenize(prop.title));
                }
            }
        }
    }

    const totalTokens = (nameTokens.length * 3) + (descTokens.length * 1.5) + paramTokens.length;
    return { nameTokens, descTokens, paramTokens, totalTokens };
}

/**
 * BM25-style keyword ranking scorer for tool catalog search.
 *
 * @param {string} query - Natural language search query.
 * @param {Array<object>} entries - Array of catalog items (e.g. declarations or { source, declaration }).
 * @param {object} [options]
 * @param {number} [options.k1=1.2] - BM25 term frequency saturation parameter.
 * @param {number} [options.b=0.75] - BM25 document length normalization parameter.
 * @param {number} [options.limit=10] - Maximum number of scored results to return.
 * @returns {Promise<Array<{ entry: object, score: number }>>}
 */
export async function rankKeywords(query, entries, { k1 = 1.2, b = 0.75, limit = 10 } = {}) {
    if (!entries || !Array.isArray(entries) || entries.length === 0) {
        return [];
    }

    const queryTerms = tokenize(query);
    if (queryTerms.length === 0) {
        // Empty query returns top N entries with 0 score
        return entries.slice(0, limit).map(entry => ({ entry, score: 0 }));
    }

    const N = entries.length;
    const docs = entries.map(entry => {
        const decl = entry.declaration || entry;
        const tokens = extractDeclarationTokens(decl);
        return { entry, ...tokens };
    });

    const avgdl = docs.reduce((acc, d) => acc + d.totalTokens, 0) / N || 1;

    // Calculate document frequencies (DF) for each query term
    const docFreqs = new Map();
    for (const term of queryTerms) {
        let count = 0;
        for (const doc of docs) {
            const hasTerm = doc.nameTokens.includes(term) ||
                            doc.descTokens.includes(term) ||
                            doc.paramTokens.includes(term);
            if (hasTerm) count++;
        }
        docFreqs.set(term, count);
    }

    // Score each document
    const scored = [];
    const normalizedQuery = query.trim().toLowerCase();

    for (const doc of docs) {
        let score = 0;
        const docLen = doc.totalTokens;
        const decl = doc.entry.declaration || doc.entry;
        const toolName = (decl.name || '').toLowerCase();

        // Exact match boost
        if (toolName && (toolName === normalizedQuery || toolName.includes(normalizedQuery))) {
            score += 10.0;
        }

        for (const term of queryTerms) {
            const df = docFreqs.get(term) || 0;
            if (df === 0) continue;

            // Standard BM25 IDF: ln(1 + (N - df + 0.5) / (df + 0.5))
            const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));

            // Weighted Term Frequency: name (3x weight), description (1.5x weight), params (1x)
            let tf = 0;
            for (const t of doc.nameTokens) {
                if (t === term || t.startsWith(term)) tf += 3;
            }
            for (const t of doc.descTokens) {
                if (t === term || t.startsWith(term)) tf += 1.5;
            }
            for (const t of doc.paramTokens) {
                if (t === term || t.startsWith(term)) tf += 1;
            }

            if (tf > 0) {
                const termScore = idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * (docLen / avgdl)))));
                score += termScore;
            }
        }

        if (score > 0) {
            scored.push({ entry: doc.entry, score });
        }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
}
