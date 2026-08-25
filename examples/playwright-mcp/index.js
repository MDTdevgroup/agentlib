import { Agent, AgentRunner, LLMService, PromptLoader } from '../../index.js';

const server = {
  command: 'npx',
  type: 'stdio',
  args: ['@playwright/mcp@latest'],
  env: process.env
};

// openai
const llm = new LLMService({ provider: 'openai', apiKey: process.env.OPENAI_API_KEY });

// gemini
// const llm = new LLMService({ provider: 'gemini', apiKey: process.env.GEMINI_API_KEY });

async function run() {
  try {
    const promptLoader = await PromptLoader.create('./agentPrompts.md');
    // Set up an agent with multiple MCP servers
    const agent = new Agent(llm, {
      enableMCP: true,
      name: 'ScraperAgent'
    });

    const systemPrompt = promptLoader.getPrompt('instruction').format();
    agent.addInput({ role: 'system', content: systemPrompt });

    console.log('Adding MCP servers...');

    // 1. Add Playwright MCP server (browser automation)
    try {
      console.log('Adding Playwright server...');
      await agent.addMCPServer('playwright', server);
      console.log('✓ Playwright server connected');
    } catch (error) {
      console.log('✗ Playwright server failed:', error.message);
    }

    const runner = new AgentRunner(agent);
    let history = await runner.run();

    console.log('\n=== Agent Response ===');
    console.log(history[history.length - 1].output);

    await agent.cleanup();

  } catch (error) {
    console.error('Error in MCP example:', error);
  }
}

// Run the example
run();