# Research Agent Example (Gemini Interactions & Gemini 3.8 Flash)

This example illustrates a production-grade, multi-agent iterative research system powered by **AgentLib 4.0** and Google's **Gemini Interactions API** running on `gemini-3.8-flash`.

---

## Key Capabilities

1. **Iterative Planning & Aspect Decomposition**:
   - The Lead Agent inspects the user topic and any prior iteration insights to decompose the problem into 1–5 focused research aspects.
   - Bounded concurrency ensures rate limits and context budgets are respected.

2. **Parallel Sub-Agent Execution with Native Google Search**:
   - Sub-agents are dispatched concurrently with Gemini's native Google Search grounding (`{ type: 'google_search' }`).
   - Grounding annotations and source URLs are automatically extracted and verified.

3. **Hierarchical Working Memory (`ResearchMemory`)**:
   - Stores raw findings alongside compressed insights.
   - Provides a dynamic `retrieve_research` tool supporting multiple detail granularities (`short`, `medium`, `long`, `full`), keeping prompt contexts compact while enabling deep dives on demand.

4. **Structured Knowledge Synthesis & Stopping Condition**:
   - The Lead Synthesizer extracts query intent, rules, entities, and assertions into typed schemas validated by Zod (`SynthesisOutputSchema`).
   - If critical information gaps remain, the system automatically triggers another focused iteration (up to `MAX_ITERATIONS`).

5. **Fact Verification & Source Citation**:
   - A Citation Agent cross-checks synthesized conclusions against gathered source materials, embedding URLs directly into the final report (`CitationOutputSchema`).

---

## Prerequisites

1. Set your `GEMINI_API_KEY` in your `.env` file at the repository root:
   ```bash
   GEMINI_API_KEY=your_gemini_api_key_here
   ```

---

## Running the Example

### Default Topic (Quantum Computing 2025–2026)
```bash
# Run from repository root
node --env-file=.env examples/research_agent/index.js
```

### Custom Topic
Pass your research inquiry as a command-line argument:
```bash
node --env-file=.env examples/research_agent/index.js "Recent developments in solid-state battery technology"
```

---

## Architecture Overview

```
User Query
    │
    ▼
┌─────────────────────────────────────────┐
│ 1. Lead Planner Agent                   │◄─── Prior Iteration Insights
│    (Decomposes into ≤ 5 distinct queries)│     via retrieve_research tool
└────────────────────┬────────────────────┘
                     │
         ┌───────────┴───────────┐
         ▼                       ▼
┌─────────────────┐     ┌─────────────────┐
│ Worker Agent 1  │ ... │ Worker Agent N  │
│ (Google Search) │     │ (Google Search) │
└────────┬────────┘     └────────┬────────┘
         │                       │
         └───────────┬───────────┘
                     ▼
┌─────────────────────────────────────────┐
│ 2. Collation & Insight Compression      │───► Stored in ResearchMemory
└────────────────────┬────────────────────┘
                     ▼
┌─────────────────────────────────────────┐
│ 3. Lead Synthesizer Agent               │
│    (Query Intent, Rules, Assertions)    │
└────────────────────┬────────────────────┘
                     │
            More research needed?
            ├── Yes ──► (Loop back to step 1)
            └── No  ──┐
                      ▼
┌─────────────────────────────────────────┐
│ 4. Citation & Grounding Agent           │
│    (Integrates authoritative URLs)      │
└────────────────────┬────────────────────┘
                     ▼
            Final Research Report
```
