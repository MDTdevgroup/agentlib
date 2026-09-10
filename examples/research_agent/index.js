import { Agent, LLMService, PromptLoader, ToolLoader } from '../../index.js';
import { z } from 'zod';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_MODEL = 'gemini-3.8-flash';
export const DEFAULT_PROVIDER = 'gemini-interactions';
export const MAX_ITERATIONS = 3;
export const MAX_ASPECTS = 5;

/**
 * Resolves final destination URL after redirects with an explicit timeout.
 *
 * @param {string} url - Target URL to resolve.
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] - Optional cancellation signal.
 * @param {number} [options.timeoutMs=5000] - Request timeout.
 * @returns {Promise<string>} Final resolved destination URL or original URL on error.
 */
export async function getDestination(url, { signal, timeoutMs = 5000 } = {}) {
    if (!url || typeof url !== 'string' || !url.startsWith('http')) {
        return url;
    }
    try {
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
        const response = await fetch(url, {
            method: 'GET',
            redirect: 'follow',
            signal: combinedSignal,
        });
        return response.url || url;
    } catch {
        return url;
    }
}

// ─── Schemas ──────────────────────────────────────────────

export const PlanOutputSchema = z.object({
    aspects_to_research: z.array(z.string()),
});

export const SynthesisOutputSchema = z.object({
    query_intent: z.array(z.string()).nullable(),
    rules: z.array(z.string()).nullable(),
    entities: z.array(z.string()).nullable(),
    assertions: z.array(z.string()).nullable(),
    clarification: z.string().nullable(),
    more_research_needed: z.boolean(),
});

export const CitationOutputSchema = z.object({
    query_intent: z.array(z.string()).nullable(),
    rules: z.array(z.string()).nullable(),
    entities: z.array(z.string()).nullable(),
    assertions: z.array(z.string()).nullable(),
    clarification: z.string().nullable(),
});

// ─── Tools ────────────────────────────────────────────────

/**
 * Built-in Google Search tool specification for Gemini Interactions API.
 */
export const geminiWebSearchTool = Object.freeze({
    type: 'google_search',
});

/**
 * Interactive terminal question tool for when the agent needs user clarification.
 */
export const askUserTool = Object.freeze({
    name: 'ask_user',
    description: 'Ask the user questions interactively when clarification or guidance is needed.',
    parameters: {
        type: 'object',
        properties: {
            questions: {
                type: 'array',
                items: { type: 'string' },
                description: 'The questions to present to the user.',
            },
        },
        required: ['questions'],
    },
    func: async ({ questions }) => {
        const rl = readline.createInterface({ input, output });
        try {
            const answer = await rl.question((questions || []).join('\n') + '\n');
            return { answer };
        } finally {
            rl.close();
        }
    },
});

// ─── Research Memory ──────────────────────────────────────

export class ResearchMemory {
    /**
     * @param {LLMService} llmService - LLM service instance for summary generation.
     * @param {object} [options]
     * @param {string} [options.model=DEFAULT_MODEL] - Model to use for summaries.
     */
    constructor(llmService, { model = DEFAULT_MODEL } = {}) {
        this.store = new Map(); // stepId -> { fullContent, insight }
        this.llmService = llmService;
        this.model = model;
    }

    /**
     * Store a research iteration's full raw content and concise insight.
     * @param {number} stepId
     * @param {string} fullContent
     * @param {string} insight
     */
    save(stepId, fullContent, insight) {
        this.store.set(stepId, { fullContent, insight });
    }

    /**
     * Get the concise insight for a given step.
     * @param {number} stepId
     * @returns {string|null}
     */
    getInsight(stepId) {
        return this.store.get(stepId)?.insight || null;
    }

    /**
     * Get the full raw content for a given step.
     * @param {number} stepId
     * @returns {string|null}
     */
    getFullContent(stepId) {
        return this.store.get(stepId)?.fullContent || null;
    }

