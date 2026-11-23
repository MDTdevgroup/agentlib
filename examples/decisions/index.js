import { LLMService } from '../../index.js';

// Run with OpenAI (default) or Gemini using the exact same OpenAI-syntax call:
//   node --env-file=.env examples/decisions/index.js
//   PROVIDER=gemini node --env-file=.env examples/decisions/index.js
const provider = (process.env.PROVIDER || 'openai').toLowerCase();
const apiKey = provider === 'gemini' ? process.env.GEMINI_API_KEY : process.env.OPENAI_API_KEY;

const llm = new LLMService({ provider, apiKey });

const ticket = 'I was charged twice for order #8821 and checkout is now completely blocked. Fix this today or I am canceling.';

const { answers, model } = await llm.decide(ticket, [
    {
        type: 'predicate',
        name: 'needs_refund',
        instructions: 'Is the customer reporting a duplicate charge or requesting a refund?',
    },
    {
        type: 'choice',
        name: 'department',
        instructions: 'Which support department should handle this ticket?',
        choices: [
            { value: 'billing', description: 'Payments, invoices, duplicate charges, and refunds.' },
            { value: 'technical', description: 'Bugs, outages, or problems using the product.' },
            { value: 'shipping', description: 'Delivery, tracking, and damaged packages.' },
            { value: 'other', description: 'Anything outside these categories.' },
        ],
    },
    {
        type: 'score',
        name: 'urgency',
        instructions: 'How urgent is this support ticket?',
        levels: [
            { label: 'Low', description: 'General question or minor inconvenience.' },
            { label: 'Medium', description: 'Issue impacts the customer, but a workaround exists.' },
            { label: 'High', description: 'Customer is blocked or threatening to cancel.' },
        ],
    },
]);

const byName = Object.fromEntries(answers.map(a => [a.name, a]));
const route = byName.department?.type === 'choice' && byName.department.confidence >= 0.7
    ? byName.department.choice
    : 'human_review';

console.log(`Provider: ${provider} (${model})`);
console.log(`Route to: ${route} (confidence: ${byName.department?.confidence?.toFixed(2)})`);
console.log(`Needs refund P(yes): ${byName.needs_refund?.probability?.toFixed(2)}`);
console.log(`Urgency score: ${byName.urgency?.score?.toFixed(2)} / 2.00`);
