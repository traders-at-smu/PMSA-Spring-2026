import { useState, useEffect } from "react";
import { usePolling } from "../hooks/usePolling";

// ---- Types ----

interface PolymarketNew {
  question: string;
  conditionId: string;
  slug: string;
  createdAt: string;
  startDate?: string;
  acceptingOrdersTimestamp?: string;
  endDate?: string;
  liquidity: number;
  volume24hr: number;
  bestBid: number;
  bestAsk: number;
  spread: number;
  outcomes: string[];
  marketUrl: string;
}

interface KalshiNew {
  ticker: string;
  title: string;
  category: string;
  createdTime: string;
  openTime: string;
  closeTime: string;
  yesBid: number;
  yesAsk: number;
  volume24h: number;
  liquidity: number;
  kalshiUrl: string;
}

interface PolyResponse {
  markets: PolymarketNew[];
  timestamp: string;
}

interface KalshiResponse {
  markets: KalshiNew[];
  timestamp: string;
}

// ---- Helpers ----

function timeAgo(isoDate: string, now: number): string {
  const ts = Date.parse(isoDate);
  if (!Number.isFinite(ts)) return "—";
  const diffMs = now - ts;
  if (diffMs < 0) return `in ${formatDuration(-diffMs)}`;
  return `${formatDuration(diffMs)} ago`;
}

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

function getAgeBadge(
  isoDate: string,
  now: number
): { label: string; classes: string } | null {
  const ts = Date.parse(isoDate);
  if (!Number.isFinite(ts)) return null;
  const diffSec = (now - ts) / 1000;
  if (diffSec < 60)
    return {
      label: "JUST LISTED",
      classes:
        "bg-emerald-500/20 text-emerald-400 border-emerald-500/30 status-live",
    };
  if (diffSec < 300)
    return {
      label: "NEW",
      classes: "bg-lime-500/15 text-lime-400 border-lime-500/25",
    };
  return null;
}

function formatUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

// ---- Component ----

