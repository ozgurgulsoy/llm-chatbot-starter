// React UI without a build step: React, htm, marked and DOMPurify load as ES modules
// from a CDN. When the app grows, these components move into a Vite project as they
// are (swap the html`...` templates for JSX).
import React, { useEffect, useMemo, useRef, useState } from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client?deps=react@18.3.1";
import htm from "https://esm.sh/htm@3.1.1";
import { marked } from "https://esm.sh/marked@12.0.2";
import DOMPurify from "https://esm.sh/dompurify@3.1.6";

const html = htm.bind(React.createElement);

marked.setOptions({ gfm: true, breaks: true });
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const STORE_KEY = "chatbot.conversations.v1";

const SUGGESTIONS = [
  "Explain how streaming responses work, in one paragraph",
  "Draft a short follow-up email to a client who went quiet",
  "Give me five name ideas for a neighborhood bakery",
  "What should I check before deploying a FastAPI app?",
];

const PROVIDER_NAMES = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  mock: "Mock mode, no API key needed",
};

// ---------- helpers ----------

const uid = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function makeTitle(text) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= 48) return clean;
  const cut = clean.slice(0, 48);
  return cut.slice(0, cut.lastIndexOf(" ") > 24 ? cut.lastIndexOf(" ") : 48) + "…";
}

// Messages worth sending back to the model: no failed replies, no empty ones.
const cleanHistory = (messages) =>
  messages
    .filter((m) => !m.error && (m.role === "user" || m.content))
    .map(({ id, role, content }) => ({ id, role, content }));

function loadStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (raw && Array.isArray(raw.conversations)) {
      // A reply that was streaming when the page closed is kept as far as it got.
      const conversations = raw.conversations.map((c) => ({
        ...c,
        messages: c.messages.filter((m) => m.role === "user" || m.content).map((m) => ({ ...m, pending: false })),
      }));
      return { conversations, activeId: raw.activeId ?? null };
    }
  } catch {}
  return { conversations: [], activeId: null };
}

function saveStore(store) {
  try {
    const conversations = store.conversations.map((c) => ({ ...c, messages: cleanHistory(c.messages) }));
    localStorage.setItem(STORE_KEY, JSON.stringify({ conversations, activeId: store.activeId }));
  } catch {
    // Storage unavailable (private mode, quota): chats still work, they just won't survive a refresh.
  }
}

function groupLabel(ts) {
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(new Date(ts))) / 86400000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return "Previous 7 days";
  if (diff < 30) return "Previous 30 days";
  return "Older";
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = Object.assign(document.createElement("textarea"), { value: text });
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
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
    if (body.detail) return "The server rejected the request.";
  } catch {}
  return `The server returned an error (${response.status}).`;
}

// ---------- small components ----------

const ICONS = {
  plus: "M12 5v14M5 12h14",
  menu: "M4 7h16M4 12h16M4 17h10",
  pencil: "M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4",
  trash: "M5 7h14M10 11v6M14 11v6M7 7l1 13h8l1-13M9.5 7V4.5h5V7",
  copy: "M9 9h10v11H9zM15 9V4H5v11h4",
  check: "M5 12.5l4.5 4.5L19 7.5",
  refresh: "M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v5h-5",
  send: "M12 19V5M6 11l6-6 6 6",
  search: "M10.5 17.5a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4.5-4.5",
  close: "M6 6l12 12M18 6L6 18",
};

function Icon({ name, size = 18 }) {
  if (name === "stop") {
    return html`<svg width=${size} height=${size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
    </svg>`;
  }
  return html`<svg
    width=${size}
    height=${size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d=${ICONS[name]} />
  </svg>`;
}

function Markdown({ text, streaming }) {
  const ref = useRef(null);
  const markup = useMemo(() => DOMPurify.sanitize(marked.parse(text || "")), [text]);

  // Add a copy button to each code block. React resets the markup when it changes,
  // so this runs again after every streamed chunk.
  useEffect(() => {
    ref.current?.querySelectorAll("pre").forEach((pre) => {
      if (pre.querySelector(".copy-code")) return;
      const button = Object.assign(document.createElement("button"), {
        type: "button",
        className: "copy-code",
        textContent: "Copy",
      });
      button.addEventListener("click", async () => {
        await copyText(pre.querySelector("code")?.innerText ?? "");
        button.textContent = "Copied";
        setTimeout(() => (button.textContent = "Copy"), 1500);
      });
      pre.appendChild(button);
    });
  }, [markup]);

  return html`<div
    className=${`md${streaming ? " streaming" : ""}`}
    ref=${ref}
    dangerouslySetInnerHTML=${{ __html: markup }}
  />`;
}

