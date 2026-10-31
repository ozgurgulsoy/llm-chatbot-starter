"""One small class per model provider. Each exposes the same method:

    async def stream(system_prompt, messages) -> async iterator of text chunks

SDKs are imported lazily, so you only need the package for the provider you use.
Adding a provider means adding one class and one line in PROVIDERS."""

import asyncio
import os
from typing import AsyncIterator


class ProviderConfigError(RuntimeError):
    """The selected provider can't start (missing key or package)."""


def _require_env(*names: str) -> None:
    if not any(os.getenv(n) for n in names):
        raise ProviderConfigError(f"{' or '.join(names)} is not set. Add it to your .env file.")


class MockProvider:
    """Streams a canned reply, so the app runs without an API key."""

    name = "mock"

    def __init__(self, model: str, **_):
        self.model = model

    async def stream(self, system_prompt: str, messages: list[dict]) -> AsyncIterator[str]:
        last = messages[-1]["content"]
        turns = sum(1 for m in messages if m["role"] == "user")
        reply = (
            f"(mock mode) You said: \"{last[:200]}\". This is message {turns} in our conversation. "
            "Set LLM_PROVIDER and an API key in .env to talk to a real model."
        )
        for word in reply.split(" "):
            await asyncio.sleep(0.03)
            yield word + " "


class OpenAIProvider:
    name = "openai"

    def __init__(self, model: str, max_output_tokens: int, timeout: int):
        _require_env("OPENAI_API_KEY")
        try:
            from openai import AsyncOpenAI
        except ImportError as e:
            raise ProviderConfigError("The 'openai' package is not installed.") from e
        self.client = AsyncOpenAI(timeout=timeout, max_retries=2)
        self.model = model
        self.max_output_tokens = max_output_tokens

    async def stream(self, system_prompt: str, messages: list[dict]) -> AsyncIterator[str]:
        stream = await self.client.chat.completions.create(
            model=self.model,
            messages=[{"role": "system", "content": system_prompt}, *messages],
            max_completion_tokens=self.max_output_tokens,
            stream=True,
        )
        async for chunk in stream:
            if chunk.choices and chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content


class AnthropicProvider:
    name = "anthropic"

    def __init__(self, model: str, max_output_tokens: int, timeout: int):
        _require_env("ANTHROPIC_API_KEY")
        try:
            from anthropic import AsyncAnthropic
        except ImportError as e:
            raise ProviderConfigError("The 'anthropic' package is not installed.") from e
        self.client = AsyncAnthropic(timeout=timeout, max_retries=2)
        self.model = model
        self.max_output_tokens = max_output_tokens

    async def stream(self, system_prompt: str, messages: list[dict]) -> AsyncIterator[str]:
        async with self.client.messages.stream(
            model=self.model,
            system=system_prompt,
            messages=messages,
            max_tokens=self.max_output_tokens,
        ) as stream:
            async for text in stream.text_stream:
                yield text


class GeminiProvider:
    name = "gemini"

    def __init__(self, model: str, max_output_tokens: int, timeout: int):
        _require_env("GEMINI_API_KEY", "GOOGLE_API_KEY")
        try:
            from google import genai
            from google.genai import types
        except ImportError as e:
            raise ProviderConfigError("The 'google-genai' package is not installed.") from e
        self.types = types
        self.client = genai.Client(http_options=types.HttpOptions(timeout=timeout * 1000))
        self.model = model
        self.max_output_tokens = max_output_tokens

    async def stream(self, system_prompt: str, messages: list[dict]) -> AsyncIterator[str]:
        t = self.types
        contents = [
            t.Content(role="model" if m["role"] == "assistant" else "user", parts=[t.Part(text=m["content"])])
            for m in messages
        ]
        stream = await self.client.aio.models.generate_content_stream(
            model=self.model,
            contents=contents,
            config=t.GenerateContentConfig(
                system_instruction=system_prompt,
                max_output_tokens=self.max_output_tokens,
            ),
        )
        async for chunk in stream:
            if chunk.text:
                yield chunk.text


PROVIDERS = {
    "mock": MockProvider,
    "openai": OpenAIProvider,
    "anthropic": AnthropicProvider,
    "gemini": GeminiProvider,
}


def create_provider(name: str, model: str, max_output_tokens: int, timeout: int):
    cls = PROVIDERS.get(name)
    if cls is None:
        raise ProviderConfigError(
            f"Unknown LLM_PROVIDER {name!r}. Use one of: {', '.join(PROVIDERS)}."
        )
    return cls(model=model, max_output_tokens=max_output_tokens, timeout=timeout)
