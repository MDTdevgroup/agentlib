# Setting Up MCP Servers

This guide shows how to install and configure various MCP servers for enhanced agent capabilities.

## Quick Start (Works Out of the Box)

The updated example will automatically try to connect to several MCP servers using `npx`, so many will work without installation:

```bash
node examples/mcp-example/main.js
```

## MCP Servers in the Example

### 1. Playwright Server (Browser Automation)
- **Package**: `@playwright/mcp`
- **Auto-installs**: Yes, via `npx`
- **Capabilities**: Web navigation, screenshots, form filling, clicking elements
- **No setup required**

### 2. Filesystem Server (File Operations)
- **Package**: `@modelcontextprotocol/server-filesystem`
- **Auto-installs**: Yes, via `npx`
- **Capabilities**: Read, write, list files and directories
- **Workspace**: Automatically uses the project directory

### 3. Brave Search Server (Web Search)
- **Package**: `@modelcontextprotocol/server-brave-search`
- **Auto-installs**: Yes, via `npx`
- **Capabilities**: Web search, current information lookup
- **API Key**: Uses demo key by default, set `BRAVE_API_KEY` for production

### 4. Memory Server (Persistent Storage)
- **Package**: `@modelcontextprotocol/server-memory`
- **Auto-installs**: Yes, via `npx`
- **Capabilities**: Store and retrieve information across sessions

## Optional: Pre-install for Better Performance

To avoid download delays, pre-install packages globally:

```bash
# Install commonly used MCP servers
npm install -g @modelcontextprotocol/server-filesystem
npm install -g @modelcontextprotocol/server-brave-search
npm install -g @modelcontextprotocol/server-memory
npm install -g @playwright/mcp
```

## Advanced Configuration

### Brave Search API Key
For production use, get a free API key:
1. Visit [Brave Search API](https://api.search.brave.com/)
2. Sign up and get your API key
3. Set environment variable:
```bash
export BRAVE_API_KEY="your_api_key_here"
```

### Custom Filesystem Directories
To limit filesystem access to specific directories, modify the args:
```javascript
args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/allowed/dir']
```

## Additional MCP Servers

You can add more MCP servers to extend functionality:

### SQLite Server (Database Operations)
```bash
npm install -g @modelcontextprotocol/server-sqlite
```
```javascript
await agent.addMCPServer('database', {
  type: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-sqlite', '--db-path', './data.db']
});
```

### GitHub Server (Repository Operations)
```bash
npm install -g @modelcontextprotocol/server-github
```
```javascript
await agent.addMCPServer('github', {
  type: 'stdio', 
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN }
});
```

## Troubleshooting

### Common Issues
- **ENOENT errors**: MCP server package not found - use `npx` with `-y` flag for auto-install
- **Permission errors**: Check directory permissions for filesystem server
- **API key errors**: Set required environment variables for search/API servers

### Error Resolution
The updated example includes graceful error handling - servers that fail to connect are skipped, and the example continues with available servers.
