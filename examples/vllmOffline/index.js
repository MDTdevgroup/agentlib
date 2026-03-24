import { Agent } from '../../src/Agent.js';
import { LLMService } from '../../src/llmService.js';

/*
This example demonstrates how to use `agentlib` with a local, offline vLLM server.

PREREQUISITES:
You must have a vLLM server running in the background. It implements an
OpenAI-compatible API on localhost by default.

1. Install vLLM (Python environment required):
   pip install vllm

2. Start the vLLM server in a separate terminal, for example:
   path/to/venv/bin/python -m vllm.entrypoints.openai.api_server --model meta-llama/Meta-Llama-3-8B-Instruct --port 8000 --chat-template chat_template.jinja
   
   You can find the list of supported models here: https://docs.vllm.ai/en/latest/models/supported_models/#text-generation

3. Once the server says "Uvicorn running on http://0.0.0.0:8000", run this script:
   node index.js
*/
async function main() {
    // We instantiate the LLMService using the 'vllm' provider.
    const llmService = new LLMService({
        provider: 'vllm'
    });
    // The library's src/providers/vllm.js automatically defaults to connecting
    // to http://localhost:8000/v1 when it creates the client.
    const agent = new Agent(llmService, {
        logmode: 'console',
        model: 'meta-llama/Meta-Llama-3-8B-Instruct',
    });


    const input = [
        { role: 'system', content: 'You are a helpful, offline AI assistant running locally on the user\'s hardware.' },
        { role: 'user', content: "Hello! What is the current system time?" }
    ];

    agent.addInput(input);

    try {
        const response = await agent.run();
        console.log(response.output);
    } catch (error) {
        console.error("\nERROR: Could not connect to the vLLM server.");
        console.error("Please ensure you have started the local Python API server on port 8000!");
        console.error("Run the following command in this directory:");
        console.error("path/to/venv/bin/python -m vllm.entrypoints.openai.api_server --model facebook/opt-125m --port 8000 --chat-template chat_template.jinja");
        console.error(`Error details: ${error.message}`);
    }
}

main();