function UserMessage({ message }) {
  return html`<div className="msg user"><div className="bubble">${message.content}</div></div>`;
}

function AssistantMessage({ message, canRegenerate, onRegenerate }) {
  const { content, pending, error } = message;
  const [copied, setCopied] = useState(false);

  async function copy() {
    await copyText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return html`<div className="msg assistant">
    ${content
      ? html`<${Markdown} text=${content} streaming=${pending} />`
      : pending && html`<span className="typing" role="status" aria-label="Writing a reply"><i></i><i></i><i></i></span>`}
    ${error &&
    html`<div className="msg-error" role="alert">
      <span>${error}</span>
      ${canRegenerate && html`<button type="button" className="text-btn" onClick=${onRegenerate}>Try again</button>`}
    </div>`}
    ${!pending &&
    content &&
    !error &&
    html`<div className="msg-actions">
      <button type="button" className="icon-btn" onClick=${copy} aria-label="Copy reply" title="Copy">
        <${Icon} name=${copied ? "check" : "copy"} size=${16} />
      </button>
      ${canRegenerate &&
      html`<button type="button" className="icon-btn" onClick=${onRegenerate} aria-label="Regenerate reply" title="Regenerate">
        <${Icon} name="refresh" size=${16} />
      </button>`}
      ${copied && html`<span className="action-note">Copied</span>`}
    </div>`}
  </div>`;
}

function ConversationItem({ conv, active, live, onSelect, onRename, onDelete }) {
  const [mode, setMode] = useState("view");
  const [draft, setDraft] = useState(conv.title);

  function save() {
    const title = draft.trim();
    if (title && title !== conv.title) onRename(conv.id, title);
    setMode("view");
  }

  if (mode === "rename") {
    return html`<li className="conv editing">
      <input
        className="rename"
        value=${draft}
        aria-label="Chat name"
        autoFocus
        onFocus=${(e) => e.target.select()}
        onChange=${(e) => setDraft(e.target.value)}
        onKeyDown=${(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setMode("view");
        }}
        onBlur=${save}
      />
    </li>`;
  }

  if (mode === "confirm") {
    return html`<li className="conv confirming">
      <span className="confirm-text">Delete this chat?</span>
      <button type="button" className="text-btn danger" onClick=${() => onDelete(conv.id)}>Delete</button>
      <button type="button" className="text-btn" onClick=${() => setMode("view")}>Cancel</button>
    </li>`;
  }

  return html`<li className=${`conv${active ? " active" : ""}`}>
    <button
      type="button"
      className="conv-main"
      onClick=${() => onSelect(conv.id)}
      onDoubleClick=${() => {
        setDraft(conv.title);
        setMode("rename");
      }}
      aria-current=${active ? "true" : undefined}
    >
      <span className="conv-title">${conv.title}</span>
      ${live && html`<span className="live-dot" title="Replying"></span>`}
    </button>
    <div className="conv-actions">
      <button
        type="button"
        className="icon-btn"
        aria-label=${`Rename “${conv.title}”`}
        title="Rename"
        onClick=${() => {
          setDraft(conv.title);
          setMode("rename");
        }}
      >
        <${Icon} name="pencil" size=${15} />
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label=${`Delete “${conv.title}”`}
        title="Delete"
        onClick=${() => setMode("confirm")}
      >
        <${Icon} name="trash" size=${15} />
      </button>
    </div>
  </li>`;
}

function Sidebar({ store, busyId, health, query, setQuery, onNew, onSelect, onRename, onDelete, onClose }) {
  const sorted = useMemo(
    () => [...store.conversations].sort((a, b) => b.updatedAt - a.updatedAt),
    [store.conversations]
  );
  const q = query.trim().toLowerCase();
  const filtered = q
    ? sorted.filter(
        (c) => c.title.toLowerCase().includes(q) || c.messages.some((m) => m.content.toLowerCase().includes(q))
      )
    : sorted;

  const groups = [];
  for (const conv of filtered) {
    const label = groupLabel(conv.updatedAt);
    if (!groups.length || groups[groups.length - 1].label !== label) groups.push({ label, items: [] });
    groups[groups.length - 1].items.push(conv);
  }

  return html`<aside className="sidebar" aria-label="Chat history">
    <div className="sidebar-top">
      <button type="button" className="new-chat" onClick=${onNew}>
        <${Icon} name="plus" size=${17} />
        <span>New chat</span>
      </button>
      <button type="button" className="icon-btn close-btn" onClick=${onClose} aria-label="Close chat history">
        <${Icon} name="close" />
      </button>
    </div>

    ${store.conversations.length > 0 &&
    html`<label className="search">
      <${Icon} name="search" size=${15} />
      <input
        type="search"
        placeholder="Search chats"
        value=${query}
        onChange=${(e) => setQuery(e.target.value)}
        aria-label="Search chats"
      />
    </label>`}

    <nav className="history">
      ${!store.conversations.length && html`<p className="history-empty">Your chats will appear here.</p>`}
      ${store.conversations.length > 0 &&
      !filtered.length &&
      html`<p className="history-empty">No chats match “${query.trim()}”.</p>`}
      ${groups.map(
        (g) => html`<section key=${g.label} className="history-group">
          <h2>${g.label}</h2>
          <ul>
            ${g.items.map(
              (c) => html`<${ConversationItem}
                key=${c.id}
                conv=${c}
                active=${c.id === store.activeId}
                live=${c.id === busyId}
                onSelect=${onSelect}
                onRename=${onRename}
                onDelete=${onDelete}
              />`
            )}
          </ul>
        </section>`
      )}
    </nav>

    ${health &&
    html`<footer className=${`model-status ${health.ready ? "ok" : "warn"}`}>
      <span className="dot" aria-hidden="true"></span>
      <span className="model-text">
        <strong>${health.ready ? health.model : "Model not configured"}</strong>
        <small>${health.ready ? PROVIDER_NAMES[health.provider] || health.provider : health.error}</small>
      </span>
    </footer>`}
  </aside>`;
}

function EmptyState({ health, onPick }) {
  return html`<div className="column empty">
    <h2 className="greeting">What are we working on?</h2>
    ${health && !health.ready && html`<p className="setup-hint">${health.error}</p>`}
    <ul className="suggestions">
      ${SUGGESTIONS.map(
        (s) => html`<li key=${s}><button type="button" onClick=${() => onPick(s)}>${s}</button></li>`
      )}
    </ul>
  </div>`;
}

function Composer({ busy, onSend, onStop, inputRef }) {
  const [value, setValue] = useState("");

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  function submit(event) {
    event?.preventDefault();
    if (busy || !value.trim()) return;
    onSend(value);
    setValue("");
  }

  function onKeyDown(event) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape" && busy) {
      onStop();
    }
  }

  return html`<div className="composer-area">
    <form className="composer" onSubmit=${submit}>
      <textarea
        ref=${inputRef}
        rows="1"
        value=${value}
        placeholder="Message the assistant"
        aria-label="Message"
        onChange=${(e) => setValue(e.target.value)}
        onKeyDown=${onKeyDown}
      ></textarea>
      ${busy
        ? html`<button type="button" className="send stop" onClick=${onStop} aria-label="Stop the reply" title="Stop (Esc)">
            <${Icon} name="stop" />
          </button>`
        : html`<button type="submit" className="send" disabled=${!value.trim()} aria-label="Send message" title="Send">
            <${Icon} name="send" />
          </button>`}
    </form>
    <p className="composer-hint">Enter sends. Shift + Enter adds a line.</p>
  </div>`;
}

