import React, { useState, useEffect } from "react";

function App() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [length, setLength] = useState("medium");
  const [bullets, setBullets] = useState(3);
  const [copied, setCopied] = useState(false);

  // State to hold all saved history items
  const [history, setHistory] = useState([]);

  // Load saved history from localStorage when the app boots up
  useEffect(() => {
    const savedHistory = localStorage.getItem("smart_read_history");
    if (savedHistory) {
      setHistory(JSON.parse(savedHistory));
    }
  }, []);

  const handleScrape = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    setSummary([]);
    setTitle("");

    try {
      const response = await fetch("http://https://smart-read-backend.onrender.com/scrape", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: url,
          length: length, // Sends "short", "medium", or "detailed"
          bullets: bullets, // Sends the exact number
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || "Something went wrong");
      }

      setTitle(data.title);
      setSummary(data.summary);

      // Add new result to the top of the history list
      const newItem = {
        id: Date.now(),
        title: data.title,
        url: url,
        summary: data.summary,
      };

      const updatedHistory = [newItem, ...history];
      setHistory(updatedHistory);
      localStorage.setItem(
        "smart_read_history",
        JSON.stringify(updatedHistory),
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Loads an old item back into active view
  const loadHistoryItem = (item) => {
    setUrl(item.url);
    setTitle(item.title);
    setSummary(item.summary);
    setError("");
  };

  // Clears a single item from the sidebar
  const deleteHistoryItem = (id, e) => {
    e.stopPropagation(); // Stop from clicking the main item container
    const updatedHistory = history.filter((item) => item.id !== id);
    setHistory(updatedHistory);
    localStorage.setItem("smart_read_history", JSON.stringify(updatedHistory));
  };

  // Clears every single item from the sidebar and local cache
  const clearAllHistory = () => {
    const confirmClear = window.confirm(
      "Are you sure you want to wipe your entire summary history? This cannot be undone.",
    );
    if (confirmClear) {
      setHistory([]);
      localStorage.removeItem("smart_read_history");
    }
  };

  const handleClear = () => {
    setUrl("");
    setTitle("");
    setSummary([]);
    setError("");
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col md:flex-row">
      {/* LEFT COLUMN: History Sidebar */}
      <aside className="w-full md:w-80 bg-slate-950 border-b md:border-b-0 md:border-r border-slate-800 p-6 flex flex-col shrink-0">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold tracking-wide text-slate-200 flex items-center gap-2">
            <span>⏳</span> Recent Summaries
          </h2>
          {history.length > 0 && (
            <button
              onClick={clearAllHistory}
              className="text-xs font-semibold text-slate-500 hover:text-red-400 transition-colors duration-150 bg-slate-900 border border-slate-800 hover:border-red-950 px-2 py-1 rounded-md"
            >
              Clear All
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto space-y-3 pr-1 max-h-64 md:max-h-[calc(100vh-120px)]">
          {history.length === 0 ? (
            <p className="text-sm text-slate-500 italic mt-4 text-center">
              No history cached yet.
            </p>
          ) : (
            // Sort pinned items to the top, then sort by newest id
            [...history]
              .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
              .map((item) => (
                <div
                  key={item.id}
                  onClick={() => loadHistoryItem(item)}
                  className={`group relative text-left w-full p-3 bg-slate-900 hover:bg-slate-800 border rounded-xl cursor-pointer transition-all duration-200 flex justify-between items-start gap-2 ${
                    item.pinned
                      ? "border-amber-500/40 bg-amber-950/5"
                      : "border-slate-800 hover:border-slate-700"
                  }`}
                >
                  <div className="truncate flex-1">
                    <p className="text-sm font-semibold text-slate-300 group-hover:text-cyan-400 truncate flex items-center gap-1.5">
                      {item.pinned && (
                        <span className="text-amber-400 shrink-0">⭐</span>
                      )}
                      <span className="truncate">{item.title}</span>
                    </p>
                    <span className="text-xs text-slate-500 truncate block mt-0.5">
                      {item.url}
                    </span>
                  </div>

                  {/* Action Buttons: Pin & Delete */}
                  <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                    <button
                      onClick={(e) => {
                        e.stopPropagation(); // Stop from opening the item
                        const updatedHistory = history.map((h) =>
                          h.id === item.id ? { ...h, pinned: !h.pinned } : h,
                        );
                        setHistory(updatedHistory);
                        localStorage.setItem(
                          "smart_read_history",
                          JSON.stringify(updatedHistory),
                        );
                      }}
                      className={`text-xs px-1.5 py-0.5 rounded transition-colors ${
                        item.pinned
                          ? "text-amber-400 hover:text-slate-400"
                          : "text-slate-500 hover:text-amber-400"
                      }`}
                      title={
                        item.pinned ? "Unpin summary" : "Pin summary to top"
                      }
                    >
                      📌
                    </button>
                    <button
                      onClick={(e) => deleteHistoryItem(item.id, e)}
                      className="text-slate-500 hover:text-red-400 text-xs px-1.5 py-0.5 rounded transition-colors"
                      title="Delete summary"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))
          )}
        </div>
      </aside>

      {/* RIGHT COLUMN: Main Aggregator Workspace */}
      <div className="flex-1 flex flex-col items-center p-6 lg:p-12 overflow-y-auto">
        <header className="max-w-2xl w-full text-center my-6 md:my-12">
          <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl bg-gradient-to-r from-cyan-400 to-blue-500 bg-clip-text text-transparent">
            Smart Read Aggregator
          </h1>
          <p className="mt-3 text-base md:text-lg text-slate-400">
            Paste any long article link below and let Gemini extract the core
            insights in seconds.
          </p>
        </header>

        <main className="max-w-2xl w-full bg-slate-800 p-6 rounded-2xl shadow-2xl border border-slate-700/60 backdrop-blur-sm">
          <form onSubmit={handleScrape} className="flex flex-col gap-5">
            {/* URL Input Bar */}
            <div className="w-full">
              <input
                type="url"
                required
                placeholder="https://example.com/article-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="w-full bg-slate-900 border border-slate-600 rounded-xl px-4 py-3 text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent transition-all shadow-inner"
              />
            </div>

            {/* NEW: Summary Configuration Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 bg-slate-900/40 p-4 rounded-xl border border-slate-700/50">
              {/* Summary Length Selector */}
              <div className="flex flex-col gap-1.5 text-left">
                <label className="text-xs font-bold uppercase tracking-wider text-slate-400">
                  Summary Depth
                </label>
                <div className="grid grid-cols-3 gap-1 bg-slate-900 p-1 rounded-lg border border-slate-700">
                  {["short", "medium", "detailed"].map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => setLength(opt)}
                      className={`capitalize text-xs font-semibold py-1.5 px-2 rounded-md transition-all ${
                        length === opt
                          ? "bg-gradient-to-r from-cyan-500 to-blue-600 text-white shadow-md"
                          : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              </div>

              {/* Bullet Point Counter Slider */}
              <div className="flex flex-col gap-1.5 text-left">
                <div className="flex justify-between items-center">
                  <label className="text-xs font-bold uppercase tracking-wider text-slate-400">
                    Bullet Points
                  </label>
                  <span className="text-xs font-bold text-cyan-400 bg-cyan-500/10 px-2 py-0.5 rounded border border-cyan-500/20">
                    {bullets} Items
                  </span>
                </div>
                <div className="flex items-center bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-700 h-[38px]">
                  <input
                    type="range"
                    min="1"
                    max="7"
                    value={bullets}
                    onChange={(e) => setBullets(parseInt(e.target.value))}
                    className="w-full accent-cyan-500 cursor-pointer"
                  />
                </div>
              </div>
            </div>

            {/* Action Buttons Row */}
            <div className="flex flex-col sm:flex-row gap-3 w-full">
              <button
                type="submit"
                disabled={loading}
                className="flex-1 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-600 hover:to-blue-700 font-semibold py-3 rounded-xl shadow-lg shadow-cyan-500/20 active:scale-95 transition-all text-white disabled:opacity-50"
              >
                {loading ? "Analyzing..." : "Summarize"}
              </button>

              {(url || title || summary.length > 0) && (
                <button
                  type="button"
                  onClick={handleClear}
                  className="bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-200 font-medium px-5 py-3 rounded-xl active:scale-95 transition-all shadow-md"
                >
                  Clear Fields
                </button>
              )}
            </div>
          </form>

          {error && (
            <div className="mt-5 p-4 bg-red-950/40 border border-red-500/30 rounded-xl text-red-200 text-sm">
              ⚠️ {error}
            </div>
          )}

          {loading && (
            <div className="mt-8 border-t border-slate-700/60 pt-6 space-y-4 animate-pulse">
              <div className="h-6 bg-slate-700 rounded-md w-3/4 mb-6"></div>
              <div className="h-16 bg-slate-700/50 rounded-xl w-full"></div>
              <div className="h-16 bg-slate-700/50 rounded-xl w-full"></div>
              <div className="h-16 bg-slate-700/50 rounded-xl w-full"></div>
            </div>
          )}

          {/* AI Results Display */}
          {!loading && (title || summary.length > 0) && (
            <div className="mt-8 border-t border-slate-700/60 pt-6">
              {/* Title block with Copy to Clipboard Action */}
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-5">
                <h2 className="text-xl font-bold text-slate-100 flex-1 leading-snug text-left">
                  {title}
                </h2>
                <button
                  type="button"
                  disabled={copied}
                  onClick={() => {
                    const markdownText = `### ${title}\n\n${summary.map((bullet) => `* ${bullet}`).join("\n")}`;
                    navigator.clipboard.writeText(markdownText);

                    // Switch state to true, then revert back after 1 seconds
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1000);
                  }}
                  className={`shrink-0 text-xs font-semibold border px-3 py-2 rounded-xl transition-all active:scale-95 flex items-center gap-1.5 self-start ${
                    copied
                      ? "bg-emerald-950/40 border-emerald-500/40 text-emerald-400"
                      : "bg-slate-900 border-slate-700 hover:border-slate-600 text-cyan-400 hover:text-cyan-300"
                  }`}
                >
                  {copied ? (
                    <>
                      <span>✅</span> Copied!
                    </>
                  ) : (
                    <>
                      <span>📋</span> Copy
                    </>
                  )}
                </button>
              </div>

              <ul className="space-y-4 text-left">
                {summary.map((bullet, index) => (
                  <li
                    key={index}
                    className="flex items-start gap-3 text-slate-300 bg-slate-900/40 p-4 rounded-xl border border-slate-700/40"
                  >
                    <span className="text-cyan-400 mt-1 select-none">✦</span>
                    <span className="leading-relaxed">{bullet}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!loading && !title && !error && (
            <div className="mt-8 border-t border-slate-700/60 pt-6 text-center text-slate-500 text-sm">
              Your summaries will appear here.
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
