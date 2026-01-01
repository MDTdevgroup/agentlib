import asyncio
from dataclasses import dataclass
from typing import Any, List, Dict
from datetime import datetime
import uuid

import logfire
from httpx import AsyncClient
from pydantic import BaseModel
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse
from pydantic_ai import Agent, RunContext

# --- User's Pydantic AI Code ---
logfire.configure(send_to_logfire='if-token-present')

@dataclass
class Deps:
    client: AsyncClient

weather_agent = Agent(
    'openai:gpt-4o',
    deps_type=Deps,
    retries=2,
    system_prompt='You are a helpful weather agent. Be concise.',
)

class LatLng(BaseModel):
    lat: float
    lng: float

@weather_agent.tool
async def get_lat_lng(ctx: RunContext[Deps], location_description: str) -> LatLng:
    """Get the latitude and longitude of a location."""
    print(f"DEBUG: Getting lat/lng for {location_description}")
    # Simulating simple logic since the example URL provided in the prompt might be specific to pydantic docs
    # Using a mock or a simple guess for demo purposes if the endpoint fails, 
    # but let's try to keep the user's logic if possible.
    # The user's code used 'https://demo-endpoints.pydantic.workers.dev/latlng'. We will trust it works.
    r = await ctx.deps.client.get(
        'https://demo-endpoints.pydantic.workers.dev/latlng',
        params={'location': location_description},
    )
    r.raise_for_status()
    return LatLng.model_validate_json(r.content)

@weather_agent.tool
async def get_weather(ctx: RunContext[Deps], lat: float, lng: float) -> dict[str, Any]:
    """Get the weather at a location."""
    print(f"DEBUG: Getting weather for {lat}, {lng}")
    temp_response, descr_response = await asyncio.gather(
        ctx.deps.client.get(
            'https://demo-endpoints.pydantic.workers.dev/number',
            params={'min': 10, 'max': 30},
        ),
        ctx.deps.client.get(
            'https://demo-endpoints.pydantic.workers.dev/weather',
            params={'lat': lat, 'lng': lng},
        ),
    )
    temp_response.raise_for_status()
    descr_response.raise_for_status()
    return {
        'temperature': f'{temp_response.text} °C',
        'description': descr_response.text,
    }

# --- A2A Server Wrap ---

app = FastAPI()

# A2A Message Models
class A2APart(BaseModel):
    kind: str
    text: str

class A2AMessage(BaseModel):
    messageId: str
    role: str
    parts: List[A2APart]
    kind: str = "message"

class JSONRPCRequest(BaseModel):
    jsonrpc: str
    method: str
    params: Dict[str, Any]
    id: Any

@app.get("/.well-known/a2a/agent-card")
async def get_agent_card():
    """Expose the Agent Card to discovery."""
    return {
        "name": "Weather Agent",
        "description": "Can check weather for multiple cities.",
        "protocolVersion": "0.3.0",
        "version": "1.0.0",
        "url": "http://localhost:8000/a2a/jsonrpc",
        "skills": [
            {"name": "check_weather", "description": "Check the weather"}
        ],
        "defaultInputModes": ["text"],
        "defaultOutputModes": ["text"],
        "additionalInterfaces": [
            { "url": "http://localhost:8000/a2a/jsonrpc", "transport": "JSONRPC" }
        ],
        "capabilities": {}
    }

@app.post("/a2a/jsonrpc")
async def handle_jsonrpc(request: JSONRPCRequest):
    """Handle incoming A2A messages via JSON-RPC."""
    if request.method not in ["a2a.interaction.send_message", "sendMessage"]:
        # Fallback for some clients that might use method name directly
        pass

    # Extract the message text
    params = request.params
    # structure might be params -> message -> parts
    message_data = params.get("message", {})
    parts = message_data.get("parts", [])
    user_query = " ".join([p.get("text", "") for p in parts if p.get("kind") == "text"])

    print(f"Received query: {user_query}")

    # Run the Agent
    async with AsyncClient() as client:
        deps = Deps(client=client)
        result = await weather_agent.run(user_query, deps=deps)
        response_text = result.data

    # return the response
    return {
        "jsonrpc": "2.0",
        "result": {
            "kind": "message",
            "messageId": str(uuid.uuid4()),
            "role": "assistant",
            "parts": [{"kind": "text", "text": str(response_text)}],
            "created": datetime.now().isoformat()
        },
        "id": request.id
    }

if __name__ == "__main__":
    import uvicorn
    # Clean check for running locally
    uvicorn.run(app, host="0.0.0.0", port=8000)
