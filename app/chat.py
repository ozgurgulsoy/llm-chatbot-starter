"""Provider-independent chat logic: validating and trimming history, and turning a
provider's text stream into server-sent events. No web framework imports here,
so this module is easy to test on its own."""

import json
import logging
from typing import AsyncIterator, Iterable

log = logging.getLogger("chatbot")

ROLES = {"user", "assistant"}


class ChatError(ValueError):
    """The request itself is invalid (shown to the user as a 400)."""


def prepare_messages(raw: Iterable[dict], max_message_chars: int, max_history_chars: int) -> list[dict]:
    """Validate the conversation sent by the client and trim it to fit the context budget."""
    messages = []
    for item in raw:
        role = item.get("role")
        content = (item.get("content") or "").strip()
        if role not in ROLES:
            raise ChatError(f"Unknown role: {role!r}")
        if not content:
            continue  # skip empty turns, e.g. an assistant reply that was stopped before any text
        if len(content) > max_message_chars:
            raise ChatError(f"Message is too long (limit is {max_message_chars} characters).")
        messages.append({"role": role, "content": content})

    if not messages or messages[-1]["role"] != "user":
        raise ChatError("The last message must come from the user.")
    return trim_history(merge_consecutive(messages), max_history_chars)


def merge_consecutive(messages: list[dict]) -> list[dict]:
    """Providers expect alternating turns; merge back-to-back messages from the same role."""
    merged: list[dict] = []
    for m in messages:
        if merged and merged[-1]["role"] == m["role"]:
            merged[-1] = {"role": m["role"], "content": merged[-1]["content"] + "\n\n" + m["content"]}
        else:
            merged.append(dict(m))
    return merged


def trim_history(messages: list[dict], max_chars: int) -> list[dict]:
    """Keep the most recent messages that fit in max_chars.

    The latest message is always kept, and the result always starts with a user
    turn, which every provider accepts. Characters are a rough, dependency-free
    stand-in for tokens; swap in a tokenizer if you need precision."""
    kept: list[dict] = []
    total = 0
    for m in reversed(messages):
        size = len(m["content"])
        if kept and total + size > max_chars:
            break
        kept.append(m)
        total += size
    kept.reverse()
    while len(kept) > 1 and kept[0]["role"] != "user":
        kept.pop(0)
    return kept


def sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


def friendly_error(exc: Exception) -> str:
    """Map SDK exceptions (OpenAI, Anthropic, Gemini) to a message a user can act on,
    without importing every SDK's exception classes."""
    name = type(exc).__name__
    status = getattr(exc, "status_code", None) or getattr(exc, "code", None)
    if "Authentication" in name or "PermissionDenied" in name or status in (401, 403):
        return "The API key was rejected. Check the key in your .env file."
    if "RateLimit" in name or status == 429:
        return "The model provider is rate limiting requests. Try again in a moment."
    if "Timeout" in name:
        return "The model took too long to respond. Try again."
    if "Connection" in name:
        return "Couldn't reach the model provider. Check your network connection."
    if "NotFound" in name or status == 404:
        return "The model wasn't found. Check LLM_MODEL in your .env file."
    if "BadRequest" in name or status == 400:
        return "The model provider rejected the request."
    return "Something went wrong while generating a reply."


async def stream_reply(provider, system_prompt: str, messages: list[dict]) -> AsyncIterator[str]:
    """Yield SSE events: {"type": "delta"} chunks, then {"type": "done"} or {"type": "error"}."""
    try:
        async for text in provider.stream(system_prompt, messages):
            if text:
                yield sse({"type": "delta", "text": text})
        yield sse({"type": "done"})
    except Exception as exc:  # report every provider failure to the client instead of dropping the stream
        log.exception("Provider %s failed", getattr(provider, "name", "?"))
        yield sse({"type": "error", "message": friendly_error(exc)})
