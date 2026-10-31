"""FastAPI app: a health endpoint, a streaming chat endpoint, and the static UI."""

import logging
from functools import lru_cache
from typing import Literal

from fastapi import FastAPI
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .chat import ChatError, prepare_messages, stream_reply
from .config import ROOT_DIR, settings
from .providers import ProviderConfigError, create_provider

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

app = FastAPI(title="LLM Chatbot Starter")


class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    messages: list[Message] = Field(min_length=1, max_length=200)


@lru_cache(maxsize=1)
def get_provider():
    """Create the provider once. Returns (provider, None) or (None, error message)."""
    try:
        return create_provider(
            settings.provider, settings.model, settings.max_output_tokens, settings.request_timeout
        ), None
    except ProviderConfigError as e:
        return None, str(e)


@app.get("/api/health")
def health():
    provider, error = get_provider()
    return {
        "provider": settings.provider,
        "model": settings.model,
        "ready": provider is not None,
        "error": error,
    }


@app.post("/api/chat")
async def chat(request: ChatRequest):
    try:
        messages = prepare_messages(
            [m.model_dump() for m in request.messages],
            settings.max_message_chars,
            settings.max_history_chars,
        )
    except ChatError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})

    provider, error = get_provider()
    if provider is None:
        return JSONResponse(status_code=503, content={"error": error})

    return StreamingResponse(
        stream_reply(provider, settings.system_prompt(), messages),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# Mounted last so the /api routes above take precedence.
app.mount("/", StaticFiles(directory=ROOT_DIR / "static", html=True), name="static")
