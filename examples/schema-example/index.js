import { Agent } from '../../src/Agent.js';
import { LLMService } from '../../src/LLMService.js';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ path: '../../.env' });

// 1. Define the Step schema (for array items)
const Step = z.object({
  explanation: z.string().min(1),
  output: z.string().min(1)
});

// 2. Define the main Output Schema
const MathReasoning = z.object({
  steps: z.array(Step).describe("Step-by-step solution process"),
  final_answer: z.string().describe("The final answer to the math problem")
});

async function main() {
  console.log('--- AgentLib Schema Example: Math Tutor ---\n');

  // 3. Initialize LLM Service
  const llmService = new LLMService('gemini', process.env.GEMINI_API_KEY);

  // 4. Initialize Agent with Output Schema
  const agent = new Agent(llmService, {
    outputSchema: MathReasoning
  });

  const problem = "Solve for x: 5x - 3 = 2x + 12";
  console.log(`Problem: ${problem}\n`);

  // 5. Add System Prompt
  agent.addInput({
    role: 'system',
    content: 'You are a helpful math tutor. Solve the problem step-by-step and provide the answer in the requested JSON format.'
  });

  // 6. Add User Prompt
  agent.addInput({
    role: 'user',
    content: problem
  });

  try {
    console.log('Running agent...');
    const response = await agent.run();

    // 7. Access Structured Output
    // The agent automatically parses the JSON into `response.output`
    const result = response.output;
    console.log("---- RESPONSE ----", response.output);

    console.log('\n--- Structured Output ---');
    console.log(`Steps Taken: ${result.steps.length}`);

    result.steps.forEach((step, i) => {
      console.log(`\nStep ${i + 1}:`);
      console.log(`  Explanation: ${step.explanation}`);
      console.log(`  Math: ${step.output}`);
    });

    console.log(`\nFinal Answer: ${result.final_answer}`);
    console.log('---------------------------');

  } catch (error) {
    console.error('Error running agent:', error);
  }
}

main().catch(console.error);
