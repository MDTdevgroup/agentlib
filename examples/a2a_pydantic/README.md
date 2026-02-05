# A2A Pydantic Example

Demonstrates a **Python Agent** (using `pydantic-ai`) exposed via **A2A** consumed by a **Node.js Agent**.

## Prerequisites
*   Python 3.9+ & Node.js 18+
*   OpenAI API Key

## 1. Setup Provider (Python)
The provider is a "Weather Expert" running on port 8000.

1.  Navigate to the provider directory:
    ```bash
    cd provider-python
    ```

2.  Create and activate a virtual environment (avoids system package errors):
    ```bash
    python3 -m venv venv
    source venv/bin/activate
    ```

3.  Install dependencies:
    ```bash
    pip install fastapi uvicorn pydantic-ai httpx logfire
    ```

4.  Run the server:
    ```bash
    export OPENAI_API_KEY=your_key_here
    python agent.py
    ```
    Server starts at `http://localhost:8000`.

## 2. Setup Consumer (Node.js)
The consumer connects to the Python provider to answer user queries.

1.  Open a **new terminal** and navigate to the consumer directory:
    ```bash
    cd ../consumer-js  # from provider-python
    # or cd examples/a2a_pydantic/consumer-js
    ```

2.  Install dependencies:
    ```bash
    npm install
    ```

3.  Run the client agent:
    ```bash
    # Ensure OPENAI_API_KEY is available (env var or .env file)
    node index.js
    ```

## Example Flow
1.  Node.js agent receives: *"What is the weather like in London?"*
2.  It delegates to the Python `weather_expert` at `localhost:8000`.
3.  Python agent processes logic and returns the result.
4.  Node.js agent displays the answer.
