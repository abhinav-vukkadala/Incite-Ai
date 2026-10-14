import React, { useState, useEffect } from "react";

const API_URL = (
  import.meta.env.VITE_API_URL ||
  import.meta.env.VITE_API_BASE_URL ||
  "http://localhost:8000"
).replace(/\/$/, "");

const STORAGE_KEY = "incite_ai_history";

export default function App() {
  const [history, setHistory] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const [activeChat, setActiveChat] = useState(null);
  const [url, setUrl] = useState("");
  const [length, setLength] = useState("medium");
  const [bullets, setBullets] = useState(5);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [copiedId, setCopiedId] = useState(null);

  // Sync state to localStorage whenever history changes
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    } catch (e) {
      console.error("Failed to write to localStorage:", e);
    }
  }, [history]);

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

      setHistory((prev) => {
        const next = [data, ...prev.filter((item) => item.id !== data.id)];
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {}
        return next;
      });

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
      await fetch(`${API_URL}/history/${id}`, { method: "DELETE" });
    } catch {}
    setHistory((prev) => {
      const updated = prev.filter((item) => item.id !== id);
      if (activeChat?.id === id) {
        setActiveChat(updated.length > 0 ? updated[0] : null);
      }
      return updated;
    });
  };

  const handleCopy = (id, bulletsList) => {
    if (!bulletsList) return;
    navigator.clipboard.writeText(bulletsList.map((b) => `• ${b}`).join("\n"));
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const activeOrLatest = activeChat || (history.length > 0 ? history[0] : null);

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

        {/* History List */}
        <div className="flex-1 overflow-y-auto px-2 py-3 space-y-1">
          <div className="px-3 pb-2 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
            Recent Research
          </div>

          {history.length === 0 ? (
            <div className="text-center py-10 px-4 text-xs text-gray-500">
              No saved chats yet.
            </div>
          ) : (
            history.map((item) => {
              const isActive = activeOrLatest?.id === item.id;
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
                  <div className="flex items-center gap-2 overflow-hidden pr-8">
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
      </aside>

      {/* ----------------- MAIN VIEW ----------------- */}
      <main className="flex-1 flex flex-col relative h-full overflow-hidden bg-[#131314]">
        {/* Header */}
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
              {activeOrLatest ? activeOrLatest.title : "Research Session"}
            </span>
          </div>

          {activeOrLatest?.url && (
            <a
              href={activeOrLatest.url}
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
          {activeOrLatest ? (
            <div className="bg-[#1E1F20] border border-[#2D2F31] rounded-2xl p-6 shadow-sm">
              <div className="flex items-center justify-between pb-4 border-b border-[#2D2F31] mb-4">
                <h1 className="text-lg font-semibold text-white tracking-tight">
                  {activeOrLatest.title}
                </h1>
                <button
                  onClick={() =>
                    handleCopy(activeOrLatest.id, activeOrLatest.summary)
                  }
                  className="text-xs text-gray-400 hover:text-white bg-[#282A2C] px-2.5 py-1.5 rounded-lg border border-[#353739]"
                >
                  {copiedId === activeOrLatest.id ? "✓ Copied" : "Copy"}
                </button>
              </div>

              <ul className="space-y-3">
                {activeOrLatest.summary?.map((point, idx) => (
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
              <h2 className="text-xl font-medium text-gray-200">
                Ready to summarize
              </h2>
              <p className="text-xs max-w-sm">
                Paste an article URL below to extract key insights.
              </p>
            </div>
          )}

          {error && (
            <div className="p-4 rounded-xl bg-red-950/40 border border-red-500/30 text-red-300 text-sm">
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
                placeholder="Paste article URL here"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={loading}
                className="flex-1 bg-transparent text-sm text-white placeholder-gray-500 focus:outline-none px-2"
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
                <span className="text-gray-400">Depth:</span>
                <select
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
        </div>
      </main>
    </div>
  );
}
