import { Agent } from '../../src/Agent.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runMCPExample() {
  try {
    // Set up an agent with multiple MCP servers
    const agent = new Agent({ 
      model: 'gpt-4o-mini',
      enableMCP: true 
    });
    
    console.log('Adding MCP servers...');

    try {
      console.log('Adding Tavily server...');
      await agent.addMCPServer('tavily', {
        type: 'streamableHttp',
        url: 'https://mcp.tavily.com/mcp/?tavilyApiKey=' + process.env.TAVILY_API_KEY,
        env: { DISPLAY: ':1' }
      });
      console.log('✓ Tavily server connected');
    } catch (error) {
      console.log('✗ Tavily server failed:', error.message);
    }
    
    // 1. Add Playwright MCP server (browser automation)
    try {
      console.log('Adding Playwright server...');
      await agent.addMCPServer('playwright', {
        type: 'streamableHttp',
        url: 'http://localhost:8931/mcp',
        env: { DISPLAY: ':1' }
      });
      console.log('✓ Playwright server connected');
    } catch (error) {
      console.log('✗ Playwright server failed:', error.message);
    }
    
    // 2. Add Filesystem MCP server (file operations)
    try {
      console.log('Adding Filesystem server...');
      const workspaceDir = path.resolve(__dirname, '../..');
      await agent.addMCPServer('filesystem', {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', workspaceDir]
      });
      console.log('✓ Filesystem server connected');
    } catch (error) {
      console.log('✗ Filesystem server failed:', error.message);
    }
    
    // 3. Add Brave Search MCP server (web search capabilities)
    try {
      console.log('Adding Brave Search server...');
      await agent.addMCPServer('brave-search', {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-brave-search'],
        env: { 
          BRAVE_API_KEY: process.env.BRAVE_API_KEY || 'demo-key'
        }
      });
      console.log('✓ Brave Search server connected');
    } catch (error) {
      console.log('✗ Brave Search server failed:', error.message);
    }
    
    // 4. Add Memory MCP server (persistent memory)
    try {
      console.log('Adding Memory server...');
      await agent.addMCPServer('memory', {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-memory']
      });
      console.log('✓ Memory server connected');
    } catch (error) {
      console.log('✗ Memory server failed:', error.message);
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
          1. If filesystem tools are available: List the files in the current directory
          2. If search tools are available: Search for information about "Model Context Protocol"
          3. If browser tools are available: Navigate to a simple website and take a screenshot
          4. If memory tools are available: Store and retrieve a simple fact
          
          Show me what capabilities are working and provide a summary of what each MCP server enables.
        `
      });
      
      const result = await agent.run();
      console.log('\n=== Agent Response ===');
      console.log(result);
    } else {
      console.log('\nNo MCP servers connected successfully. Please check the installation instructions in setup-mcp-servers.md');
    }

    await agent.cleanup();
    
  } catch (error) {
    console.error('Error in MCP example:', error);
  }
}

// Run the example
runMCPExample();