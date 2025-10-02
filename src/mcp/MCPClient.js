import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

class MCPClient {
  constructor() {
    this.mcp = new Client({ name: "mcp-client-cli", version: "1.0.0" });
    this.tools = [];
    this.isConnected = false;
  }

  async connectToServer(server) {
    try {
        switch (server.type) {
            case "stdio":
                this.transport = new StdioClientTransport(server);
                break;
            case "sse":
                this.transport = new SSEClientTransport(server.url);
                break;
            case "streamableHttp":
                this.transport = new StreamableHTTPClientTransport(server.url);
                break;
            default:
                throw new Error("Invalid server type");
        }
        await this.mcp.connect(this.transport);
    
        const toolsResult = await this.mcp.listTools();
        this.tools = toolsResult.tools.map((tool) => {
            return {
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
            func: async (args) => {
                return await this.executeTool(tool.name, args);
            }
            };
        });
        this.isConnected = true;
        console.log(
            "Connected to MCP server with tools:",
            this.tools.map(({ name }) => name)
        );
        
        return this.tools;
    } catch (e) {
      console.log("Failed to connect to MCP server: ", e);
      throw e;
    }
  }

  async executeTool(toolName, args) {
    if (!this.isConnected) {
      throw new Error("MCP client is not connected to a server");
    }

    const tool = this.tools.find(t => t.name === toolName);
    if (!tool) {
      throw new Error(`Tool '${toolName}' not found on MCP server`);
    }

    try {
      const result = await this.mcp.callTool({
        name: toolName,
        arguments: args,
      });
      return result.content;
    } catch (error) {
      console.error(`Error executing MCP tool '${toolName}':`, error);
      throw error;
    }
  }
  
  getTools() {
    if (!this.isConnected) {
      return [];
    }
    return this.tools;
  }

  getToolNames() {
    return this.tools.map(tool => tool.name);
  }

  getAvailableTools() {
    return this.tools.map(tool => tool.name);
  }

  getAgentTools() {
    return this.tools;
  }

  isServerConnected() {
    return this.isConnected;
  }

  async disconnect() {
    if (this.transport && this.isConnected) {
      await this.transport.close();
      this.isConnected = false;
      this.tools = [];
    }
  }
}

export default MCPClient;