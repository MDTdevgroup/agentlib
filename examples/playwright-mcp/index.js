import { Agent } from '../../src/Agent.js';
import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });

const server = {
    command: 'npx',
    type: 'stdio',
    args: ['@playwright/mcp@latest'],
    env: process.env
};

async function run() {
  try {
    // Set up an agent with multiple MCP servers
    const agent = new Agent('openai', process.env.OPENAI_API_KEY, { 
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
        content: `
          Please demonstrate the MCP capabilities by:
          1. Open https://ramenraijin.com/
          2. Navigate the website and return a list of wines that they have 
        `
      });
      while (true) {
        const result = await agent.run();
        for (const output of result.output) {
            if (output.type === 'function_call') {
            console.log(`Function call: ${output.name}`);
            console.log(`Arguments: ${output.arguments}`);
            }
        }
        console.log('\n=== Agent Response ===');
        console.log(result.output_text);  
        console.log("result type: ", typeof result.output_text);
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