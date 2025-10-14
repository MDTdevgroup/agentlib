import { Agent } from '../../src/Agent.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

(async function run() {
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
          Search the web for the most recent articles or GitHub discussions about the Model Context Protocol (MCP). 
          Summarize what it is, what tools it provides, and any updates or implementations released in 2025. Then, 
          open the official MCP GitHub page in the browser and take a screenshot of the repository's main README 
          section. Save the summary and screenshot in ./reports as mcp_report.txt and mcp_repo.png. Finally, store 
          a memory note that I have already researched the MCP protocol so you dont repeat this task next time.
        `
      });
      let result;
      while (true) {
        result = await agent.run();
        for (const item of result.output) {
          if (item.type === 'function_call') {
            console.log('Function call:', item.name);
            console.log('Function call arguments:', item.arguments);
          }
        }
        if (result.output_text !== '') {
          break;
        }
      }

      console.log('\n=== Agent Response ===');
      console.log(result.output_text);

      } else {
        console.log('\nNo MCP servers connected successfully. Please check the installation instructions in setup-mcp-servers.md');
      }

    await agent.cleanup();
    
  } catch (error) {
    console.error('Error in MCP example:', error);
  }
})();