# LLM Service

The `LLMService` is a unified abstraction over various LLM providers (currently OpenAI and Gemini). It standardizes inputs and outputs. The schema is based on OpenAI's API.

## Initialization

```javascript
import { LLMService } from '@peebles-group/agentlib-js';

// OpenAI
const openaiLlm = new LLMService({ provider: 'openai', apiKey: process.env.OPENAI_API_KEY });

// Gemini
const geminiLlm = new LLMService({ provider: 'gemini', apiKey: process.env.GEMINI_API_KEY });
```

## Structured Outputs

AgentLib supports type-safe structured outputs using Zod schemas for reliable JSON responses.

```javascript
import { z } from 'zod';

const ResponseSchema = z.object({
  answer: z.string(),
  confidence: z.number(),
  sources: z.array(z.string())
});

const response = await llm.chat(messages, {
    model: 'gpt-4o-mini',
    outputSchema: ResponseSchema
});

// Access parsed structured data
const data = response.output;
```

## Decisions API

`LLMService.decide(input, questions, options)` evaluates closed-ended `predicate`, `choice`, and `score` questions against shared evidence and returns calibrated probabilities in OpenAI's Decisions format across both OpenAI (`gpt-6-luna`) and Gemini (`gemini-decision-1`).

```javascript
const llm = new LLMService({ provider: 'openai', apiKey: process.env.OPENAI_API_KEY });
// Swap to { provider: 'gemini', apiKey: process.env.GEMINI_API_KEY } with no code changes

const { answers, model, usage } = await llm.decide(
    'I was charged twice for my order.',
    [
        {
            type: 'predicate',
            name: 'is_billing_issue',
            instructions: 'Is this customer reporting a billing issue?',
        },
        {
            type: 'choice',
            name: 'department',
            instructions: 'Which department should handle this complaint?',
            choices: [
                { value: 'billing', description: 'Payments, invoices, and refunds.' },
                { value: 'technical', description: 'Problems using the product.' },
                { value: 'shipping', description: 'Delivery and tracking.' },
                { value: 'other', description: 'Requests outside these categories.' },
            ],
        },
        {
            type: 'score',
            name: 'severity',
            instructions: 'How severe is this issue?',
            levels: [
                { label: 'Low', description: 'Minor inconvenience.' },
                { label: 'Medium', description: 'Workaround available.' },
                { label: 'High', description: 'Fully blocked.' },
            ],
        },
    ]
);
```

### Provider Translation Notes (Gemini)

When `provider` is `'gemini'` or `'gemini-interactions'`, AgentLib automatically translates OpenAI Decisions requests and responses:
- Defaults `model` to `'gemini-decision-1'` and routes requests to `v1beta`.
- Maps `predicate` ↔ `noul`, `choice.choices` ↔ `criteria` map, and `score.levels` ↔ `criteria` array, restoring original question order, `name`s (or `null`), boolean choice values, and level `label`s.
- Translates OpenAI `input_text`, `input_image` (data URLs and HTTP/HTTPS URLs), `input_json`, and multi-turn conversation/tool items into Gemini content blocks.
- Normalizes Gemini `usage` into OpenAI's `usage` shape while preserving the unmodified Gemini response at `rawResponse.originalFormat`.
- Ignores OpenAI-only caching/safety options (`prompt_cache_key`, `prompt_cache_options`, `safety_identifier`) and fails fast if media is placed inside question `instructions` (unsupported by Gemini Decisions).

## Standardized Syntax

All inputs and outputs across all providers strictly follow OpenAI's API structure.

Input format follows OpenAI's message structure:
```javascript
[{ role: 'user', content: 'Hello' }]
```

The returned payload normalizes provider differences into standard keys like `output` and `rawResponse`. Here is an example of what this looks like (OpenAI gpt-5): 

```javascript
{
  output: 'Hello! How can I help you today?',
  rawResponse: {
    id: 'resp_0cf2adbd0d6943ce006a062db14664819b86aac2353a63af39',
    object: 'response',
    created_at: 1778789809,
    status: 'completed',
    background: false,
    billing: { payer: 'developer' },
    completed_at: 1778789810,
    error: null,
    frequency_penalty: 0,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    max_tool_calls: null,
    model: 'gpt-5-2025-08-07',
    moderation: null,
    output: [ [Object], [Object] ],
    parallel_tool_calls: true,
    presence_penalty: 0,
    previous_response_id: null,
    prompt_cache_key: null,
    prompt_cache_retention: 'in_memory',
    reasoning: { effort: 'medium', summary: null },
    safety_identifier: null,
    service_tier: 'default',
    store: true,
    temperature: 1,
    text: { format: [Object], verbosity: 'medium' },
    tool_choice: 'auto',
    tools: [],
    top_logprobs: 0,
    top_p: 1,
    truncation: 'disabled',
    usage: {
      input_tokens: 10,
      input_tokens_details: [Object],
      output_tokens: 52,
      output_tokens_details: [Object],
      total_tokens: 62
    },
    user: null,
    metadata: {},
    output_text: 'Hello! How can I help you today?'
  }
}
```
