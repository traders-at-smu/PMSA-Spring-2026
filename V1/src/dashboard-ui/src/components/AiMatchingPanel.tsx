import { useState } from "react";
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

// ---- Component ----

export function AiMatchingPanel({ paused }: { paused: boolean }) {
  const [verdictFilter, setVerdictFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);

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
          {status?.lastScanDurationMs ? (
            <div className="text-right">
              <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Scan Duration</p>
              <p className="text-[13px] text-zinc-300 font-mono">{(status.lastScanDurationMs / 1000).toFixed(1)}s</p>
            </div>
          ) : null}
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
                      <p className="text-[12px] text-zinc-200 leading-tight max-w-[280px] truncate" title={row.poly_title}>
                        {row.poly_title}
                      </p>
                      <p className="text-[10px] text-zinc-600 font-mono mt-0.5">{row.poly_slug}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-[12px] text-zinc-200 leading-tight max-w-[280px] truncate" title={row.kalshi_title}>
                        {row.kalshi_title}
                      </p>
                      <p className="text-[10px] text-zinc-600 font-mono mt-0.5">{row.kalshi_ticker}</p>
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
