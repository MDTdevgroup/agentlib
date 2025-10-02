import MCPClient from "./MCPClient.js";

export class MCPManager {
  constructor() {
    this.clients = new Map(); 
    this.serverConfigs = new Map(); 
  }

  async addServer(serverName, serverConfig) {
    if (this.clients.has(serverName)) {
      throw new Error(`MCP server '${serverName}' already exists`);
    }

    try {
      const client = new MCPClient();
      const tools = await client.connectToServer(serverConfig);
      
      this.clients.set(serverName, client);
      this.serverConfigs.set(serverName, serverConfig);
      
      console.log(`MCPManager: Connected to server '${serverName}' with ${tools.length} tools`);
      return { serverName, tools, toolCount: tools.length };
      
    } catch (error) {
      console.error(`MCPManager: Failed to connect to server '${serverName}':`, error);
      throw error;
    }
  }

  async removeServer(serverName) {
    const client = this.clients.get(serverName);
    if (!client) {
      console.warn(`MCPManager: Server '${serverName}' not found`);
      return false;
    }

    try {
      await client.disconnect();
      this.clients.delete(serverName);
      this.serverConfigs.delete(serverName);
      console.log(`MCPManager: Disconnected from server '${serverName}'`);
      return true;
    } catch (error) {
      console.error(`MCPManager: Error disconnecting from server '${serverName}':`, error);
      throw error;
    }
  }

  // Get all tools from all connected servers
  getAllTools() {
    const allTools = [];
    
    for (const [serverName, client] of this.clients) {
      allTools.push(...client.getTools());
    }
    
    return allTools;
  }

  // Execute a tool by finding the right server
  async executeTool(toolName, args) {
    for (const [serverName, client] of this.clients) {
      if (client.isServerConnected()) {
        const availableTools = client.getAvailableTools();
        if (availableTools.includes(toolName)) {
          console.log(`MCPManager: Executing '${toolName}' on server '${serverName}'`);
          return await client.executeTool(toolName, args);
        }
      }
    }
    
    throw new Error(`MCPManager: Tool '${toolName}' not found on any connected server`);
  }

  // Get comprehensive server information
  getServerInfo() {
    const info = {
      totalServers: this.clients.size,
      connectedServers: 0,
      totalTools: 0,
      servers: {}
    };

    for (const [serverName, client] of this.clients) {
      const isConnected = client.isServerConnected();
      const tools = isConnected ? client.getAvailableTools() : [];
      
      if (isConnected) {
        info.connectedServers++;
        info.totalTools += tools.length;
      }

      info.servers[serverName] = {
        connected: isConnected,
        toolCount: tools.length,
        tools: tools,
        config: this.serverConfigs.get(serverName)
      };
    }

    return info;
  }

  // Health check all servers
  async healthCheck() {
    const results = {
      manager: 'healthy',
      servers: {}
    };

    for (const [serverName, client] of this.clients) {
      try {
        if (client.isServerConnected()) {
          // Try to get tools as a health check
          client.getAvailableTools();
          results.servers[serverName] = 'healthy';
        } else {
          results.servers[serverName] = 'disconnected';
        }
      } catch (error) {
        results.servers[serverName] = 'unhealthy';
        console.warn(`MCPManager: Health check failed for '${serverName}':`, error.message);
      }
    }

    return results;
  }

  // Reconnect a specific server
  async reconnectServer(serverName) {
    const config = this.serverConfigs.get(serverName);
    if (!config) {
      throw new Error(`MCPManager: No config found for server '${serverName}'`);
    }

    // Remove existing connection
    await this.removeServer(serverName);
    
    // Reconnect
    return await this.addServer(serverName, config);
  }

  // Reconnect all disconnected servers
  async reconnectAll() {
    const results = [];
    
    for (const [serverName, client] of this.clients) {
      if (!client.isServerConnected()) {
        try {
          const result = await this.reconnectServer(serverName);
          results.push({ serverName, status: 'reconnected', ...result });
        } catch (error) {
          results.push({ serverName, status: 'failed', error: error.message });
        }
      }
    }
    
    return results;
  }

  // Batch operations
  async addMultipleServers(serverConfigs) {
    const results = [];
    
    for (const { name, config } of serverConfigs) {
      try {
        const result = await this.addServer(name, config);
        results.push({ ...result, status: 'success' });
      } catch (error) {
        results.push({ serverName: name, status: 'failed', error: error.message });
      }
    }
    
    return results;
  }

  // Get servers by capability (tools matching a pattern)
  getServersByTool(toolNamePattern) {
    const matchingServers = [];
    const regex = new RegExp(toolNamePattern, 'i');
    
    for (const [serverName, client] of this.clients) {
      if (client.isServerConnected()) {
        const tools = client.getAvailableTools();
        const matchingTools = tools.filter(tool => regex.test(tool));
        
        if (matchingTools.length > 0) {
          matchingServers.push({
            serverName,
            matchingTools
          });
        }
      }
    }
    
    return matchingServers;
  }

  // Cleanup all connections
  async cleanup() {
    console.log(`MCPManager: Cleaning up ${this.clients.size} connections...`);
    
    const disconnectPromises = [];
    for (const [serverName, client] of this.clients) {
      disconnectPromises.push(
        client.disconnect().catch(error => 
          console.error(`MCPManager: Error disconnecting '${serverName}':`, error)
        )
      );
    }
    
    await Promise.allSettled(disconnectPromises);
    this.clients.clear();
    this.serverConfigs.clear();
    
    console.log('MCPManager: Cleanup completed');
  }

  // Iterator support for easy looping
  [Symbol.iterator]() {
    return this.clients.entries();
  }

  // Get list of connected server names
  getConnectedServerNames() {
    return Array.from(this.clients.keys()).filter(serverName => 
      this.clients.get(serverName).isServerConnected()
    );
  }

  // Get total tool count across all servers
  getTotalToolCount() {
    let count = 0;
    for (const client of this.clients.values()) {
      if (client.isServerConnected()) {
        count += client.getAvailableTools().length;
      }
    }
    return count;
  }
}
