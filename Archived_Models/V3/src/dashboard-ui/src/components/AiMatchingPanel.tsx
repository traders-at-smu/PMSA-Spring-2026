import { useState, useEffect, useRef } from "react";
import { usePolling } from "../hooks/usePolling";

// ---- Types ----

interface AiMatchRow {
  id: number;
  created_at: string;
  poly_slug: string;
  kalshi_ticker: string;
  poly_title: string;
  kalshi_title: string;
  text_score: number;
  ai_match: number;
  ai_confidence: number;
  ai_reasoning: string;
  ai_model: string;
  ai_latency_ms: number;
  from_cache: number;
  final_verdict: string;
  user_override: string | null;
  poly_url: string | null;
  kalshi_url: string | null;
}

interface MatchStatus {
  aiVerifier: "kimi-k2.5" | "openai-embeddings" | "none";
  kimiStats: {
    totalCalls: number;
    cacheHits: number;
    cacheMisses: number;
    hitRate: number;
    avgLatencyMs: number;
    totalTokensUsed: number;
    estimatedCostUsd: number;
    cacheSize: number;
  } | null;
  matchStats: {
    total: number;
    verified: number;
    rejected: number;
    pending: number;
    avgConfidence: number;
  };
  lastScanAt: string | null;
  scanning: boolean;
  lastScanDurationMs: number;
}

interface ResultsResponse {
  results: AiMatchRow[];
}

// ---- Helpers ----

function confidenceBadge(confidence: number): { bg: string; text: string; label: string } {
  if (confidence >= 0.70) return { bg: "bg-emerald-500/15", text: "text-emerald-400", label: `${(confidence * 100).toFixed(0)}%` };
  if (confidence >= 0.50) return { bg: "bg-amber-500/15", text: "text-amber-400", label: `${(confidence * 100).toFixed(0)}%` };
  return { bg: "bg-red-500/15", text: "text-red-400", label: `${(confidence * 100).toFixed(0)}%` };
}

function verdictBadge(verdict: string): { bg: string; text: string } {
  if (verdict === "verified") return { bg: "bg-emerald-500/15", text: "text-emerald-400" };
  if (verdict === "rejected") return { bg: "bg-red-500/15", text: "text-red-400" };
  return { bg: "bg-zinc-500/15", text: "text-zinc-400" };
}