    /**
     * Get a summary of past findings at the requested detail level.
     * Granularities:
     * - "short": ~50 words
     * - "medium": ~150 words
     * - "long": ~300 words
     * - "full": raw unmodified content
     *
     * @param {number} stepId - Iteration step (1-indexed).
     * @param {'short'|'medium'|'long'|'full'} detailLevel
     * @param {object} [options]
     * @param {AbortSignal} [options.signal]
     * @returns {Promise<string>}
     */
    async getSummary(stepId, detailLevel, { signal } = {}) {
        const content = this.getFullContent(stepId);
        if (!content) {
            return `No content found for iteration step ${stepId}.`;
        }

        if (detailLevel === 'full') {
            return content;
        }

        const lengthMap = {
            short: '50 words',
            medium: '150 words',
            long: '300 words',
        };
        const targetLength = lengthMap[detailLevel] || '150 words';

        try {
            const prompt = `Summarize the following research findings in approximately ${targetLength}. Preserve key data points, metrics, and sources.\n\n${content}`;
            const result = await this.llmService.chat(
                [{ role: 'user', content: prompt }],
                { model: this.model, signal }
            );
            return result.output || content;
        } catch (error) {
            // Fall back gracefully to full content if summary generation fails
            return content;
        }
    }
}

// ─── Helpers ──────────────────────────────────────────────

/**
 * Extract and parse JSON from a text response that may contain markdown code fences.
 *
 * @param {string|object} text
 * @returns {object} Parsed JSON data
 */
export function parseJsonFromText(text) {
    if (typeof text === 'object' && text !== null) {
        return text;
    }

    const trimmed = String(text || '').trim();

    // 1. Direct parse attempt
    try {
        return JSON.parse(trimmed);
    } catch {
        // Continue to extraction attempts
    }

    // 2. Extract from markdown code fence ```json ... ```
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
        try {
            return JSON.parse(fenceMatch[1].trim());
        } catch {
            // Fall through
        }
    }

    // 3. Extract first balanced or bracketed JSON object/array
    const jsonMatch = trimmed.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (jsonMatch) {
        try {
            return JSON.parse(jsonMatch[1].trim());
        } catch {
            // Fall through
        }
    }

    throw new Error(`Could not extract valid JSON from response: ${trimmed.slice(0, 200)}`);
}

/**
 * Extracts grounding sources and citation URLs from a Gemini Interactions response.
 *
 * @param {object} turn - Completed Agent turn
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string[]>} List of unique, resolved destination URLs
 */
export async function extractGroundingSources(turn, { signal } = {}) {
    const rawUrls = new Set();

    // 1. Inspect interaction steps for URL citations in model output annotations
    const steps = turn?.rawResponse?.steps || turn?.rawResponse?.originalFormat?.steps || [];
    for (const step of steps) {
        if (step.type === 'model_output' && Array.isArray(step.content)) {
            for (const part of step.content) {
                if (Array.isArray(part?.annotations)) {
                    for (const ann of part.annotations) {
                        if (ann?.type === 'url_citation' && ann.url) {
                            rawUrls.add(ann.url);
                        }
                    }
                }
            }
        }
        if (step.type === 'google_search_result' && Array.isArray(step.result)) {
            for (const item of step.result) {
                if (item?.url) rawUrls.add(item.url);
            }
        }
    }

    // 2. Inspect candidates grounding chunks if present (standard Gemini shape)
    const chunks = turn?.rawResponse?.originalFormat?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    for (const chunk of chunks) {
        if (chunk?.web?.uri) {
            rawUrls.add(chunk.web.uri);
        }
    }

    // 3. Fallback: extract explicit markdown links or plain URLs from output text
    if (turn?.output && typeof turn.output === 'string') {
        const urlMatches = turn.output.matchAll(/https?:\/\/[^\s)\]>"']+/g);
        for (const match of urlMatches) {
            rawUrls.add(match[0]);
        }
    }

    // 4. Resolve redirects with bounded timeout and deduplicate
    const resolved = await Promise.all(
        Array.from(rawUrls).map(u => getDestination(u, { signal }))
    );

    return Array.from(new Set(resolved.filter(Boolean)));
}

