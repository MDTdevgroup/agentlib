# A2A Pydantic Example

This example demonstrates how to create a **Python Agent** (using `pydantic-ai`) that exposes itself via the **A2A (Agent-to-Agent) Protocol**, and how to consume it from a **Node.js Agent** (using `agentlib`).

## Structure

*   `provider-python/`: Contains the Python agent that serves as the expert. It uses `pydantic-ai` to handle logic and `fastapi` to expose A2A endpoints.
*   `consumer-js/`: Contains the Node.js agent that connects to the Python agent using `agentlib`.

## Prerequisites

*   **Python**: 3.9 or higher
*   **Node.js**: 18 or higher
*   **OpenAI API Key**: Required for the agents to run.

## 1. Setup Provider (Python)

The provider is a Python service running on port 8000. It defines a "Weather Expert" agent.

1.  Navigate to the provider directory:
    ```bash
    cd provider-python
    ```

2.  Install dependencies:
    ```bash
    pip install fastapi uvicorn pydantic-ai httpx logfire
    ```

3.  Run the server:
    ```bash
    # Ensure OPENAI_API_KEY is set in your environment
    export OPENAI_API_KEY=your_key_here
    
    python agent.py
    ```

    The server will start at `http://localhost:8000`. You can view the Agent Card at `http://localhost:8000/.well-known/a2a/agent-card`.

## 2. Setup Consumer (Node.js)

The consumer is a Node.js agent that uses `agentlib`. It connects to the Python provider to answer user queries.

1.  Navigate to the consumer directory:
    ```bash
    cd ../consumer-js
    ```

2.  Install dependencies (if not already installed in root):
    ```bash
    npm install
    # or if purely local to this example (ensure SDK is available)
    ```

3.  Run the client agent:
    ```bash
    # Ensure .env file with OPENAI_API_KEY exists in project root or set it here
    node index.js
    ```

## Example Flow

1.  The Node.js agent receives the user query: *"What is the weather like in London and in Wiltshire?"*
2.  It sees it has a tool `weather_expert` connected to `http://localhost:8000`.
3.  It sends the request to the Python agent via A2A.
4.  The Python agent uses its internal `pydantic-ai` logic (and tools) to process the request.
5.  The Python agent returns the answer.
6.  The Node.js agent displays the final result.
