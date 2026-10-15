import React, { useState, useEffect, useMemo, useRef } from "react";

const API_URL = (
  import.meta.env.VITE_API_URL ||
  import.meta.env.VITE_API_BASE_URL ||
  "http://localhost:8000"
).replace(/\/$/, "");

const STORAGE_KEY = "incite_ai_history";
const MAX_HISTORY = 100;

function safeSourceUrl(value) {
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

function validSummary(item) {
  return (
    item &&
    Number.isSafeInteger(item.id) &&
    typeof item.title === "string" &&
    item.title.length <= 512 &&
    Array.isArray(item.summary) &&
    item.summary.length >= 1 &&
    item.summary.length <= 7 &&
    item.summary.every(
      (point) => typeof point === "string" && point.length <= 2000,
    )
  );
}

export default function App() {
  const [history, setHistory] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      const parsed = saved ? JSON.parse(saved) : [];
      return Array.isArray(parsed)
        ? parsed.filter(validSummary).slice(0, MAX_HISTORY)
        : [];
    } catch {
      return [];
    }
  });

  // Track explicitly whether user clicked "+" to start a new chat
  const [isNewChat, setIsNewChat] = useState(false);
  const [activeChat, setActiveChat] = useState(null);
  const [url, setUrl] = useState("");
  const [length, setLength] = useState("medium");
  const [bullets, setBullets] = useState(5);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(
    () => window.innerWidth >= 768,
  );
  const [copiedId, setCopiedId] = useState(null);
  const requestRef = useRef(null);
  const copyTimerRef = useRef(null);
  useEffect(
    () => () => {
      requestRef.current?.abort();
      clearTimeout(copyTimerRef.current);
    },
    [],
  );

  // Sync state to localStorage whenever history changes
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    } catch (e) {
      console.error("Failed to write to localStorage:", e);
    }
  }, [history]);

  // Sort history: pinned items first, then newer items
  const sortedHistory = useMemo(
    () =>
      [...history].sort((a, b) => {
        if (Boolean(b.is_pinned) !== Boolean(a.is_pinned)) {
          return (b.is_pinned ? 1 : 0) - (a.is_pinned ? 1 : 0);
        }
        return (
          (Date.parse(b.created_at) || b.id || 0) -
          (Date.parse(a.created_at) || a.id || 0)
        );
      }),
    [history],
  );

  const handleStartNewChat = () => {
    setIsNewChat(true);
    setActiveChat(null);
    setUrl("");
    setError("");
    if (window.innerWidth < 768) setSidebarOpen(false);
  };

  const handleSelectChat = (item) => {
    setIsNewChat(false);
    setActiveChat(item);
    setError("");
  };

  const handleSummarize = async (e) => {
    if (e) e.preventDefault();
    const targetUrl = url.trim();
    if (!targetUrl || loading) return;

    try {
      if (!safeSourceUrl(targetUrl) || targetUrl.length > 2048)
        throw new Error();
    } catch {
      setError("Enter a valid public http(s) article URL.");
      return;
    }
    setError("");
    setLoading(true);
    const controller = new AbortController();
    requestRef.current = controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 65000);

    try {
      const res = await fetch(`${API_URL}/scrape`, {
        method: "POST",
        signal: controller.signal,
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: targetUrl,
          length,
          bullets: Number(bullets),
        }),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          typeof data?.detail === "string"
            ? data.detail
            : res.status === 429
              ? "Too many requests. Please wait a minute and try again."
              : "Unable to summarize article. Please try again.",
        );
      }

      if (controller.signal.aborted)
        throw new DOMException("Cancelled", "AbortError");
      if (!validSummary(data)) {
        throw new Error(
          "The server returned an invalid summary. Please try again.",
        );
      }
      setHistory((prev) =>
        [data, ...prev.filter((item) => item.id !== data.id)].slice(
          0,
          MAX_HISTORY,
        ),
      );

      setIsNewChat(false);
      setActiveChat(data);
      setUrl("");
    } catch (err) {
      setError(
        err.name === "AbortError"
          ? timedOut
            ? "The request timed out. Please try again."
            : "Request cancelled."
          : err.message || "Failed to reach backend.",
      );
    } finally {
      clearTimeout(timeout);
      requestRef.current = null;
      setLoading(false);
    }
  };

  const handleTogglePin = (e, id) => {
    e.stopPropagation();

    setHistory((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, is_pinned: !item.is_pinned } : item,
      ),
    );

    if (activeChat?.id === id) {
      setActiveChat((prev) =>
        prev ? { ...prev, is_pinned: !prev.is_pinned } : null,
      );
    }
  };

  const handleDelete = (e, id) => {
    e.stopPropagation();
    setHistory((prev) => prev.filter((item) => item.id !== id));
    if (activeChat?.id === id) setActiveChat(null);
  };

  const handleCopy = async (id, bulletsList) => {
    if (!bulletsList) return;
    try {
      await navigator.clipboard.writeText(
        bulletsList.map((b) => `• ${b}`).join("\n"),
      );
    } catch {
      setError("Unable to copy. Select the summary text and copy it manually.");
      return;
    }
    setCopiedId(id);
    clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopiedId(null), 2000);
  };

  // Determine which article to render
  const currentChat = isNewChat
    ? null
    : activeChat || (sortedHistory.length > 0 ? sortedHistory[0] : null);

  return (
    <div className="flex h-dvh bg-[#131314] text-[#E3E3E3] font-sans overflow-hidden antialiased">
      {/* ----------------- CHATBOT SIDEBAR ----------------- */}
      <aside
        id="research-history"
        aria-label="Saved summaries"
        inert={!sidebarOpen}
        className={`${
          sidebarOpen ? "w-72" : "w-0"
        } max-md:absolute max-md:h-full transition-all duration-300 ease-in-out bg-[#1E1F20] border-r border-[#2D2F31] flex flex-col z-20 overflow-hidden shrink-0`}
      >
        <div className="p-4 flex items-center justify-between border-b border-[#2D2F31]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center font-bold text-white shadow-md">
              <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
                <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
              </svg>
            </div>
            <span className="font-semibold text-lg tracking-tight text-white">
              Incite AI
            </span>
          </div>

          <button
            onClick={handleStartNewChat}
            className="p-1.5 hover:bg-[#282A2C] rounded-lg text-gray-400 hover:text-white transition flex items-center gap-1 text-xs"
            title="New Research Session"
          >
            <svg
              className="w-5 h-5 stroke-current"
              fill="none"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 4v16m8-8H4"
              />
            </svg>
          </button>
        </div>

        <div className="flex justify-between px-4 py-2 text-xs">
          <button
            type="button"
            onClick={() => {
              setHistory([]);
              setActiveChat(null);
              setIsNewChat(true);
            }}
            className="text-gray-400 hover:text-white"
          >
            Clear history
          </button>
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            className="text-gray-400 hover:text-white md:hidden"
            aria-label="Close sidebar"
          >
            Close
          </button>
        </div>
        {/* History List */}
        <div className="flex-1 overflow-y-auto px-2 py-3 space-y-1">
          <div className="px-3 pb-2 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
            Recent Research
          </div>

          {sortedHistory.length === 0 ? (
            <div className="text-center py-10 px-4 text-xs text-gray-500">
              No saved chats yet.
            </div>
          ) : (
            sortedHistory.map((item) => {
              const isActive = !isNewChat && currentChat?.id === item.id;
              return (
                <div
                  key={item.id}
                  className={`group relative flex items-center justify-between px-3 py-2.5 rounded-lg text-sm cursor-pointer transition ${
                    isActive
                      ? "bg-[#004A77] text-white font-medium"
                      : "hover:bg-[#282A2C] text-gray-300"
                  }`}
                >
                  <div className="flex items-center gap-2 overflow-hidden pr-10">
                    {item.is_pinned ? (
                      <span
                        className="text-yellow-400 text-xs shrink-0"
                        title="Pinned"
                      >
                        📌
                      </span>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => {
                        handleSelectChat(item);
                        if (window.innerWidth < 768) setSidebarOpen(false);
                      }}
                      aria-current={isActive ? "true" : undefined}
                      className="truncate text-left focus-visible:underline"
                    >
                      {item.title || "Untitled Summary"}
                    </button>
                  </div>

                  {/* Actions overlay: pin & delete */}
                  <div className="absolute right-2 flex items-center gap-1.5 bg-[#1E1F20] px-1 py-0.5 rounded opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => handleTogglePin(e, item.id)}
                      className={`p-1 text-xs transition ${
                        item.is_pinned
                          ? "text-yellow-400"
                          : "text-gray-400 hover:text-yellow-300"
                      }`}
                      title={item.is_pinned ? "Unpin chat" : "Pin to top"}
                    >
                      📌
                    </button>
                    <button
                      onClick={(e) => handleDelete(e, item.id)}
                      className="p-1 text-xs text-gray-400 hover:text-red-400 transition"
                      title="Delete chat"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* ----------------- MAIN VIEW ----------------- */}
      <main className="min-w-0 flex-1 flex flex-col relative h-full overflow-hidden bg-[#131314]">
        {/* Header */}
        <header className="h-14 border-b border-[#2D2F31] px-4 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3 overflow-hidden">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="p-2 hover:bg-[#282A2C] rounded-lg text-gray-400 hover:text-white transition"
              title="Toggle Sidebar"
              aria-expanded={sidebarOpen}
              aria-controls="research-history"
            >
              <svg
                className="w-5 h-5 stroke-current"
                fill="none"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4 6h16M4 12h16M4 18h16"
                />
              </svg>
            </button>
            <span className="text-sm font-medium text-gray-200 truncate">
              {currentChat ? currentChat.title : "New Research Session"}
            </span>
          </div>

          {safeSourceUrl(currentChat?.url) && (
            <a
              href={safeSourceUrl(currentChat.url)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-400 hover:underline shrink-0"
            >
              Source ↗
            </a>
          )}
        </header>

        {/* Content Display */}
        <div className="flex-1 overflow-y-auto px-4 py-6 max-w-4xl w-full mx-auto space-y-6">
          {currentChat ? (
            <div className="bg-[#1E1F20] border border-[#2D2F31] rounded-2xl p-6 shadow-sm">
              <div className="flex items-center justify-between pb-4 border-b border-[#2D2F31] mb-4">
                <div className="flex items-center gap-2 truncate pr-4">
                  {currentChat.is_pinned && (
                    <span className="text-yellow-400 text-sm">📌</span>
                  )}
                  <h1 className="text-lg font-semibold text-white tracking-tight truncate">
                    {currentChat.title}
                  </h1>
                </div>
                <button
                  onClick={() =>
                    handleCopy(currentChat.id, currentChat.summary)
                  }
                  className="text-xs text-gray-400 hover:text-white bg-[#282A2C] px-2.5 py-1.5 rounded-lg border border-[#353739] shrink-0"
                >
                  {copiedId === currentChat.id ? "✓ Copied" : "Copy"}
                </button>
              </div>

              <ul className="space-y-3">
                {currentChat.summary?.map((point, idx) => (
                  <li
                    key={idx}
                    className="flex items-start gap-3 text-sm text-gray-300 leading-relaxed"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-400 mt-2 shrink-0" />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="h-64 flex flex-col items-center justify-center text-center space-y-3 text-gray-400">
              <div className="w-12 h-12 rounded-2xl bg-[#1E1F20] border border-[#2D2F31] flex items-center justify-center text-blue-400 mb-2">
                <svg className="w-6 h-6 fill-current" viewBox="0 0 24 24">
                  <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
                </svg>
              </div>
              <h2 className="text-xl font-medium text-gray-200">
                New Research Session
              </h2>
              <p className="text-xs max-w-sm">
                Paste an article URL below to extract key insights.
              </p>
            </div>
          )}

          {loading && (
            <div className="flex items-center gap-3">
              <p role="status" className="text-sm text-gray-400">
                Reading the article and generating insights…
              </p>
              <button
                type="button"
                onClick={() => requestRef.current?.abort()}
                className="text-sm text-blue-400"
              >
                Cancel
              </button>
            </div>
          )}
          {error && (
            <div
              role="alert"
              className="p-4 rounded-xl bg-red-950/40 border border-red-500/30 text-red-300 text-sm"
            >
              {error}
            </div>
          )}
        </div>

        {/* ----------------- INPUT & CONTROLS DOCK ----------------- */}
        <div className="p-4 max-w-4xl w-full mx-auto shrink-0">
          <form
            onSubmit={handleSummarize}
            className="bg-[#1E1F20] border border-[#2D2F31] focus-within:border-blue-500 rounded-2xl p-3 shadow-xl transition space-y-3"
          >
            <div className="flex items-center gap-2">
              <input
                type="url"
                aria-label="Article URL"
                required
                maxLength={2048}
                placeholder="Paste article URL here"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={loading}
                className="min-w-0 flex-1 bg-transparent text-sm text-white placeholder-gray-500 focus:outline-none px-2"
              />
              <button
                type="submit"
                disabled={loading}
                className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-xs font-medium transition shrink-0"
              >
                {loading ? "Generating..." : "Generate Insight"}
              </button>
            </div>

            {/* Slider & Depth Controls */}
            <div className="flex flex-wrap items-center justify-between gap-4 pt-2 border-t border-[#2D2F31] text-xs px-2">
              <div className="flex items-center gap-3">
                <label htmlFor="bullet-slider" className="text-gray-400">
                  Bullet Points
                </label>
                <input
                  id="bullet-slider"
                  disabled={loading}
                  type="range"
                  min="1"
                  max="7"
                  value={bullets}
                  onChange={(e) => setBullets(Number(e.target.value))}
                  className="w-28 accent-blue-500 cursor-pointer"
                />
                <span className="font-mono text-blue-400 w-4 text-center">
                  {bullets}
                </span>
                <span className="text-[10px] text-gray-500">7</span>
              </div>

              <div className="flex items-center gap-2">
                <label htmlFor="summary-depth" className="text-gray-400">
                  Depth:
                </label>
                <select
                  id="summary-depth"
                  disabled={loading}
                  value={length}
                  onChange={(e) => setLength(e.target.value)}
                  className="bg-[#282A2C] text-gray-300 border border-[#353739] rounded px-2 py-0.5 text-xs focus:outline-none"
                >
                  <option value="short">Short</option>
                  <option value="medium">Medium</option>
                  <option value="detailed">Detailed</option>
                </select>
              </div>
            </div>
          </form>
          <p className="mt-2 text-center text-xs text-gray-400">
            AI summaries can miss context. Verify details with the source.
            History is saved on this device (up to 100 summaries). Article text
            is sent to Gemini for processing.
          </p>
        </div>
      </main>
    </div>
  );
}