function textScoreColor(score: number): string {
  if (score >= 0.50) return "text-emerald-400";
  if (score >= 0.35) return "text-amber-400";
  return "text-red-400";
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ---- Scan Log Types ----

interface ScanLogEntry {
  ts: string;
  level: "info" | "warn" | "error" | "step" | "detail";
  msg: string;
}

const LOG_LEVEL_STYLES: Record<ScanLogEntry["level"], { color: string; prefix: string }> = {
  step: { color: "text-blue-400", prefix: ">>>" },
  info: { color: "text-zinc-300", prefix: "   " },
  detail: { color: "text-zinc-500", prefix: "   " },
  warn: { color: "text-amber-400", prefix: "!!!" },
  error: { color: "text-red-400", prefix: "ERR" },
};

function ScanTerminal({ paused }: { paused: boolean }) {
  const [logs, setLogs] = useState<ScanLogEntry[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (paused) return;

    const evtSource = new EventSource("/api/scan-logs/stream");
    evtSource.onmessage = (e) => {
      try {
        const entry: ScanLogEntry = JSON.parse(e.data);
        setLogs((prev) => {
          const next = [...prev, entry];
          return next.length > 500 ? next.slice(-500) : next;
        });
      } catch { /* ignore malformed */ }
    };
    evtSource.onerror = () => {
      // reconnect handled by browser
    };
    return () => evtSource.close();
  }, [paused]);

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, autoScroll]);

  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
  };

  return (
    <div className="glass-card rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.06]">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">Live Scan Log</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-zinc-600">{logs.length} entries</span>
          <button
            onClick={() => setLogs([])}
            className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors"
          >
            Clear
          </button>
        </div>
      </div>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-64 overflow-y-auto bg-black/40 font-mono text-[11px] leading-[1.6] p-3 scrollbar-thin scrollbar-thumb-zinc-800"
      >
        {logs.length === 0 && (
          <div className="text-zinc-600 italic">Waiting for scan activity...</div>
        )}
        {logs.map((entry, i) => {
          const style = LOG_LEVEL_STYLES[entry.level];
          const time = new Date(entry.ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
          return (
            <div key={i} className="flex gap-0 whitespace-pre-wrap break-all">
              <span className="text-zinc-600 shrink-0">{time} </span>
              <span className={`shrink-0 ${style.color}`}>{style.prefix} </span>
              <span className={style.color}>{entry.msg}</span>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
      {!autoScroll && (
        <button
          onClick={() => { setAutoScroll(true); bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }}
          className="w-full py-1.5 text-[10px] text-zinc-500 hover:text-zinc-300 bg-zinc-900/80 border-t border-white/[0.06] transition-colors"
        >
          Scroll to bottom
        </button>
      )}
    </div>
  );
}

// ---- Component ----

export function AiMatchingPanel({ paused }: { paused: boolean }) {
  const [verdictFilter, setVerdictFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [rescanning, setRescanning] = useState(false);

  const statusPoll = usePolling<MatchStatus>("/api/ai-matching/status", 10_000, paused);
  const resultsPoll = usePolling<ResultsResponse>(
    `/api/ai-matching/results${verdictFilter !== "all" ? `?verdict=${verdictFilter}` : ""}`,
    30_000,
    paused
  );

  const status = statusPoll.data;
  const results = resultsPoll.data?.results ?? [];

  // Client-side search filter
  const filtered = search
    ? results.filter(
        (r) =>
          r.poly_title.toLowerCase().includes(search.toLowerCase()) ||
          r.kalshi_title.toLowerCase().includes(search.toLowerCase()) ||
          r.poly_slug.toLowerCase().includes(search.toLowerCase()) ||
          r.kalshi_ticker.toLowerCase().includes(search.toLowerCase())
      )
    : results;

  async function handleRescan() {
    setRescanning(true);
    try {
      await fetch("/api/cross-platform/refresh", { method: "POST" });
      statusPoll.refetch();
      resultsPoll.refetch();
    } catch { /* silent */ }
    finally { setRescanning(false); }
  }

  const [runningCycle, setRunningCycle] = useState(false);
  async function handleRunCycle() {
    setRunningCycle(true);
    try {
      await fetch("/api/cross-platform/rescan", { method: "POST" });
      statusPoll.refetch();
      resultsPoll.refetch();
    } catch { /* silent */ }
    finally { setRunningCycle(false); }
  }

  async function handleOverride(polySlug: string, kalshiTicker: string, action: "approved" | "rejected") {
    try {
      await fetch("/api/ai-matching/override", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ polySlug, kalshiTicker, action }),
      });
      resultsPoll.refetch();
      statusPoll.refetch();
    } catch { /* silent */ }
  }

  // ---- Render ----

  if (statusPoll.loading && !status) {
    return (
      <div className="space-y-4">
        <div className="glass-card rounded-xl p-6 h-32 animate-pulse" />
        <div className="grid grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="glass-card rounded-xl p-5 h-24 animate-pulse" />
          ))}
        </div>
        <div className="glass-card rounded-xl p-6 h-64 animate-pulse" />
      </div>
    );
  }

  const stats = status?.matchStats;
  const kimi = status?.kimiStats;
  const verifierLabel = status?.aiVerifier === "kimi-k2.5" ? "KimiK2.5" : status?.aiVerifier === "openai-embeddings" ? "OpenAI Embeddings" : "None";

  return (
    <div className="space-y-5">
      {/* ── Pipeline Status Card ── */}
      <div className="glass-card rounded-xl p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-[15px] font-semibold text-zinc-100">AI Pair Verification</h2>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase ${
                  status?.aiVerifier !== "none"
                    ? "bg-emerald-500/15 text-emerald-400"
                    : "bg-red-500/15 text-red-400"
                }`}>
                  {status?.aiVerifier !== "none" ? "ACTIVE" : "DISABLED"}
                </span>
              </div>
              <p className="text-[11px] text-zinc-500 mt-0.5">
                Model: <span className="text-zinc-400 font-medium">{verifierLabel}</span>
                {status?.lastScanAt && (
                  <> &middot; Last scan: <span className="text-zinc-400">{timeAgo(status.lastScanAt)}</span></>
                )}
                {status?.scanning && (
                  <> &middot; <span className="text-amber-400 animate-pulse">Scanning...</span></>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            {status?.lastScanDurationMs ? (
              <div className="text-right">
                <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Scan Duration</p>
                <p className="text-[13px] text-zinc-300 font-mono">{(status.lastScanDurationMs / 1000).toFixed(1)}s</p>
              </div>
            ) : null}
            <button
              onClick={handleRunCycle}
              disabled={runningCycle || rescanning || status?.scanning}
              className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold uppercase tracking-wider transition-all border ${
                runningCycle || rescanning || status?.scanning
                  ? "bg-zinc-800/50 text-zinc-600 border-zinc-700 cursor-not-allowed"
                  : "bg-blue-500/10 text-blue-400 border-blue-500/30 hover:bg-blue-500/20"
              }`}
            >
              {runningCycle ? "Running..." : "Run Cycle"}
            </button>
            <button
              onClick={handleRescan}
              disabled={rescanning || runningCycle || status?.scanning}
              className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold uppercase tracking-wider transition-all border ${
                rescanning || runningCycle || status?.scanning
                  ? "bg-zinc-800/50 text-zinc-600 border-zinc-700 cursor-not-allowed"
                  : "bg-[#CC0035]/10 text-[#CC0035] border-[#CC0035]/30 hover:bg-[#CC0035]/20"
              }`}
            >
              {rescanning ? "Rescanning..." : "Force Rescan"}
            </button>
          </div>
        </div>
      </div>

      {/* ── Stats Row ── */}
      <div className="grid grid-cols-4 gap-4">
        <div className="glass-card rounded-xl p-5">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Total Evaluated</p>
          <p className="text-2xl font-semibold text-zinc-100 tabular-nums">{stats?.total ?? 0}</p>
        </div>
        <div className="glass-card rounded-xl p-5">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Verified Matches</p>
          <p className="text-2xl font-semibold text-emerald-400 tabular-nums">{stats?.verified ?? 0}</p>
        </div>
        <div className="glass-card rounded-xl p-5">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Avg Confidence</p>
          <p className="text-2xl font-semibold text-zinc-100 tabular-nums">
            {stats?.avgConfidence ? `${(stats.avgConfidence * 100).toFixed(1)}%` : "—"}
          </p>
        </div>
        <div className="glass-card rounded-xl p-5">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Cache Hit Rate</p>
          <p className="text-2xl font-semibold text-zinc-100 tabular-nums">
            {kimi ? `${(kimi.hitRate * 100).toFixed(0)}%` : "—"}
          </p>
          {kimi && (
            <p className="text-[10px] text-zinc-500 mt-0.5">
              {kimi.cacheSize} cached &middot; ~${kimi.estimatedCostUsd.toFixed(4)}
            </p>
          )}
        </div>
      </div>

      {/* ── Live Scan Terminal ── */}
      <ScanTerminal paused={paused} />

      {/* ── Filter Bar ── */}
      <div className="flex items-center gap-3">
        {["all", "verified", "rejected", "pending"].map((v) => (
          <button
            key={v}
            onClick={() => setVerdictFilter(v)}
            className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold uppercase tracking-wider transition-all ${
              verdictFilter === v
                ? "bg-[#CC0035]/15 text-[#CC0035] border border-[#CC0035]/30"
                : "bg-white/[0.03] text-zinc-500 border border-white/[0.06] hover:text-zinc-300"
            }`}
          >
            {v}
            {v !== "all" && stats && (
              <span className="ml-1.5 text-[10px] opacity-70">
                {v === "verified" ? stats.verified : v === "rejected" ? stats.rejected : stats.pending}
              </span>
            )}
          </button>
        ))}

        <div className="flex-1" />

        <input
          type="text"
          placeholder="Search markets..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-3 py-1.5 rounded-lg bg-white/[0.03] border border-white/[0.06] text-[12px] text-zinc-300 placeholder-zinc-600 w-64 focus:outline-none focus:border-zinc-500"
        />
      </div>

      {/* ── Results Table ── */}
      <div className="glass-card rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/[0.06]">
                <th className="px-4 py-3 text-left text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">Polymarket</th>
                <th className="px-4 py-3 text-left text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">Kalshi</th>
                <th className="px-4 py-3 text-center text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">Text</th>
                <th className="px-4 py-3 text-center text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">AI Conf</th>
                <th className="px-4 py-3 text-center text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">Verdict</th>
                <th className="px-4 py-3 text-center text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-[13px] text-zinc-600">
                    {resultsPoll.loading ? "Loading..." : "No AI match results yet. Run a scan to populate."}
                  </td>
                </tr>
              )}
              {filtered.map((row) => {
                const conf = confidenceBadge(row.ai_confidence);
                const verd = verdictBadge(row.final_verdict);
                const isExpanded = expandedId === row.id;

                return (
                  <tr key={row.id} className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors">
                    <td className="px-4 py-3">
                      {(() => {
                        const polyUrl = row.poly_url || `https://polymarket.com/event/${row.poly_slug}`;
                        return (
                          <>
                            <a
                              href={polyUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[12px] text-blue-400 hover:text-blue-300 hover:underline leading-tight max-w-[280px] truncate block"
                              title={row.poly_title}
                            >
                              {row.poly_title}
                            </a>
                            <p className="text-[10px] text-zinc-600 font-mono mt-0.5">{row.poly_slug}</p>
                          </>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-3">
                      {(() => {
                        const kalshiUrl = row.kalshi_url || `https://kalshi.com/markets/${row.kalshi_ticker}`;
                        return (
                          <>
                            <a
                              href={kalshiUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[12px] text-blue-400 hover:text-blue-300 hover:underline leading-tight max-w-[280px] truncate block"
                              title={row.kalshi_title}
                            >
                              {row.kalshi_title}
                            </a>
                            <p className="text-[10px] text-zinc-600 font-mono mt-0.5">{row.kalshi_ticker}</p>
                          </>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`text-[12px] font-mono font-semibold ${textScoreColor(row.text_score)}`}>
                        {(row.text_score * 100).toFixed(0)}%
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold ${conf.bg} ${conf.text}`}>
                        {row.ai_match ? "MATCH" : "NO"} {conf.label}
                      </span>
                      <button
                        onClick={() => setExpandedId(isExpanded ? null : row.id)}
                        className="ml-1.5 text-[10px] text-zinc-600 hover:text-zinc-400"
                        title="Show reasoning"
                      >
                        {isExpanded ? "[-]" : "[+]"}
                      </button>
                      {isExpanded && (
                        <p className="text-[10px] text-zinc-500 mt-1 text-left max-w-[240px] leading-relaxed">
                          {row.ai_reasoning}
                          <br />
                          <span className="text-zinc-600">
                            {row.ai_latency_ms}ms &middot; {row.from_cache ? "cached" : "live"} &middot; {row.ai_model}
                          </span>
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${verd.bg} ${verd.text}`}>
                        {row.final_verdict}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <div className="flex items-center justify-center gap-1.5">
                        <button
                          onClick={() => handleOverride(row.poly_slug, row.kalshi_ticker, "approved")}
                          disabled={row.user_override === "approved"}
                          className={`px-2 py-1 rounded text-[10px] font-semibold transition-all ${
                            row.user_override === "approved"
                              ? "bg-emerald-500/20 text-emerald-400 cursor-default"
                              : "bg-white/[0.04] text-zinc-500 hover:bg-emerald-500/15 hover:text-emerald-400 border border-white/[0.06]"
                          }`}
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => handleOverride(row.poly_slug, row.kalshi_ticker, "rejected")}
                          disabled={row.user_override === "rejected"}
                          className={`px-2 py-1 rounded text-[10px] font-semibold transition-all ${
                            row.user_override === "rejected"
                              ? "bg-red-500/20 text-red-400 cursor-default"
                              : "bg-white/[0.04] text-zinc-500 hover:bg-red-500/15 hover:text-red-400 border border-white/[0.06]"
                          }`}
                        >
                          Reject
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 border-t border-white/[0.04] flex items-center justify-between">
          <p className="text-[10px] text-zinc-600">
            Showing {filtered.length} of {results.length} results
          </p>
          {resultsPoll.lastUpdated && (
            <p className="text-[10px] text-zinc-600">
              Updated {timeAgo(resultsPoll.lastUpdated.toISOString())}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
