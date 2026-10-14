import React, { useState, useEffect } from "react";

const API_URL = (
  import.meta.env.VITE_API_URL ||
  import.meta.env.VITE_API_BASE_URL ||
  "http://localhost:8000"
).replace(/\/$/, "");

export default function App() {
  const [history, setHistory] = useState([]);
  const [activeChat, setActiveChat] = useState(null);
  const [url, setUrl] = useState("");
  const [length, setLength] = useState("medium");
  const [bullets, setBullets] = useState(5);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [copiedId, setCopiedId] = useState(null);

  useEffect(() => {
    fetchHistory();
  }, []);

  const fetchHistory = async () => {
    try {
      const res = await fetch(`${API_URL}/history?limit=50`);
      if (res.ok) {
        const data = await res.json();
        setHistory(data);
        if (data.length > 0 && !activeChat) {
          setActiveChat(data[0]);
        }
      }
    } catch (err) {
      console.error("Failed to load history from database:", err);
    }
  };

  const handleSummarize = async (e) => {
    if (e) e.preventDefault();
    const targetUrl = url.trim();
    if (!targetUrl || loading) return;

    setError("");
    setLoading(true);

    try {
      const res = await fetch(`${API_URL}/scrape`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: targetUrl,
          length,
          bullets: Number(bullets),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || "Unable to summarize article.");
      }

      setHistory((prev) => [data, ...prev]);
      setActiveChat(data);
      setUrl("");
    } catch (err) {
      setError(err.message || "Failed to reach backend.");
    } finally {
      setLoading(false);
    }
  };

  const handleTogglePin = async (e, id) => {
    e.stopPropagation();
    try {
      const res = await fetch(`${API_URL}/history/${id}/pin`, {
        method: "PATCH",
      });
      if (res.ok) {
        const updated = await res.json();
        setHistory((prev) =>
          prev.map((item) => (item.id === id ? updated : item)),
        );
        if (activeChat?.id === id) setActiveChat(updated);
      }
    } catch (err) {
      console.error("Failed to toggle pin:", err);
    }
  };

  const handleDelete = async (e, id) => {
    e.stopPropagation();
    try {
      const res = await fetch(`${API_URL}/history/${id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        const updated = history.filter((item) => item.id !== id);
        setHistory(updated);
        if (activeChat?.id === id) {
          setActiveChat(updated.length > 0 ? updated[0] : null);
        }
      }
    } catch (err) {
      console.error("Failed to delete chat:", err);
    }
  };

  const handleCopy = (id, bulletsList) => {
    navigator.clipboard.writeText(bulletsList.map((b) => `• ${b}`).join("\n"));
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div className="flex h-screen bg-[#131314] text-[#E3E3E3] font-sans overflow-hidden antialiased">
      {/* ----------------- CHATBOT SIDEBAR ----------------- */}
      <aside
        className={`${
          sidebarOpen ? "w-72" : "w-0"
        } transition-all duration-300 ease-in-out bg-[#1E1F20] border-r border-[#2D2F31] flex flex-col z-20 overflow-hidden shrink-0`}
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
            onClick={() => {
              setActiveChat(null);
              setError("");
            }}
            className="p-1.5 hover:bg-[#282A2C] rounded-lg text-gray-400 hover:text-white transition"
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

        {/* History Chat Titles */}
        <div className="flex-1 overflow-y-auto px-2 py-3 space-y-1">
          <div className="px-3 pb-2 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
            Recent Research
          </div>

          {history.length === 0 ? (
            <div className="text-center py-10 px-4 text-xs text-gray-500">
              No saved chats yet. Enter an article link below to begin.
            </div>
          ) : (
            history.map((item) => {
              const isActive = activeChat?.id === item.id;
              return (
                <div
                  key={item.id}
                  onClick={() => {
                    setActiveChat(item);
                    setError("");
                  }}
                  className={`group relative flex items-center justify-between px-3 py-2.5 rounded-lg text-sm cursor-pointer transition ${
                    isActive
                      ? "bg-[#004A77] text-white font-medium"
                      : "hover:bg-[#282A2C] text-gray-300"
                  }`}
                >
                  <div className="flex items-center gap-2 overflow-hidden pr-10">
                    {item.is_pinned && (
                      <span className="text-yellow-400 text-xs shrink-0">
                        📌
                      </span>
                    )}
                    <span className="truncate">
                      {item.title || "Untitled Summary"}
                    </span>
                  </div>

                  <div className="absolute right-2 hidden group-hover:flex items-center gap-1.5 bg-[#282A2C] px-1 py-0.5 rounded">
                    <button
                      onClick={(e) => handleTogglePin(e, item.id)}
                      className="p-1 text-gray-400 hover:text-yellow-400 transition"
                      title={item.is_pinned ? "Unpin" : "Pin"}
                    >
                      📌
                    </button>
                    <button
                      onClick={(e) => handleDelete(e, item.id)}
                      className="p-1 text-gray-400 hover:text-red-400 transition"
                      title="Delete"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="p-3 border-t border-[#2D2F31] text-[11px] text-gray-400 flex items-center justify-between">
          <span>Incite Research Agent</span>
          <span className="text-blue-400 font-mono">v1.2</span>
        </div>
      </aside>

      {/* ----------------- CHAT CONVERSATION VIEW ----------------- */}
      <main className="flex-1 flex flex-col relative h-full overflow-hidden bg-[#131314]">
        {/* Top Chat Header */}
        <header className="h-14 border-b border-[#2D2F31] px-4 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3 overflow-hidden">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="p-2 hover:bg-[#282A2C] rounded-lg text-gray-400 hover:text-white transition"
              title="Toggle Sidebar"
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
              {activeChat ? activeChat.title : "New Research Session"}
            </span>
          </div>

          {activeChat && (
            <a
              href={activeChat.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 bg-blue-500/10 px-3 py-1.5 rounded-full border border-blue-500/20 transition shrink-0"
            >
              <span>Source URL</span>
              <span>↗</span>
            </a>
          )}
        </header>

        {/* Conversation Area */}
        <div className="flex-1 overflow-y-auto px-4 py-8 max-w-4xl w-full mx-auto space-y-6">
          {!activeChat ? (
            <div className="h-full flex flex-col items-center justify-center text-center space-y-4 my-auto">
              <div className="w-14 h-14 rounded-2xl bg-[#1E1F20] border border-[#2D2F31] flex items-center justify-center text-blue-400 shadow-xl">
                <svg className="w-7 h-7 fill-current" viewBox="0 0 24 24">
                  <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
                </svg>
              </div>
              <h2 className="text-2xl font-semibold text-white tracking-tight">
                Where should we focus today?
              </h2>
              <p className="text-sm text-gray-400 max-w-md leading-relaxed">
                Paste any article or research paper link. Incite AI extracts
                structural takeaways, assigns a smart topic title, and saves
                everything to your database.
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {/* User Article Link Bubble */}
              <div className="flex justify-end">
                <div className="bg-[#282A2C] border border-[#353739] text-gray-200 px-4 py-3 rounded-2xl rounded-tr-sm text-sm max-w-lg shadow-sm">
                  <div className="text-[11px] text-gray-400 font-medium mb-1">
                    Target Article
                  </div>
                  <a
                    href={activeChat.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:underline break-all font-mono text-xs"
                  >
                    {activeChat.url}
                  </a>
                </div>
              </div>

              {/* AI Response Bubble */}
              <div className="flex gap-4">
                <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center text-white shrink-0 mt-1 shadow-md">
                  <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
                    <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
                  </svg>
                </div>

                <div className="flex-1 bg-[#1E1F20] border border-[#2D2F31] rounded-2xl rounded-tl-sm p-6 shadow-sm">
                  <div className="flex items-center justify-between pb-4 border-b border-[#2D2F31] mb-4">
                    <h1 className="text-lg font-semibold text-white tracking-tight">
                      {activeChat.title}
                    </h1>
                    <button
                      onClick={() =>
                        handleCopy(activeChat.id, activeChat.summary)
                      }
                      className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white transition bg-[#282A2C] px-2.5 py-1.5 rounded-lg border border-[#353739]"
                      title="Copy Takeaways"
                    >
                      {copiedId === activeChat.id ? (
                        <span className="text-green-400 font-medium">
                          ✓ Copied
                        </span>
                      ) : (
                        <span>Copy</span>
                      )}
                    </button>
                  </div>

                  {/* Bullet Points */}
                  <ul className="space-y-3.5">
                    {activeChat.summary.map((point, idx) => (
                      <li
                        key={idx}
                        className="flex items-start gap-3 text-sm text-gray-300 leading-relaxed"
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-400 mt-2 shrink-0" />
                        <span>{point}</span>
                      </li>
                    ))}
                  </ul>

                  {/* Badges */}
                  <div className="flex items-center gap-2 mt-6 pt-4 border-t border-[#2D2F31] text-[11px] text-gray-400 font-mono">
                    <span className="bg-[#282A2C] px-2.5 py-1 rounded-md border border-[#353739]">
                      Depth: {activeChat.length?.toUpperCase()}
                    </span>
                    <span className="bg-[#282A2C] px-2.5 py-1 rounded-md border border-[#353739]">
                      Bullets: {activeChat.bullets}
                    </span>
                    {activeChat.created_at && (
                      <span className="text-gray-500 ml-auto">
                        {new Date(activeChat.created_at).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="p-4 rounded-xl bg-red-950/40 border border-red-500/30 text-red-300 text-sm flex items-center gap-3">
              <span className="text-lg">⚠️</span>
              <p>{error}</p>
            </div>
          )}
        </div>

        {/* ----------------- FLOATING PROMPT PILL DOCK ----------------- */}
        <div className="p-4 max-w-4xl w-full mx-auto shrink-0">
          <form
            onSubmit={handleSummarize}
            className="bg-[#1E1F20] border border-[#2D2F31] focus-within:border-blue-500 rounded-2xl p-2.5 shadow-2xl transition"
          >
            <div className="flex items-center gap-2 px-2">
              <input
                type="url"
                placeholder="Paste article link (e.g., https://en.wikipedia.org/wiki/Artificial_intelligence)"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={loading}
                required
                className="flex-1 bg-transparent text-sm text-white placeholder-gray-500 focus:outline-none py-1"
              />
              <button
                type="submit"
                disabled={loading || !url.trim()}
                className="w-9 h-9 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:hover:bg-blue-600 flex items-center justify-center text-white transition shrink-0 shadow-md"
              >
                {loading ? (
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <svg
                    className="w-4 h-4 fill-current rotate-45 -mr-0.5"
                    viewBox="0 0 24 24"
                  >
                    <path d="M2 21L23 12L2 3V10L17 12L2 14V21Z" />
                  </svg>
                )}
              </button>
            </div>

            {/* Config Controls */}
            <div className="flex items-center gap-4 px-2 pt-2.5 mt-2 border-t border-[#2D2F31] text-xs">
              <span className="text-gray-400 font-medium">Parameters:</span>

              {/* Bullet Count Selector */}
              <div className="flex items-center gap-1.5">
                <label className="text-gray-400">Bullets:</label>
                <select
                  value={bullets}
                  onChange={(e) => setBullets(Number(e.target.value))}
                  className="bg-[#282A2C] text-gray-200 border border-[#353739] rounded-md px-2 py-0.5 text-xs focus:outline-none"
                >
                  {[1, 2, 3, 4, 5, 6, 7].map((num) => (
                    <option key={num} value={num}>
                      {num} points
                    </option>
                  ))}
                </select>
              </div>

              {/* Depth Selector */}
              <div className="flex items-center gap-1.5">
                <label className="text-gray-400">Depth:</label>
                <select
                  value={length}
                  onChange={(e) => setLength(e.target.value)}
                  className="bg-[#282A2C] text-gray-200 border border-[#353739] rounded-md px-2 py-0.5 text-xs focus:outline-none capitalize"
                >
                  <option value="short">Short (Snappy)</option>
                  <option value="medium">Medium (Balanced)</option>
                  <option value="detailed">Detailed (In-depth)</option>
                </select>
              </div>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}
