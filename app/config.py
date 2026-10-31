"""Settings, read once from environment variables (and an optional .env file)."""

import os
from dataclasses import dataclass
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent

try:  # python-dotenv is optional; plain environment variables work too
    from dotenv import load_dotenv

    load_dotenv(ROOT_DIR / ".env")
except ImportError:
    pass

DEFAULT_MODELS = {
    "openai": "gpt-4o-mini",
    "anthropic": "claude-haiku-5-5",
    "gemini": "gemini-3.6-flash",
    "mock": "mock-echo",
}


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    provider: str
    model: str
    max_output_tokens: int
    request_timeout: int
    max_history_chars: int
    max_message_chars: int
    system_prompt_file: Path

    def system_prompt(self) -> str:
        """Read on every request, so edits to the prompt file apply without a restart."""
        try:
            return self.system_prompt_file.read_text(encoding="utf-8").strip()
        except OSError:
            return "You are a helpful assistant."


def load_settings() -> Settings:
    provider = os.getenv("LLM_PROVIDER", "mock").strip().lower()
    prompt_file = Path(os.getenv("SYSTEM_PROMPT_FILE", "system_prompt.txt"))
    if not prompt_file.is_absolute():
        prompt_file = ROOT_DIR / prompt_file
    return Settings(
        provider=provider,
        model=os.getenv("LLM_MODEL", "").strip() or DEFAULT_MODELS.get(provider, ""),
        max_output_tokens=_int("MAX_OUTPUT_TOKENS", 1024),
        request_timeout=_int("REQUEST_TIMEOUT_SECONDS", 60),
        max_history_chars=_int("MAX_HISTORY_CHARS", 24000),
        max_message_chars=_int("MAX_MESSAGE_CHARS", 8000),
        system_prompt_file=prompt_file,
    )


settings = load_settings()