// ─── Research System ──────────────────────────────────────

export class ResearchSystem {
    /**
     * @param {object} [config={}]
     * @param {string} [config.apiKey] - Gemini API Key (defaults to process.env.GEMINI_API_KEY).
     * @param {string} [config.model=DEFAULT_MODEL] - Gemini model to use.
     * @param {string} [config.provider=DEFAULT_PROVIDER] - Provider name ('gemini-interactions').
     * @param {string} [config.promptsPath] - Path to prompts YAML file.
     * @param {number} [config.maxIterations=MAX_ITERATIONS] - Max outer loop iterations.
     * @param {number} [config.maxAspects=MAX_ASPECTS] - Max parallel research aspects per turn.
     * @param {boolean} [config.enableAskUser=false] - Whether to allow lead agent to query user interactively.
     */
    constructor({
        apiKey = process.env.GEMINI_API_KEY,
        model = DEFAULT_MODEL,
        provider = DEFAULT_PROVIDER,
        promptsPath = path.join(__dirname, 'prompts.yml'),
        maxIterations = MAX_ITERATIONS,
        maxAspects = MAX_ASPECTS,
        enableAskUser = false,
    } = {}) {
        this.model = model;
        this.provider = provider;
        this.promptsPath = promptsPath;
        this.maxIterations = maxIterations;
        this.maxAspects = maxAspects;
        this.enableAskUser = enableAskUser;

        this.llmService = new LLMService({
            provider: this.provider,
            apiKey: apiKey || process.env.GEMINI_API_KEY,
        });
    }

    /**
     * Creates the retrieve_research tool linked to a specific memory instance.
     * @private
     */
    _createRetrieveResearchTool(memory, signal) {
        return {
            name: 'retrieve_research',
            description: 'Retrieve content from a previous research iteration at a specified detail level. Use this when concise prior insights need deeper verification.',
            parameters: {
                type: 'object',
                properties: {
                    step: {
                        type: 'number',
                        description: 'The iteration step number to retrieve (1-indexed).',
                    },
                    detail_level: {
                        type: 'string',
                        enum: ['short', 'medium', 'long', 'full'],
                        description: 'Granularity to return: "short" (~50 words), "medium" (~150 words), "long" (~300 words), or "full" (raw findings).',
                    },
                },
                required: ['step', 'detail_level'],
            },
            func: async ({ step, detail_level }) => {
                return await memory.getSummary(Number(step), detail_level, { signal });
            },
        };
    }

    /**
     * Compresses raw iteration findings into a high-density insight string.
     * @private
     */
    async _compressToInsight(loader, findingsText, signal) {
        const agent = new Agent(this.llmService, { model: this.model });
        const promptTemplate = loader.getPrompt('summarize_findings');
        const prompt = promptTemplate.format({ findings: findingsText });

        agent.addInput({ role: 'user', content: prompt });

        try {
            const history = await agent.run(null, { signal });
            const lastTurn = history[history.length - 1];
            return lastTurn?.output || findingsText;
        } catch {
            return findingsText;
        }
    }

