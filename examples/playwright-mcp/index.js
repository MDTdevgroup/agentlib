import { Agent } from '../../src/Agent.js';
import { LLMService } from '../../src/llmService.js';
import { PromptLoader } from '../../src/prompt-loader/promptLoader.js';
import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });

const server = {
  command: 'npx',
  type: 'stdio',
  args: ['@playwright/mcp@latest'],
  env: process.env
};

// openai
// const llm = new LLMService('openai', process.env.OPENAI_API_KEY);

// gemini
const llm = new LLMService('gemini', process.env.GEMINI_API_KEY);

async function run() {
  try {
    const promptLoader = await PromptLoader.create('./agentPrompts.md');
    // Set up an agent with multiple MCP servers
    const agent = new Agent(llm, {
      enableMCP: true
    });

    console.log('Adding MCP servers...');

    // 1. Add Playwright MCP server (browser automation)
    try {
      console.log('Adding Playwright server...');
      await agent.addMCPServer('playwright', server);
      console.log('✓ Playwright server connected');
    } catch (error) {
      console.log('✗ Playwright server failed:', error.message);
    }

    // Comprehensive example task
    agent.addInput({
      role: 'user',
      content: promptLoader.getPrompt('instruction').format()
    });
    while (true) {
      const result = await agent.run();
      for (const out of result.rawResponse.output) {
        if (out.type === 'function_call') {
          console.log(`Function call: ${out.name}`);
          console.log(`Arguments: ${out.arguments}`);
        }
      }
      console.log('\n=== Agent Response ===');
      console.log(result.output);
      console.log("result type: ", typeof result.output);
    }

    await agent.cleanup();

  } catch (error) {
    console.error('Error in MCP example:', error);
  }
}

// Run the example
run();