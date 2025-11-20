import { Agent } from '../../src/Agent.js';
import { LLMService } from '../../src/llmService.js';
import { PromptLoader } from '../../src/prompt-loader/promptLoader.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const llm = new LLMService('openai', process.env.OPENAI_API_KEY);
const promptLoader = await PromptLoader.create('./prompts.yml');

(async function run() {
  try {
    // Set up an agent with multiple MCP servers
    const agent = new Agent(llm, {
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
        content: promptLoader.getPrompt('instruction').format()
      });
      let result;
      while (true) {
        result = await agent.run();
        for (const item of result.rawResponse.output) {
          if (item.type === 'function_call') {
            console.log('Function call:', item.name);
            console.log('Function call arguments:', item.arguments);
          }
        }
        if (result.output !== '') {
          break;
        }
      }


      console.log('\n=== Agent Response ===');
      console.log(result.output);

    } else {
      console.log('\nNo MCP servers connected successfully. Please check the installation instructions in setup-mcp-servers.md');
    }

    await agent.cleanup();

  } catch (error) {
    console.error('Error in MCP example:', error);
  }
})();