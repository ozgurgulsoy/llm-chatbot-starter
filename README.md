# LLM Chatbot Starter

A small, clean chatbot prototype: a FastAPI backend that streams replies from OpenAI, Claude or Gemini, and a lightweight React chat UI. It is meant as a solid base to build on, not a framework.

## Features

- Chat UI with streaming replies, a Stop button, and a **New chat** reset
- Conversation context: the full history is sent with each turn and trimmed to a budget on the server
- Configurable system prompt in `system_prompt.txt` (picked up without a restart)
- One environment variable switches the provider: `openai`, `anthropic`, `gemini`, or `mock`
- Clear error handling: bad API key, rate limits, timeouts and network failures show a readable message with a Retry button
- Mock mode, so you can run the app without an API key
- Chat survives a page refresh (stored in the browser)

## Quick start

Requires Python 3.10+.

```bash
git clone https://github.com/ozgurgulsoy/llm-chatbot-starter.git
cd llm-chatbot-starter

python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env             # then edit .env
uvicorn app.main:app --reload
```

Open http://localhost:8000.

With the default `.env` the app runs in mock mode. To use a real model, set the provider and its key:

```bash
LLM_PROVIDER=openai              # or anthropic, gemini
OPENAI_API_KEY=sk-...
```

The header shows which provider and model are active. If something is missing, it says what.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `LLM_PROVIDER` | `mock` | `openai`, `anthropic`, `gemini` or `mock` |
| `LLM_MODEL` | per provider | Override the model, e.g. a larger or newer one |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` | | Key for the chosen provider |
| `MAX_OUTPUT_TOKENS` | `1024` | Maximum reply length |
| `REQUEST_TIMEOUT_SECONDS` | `60` | Give up on a slow provider after this |
| `MAX_HISTORY_CHARS` | `24000` | How much recent conversation is sent to the model |
| `MAX_MESSAGE_CHARS` | `8000` | Longest single message accepted |
| `SYSTEM_PROMPT_FILE` | `system_prompt.txt` | Where the system prompt lives |

Default models: `gpt-4o-mini` (OpenAI), `claude-haiku-5-5` (Anthropic), `gemini-3.6-flash` (Gemini). Model lineups change often, so set `LLM_MODEL` to whatever you want to use.

## How it works

```
Browser (React)  ──POST /api/chat {messages}──▶  FastAPI
                 ◀── server-sent events ───────  ├─ validate + trim history (app/chat.py)
                                                 └─ provider.stream()      (app/providers.py)
```

- **Stateless backend.** The browser keeps the conversation and sends it with each message. The server validates it, trims it to `MAX_HISTORY_CHARS` (always keeping the latest message and starting on a user turn), adds the system prompt and streams the reply. No database is needed at this stage, and adding one later doesn't change the API.
- **Streaming.** Replies arrive as server-sent events: `delta` chunks, then `done` or `error`. Errors that happen mid-stream still reach the UI.
- **Providers.** Each provider is one small class with the same `stream()` method. Adding another provider means adding one class.
- **No front-end build step.** React and [htm](https://github.com/developit/htm) load as ES modules, so there's nothing to compile. When the UI grows, the components move into a Vite project as they are.

## Project structure

```
app/
  main.py         FastAPI routes: /api/health, /api/chat, static files
  chat.py         History validation, trimming, SSE streaming, error messages
  providers.py    OpenAI, Anthropic, Gemini and mock providers
  config.py       Settings from environment variables
static/           Chat UI (index.html, app.js, styles.css)
tests/            Unit tests for the chat logic
system_prompt.txt
```

## Tests

```bash
python -m unittest discover tests
```

The tests cover history validation and trimming, streaming, and how provider failures surface to the user. They use the standard library only and need no API key.

## Natural next steps

Left out on purpose for the prototype: authentication, saving conversations in a database, analytics, and retrieval (RAG). The structure leaves room for each without a rewrite.
