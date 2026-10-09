import React, { useState, useEffect } from "react";

// Set VITE_API_URL in your hosting provider (e.g. Vercel) to your deployed backend,
// like https://your-backend.onrender.com. Falls back to localhost for local dev.
const API_URL = (
  import.meta.env.VITE_API_URL || "http://localhost:8000"
).replace(/\/$/, "");

const HISTORY_KEY = "incite_ai_history";
const MAX_HISTORY = 50;

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function getErrorMessage(status, data) {
  if (status === 429) {
    return "Rate limit reached (5 requests per minute). Please wait a moment and try again.";
  }
  if (typeof data?.detail === "string") return data.detail;
  if (status === 422) return "Please enter a valid article URL.";
  return "Unable to scrape or summarize URL.";
}

function loadSavedHistory() {
  try {
    const saved = localStorage.getItem(HISTORY_KEY);
    const parsed = saved ? JSON.parse(saved) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveHistory(items) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items));
  } catch {
    // Storage can be full or blocked; the app keeps working without it.
  }
}

function App() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [length, setLength] = useState("medium"); // short, medium, detailed
  const [bullets, setBullets] = useState(5);
  const [copied, setCopied] = useState(false);

  const [history, setHistory] = useState([]);

  // Load history on initial mount
  useEffect(() => {
    setHistory(loadSavedHistory());
  }, []);

  const lengthMapping = { 0: "short", 1: "medium", 2: "detailed" };
  const reverseLengthMapping = { short: 0, medium: 1, detailed: 2 };

  const updateHistory = (items) => {
    setHistory(items);
    saveHistory(items);
  };

  const handleScrape = async (e) => {
    if (e) e.preventDefault();
    const trimmedUrl = url.trim();
    if (!trimmedUrl || loading) return;

    setLoading(true);
    setError("");

    try {
      const response = await fetch(`${API_URL}/scrape`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmedUrl, length, bullets }),
      });

      let data = {};
      try {
        data = await response.json();
      } catch {
        data = {};
      }

      if (!response.ok) {
        throw new Error(getErrorMessage(response.status, data));
      }

      const articleTitle = data.title || "Research Document";
      const articleSummary = data.summary || [];

      setTitle(articleTitle);
      setSummary(articleSummary);

      const newItem = {
        id: Date.now(),
        title: articleTitle,
        url: trimmedUrl,
        summary: articleSummary,
        date: new Date()
          .toLocaleDateString("en-GB", { day: "numeric", month: "short" })
          .toUpperCase(),
        pinned: false,
      };

      updateHistory([newItem, ...history].slice(0, MAX_HISTORY));
    } catch (err) {
      setError(
        err instanceof TypeError
          ? "Can't reach the server right now. Please try again in a moment."
          : err.message,
      );
    } finally {
      setLoading(false);
    }
  };

  const loadHistoryItem = (item) => {
    setUrl(item.url);
    setTitle(item.title);
    setSummary(item.summary);
    setError("");
  };

  const togglePin = (id, e) => {
    if (e) e.stopPropagation();
    updateHistory(
      history.map((item) =>
        item.id === id ? { ...item, pinned: !item.pinned } : item,
      ),
    );
  };

  const deleteHistoryItem = (id, e) => {
    if (e) e.stopPropagation();
    updateHistory(history.filter((item) => item.id !== id));
  };

  const clearAllHistory = () => {
    if (
      window.confirm("Are you sure you want to clear your research history?")
    ) {
      updateHistory([]);
    }
  };

  const copyToClipboard = async (textToCopy) => {
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be unavailable (e.g. insecure context); ignore.
    }
  };

  const handleNewSummary = () => {
    setUrl("");
    setTitle("");
    setSummary([]);
    setError("");
  };

  const recent = history.slice(0, 6);
  const pinnedCount = history.filter((item) => item.pinned).length;
  const latest = history[0];

  return (
    <div className="min-h-screen bg-[#faf9f8] text-[#1a1c1c] flex flex-col font-sans">
      {/* TOP NAVBAR */}
      <header className="sticky top-0 z-50 bg-[#faf9f8] border-b border-[#c2c8c0]/20">
        <div className="flex justify-between items-center w-full px-8 py-3 mx-auto">
          <div className="font-serif text-2xl font-bold tracking-tight text-[#1a1c1c]">
            Incite AI
          </div>
          <nav className="flex items-center gap-8">
            <a
              className="text-sm font-semibold text-[#4a654f] border-b-2 border-[#4a654f] pb-1"
              href="#workspace"
            >
              Summarize
            </a>
            <a
              className="text-sm font-semibold text-[#424842] hover:text-[#4a654f] transition-colors"
              href="#history"
            >
              History
            </a>
          </nav>
        </div>
      </header>

      {/* THREE-COLUMN LAYOUT */}
      <div className="flex h-[calc(100vh-57px)] w-full overflow-hidden">
        {/* LEFT SIDEBAR */}
        <aside className="hidden lg:flex flex-col h-full py-8 px-4 w-64 bg-[#f4f3f2] border-r border-[#c2c8c0]/20 shrink-0">
          <div className="px-3 mb-6">
            <h2 className="font-serif text-2xl font-bold text-[#1a1c1c] mb-1">
              Recent Summaries
            </h2>
            <p className="text-xs text-[#424842]/70">
              Your curated research journal
            </p>
          </div>

          <nav className="flex flex-col gap-1.5 flex-grow overflow-y-auto">
            {recent.length === 0 ? (
              <p className="px-3 text-xs italic text-[#424842]/50">
                Nothing here yet.
              </p>
            ) : (
              recent.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => loadHistoryItem(item)}
                  className="flex items-center gap-3 text-left text-[#424842] p-3 rounded-xl hover:bg-[#e3e2e1]/60 transition-all"
                >
                  <span className="material-symbols-outlined text-[18px]">
                    article
                  </span>
                  <span className="text-sm truncate">{item.title}</span>
                </button>
              ))
            )}
          </nav>

          <div className="mt-auto pt-4 border-t border-[#c2c8c0]/20">
            <button
              type="button"
              onClick={handleNewSummary}
              className="w-full py-2.5 rounded-lg border border-[#737972] text-[#1a1c1c] font-semibold hover:bg-[#4a654f]/10 transition-colors flex items-center justify-center gap-2 text-sm"
            >
              <span className="material-symbols-outlined text-[18px]">add</span>
              New Summary
            </button>
          </div>
        </aside>

        {/* CENTER MAIN CONTENT WORKSPACE */}
        <main
          className="flex-1 overflow-y-auto bg-[#faf9f8] paper-texture relative"
          id="workspace"
        >
          <div className="max-w-[720px] mx-auto px-6 py-12">
            {/* MAIN HEADER */}
            <div className="text-center mb-12">
              <h1 className="font-serif text-4xl md:text-5xl font-bold text-[#1a1c1c] mb-3">
                Incite AI
              </h1>
              <p className="text-base text-[#424842] italic opacity-80">
                Transform dense articles into actionable intelligence in
                seconds.
              </p>
            </div>

            {/* INPUT SCRAPER BOX */}
            <form onSubmit={handleScrape} className="space-y-8 mb-16">
              <div className="flex items-center gap-3 border-b border-[#1a1c1c]/20 focus-within:border-[#4a654f] pb-3 transition-colors">
                <span className="material-symbols-outlined text-[#424842]">
                  link
                </span>
                <input
                  id="url-input"
                  aria-label="paste article url here"
                  className="w-full bg-transparent border-none focus:outline-none text-base placeholder:text-[#424842]/40"
                  placeholder="Paste article URL here..."
                  type="url"
                  required
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <label
                      htmlFor="summary-depth"
                      className="text-xs font-bold uppercase tracking-widest text-[#424842]"
                    >
                      Summary Depth
                    </label>
                    <span className="text-sm font-semibold text-[#1a1c1c] capitalize">
                      {length}
                    </span>
                  </div>
                  <input
                    id="summary-depth"
                    className="range-slider"
                    max="2"
                    min="0"
                    step="1"
                    type="range"
                    value={reverseLengthMapping[length]}
                    onChange={(e) => setLength(lengthMapping[e.target.value])}
                  />
                  <div className="flex justify-between text-[10px] uppercase tracking-tighter text-[#424842]/60 font-bold">
                    <span>Short</span>
                    <span>Detailed</span>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <label
                      htmlFor="bullet-points"
                      className="text-xs font-bold uppercase tracking-widest text-[#424842]"
                    >
                      Bullet Points
                    </label>
                    <span className="text-sm font-semibold text-[#1a1c1c]">
                      {bullets}
                    </span>
                  </div>
                  <input
                    id="bullet-points"
                    className="range-slider"
                    max="7"
                    min="1"
                    step="1"
                    type="range"
                    value={bullets}
                    onChange={(e) => setBullets(parseInt(e.target.value))}
                  />
                  <div className="flex justify-between text-[10px] uppercase tracking-tighter text-[#424842]/60 font-bold">
                    <span>1</span>
                    <span>7</span>
                  </div>
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-3.5 border border-[#1a1c1c] text-[#1a1c1c] font-semibold flex items-center justify-center gap-2 hover:bg-[#1a1c1c] hover:text-[#faf9f8] transition-all duration-300 disabled:opacity-50"
              >
                <span
                  className={`material-symbols-outlined text-[20px] ${loading ? "animate-spin" : ""}`}
                >
                  {loading ? "progress_activity" : "auto_awesome"}
                </span>
                <span>
                  {loading ? "Analyzing Source..." : "Generate Insight"}
                </span>
              </button>
            </form>

            {/* ERROR DISPLAY */}
            {error && (
              <div
                role="alert"
                className="mb-8 p-4 bg-[#ffdad6] text-[#93000a] rounded-lg text-sm border border-[#ba1a1a]/20"
              >
                ⚠️ {error}
              </div>
            )}

            {/* ACTIVE RESULT CARD */}
            {!loading && (title || summary.length > 0) && (
              <div className="bg-[#f4f3f2] border border-[#c2c8c0]/30 p-6 mb-12 shadow-sm rounded-lg space-y-4">
                <div className="flex justify-between items-start gap-4">
                  <div>
                    <span className="text-[10px] uppercase tracking-[0.2em] text-[#4a654f] font-bold mb-1 block">
                      ACTIVE RESULT
                    </span>
                    <h3 className="font-serif text-2xl font-bold leading-snug text-[#1a1c1c]">
                      {title}
                    </h3>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      copyToClipboard(
                        `### ${title}\n\n${summary.map((b) => `* ${b}`).join("\n")}`,
                      )
                    }
                    className="flex items-center gap-1.5 text-xs font-semibold text-[#424842] hover:text-[#4a654f] transition-colors shrink-0"
                  >
                    <span className="material-symbols-outlined text-[16px]">
                      {copied ? "check" : "content_copy"}
                    </span>
                    <span>{copied ? "Copied" : "Copy Summary"}</span>
                  </button>
                </div>

                <div className="space-y-3 pt-2">
                  {summary.map((point, idx) => (
                    <div
                      key={idx}
                      className="flex gap-3 text-sm text-[#424842]"
                    >
                      <span className="text-[#4a654f] font-bold">
                        {(idx + 1).toString().padStart(2, "0")}.
                      </span>
                      <p className="leading-relaxed">{point}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* HISTORY SECTION */}
            <div className="space-y-6" id="history">
              <div className="flex justify-between items-end border-b border-[#c2c8c0]/20 pb-3">
                <h3 className="font-serif text-2xl font-bold text-[#1a1c1c]">
                  History
                </h3>
                {history.length > 0 && (
                  <div className="flex gap-4 text-xs font-semibold uppercase tracking-widest text-[#424842]/60">
                    <button
                      type="button"
                      onClick={clearAllHistory}
                      className="hover:text-[#ba1a1a] transition-colors"
                    >
                      Clear All
                    </button>
                  </div>
                )}
              </div>

              <div className="space-y-6">
                {history.length === 0 ? (
                  <div className="text-center py-12 text-[#424842]/40 italic text-sm">
                    Your summarized research will appear here.
                  </div>
                ) : (
                  [...history]
                    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
                    .map((item) => (
                      <div
                        key={item.id}
                        onClick={() => loadHistoryItem(item)}
                        className={`bg-[#f4f3f2] border ${
                          item.pinned
                            ? "border-[#4a654f]"
                            : "border-[#c2c8c0]/20"
                        } p-6 hover:border-[#4a654f]/40 transition-all cursor-pointer relative group rounded-sm`}
                      >
                        <div className="flex justify-between items-start mb-3 gap-4">
                          <div>
                            <span className="text-[10px] uppercase tracking-[0.2em] text-[#4a654f] font-bold mb-1 block">
                              {getDomain(item.url) || "ARTICLE"} •{" "}
                              {item.date || "TODAY"}
                            </span>
                            <h4 className="font-serif text-xl font-bold leading-snug text-[#1a1c1c]">
                              {item.title}
                            </h4>
                          </div>
                          <div className="flex gap-2 shrink-0">
                            <button
                              type="button"
                              aria-label={
                                item.pinned ? "Unpin summary" : "Pin summary"
                              }
                              onClick={(e) => togglePin(item.id, e)}
                              className={`material-symbols-outlined text-[20px] transition-colors ${
                                item.pinned
                                  ? "text-[#4a654f]"
                                  : "text-[#424842]/30 group-hover:text-[#4a654f]"
                              }`}
                            >
                              push_pin
                            </button>
                            <button
                              type="button"
                              aria-label="Delete summary"
                              onClick={(e) => deleteHistoryItem(item.id, e)}
                              className="material-symbols-outlined text-[20px] text-[#424842]/30 hover:text-[#ba1a1a] transition-colors"
                            >
                              delete
                            </button>
                          </div>
                        </div>

                        <div className="space-y-2.5 mb-6">
                          {item.summary &&
                            item.summary.map((point, idx) => (
                              <div
                                key={idx}
                                className="flex gap-3 text-sm text-[#424842]"
                              >
                                <span className="text-[#4a654f] font-bold">
                                  {(idx + 1).toString().padStart(2, "0")}.
                                </span>
                                <p className="leading-relaxed line-clamp-2">
                                  {point}
                                </p>
                              </div>
                            ))}
                        </div>

                        <div className="flex justify-end items-center pt-2">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              copyToClipboard(
                                `### ${item.title}\n\n${(item.summary || []).map((b) => `* ${b}`).join("\n")}`,
                              );
                            }}
                            className="flex items-center gap-1 text-xs font-semibold text-[#424842] hover:text-[#4a654f] transition-colors"
                          >
                            <span className="material-symbols-outlined text-[16px]">
                              content_copy
                            </span>
                            <span>Copy Summary</span>
                          </button>
                        </div>
                      </div>
                    ))
                )}
              </div>
            </div>
          </div>
        </main>

        {/* RIGHT INSIGHTS SIDEBAR (real stats from your history) */}
        <aside className="hidden xl:flex flex-col w-80 bg-[#e9e8e7]/30 border-l border-[#c2c8c0]/20 p-6 overflow-y-auto shrink-0">
          <h5 className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#424842]/60 mb-6">
            Reading Insights
          </h5>
          <div className="space-y-4">
            <div className="p-4 bg-[#faf9f8] rounded-lg border border-[#c2c8c0]/20 shadow-sm">
              <p className="text-[10px] font-bold text-[#4a654f] uppercase mb-1.5 tracking-wider">
                Articles Analyzed
              </p>
              <p className="font-serif text-3xl font-bold text-[#1a1c1c]">
                {history.length}
              </p>
            </div>
            <div className="p-4 bg-[#faf9f8] rounded-lg border border-[#c2c8c0]/20 shadow-sm">
              <p className="text-[10px] font-bold text-[#4a654f] uppercase mb-1.5 tracking-wider">
                Pinned
              </p>
              <p className="font-serif text-3xl font-bold text-[#1a1c1c]">
                {pinnedCount}
              </p>
            </div>
            {latest && getDomain(latest.url) && (
              <div className="p-4 bg-[#faf9f8] rounded-lg border border-[#c2c8c0]/20 shadow-sm">
                <p className="text-[10px] font-bold text-[#4a654f] uppercase mb-1.5 tracking-wider">
                  Latest Source
                </p>
                <p className="text-sm text-[#1a1c1c] break-words">
                  {getDomain(latest.url)}
                </p>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

export default App;
