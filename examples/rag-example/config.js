export const MONGODB_URI = 'mongodb://localhost:27015/?directConnection=true';
export const DATABASE_NAME = 'agentlib';
export const COLLECTION_NAME = 'documents';
export const EMBEDDING_MODEL = 'text-embedding-3-small'; // 1536 vector dimensions
export const NUM_CANDIDATES = 50;
export const LIMIT = 5;
export const docs = [
    {
      title: "Overview of AgentLib",
      content: "AgentLib is a lightweight Node.js library for building AI agents that integrate with multiple LLM providers and MCP servers. It enables structured outputs, tool calling, and orchestration of reasoning steps."
    },
    {
      title: "Installing AgentLib",
      content: "To get started, run npm install and set up your API keys for OpenAI or Gemini in a .env file. You can then run examples such as runner_two_agent_conversation or playwright-mcp to see agents in action."
    },
    {
      title: "Using Zod Schemas in AgentLib",
      content: "AgentLib supports Zod for schema validation, allowing developers to define structured input and output formats for reliable and type-safe agent communication."
    },
    {
      title: "Structured Outputs with Zod",
      content: "By passing a Zod schema to outputSchema, AgentLib ensures the LLM response matches the expected structure. If validation fails, an error is raised to maintain reliability."
    },
    {
      title: "MCP Integration",
      content: "AgentLib supports MCP servers for capabilities like browser automation, filesystem access, and web search. These can be added using addMCPServer with the desired configuration."
    },
    {
      title: "OpenAI and Gemini Support",
      content: "AgentLib supports multiple LLM providers including OpenAI models like gpt-4o and Gemini models like gemini-2.5-flash-lite. Developers can switch providers easily."
    },
    {
      title: "Tool Calling",
      content: "AgentLib enables native function execution through tool calling. Developers can define custom tools as JavaScript functions that the LLM can invoke dynamically."
    },
    {
      title: "Running Examples",
      content: "Examples included with AgentLib demonstrate different capabilities such as simple agent interactions, SQL querying, and multi-agent orchestration."
    },
    {
      title: "Agent Configuration",
      content: "An agent is initialized by specifying a model, optional tools, MCP servers, and Zod schemas for input/output. These configurations define the behavior and capabilities of the agent."
    },
    {
      title: "Output Access",
      content: "AgentLib returns both structured and raw outputs. The field result.output gives the response text or structured data, while raw provider payloads are available via rawResponse."
    },
    {
      title: "Token Usage and Model Info",
      content: "Every AgentLib response includes metadata about model usage, input and output tokens, and reasoning summaries for debugging and optimization."
    },
    {
      title: "RAG Integration Concept",
      content: "Retrieval-Augmented Generation (RAG) can be built on top of AgentLib by combining it with a vector store such as MongoDB. Embeddings are stored and retrieved as context."
    },
    {
      title: "MongoDB Vector Store Example",
      content: "To use MongoDB with AgentLib for RAG, store document embeddings in a collection, then perform vector searches to retrieve the most relevant chunks for user queries."
    },
    {
      title: "Agent Orchestration",
      content: "AgentLib supports orchestration of multiple agents working together. For example, one agent may handle translation, while another verifies or enhances the output."
    },
    {
      title: "Environment Setup",
      content: "Ensure you have your environment variables set up in a .env file with OPENAI_API_KEY and GEMINI_API_KEY before running any examples or agents."
    },
    {
      title: "Two-Agent Conversation Example",
      content: "The runner_two_agent_conversation example shows multi-agent interaction and round-trip dialogue orchestration."
    },
    {
      title: "SQL Agent Example",
      content: "The sqlAgent example demonstrates structured output, database interaction, and validation using Zod schemas for responses containing SQL query results."
    },
    {
      title: "Playwright MCP Example",
      content: "The playwright-mcp directory shows how to integrate MCP servers for browser automation, filesystem access, and web interactions."
    },
    {
      title: "Round Robin Conversation Example",
      content: "The runner_round_robin_conversation demonstrates multi-agent orchestration using custom turn strategies across multiple agents."
    },
    {
      title: "Extending AgentLib",
      content: "Developers can extend AgentLib with new tool definitions, custom schemas, or integration layers for external systems like databases or APIs."
    }
];
                