export function NewMarketsPanel({ paused }: { paused: boolean }) {
  const [source, setSource] = useState<"polymarket" | "kalshi">("polymarket");
  const [now, setNow] = useState(Date.now());

  // Tick every second for countdown updates
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Poll both endpoints (10s interval for fast updates)
  const polyData = usePolling<PolyResponse>(
    "/api/screener/new-markets",
    10_000,
    paused
  );
  const kalshiData = usePolling<KalshiResponse>(
    "/api/kalshi/screener/new-markets",
    10_000,
    paused
  );

  const activeData = source === "polymarket" ? polyData : kalshiData;
  const polyMarkets = polyData.data?.markets ?? [];
  const kalshiMarkets = kalshiData.data?.markets ?? [];

  return (
    <div className="space-y-5">
      {/* Section header */}
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100 tracking-tight">
            New Markets
          </h2>
          <p className="text-xs text-zinc-500 mt-0.5">
            Recently created markets with live countdown timers
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div
              className={`w-2 h-2 rounded-full ${
                !paused && activeData.lastUpdated
                  ? "bg-emerald-400 status-live"
                  : "bg-zinc-600"
              }`}
            />
            <span className="text-xs text-zinc-500 font-medium">
              {paused
                ? "Paused"
                : activeData.lastUpdated
                ? "Auto-refresh 10s"
                : "Loading..."}
            </span>
          </div>
          {activeData.lastUpdated && (
            <>
              <div className="w-px h-4 bg-zinc-800" />
              <span className="text-xs text-zinc-600 font-mono tabular-nums">
                {activeData.lastUpdated.toLocaleTimeString()}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Source tabs */}
      <div className="glass-card rounded-xl p-1.5 inline-flex gap-1">
        <button
          onClick={() => setSource("polymarket")}
          className={`px-4 py-2 rounded-lg text-[13px] font-medium transition-all duration-200 ${
            source === "polymarket"
              ? "bg-lime-500/15 text-lime-400 shadow-inner shadow-lime-500/5"
              : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]"
          }`}
        >
          Polymarket
          {polyMarkets.length > 0 && (
            <span
              className={`ml-2 text-[11px] px-1.5 py-0.5 rounded-md ${
                source === "polymarket"
                  ? "bg-lime-500/20 text-lime-300"
                  : "bg-zinc-800 text-zinc-500"
              }`}
            >
              {polyMarkets.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setSource("kalshi")}
          className={`px-4 py-2 rounded-lg text-[13px] font-medium transition-all duration-200 ${
            source === "kalshi"
              ? "bg-cyan-500/15 text-cyan-400 shadow-inner shadow-cyan-500/5"
              : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]"
          }`}
        >
          Kalshi
          {kalshiMarkets.length > 0 && (
            <span
              className={`ml-2 text-[11px] px-1.5 py-0.5 rounded-md ${
                source === "kalshi"
                  ? "bg-cyan-500/20 text-cyan-300"
                  : "bg-zinc-800 text-zinc-500"
              }`}
            >
              {kalshiMarkets.length}
            </span>
          )}
        </button>
      </div>

      {/* Loading state */}
      {activeData.loading && !activeData.data ? (
        <div className="glass-card rounded-xl p-16 flex flex-col items-center gap-3">
          <div className="w-5 h-5 border-2 border-zinc-700 border-t-lime-400 rounded-full animate-spin" />
          <span className="text-xs text-zinc-500">
            Loading new markets...
          </span>
        </div>
      ) : (
        <>
          {/* ---- Polymarket ---- */}
          {source === "polymarket" && (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {polyMarkets.length === 0 ? (
                <div className="col-span-full glass-card rounded-xl p-12 text-center text-zinc-500 text-sm">
                  No new Polymarket markets found
                </div>
              ) : (
                polyMarkets.map((m) => {
                  const badge = getAgeBadge(m.createdAt, now);
                  const hasOrders =
                    m.bestBid > 0 || m.bestAsk > 0;
                  return (
                    <div
                      key={m.conditionId}
                      className="glass-card rounded-xl p-4 group hover:border-lime-500/10 transition-colors"
                    >
                      {/* Top row: badge + time ago */}
                      <div className="flex items-center justify-between mb-2.5">
                        {badge ? (
                          <span
                            className={`px-2 py-0.5 rounded-md text-[10px] font-bold tracking-wider border ${badge.classes}`}
                          >
                            {badge.label}
                          </span>
                        ) : (
                          <span className="text-[10px] text-zinc-600 font-medium tracking-wide uppercase">
                            Listed
                          </span>
                        )}
                        <span className="text-xs font-mono tabular-nums text-zinc-500">
                          {timeAgo(m.createdAt, now)}
                        </span>
                      </div>

                      {/* Title */}
                      <div className="text-[13px] text-zinc-200 font-medium leading-snug line-clamp-2 mb-3">
                        {m.question}
                      </div>

                      {/* Pricing */}
                      {hasOrders ? (
                        <div className="grid grid-cols-3 gap-2 mb-3">
                          <div className="bg-white/[0.02] rounded-lg p-2 text-center border border-white/[0.04]">
                            <div className="text-[9px] text-zinc-600 uppercase tracking-[0.12em] font-semibold">
                              Bid
                            </div>
                            <div className="font-mono text-emerald-400 text-sm mt-0.5 tabular-nums">
                              {(m.bestBid * 100).toFixed(1)}&cent;
                            </div>
                          </div>
                          <div className="bg-white/[0.02] rounded-lg p-2 text-center border border-white/[0.04]">
                            <div className="text-[9px] text-zinc-600 uppercase tracking-[0.12em] font-semibold">
                              Ask
                            </div>
                            <div className="font-mono text-red-400 text-sm mt-0.5 tabular-nums">
                              {(m.bestAsk * 100).toFixed(1)}&cent;
                            </div>
                          </div>
                          <div className="bg-amber-500/[0.06] rounded-lg p-2 text-center border border-amber-500/10">
                            <div className="text-[9px] text-amber-500/80 uppercase tracking-[0.12em] font-semibold">
                              Spread
                            </div>
                            <div className="font-mono text-amber-400 text-sm mt-0.5 font-semibold tabular-nums">
                              {(m.spread * 100).toFixed(1)}&cent;
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="bg-zinc-800/40 rounded-lg p-3 text-center mb-3 border border-white/[0.03]">
                          <span className="text-[11px] text-zinc-500 font-medium">
                            No orders yet
                          </span>
                        </div>
                      )}

                      {/* Footer: Liq, Vol, Link */}
                      <div className="flex items-center justify-between pt-2.5 border-t border-white/[0.04] text-xs text-zinc-500">
                        <div className="flex gap-3">
                          <span>
                            Liq:{" "}
                            <span className="text-zinc-400 font-mono tabular-nums">
                              {formatUsd(m.liquidity)}
                            </span>
                          </span>
                          <span>
                            Vol 24h:{" "}
                            <span className="text-zinc-400 font-mono tabular-nums">
                              {formatUsd(m.volume24hr)}
                            </span>
                          </span>
                        </div>
                        {m.marketUrl && (
                          <a
                            href={m.marketUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-lime-500/70 hover:text-lime-400 transition-colors text-[11px] font-medium"
                          >
                            View &nearr;
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}

          {/* ---- Kalshi ---- */}
          {source === "kalshi" && (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {kalshiMarkets.length === 0 ? (
                <div className="col-span-full glass-card rounded-xl p-12 text-center text-zinc-500 text-sm">
                  No new Kalshi markets found
                </div>
              ) : (
                kalshiMarkets.map((m) => {
                  const badge = getAgeBadge(m.createdTime, now);
                  const hasOrders = m.yesBid > 0 || m.yesAsk > 0;
                  const spread = m.yesAsk - m.yesBid;
                  return (
                    <div
                      key={m.ticker}
                      className="glass-card rounded-xl p-4 group hover:border-cyan-500/10 transition-colors"
                    >
                      {/* Top row: badge + time ago */}
                      <div className="flex items-center justify-between mb-2.5">
                        <div className="flex items-center gap-2">
                          {badge ? (
                            <span
                              className={`px-2 py-0.5 rounded-md text-[10px] font-bold tracking-wider border ${badge.classes}`}
                            >
                              {badge.label}
                            </span>
                          ) : (
                            <span className="text-[10px] text-zinc-600 font-medium tracking-wide uppercase">
                              Listed
                            </span>
                          )}
                          {m.category && (
                            <span className="px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-cyan-500/10 text-cyan-400/60 border border-cyan-500/15">
                              {m.category}
                            </span>
                          )}
                        </div>
                        <span className="text-xs font-mono tabular-nums text-zinc-500">
                          {timeAgo(m.createdTime, now)}
                        </span>
                      </div>

                      {/* Title */}
                      <div className="text-[13px] text-zinc-200 font-medium leading-snug line-clamp-2 mb-3">
                        {m.title}
                      </div>

                      {/* Pricing */}
                      {hasOrders ? (
                        <div className="grid grid-cols-3 gap-2 mb-3">
                          <div className="bg-white/[0.02] rounded-lg p-2 text-center border border-white/[0.04]">
                            <div className="text-[9px] text-zinc-600 uppercase tracking-[0.12em] font-semibold">
                              Bid
                            </div>
                            <div className="font-mono text-emerald-400 text-sm mt-0.5 tabular-nums">
                              {(m.yesBid * 100).toFixed(1)}&cent;
                            </div>
                          </div>
                          <div className="bg-white/[0.02] rounded-lg p-2 text-center border border-white/[0.04]">
                            <div className="text-[9px] text-zinc-600 uppercase tracking-[0.12em] font-semibold">
                              Ask
                            </div>
                            <div className="font-mono text-red-400 text-sm mt-0.5 tabular-nums">
                              {(m.yesAsk * 100).toFixed(1)}&cent;
                            </div>
                          </div>
                          <div className="bg-amber-500/[0.06] rounded-lg p-2 text-center border border-amber-500/10">
                            <div className="text-[9px] text-amber-500/80 uppercase tracking-[0.12em] font-semibold">
                              Spread
                            </div>
                            <div className="font-mono text-amber-400 text-sm mt-0.5 font-semibold tabular-nums">
                              {(spread * 100).toFixed(1)}&cent;
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="bg-zinc-800/40 rounded-lg p-3 text-center mb-3 border border-white/[0.03]">
                          <span className="text-[11px] text-zinc-500 font-medium">
                            No orders yet
                          </span>
                        </div>
                      )}

                      {/* Footer: Liq, Vol, Link */}
                      <div className="flex items-center justify-between pt-2.5 border-t border-white/[0.04] text-xs text-zinc-500">
                        <div className="flex gap-3">
                          <span>
                            Liq:{" "}
                            <span className="text-zinc-400 font-mono tabular-nums">
                              {formatUsd(m.liquidity)}
                            </span>
                          </span>
                          <span>
                            Vol 24h:{" "}
                            <span className="text-zinc-400 font-mono tabular-nums">
                              {formatUsd(m.volume24h)}
                            </span>
                          </span>
                        </div>
                        {m.kalshiUrl && (
                          <a
                            href={m.kalshiUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-cyan-500/70 hover:text-cyan-400 transition-colors text-[11px] font-medium"
                          >
                            View &nearr;
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