// ---------- app ----------

function App() {
  const [store, setStore] = useState(loadStore);
  const [busyId, setBusyId] = useState(null);
  const [health, setHealth] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [query, setQuery] = useState("");
  const abortRef = useRef(null);
  const inputRef = useRef(null);
  const scrollRef = useRef(null);
  const stickRef = useRef(true);

  const active = store.conversations.find((c) => c.id === store.activeId) || null;
  const busy = busyId !== null;

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth({ ready: false, error: "Can't reach the server. Is it running?" }));
  }, []);

  useEffect(() => {
    if (!busy) saveStore(store);
  }, [store, busy]);

  useEffect(() => {
    document.title = active ? `${active.title} · Chatbot` : "Chatbot";
  }, [active?.title]);

  // Follow the reply as it streams, unless the reader has scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [active?.messages]);

  useEffect(() => {
    stickRef.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    inputRef.current?.focus();
  }, [store.activeId]);

  function onScroll() {
    const el = scrollRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  const patchConversation = (id, fn) =>
    setStore((s) => ({ ...s, conversations: s.conversations.map((c) => (c.id === id ? fn(c) : c)) }));

  const patchLastMessage = (id, patch) =>
    patchConversation(id, (c) => {
      if (!c.messages.length) return c;
      const messages = c.messages.slice();
      const last = messages[messages.length - 1];
      messages[messages.length - 1] = { ...last, ...(typeof patch === "function" ? patch(last) : patch) };
      return { ...c, messages };
    });

  async function streamReply(convId, history) {
    patchConversation(convId, (c) => ({
      ...c,
      messages: [...history, { id: uid(), role: "assistant", content: "", pending: true }],
      updatedAt: Date.now(),
    }));
    setBusyId(convId);
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
        patchLastMessage(convId, { pending: false, error: await errorFrom(response) });
        return;
      }
      for await (const event of readEvents(response)) {
        if (event.type === "delta") patchLastMessage(convId, (m) => ({ content: m.content + event.text }));
        else if (event.type === "error") patchLastMessage(convId, { error: event.message });
      }
      patchLastMessage(convId, { pending: false });
    } catch (err) {
      patchLastMessage(
        convId,
        err.name === "AbortError"
          ? { pending: false }
          : { pending: false, error: "The connection to the server was lost. Check that it's running, then try again." }
      );
    } finally {
      abortRef.current = null;
      setBusyId(null);
    }
  }

  function send(text) {
    const content = text.trim();
    if (!content || busy) return;
    stickRef.current = true;
    const userMessage = { id: uid(), role: "user", content };

    let conv = active;
    if (!conv) {
      conv = { id: uid(), title: makeTitle(content), messages: [], updatedAt: Date.now() };
      const created = conv;
      setStore((s) => ({ conversations: [created, ...s.conversations], activeId: created.id }));
    }
    streamReply(conv.id, [...cleanHistory(conv.messages), userMessage]);
  }

  function regenerate() {
    if (!active || busy) return;
    const messages = active.messages.slice();
    while (messages.length && messages[messages.length - 1].role === "assistant") messages.pop();
    const history = cleanHistory(messages);
    if (history.length && history[history.length - 1].role === "user") streamReply(active.id, history);
  }

  const stop = () => abortRef.current?.abort();

  function newChat() {
    setStore((s) => ({ ...s, activeId: null }));
    setSidebarOpen(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function select(id) {
    setStore((s) => ({ ...s, activeId: id }));
    setSidebarOpen(false);
  }

  const rename = (id, title) => patchConversation(id, (c) => ({ ...c, title }));

  function remove(id) {
    if (id === busyId) stop();
    setStore((s) => ({
      conversations: s.conversations.filter((c) => c.id !== id),
      activeId: s.activeId === id ? null : s.activeId,
    }));
  }

  const lastIndex = active ? active.messages.length - 1 : -1;

  return html`<div className=${`app${sidebarOpen ? " sidebar-open" : ""}`}>
    <${Sidebar}
      store=${store}
      busyId=${busyId}
      health=${health}
      query=${query}
      setQuery=${setQuery}
      onNew=${newChat}
      onSelect=${select}
      onRename=${rename}
      onDelete=${remove}
      onClose=${() => setSidebarOpen(false)}
    />
    <div className="scrim" onClick=${() => setSidebarOpen(false)} aria-hidden="true"></div>

    <main className="main">
      <header className="topbar">
        <button type="button" className="icon-btn menu-btn" onClick=${() => setSidebarOpen(true)} aria-label="Open chat history">
          <${Icon} name="menu" />
        </button>
        <h1 className="topbar-title">${active ? active.title : "New chat"}</h1>
        <button type="button" className="icon-btn topbar-new" onClick=${newChat} aria-label="New chat" title="New chat">
          <${Icon} name="plus" />
        </button>
      </header>

      <div className="messages" ref=${scrollRef} onScroll=${onScroll}>
        ${active && active.messages.length
          ? html`<div className="column thread">
              ${active.messages.map((m, i) =>
                m.role === "user"
                  ? html`<${UserMessage} key=${m.id} message=${m} />`
                  : html`<${AssistantMessage}
                      key=${m.id}
                      message=${m}
                      canRegenerate=${i === lastIndex && !busy}
                      onRegenerate=${regenerate}
                    />`
              )}
            </div>`
          : html`<${EmptyState} health=${health} onPick=${send} />`}
      </div>

      <div className="composer-wrap">
        <div className="column">
          <${Composer} busy=${busy} onSend=${send} onStop=${stop} inputRef=${inputRef} />
        </div>
      </div>
    </main>
  </div>`;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
