import { Agent } from '../../src/Agent.js';
import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });
import { z } from 'zod';

const server = {
    command: 'npx',
    type: 'stdio',
    args: ['@playwright/mcp@latest'],
    env: process.env
};

// Define a simple output schema for structured responses
const PersonalityAnalysis = z.object({
  traits: z.array(z.string()).describe("List of personality traits observed"),
  confidence: z.number().min(0).max(100).describe("Confidence level in the analysis (0-100)"),
  summary: z.string().describe("Brief summary of the personality analysis")
});

async function runSimpleSchemaExample() {
  console.log('Simple Output Schema Example\n');
  console.log('This demonstrates how to get structured JSON responses from an LLM.\n');

  // Create agent with output schema - this ensures responses follow the defined structure
  const agent = new Agent('openai', process.env.OPENAI_API_KEY, {
    model: 'gpt-4o-mini',
    outputSchema: PersonalityAnalysis,  // The LLM will be forced to respond in this format
    enableMCP: true
  });

  await agent.addMCPServer('playwright', server);

  // Add system prompt
  agent.addInput({
    role: 'system',
    content: 'You are a personality analyst. Analyze the given text and provide insights about the person\'s personality traits.'
  });

  // Test with a sample text
  const sampleText = "I love organizing events and bringing people together. I'm always the first to volunteer for group projects and I get energized by meeting new people. Sometimes I worry too much about what others think, but I try to stay positive and help others whenever I can.";

  agent.addInput({
    role: 'user',
    content: `Please analyze this person's personality based on their description: "${sampleText}"`
  });

  try {
    console.log('Sending request to LLM...\n');
    
    const result = await agent.run();
    
    // The output_text will be structured JSON matching our schema
    console.log('Raw Response:');
    console.log(result.output_parsed);
    console.log();

    // Parse and display the structured data
    const analysis = JSON.parse(result.output_text);
    
    console.log('Structured Analysis:');
    console.log(`Confidence: ${analysis.confidence}%`);
    console.log('Traits:');
    analysis.traits.forEach((trait, index) => {
      console.log(`   ${index + 1}. ${trait}`);
    });
    console.log(`Summary: ${analysis.summary}`);
    
    console.log('\nSchema validation passed - response matches expected structure!');

  } catch (error) {
    console.error('Error:', error.message);
  }
}

// Run the example
async function main() {
  try {
    await runSimpleSchemaExample();
  } catch (error) {
    console.error('Fatal error:', error);
  }
}

main().catch(console.error);
