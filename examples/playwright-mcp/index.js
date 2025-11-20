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

const llm = new LLMService('openai', process.env.OPENAI_API_KEY);

async function run() {
  try {
    const promptLoader = await PromptLoader.create('./agentPrompts.md');
    // Set up an agent with multiple MCP servers
    const agent = new Agent(llm, {
      model: 'gpt-4o-mini',
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

    console.log('\n=== MCP Server Summary ===');
    const serverInfo = agent.mcpManager.getServerInfo();
    console.log(`Connected servers: ${serverInfo.connectedServers}/${serverInfo.totalServers}`);
    console.log(`Total tools available: ${serverInfo.totalTools}`);

    if (serverInfo.totalTools > 0) {
      console.log('\nAvailable tools:');
      const allTools = agent.mcpManager.getAllTools();
      allTools.forEach(tool => {
        console.log(`  - ${tool.name} (from ${tool._mcpServer})`);
      });

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
    } else {
      console.log('\nNo MCP servers connected successfully. Please check the installation instructions in setup-mcp-servers.md');
    }

    await agent.cleanup();

  } catch (error) {
    console.error('Error in MCP example:', error);
  }
}

// Run the example
run();