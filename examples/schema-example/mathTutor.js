import { Agent } from '../../src/Agent.js';
import { z } from 'zod';

// Define the step schema for math problem solving
const Step = z.object({
  explanation: z.string().describe("Clear explanation of what's happening in this step"),
  output: z.string().describe("The mathematical result or equation after this step")
});

// Define the complete math reasoning output schema
const MathReasoning = z.object({
  steps: z.array(Step).describe("Step-by-step solution process"),
  final_answer: z.string().describe("The final answer to the math problem")
});

// Define input schema for math problems
const MathProblemInput = z.object({
  role: z.string(),
  content: z.string()
});

async function runMathTutorExample() {
  console.log('Math Tutor with Structured Input/Output Example\n');

  // Create agent with both input and output schemas
  const agent = new Agent({
    model: 'gpt-4o-mini',
    inputSchema: MathProblemInput,
    outputSchema: MathReasoning
  });

  // Test input data
  const mathProblems = [
    {
      problem: "Solve for x: 8x + 7 = -23",
      difficulty: "medium"
    },
    {
      problem: "Find the derivative of f(x) = 3x² + 2x - 5",
      difficulty: "hard"
    },
    {
      problem: "What is 15% of 240?",
      difficulty: "easy"
    }
  ];

  for (const problemData of mathProblems) {
    console.log(`Problem: ${problemData.problem}`);
    console.log(`Difficulty: ${problemData.difficulty}\n`);

    // Add system message for math tutoring
    agent.addInput({
      role: 'system',
      content: 'You are a helpful math tutor. Guide the user through the solution step by step. Be clear and educational in your explanations.'
    });

    // Add user input with structured data
    agent.addInput({
      role: 'user',
      content: `Please solve this ${problemData.difficulty} math problem: ${problemData.problem}`
    });

    try {
      const result = await agent.run();
      
      console.log('Raw LLM Response Structure:');
      console.log('- Status:', result.status);
      console.log('- Model:', result.model);
      console.log('- Usage:', result.usage);
      console.log();

      // Access the structured response text
      const responseText = result.output_parsed;
      console.log('Structured Response:');
      console.log(responseText);
      console.log();

      // Parse the JSON response to work with structured data
      try {
        console.log('Parsed Structured Data:');
        console.log('Steps taken:', responseText.steps.length);
        responseText.steps.forEach((step, index) => {
          console.log(`  Step ${index + 1}: ${step.explanation}`);
          console.log(`    Result: ${step.output}`);
        });
        console.log(`Final Answer: ${responseText.final_answer}`);
        
      } catch (parseError) {
        console.log('Could not parse response as JSON:', parseError.message);
      }

    } catch (error) {
      console.error('Error:', error.message);
    }

    console.log('\n' + '='.repeat(60) + '\n');
    
    // Clear inputs for next problem
    agent.cleanup();
  }
}

// Handle edge cases and errors
async function demonstrateErrorHandling() {
  console.log('Error Handling Examples\n');

  const agent = new Agent({
    model: 'gpt-4o-mini',
    inputSchema: MathProblemInput,
    outputSchema: MathReasoning
  });

  // Test with invalid input (should be caught by input schema)
  try {
    console.log('Testing invalid input schema...');
    
    agent.addInput({
      role: 'system',
      content: 'You are a math tutor.'
    });

    // This should fail input validation
    agent.addInput({
      role: 'user',
      content: 'Invalid input without proper structure'
    });

    const result = await agent.run();
    console.log('Handled gracefully:', result.status);
    
  } catch (error) {
    console.log('Input validation or processing error:', error.message);
  }

  console.log('\n' + '='.repeat(60) + '\n');
}

// Run the examples
async function main() {
  try {
    await runMathTutorExample();
    await demonstrateErrorHandling();
  } catch (error) {
    console.error('Fatal error:', error);
  }
}

main().catch(console.error);
