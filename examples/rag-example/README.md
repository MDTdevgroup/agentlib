# RAG Example Quick Start

Reference: https://www.mongodb.com/docs/atlas/atlas-vector-search/tutorials/vector-search-quick-start/?deployment-type=local&interface-local-only=driver&language-local-only=nodejs

**Time required:** 15 minutes

## Prerequisites

### 1. Install Dependencies

#### Install the Atlas CLI
If you use Homebrew, you can run the following command in your terminal:
```bash
brew install mongodb-atlas-cli
```

For installation instructions on other operating systems, see [Install the Atlas CLI](https://www.mongodb.com/docs/atlas/cli/stable/install-atlas-cli/)

#### Install Docker
Docker requires a network connection for pulling and caching MongoDB images.

- For MacOS or Windows, install [Docker Desktop v4.31+](https://www.docker.com/products/docker-desktop/)
- For Linux, install [Docker Engine v27.0+](https://docs.docker.com/engine/install/)
- For RHEL, you can also use [Podman v5.0+](https://podman.io/getting-started/installation)

#### Install MongoDB Database Tools
You must install the MongoDB Command Line Database Tools to access the `mongorestore` command, which you'll use to load the sample data.

[Download MongoDB Database Tools](https://www.mongodb.com/try/download/database-tools)

### 2. Set up Your Local Atlas Deployment

1. If you don't have an existing Atlas account, run `atlas setup` in your terminal or create a new account.

2. Run `atlas deployments setup` and follow the prompts to create a local deployment. When prompted to connect to the deployment, select **skip**.

For detailed instructions, see [Create a Local Atlas Deployment](https://www.mongodb.com/docs/atlas/cli/stable/atlas-deployments-setup/).

### 3. Load the Sample Data

1. Run utils.js script only once:
```bash
node utils.js
```

## Create a Vector Search Index

### 1. Install MongoDB Node Driver

Add the MongoDB Node Driver as a dependency in your project:
```bash
npm install mongodb
```

### 2. Define the Index

The `vector-index.js` file in this directory contains the code to create a Vector Search index. This index definition:

- Indexes the `chunks.embedding` field as the vector type. This field contains vector embeddings that represent the details of the agent library.
- Specifies 1536 vector dimensions to match OpenAI's text-embedding-3-small model.
- Measures similarity using dotProduct similarity.
- Enables automatic quantization of the vectors.
- Includes a polling mechanism to check if the index is ready to use.

To drop a vector_index: Install MongoDB compass and connect to the database with the connection string and remove it from the indexes -> search indexes tab

### 3. Configure Connection String

All configurations are found in config.js, feel free to change those as needed. But make sure they match with the local atlas deployment.

**For Local Atlas Deployment:**
```
mongodb://localhost:<port-number>
```

**For Atlas Cluster:**
```
mongodb+srv://<db_username>:<db_password>@<clusterName>.<hostname>.mongodb.net
```

> **Note:** Ensure that your connection string includes your database user's credentials.

### 4. Create the Index

Run the following command to create the vector search index:
```bash
node vector-index.js
```

Expected output:
```
New search index named vector_index is building.
Polling to check if the index is ready. This may take up to a minute.
vector_index is ready for querying.
```

## Run a Vector Search Query

The `index.js` file contains a the script to run a conversation with the user and agent. The agent uses vector search to answer user's queries about the agent lib.

### Run the Query

Execute the vector search query:
```bash
node index.js
```

Example interaction:
```bash
User: does this have mcp integration?
Retrieving documents for query: MCP integration
connection to database successful
Top results:

[MCP Example] (score: 0.833)
The mcp-example directory shows how to integrate MCP servers for browser automation, filesystem access, and web interactions.

[MCP Integration] (score: 0.768)
AgentLib supports MCP servers for capabilities like browser automation, filesystem access, and web search. These can be added using addMCPServer with 

[MCP Integration] (score: 0.768)
the desired configuration.

Results: Document: MCP Example
Chunk: The mcp-example directory shows how to integrate MCP servers for browser automation, filesystem access, and web interactions.
---
Document: MCP Integration
Chunk: AgentLib supports MCP servers for capabilities like browser automation, filesystem access, and web search. These can be added using addMCPServer with 
---
Document: MCP Integration
Chunk: the desired configuration.

Agent: Yes, there is MCP integration available. It supports capabilities such as browser automation, filesystem access, and web search. You can add MCP servers using the `addMCPServer` method with the desired configuration.
User: 
```

## Files in This Example

- `vector-index.js` - Creates the vector search index
- `index.js` - Runs the user agent interaction script and vector search
- `config.js` - Configuration settings
- `utils.js` - Utility functions
- `README.md` - This documentation

## Learning Summary

This quick start demonstrates:
- How to create a MongoDB Vector Search index on vector embeddings
- How to perform semantic search using the `$vectorSearch` aggregation stage
- How vector similarity search can find semantically related content even when exact keywords don't match
- How an agent can use this as a tool to answer queries

For more information, see the [MongoDB Vector Search documentation](https://www.mongodb.com/docs/atlas/atlas-vector-search/).

## Implementation Notes

This version uses:
- **Atlas (Local)** - Local MongoDB Atlas deployment
- **Driver** - MongoDB Node.js Driver
- **Node.js** - JavaScript runtime environment