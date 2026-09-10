# Agent-to-Agent (A2A) Demo

This example demonstrates how to use the `@a2a-js/sdk` integration within `agentlib` to establish a seamless, cross-process Agent-to-Agent communication.

In this demo, a **Client Agent** communicates with a **Math Expert Server Agent**. The server agent registers native tools and exposes them securely via an A2A HTTP REST server. The client agent connects to this server and treats the remote agent exactly as if it were a local function calling tool.

## Requirements

Ensure you have your `.env` file at the root of the project with a valid `OPENAI_API_KEY`.

## Running the Demo

Because this simulates a distributed system, you will need to run the server and client in two separate terminal sessions.

### Step 1: Start the Math Expert Server

In your first terminal, start the server:

```bash
cd examples/a2a_demo
node server.js
```

You should see:
```text
A2A Server started on http://localhost:4000
   Card: http://localhost:4000/.well-known/agent-card.json
```

### Step 2: Run the Client

In a separate terminal, execute the client:

```bash
cd examples/a2a_demo
node client.js
```

The client will:
1. Connect to `http://localhost:4000`.
2. Discover the remote `calculate_sum` tool hosted by the math expert.
3. Automatically execute a conversational loop with the user's prompt ("What is 123 + 456?").
4. The client's LLM will choose to invoke the remote tool, the payload will be sent across the network, the server agent will compute the result (579), and return it to the client.
5. The client will finalize the text response and print it to the console.

## How it works

Behind the scenes, `AgentLib` implements `AgentExecutorAdapter` and integrates deeply with the open-source A2A protocol.

* **Server:** Uses `startA2AServer(agent, { port: 4000 })` to automatically expose the agent's loaded tools.
* **Client:** Uses `createRemoteAgentTool('http://localhost:4000', ...)` to bind a remote server as a callable tool in the `ToolLoader`.