    /**
     * Executes the multi-agent research workflow on the provided topic.
     *
     * @param {string} topic - The inquiry or subject to research.
     * @param {object} [options]
     * @param {boolean} [options.citationEnabled=true] - Whether to invoke Citation Agent after synthesis.
     * @param {AbortSignal} [options.signal] - Cancellation signal.
     * @returns {Promise<object>} Synthesized and factually grounded research results.
     */
    async runResearch(topic, { citationEnabled = true, signal } = {}) {
        signal?.throwIfAborted?.();

        const loader = await PromptLoader.create(this.promptsPath);
        const memory = new ResearchMemory(this.llmService, { model: this.model });
        const retrieveTool = this._createRetrieveResearchTool(memory, signal);

        let currentTopic = topic;
        let allDocumentsText = '';

        for (let iteration = 1; iteration <= this.maxIterations; iteration++) {
            signal?.throwIfAborted?.();

            console.log(`\n${'='.repeat(60)}`);
            console.log(`  RESEARCH ITERATION ${iteration}/${this.maxIterations}`);
            console.log(`${'='.repeat(60)}\n`);

            const prevInsight = iteration > 1 ? memory.getInsight(iteration - 1) : null;
            const previousInsightSection = prevInsight
                ? `----------------\nPREVIOUS RESEARCH INSIGHT (Iteration ${iteration - 1})\n----------------\n${prevInsight}\n\nUse retrieve_research with step=${iteration - 1} if you need full details.`
                : '';

            // ── Step 1: Lead Agent Planning ──
            console.log('Lead Agent planning research aspects...');
            const planToolLoader = new ToolLoader();
            planToolLoader.addTool(retrieveTool);
            if (this.enableAskUser) {
                planToolLoader.addTool(askUserTool);
            }

            const planAgent = new Agent(this.llmService, {
                model: this.model,
                toolLoader: planToolLoader,
            });

            const planPrompt = loader.getPrompt('research_lead_plan').format({
                topic: currentTopic,
                previous_insight: previousInsightSection,
            });
            planAgent.addInput({ role: 'user', content: planPrompt });

            const planHistory = await planAgent.run(null, { signal });
            const planTurn = planHistory[planHistory.length - 1];
            const plan = PlanOutputSchema.parse(parseJsonFromText(planTurn?.output));

            if (Array.isArray(plan.aspects_to_research) && plan.aspects_to_research.length > this.maxAspects) {
                console.log(`Limiting aspects from ${plan.aspects_to_research.length} to maximum bounded limit of ${this.maxAspects}.`);
                plan.aspects_to_research = plan.aspects_to_research.slice(0, this.maxAspects);
            }

            console.log('Aspects to research:');
            (plan.aspects_to_research || []).forEach((a, i) => console.log(`  ${i + 1}. ${a}`));

            if (!plan.aspects_to_research || plan.aspects_to_research.length === 0) {
                console.log('No further research aspects identified. Concluding research loop.');
                break;
            }

            // ── Step 2: Parallel Sub-Agent Execution ──
            console.log(`\nDispatching ${plan.aspects_to_research.length} sub-agents in parallel...`);

            const taskPromises = plan.aspects_to_research.map(async (aspect) => {
                signal?.throwIfAborted?.();
                console.log(`  -> Sub-Agent assigned: "${aspect.slice(0, 75)}..."`);

                const workerAgent = new Agent(this.llmService, {
                    model: this.model,
                    tools: [geminiWebSearchTool],
                });

                const workerPrompt = loader.getPrompt('research_worker').format({
                    aspect,
                    all_aspects: JSON.stringify(plan.aspects_to_research, null, 2),
                    topic: currentTopic,
                });

                workerAgent.addInput({ role: 'user', content: workerPrompt });

                try {
                    const workerHistory = await workerAgent.run(null, { signal });
                    const workerTurn = workerHistory[workerHistory.length - 1];
                    const sources = await extractGroundingSources(workerTurn, { signal });

                    console.log(`  <- Sub-Agent completed: "${aspect.slice(0, 50)}..." (${sources.length} sources)`);
                    return {
                        aspect,
                        result: {
                            findings: workerTurn?.output || '',
                            sources,
                        },
                    };
                } catch (err) {
                    console.error(`  !! Sub-Agent error for "${aspect.slice(0, 50)}...":`, err.message);
                    return { aspect, error: err.message };
                }
            });

            // Bounded concurrency execution
            const results = await Promise.all(taskPromises);

            // ── Step 3: Collate findings ──
            let findingsText = '';
            for (const r of results) {
                if (r.error) {
                    findingsText += `Aspect: ${r.aspect}\nError encountered: ${r.error}\n\n`;
                } else {
                    const sourceList = (r.result.sources || []).join(', ') || 'None reported';
                    findingsText += `Aspect: ${r.aspect}\nFindings: ${r.result.findings}\nSources: ${sourceList}\n\n`;
                }
            }

            allDocumentsText += `--- Iteration ${iteration} ---\n${findingsText}\n`;

            // ── Step 4: Compress to insight and store in memory ──
            console.log('\nCompressing iteration findings into concise insight...');
            const insight = await this._compressToInsight(loader, findingsText, signal);
            memory.save(iteration, findingsText, insight);
            console.log(`Insight: "${insight.slice(0, 140)}..."`);

            // ── Step 5: Lead Agent Synthesis ──
            console.log('\nLead Agent synthesizing iteration results...');
            const synthesisToolLoader = new ToolLoader();
            synthesisToolLoader.addTool(retrieveTool);

            const synthesisAgent = new Agent(this.llmService, {
                model: this.model,
                toolLoader: synthesisToolLoader,
            });

            const synthesisPrompt = loader.getPrompt('research_lead_synthesize').format({
                topic: currentTopic,
                aspects_to_research: JSON.stringify(plan.aspects_to_research),
                findings: findingsText,
                previous_insight: previousInsightSection,
            });

            synthesisAgent.addInput({ role: 'user', content: synthesisPrompt });
            const synthesisHistory = await synthesisAgent.run(null, { signal });
            const synthesisTurn = synthesisHistory[synthesisHistory.length - 1];
            const synthesis = SynthesisOutputSchema.parse(parseJsonFromText(synthesisTurn?.output));

            console.log(`Synthesis complete. More research needed: ${synthesis.more_research_needed}`);

            const { more_research_needed, ...groundedModel } = synthesis;
            currentTopic = JSON.stringify(groundedModel);

            if (!more_research_needed) {
                console.log('Knowledge gaps fulfilled. Ending iterations.');
                break;
            }

            console.log('Proceeding to next research iteration...\n');
        }

        // ── Step 6: Citation Agent ──
        if (citationEnabled) {
            signal?.throwIfAborted?.();
            console.log('\nCitation Agent verifying facts and integrating source references...');

            const citationAgent = new Agent(this.llmService, {
                model: this.model,
                outputSchema: CitationOutputSchema,
            });

            const citationPrompt = loader.getPrompt('citation_agent').format({
                model: currentTopic,
                documents: allDocumentsText,
            });

            citationAgent.addInput({ role: 'user', content: citationPrompt });

            const citationHistory = await citationAgent.run(null, { signal });
            const citationTurn = citationHistory[citationHistory.length - 1];

            console.log('Citations integrated successfully.');
            return citationTurn.output || parseJsonFromText(citationTurn?.rawResponse?.text);
        }

        return parseJsonFromText(currentTopic);
    }
}

/**
 * Functional factory conforming to repository SICP-inspired style.
 *
 * @param {object} [options]
 * @returns {ResearchSystem}
 */
export function createResearchSystem(options) {
    return new ResearchSystem(options);
}

// ─── CLI Execution ────────────────────────────────────────

const isDirectExecution = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectExecution) {
    const defaultTopic = 'Recent breakthroughs and performance benchmarks in quantum computing hardware (2025-2026)';
    const targetTopic = process.argv[2] || defaultTopic;

    console.log(`Starting Research Agent with Gemini Interactions (model: ${DEFAULT_MODEL})...`);
    console.log(`Topic: "${targetTopic}"\n`);

    const system = createResearchSystem();
    system.runResearch(targetTopic)
        .then((result) => {
            console.log('\n================ FINAL RESEARCH REPORT ================');
            console.log(JSON.stringify(result, null, 2));
            console.log('=======================================================');
        })
        .catch((error) => {
            console.error('\nResearch failed:', error);
            process.exitCode = 1;
        });
}
