# Schema Examples

This directory demonstrates how to use **input and output schemas** with AgentLib's LLM service, showcasing OpenAI's Structured Outputs feature for reliable, type-safe AI responses.

## Overview

Structured Outputs ensure that AI model responses always adhere to your defined JSON Schema, eliminating the need to validate or retry incorrectly formatted responses. This provides:

- **Reliable type-safety**: No need to validate or retry incorrectly formatted responses
- **Explicit refusals**: Safety-based model refusals are programmatically detectable  
- **Simpler prompting**: No need for strongly worded prompts to achieve consistent formatting

## Examples Included

### 1. Math Tutor (`mathTutor.js`)

Demonstrates structured step-by-step problem solving with both input and output validation.

**Features:**
- Input schema validation for math problems
- Structured output with step-by-step solutions
- Error handling and edge cases
- Multiple difficulty levels

**Schemas:**
```javascript
// Input validation
const MathProblemInput = z.object({
  problem: z.string(),
  difficulty: z.enum(['easy', 'medium', 'hard']).optional()
});

// Structured output
const MathReasoning = z.object({
  steps: z.array(Step),
  final_answer: z.string()
});
```

**Run:**
```bash
node examples/schema-example/mathTutor.js
```

### 2. Data Extraction (`dataExtraction.js`)

Shows how to extract structured data from unstructured text with input validation.

**Features:**
- Research paper data extraction
- Content moderation with confidence scores
- Input validation with minimum length requirements
- Multiple extraction types

**Schemas:**
```javascript
// Research paper extraction
const ResearchPaperExtraction = z.object({
  title: z.string(),
  authors: z.array(z.string()),
  abstract: z.string(),
  keywords: z.array(z.string())
});

// Content moderation
const ContentCompliance = z.object({
  is_violating: z.boolean(),
  category: z.enum(['violence', 'sexual', 'self_harm', 'harassment', 'none']),
  confidence_score: z.number().min(0).max(1)
});
```

**Run:**
```bash
node examples/schema-example/dataExtraction.js
```

### 3. UI Generation (`uiGeneration.js`)

Demonstrates recursive schema definitions for generating UI component structures.

**Features:**
- Recursive UI component schemas
- HTML generation from structured data
- Component analysis and statistics
- Complex dashboard layouts

**Schemas:**
```javascript
// Recursive UI component schema
const UIComponent = z.lazy(() => z.object({
  type: z.enum(['div', 'button', 'header', 'section', 'field', 'form']),
  label: z.string(),
  children: z.array(UIComponent),
  attributes: z.array(UIAttribute)
}));
```

**Run:**
```bash
node examples/schema-example/uiGeneration.js
```

## Key Concepts

### Input Schema Validation

Input schemas validate data before sending to the LLM:

```javascript
const agent = new Agent({
  model: 'gpt-4o-mini',
  inputSchema: MyInputSchema,  // Validates input data
  outputSchema: MyOutputSchema // Ensures structured response
});
```

### Output Schema Structure

The LLM response follows this structure:

```javascript
{
  "id": "resp_...",
  "status": "completed",
  "model": "gpt-4o-mini",
  "output": [{
    "type": "message",
    "content": [{
      "type": "output_text",
      "text": "{ \"structured\": \"json response\" }"
    }]
  }],
  "usage": {
    "input_tokens": 36,
    "output_tokens": 87,
    "total_tokens": 123
  }
}
```

### Accessing Structured Data

```javascript
const result = await agent.run();

// Get the structured JSON response
const responseText = result.output_text;

// Parse the structured data
const structuredData = JSON.parse(responseText);
```

### Error Handling

Handle various edge cases:

```javascript
try {
  const result = await agent.run();
  
  // Check for incomplete responses
  if (result.status === "incomplete") {
    console.log("Response was truncated:", result.incomplete_details.reason);
  }
  
  // Check for refusals
  if (result.output[0].content[0].type === "refusal") {
    console.log("Model refused:", result.output[0].content[0].refusal);
  }
  
  // Parse successful response
  const data = JSON.parse(result.output_text);
  
} catch (error) {
  console.error("Error:", error.message);
}
```

## Schema Design Best Practices

### 1. Clear Naming and Descriptions
```javascript
const Schema = z.object({
  title: z.string().describe("The main title of the document"),
  confidence: z.number().min(0).max(1).describe("Confidence score between 0 and 1")
});
```

### 2. Use Enums for Controlled Values
```javascript
const Status = z.enum(['pending', 'completed', 'failed']);
```

### 3. Handle Optional Fields with Nullable Types
```javascript
const OptionalField = z.string().nullable().describe("Optional field, null if not applicable");
```

### 4. Validate Input Constraints
```javascript
const Input = z.object({
  text: z.string().min(10).max(1000),
  count: z.number().int().positive()
});
```

### 5. Use Recursive Schemas for Nested Structures
```javascript
const TreeNode = z.lazy(() => z.object({
  value: z.string(),
  children: z.array(TreeNode)
}));
```

## Supported Models

Structured Outputs work with:
- `gpt-4o-mini`
- `gpt-4o-2024-08-06` and later
- `gpt-4.1` (latest)

## Schema Limitations

- Maximum 5000 object properties total
- Up to 10 levels of nesting
- All fields must be required (use nullable for optional)
- `additionalProperties: false` is required
- Root object cannot use `anyOf`

## Troubleshooting

### Common Issues

1. **Schema Validation Errors**: Ensure all required fields are present and types match
2. **Parsing Errors**: Check that the response is valid JSON
3. **Input Too Long**: Respect token limits for your model
4. **Unsupported Schema**: Verify your schema follows supported JSON Schema subset

### Debug Tips

```javascript
// Log the raw response for debugging
console.log('Raw response:', result.output_text);

// Check response status
console.log('Status:', result.status);

// Monitor token usage
console.log('Tokens used:', result.usage.total_tokens);
```

## Next Steps

- Explore the [OpenAI Structured Outputs documentation](https://platform.openai.com/docs/guides/structured-outputs)
- Try combining schemas with [function calling](../mcp-example/)
- Experiment with different model parameters
- Build your own custom schemas for your use case

## Requirements

- Node.js 18+
- OpenAI API key in `.env` file
- Zod for schema validation (`npm install zod`)
