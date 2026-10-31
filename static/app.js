// React UI without a build step: React and htm load as ES modules from a CDN.
// When the app grows, the same components move into a Vite project unchanged
// (swap the html`...` templates for JSX).
import React, { useEffect, useRef, useState } from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client?deps=react@18.3.1";
import htm from "https://esm.sh/htm@3.1.1";

const html = htm.bind(React.createElement);
const STORAGE_KEY = "chatbot.messages";

function loadMessages() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter((m) => m && m.role && typeof m.content === "string") : [];
  } catch {
    return [];
  }
}

function saveMessages(messages) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.map(({ role, content }) => ({ role, content }))));
  } catch {
    // storage unavailable (private mode etc.): the chat still works, it just won't survive a refresh
  }
}

// Parse a server-sent event stream from a fetch() response.
async function* readEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) yield JSON.parse(data);
    }
  }
}

async function errorFrom(response) {
  try {
    const body = await response.json();
    if (typeof body.error === "string") return body.error;
    if (body.detail) return "The request was rejected by the server.";
  } catch {}
  return `Server error (${response.status}).`;
}

function Message({ message, onRetry }) {
  const { role, content, error, pending } = message;
  return html`
    <div className=${`msg ${role}`}>
      <div className="bubble">
        ${content}
        ${pending && !content && html`<span className="typing" aria-label="Thinking"><i></i><i></i><i></i></span>`}
        ${error && html`
          <div className="error">
            <span>${error}</span>
            ${onRetry && html`<button className="link" onClick=${onRetry}>Retry</button>`}
          </div>
        `}
      </div>
    </div>
  `;
}

function App() {
  const [messages, setMessages] = useState(loadMessages);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState(null);
  const abortRef = useRef(null);
  const endRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth({ ready: false, error: "Can't reach the backend." }));
  }, []);

  useEffect(() => {
    if (!busy) saveMessages(messages.filter((m) => !m.error));
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);

  const updateLast = (patch) =>
    setMessages((prev) => {
      if (!prev.length) return prev; // chat was reset while a reply was streaming
      const next = prev.slice();
      const last = next[next.length - 1];
      next[next.length - 1] = { ...last, ...(typeof patch === "function" ? patch(last) : patch) };
      return next;
    });

  async function send(history) {
    setMessages([...history, { role: "assistant", content: "", pending: true }]);
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history.map(({ role, content }) => ({ role, content })) }),
        signal: controller.signal,
      });
      if (!response.ok) {
        updateLast({ pending: false, error: await errorFrom(response) });
        return;
      }
      for await (const event of readEvents(response)) {
        if (event.type === "delta") updateLast((m) => ({ content: m.content + event.text }));
        else if (event.type === "error") updateLast({ error: event.message });
      }
      updateLast({ pending: false });
    } catch (err) {
      if (err.name === "AbortError") updateLast({ pending: false });
      else updateLast({ pending: false, error: "Connection lost. Check that the server is running." });
    } finally {
      abortRef.current = null;
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  function submit(event) {
    event?.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    const history = messages.filter((m) => !m.error && (m.content || m.role === "user"));
    send([...history, { role: "user", content: text }]);
  }

  function retry() {
    // Drop the failed reply and send the same conversation again.
    const history = messages.slice(0, -1).filter((m) => !m.error);
    if (history.length && history[history.length - 1].role === "user") send(history);
  }

  function newChat() {
    abortRef.current?.abort();
    setMessages([]);
    setInput("");
    saveMessages([]);
    inputRef.current?.focus();
  }

  function onKeyDown(event) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) submit(event);
  }

  const lastIndex = messages.length - 1;

  return html`
    <div className="app">
      <header>
        <div className="title">
          <strong>Chatbot</strong>
          ${health &&
          html`<span className=${`badge ${health.ready ? "ok" : "warn"}`} title=${health.error || ""}>
            ${health.ready ? `${health.provider} · ${health.model}` : "not configured"}
          </span>`}
        </div>
        <button className="ghost" onClick=${newChat} disabled=${!messages.length && !busy}>New chat</button>
      </header>

      <main>
        ${!messages.length &&
        html`<div className="empty">
          <h1>How can I help?</h1>
          ${health && !health.ready && html`<p className="hint">${health.error}</p>`}
        </div>`}
        ${messages.map(
          (m, i) => html`<${Message}
            key=${i}
            message=${m}
            onRetry=${i === lastIndex && m.error && !busy ? retry : null}
          />`
        )}
        <div ref=${endRef}></div>
      </main>

      <form onSubmit=${submit}>
        <textarea
          ref=${inputRef}
          rows="1"
          value=${input}
          placeholder="Message the chatbot…"
          onChange=${(e) => setInput(e.target.value)}
          onKeyDown=${onKeyDown}
          autoFocus
        ></textarea>
        ${busy
          ? html`<button type="button" className="primary" onClick=${() => abortRef.current?.abort()}>Stop</button>`
          : html`<button type="submit" className="primary" disabled=${!input.trim()}>Send</button>`}
      </form>
    </div>
  `;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
