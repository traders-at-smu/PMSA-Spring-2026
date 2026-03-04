import { useState, useEffect } from "react";
import { usePolling } from "../hooks/usePolling";

// ---- Types ----

interface CrossPlatformArb {
  event: string;
  outcome: string;
  polymarketSlug: string;
  kalshiTicker: string;
  polyYesBid: number;
  polyYesAsk: number;
  kalshiYesBid: number;
  kalshiYesAsk: number;
  buyYesVenue: "POLYMARKET" | "KALSHI";
  buyYesPrice: number;
  buyNoVenue: "POLYMARKET" | "KALSHI";
  buyNoPrice: number;
  grossProfit: number;
  netProfit: number;
  roi: number;
  priceDiff: number;
  polymarketUrl: string;
  kalshiUrl: string;
  similarityScore: number;
  category: string;
}

interface PriceDiff {
  event: string;
  outcome: string;
  kalshiPrice: number;
  polymarketPrice: number;
  diff: number;
  diffPct: number;
  polymarketUrl: string;
  kalshiUrl: string;
  category: string;
}

interface VolumePair {
  event: string;
  kalshiTicker: string;
  polymarketSlug: string;
  kalshiVolume24h: number;
  polymarketVolume24h: number;
  kalshiLiquidity: number;
  polymarketLiquidity: number;
  volumeDiff: number;
  polymarketUrl: string;
  kalshiUrl: string;
  category: string;
  similarityScore: number;
}

interface ArbResponse {
  arbs: CrossPlatformArb[];
  matchedPairs: number;
  polymarketsScanned: number;
  kalshiMarketsScanned: number;
  timestamp: string;
}

interface MatchedPairInfo {
  polymarketTitle: string;
  kalshiTitle: string;
  polymarketUrl: string;
  kalshiUrl: string;
  similarityScore: number;
  category: string;
  polyYesBid: number;
  polyYesAsk: number;
  kalshiYesBid: number;
  kalshiYesAsk: number;
  hasArb: boolean;
}

interface DiffResponse {
  diffs: PriceDiff[];
  volumes: VolumePair[];
  matchedPairs: number;
  timestamp: string;
}

interface PairsResponse {
  pairs: MatchedPairInfo[];
  total: number;
  filtered: number;
  timestamp: string;
}

// ---- Helpers ----

function formatUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function VenueBadge({ venue }: { venue: "POLYMARKET" | "KALSHI" }) {
  const isKalshi = venue === "KALSHI";
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider ${
        isKalshi
          ? "bg-cyan-500/15 text-cyan-400 border border-cyan-500/25"
          : "bg-violet-500/15 text-violet-400 border border-violet-500/25"
      }`}
    >
      {isKalshi ? "Kalshi" : "Poly"}
    </span>
  );
}

function CategoryBadge({ category }: { category: string }) {
  const colors: Record<string, string> = {
    politics: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    macro: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    sports: "bg-green-500/10 text-green-400 border-green-500/20",
    crypto: "bg-orange-500/10 text-orange-400 border-orange-500/20",
    other: "bg-zinc-700/30 text-zinc-500 border-zinc-600/30",
  };
  return (
    <span
      className={`px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider border ${
        colors[category] || colors.other
      }`}
    >
      {category}
    </span>
  );
}

// ---- Component ----

export function CrossPlatformPanel({ paused }: { paused: boolean }) {
  const [tab, setTab] = useState<"arb" | "diff" | "vol" | "pairs">("arb");
  const [countdown, setCountdown] = useState(30);
  const [pairsFilter, setPairsFilter] = useState<"all" | "arb" | "no-arb">("all");

  const arbData = usePolling<ArbResponse>("/api/cross-platform/arbs", 30_000, paused);
  const diffData = usePolling<DiffResponse>("/api/cross-platform/diffs", 30_000, paused);
  const pairsData = usePolling<PairsResponse>(`/api/cross-platform/pairs?filter=${pairsFilter}`, 30_000, paused);

  // Countdown timer
  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => {
      setCountdown((prev) => (prev <= 1 ? 30 : prev - 1));
    }, 1000);
    return () => clearInterval(t);
  }, [paused]);

  // Reset countdown on new data
  useEffect(() => {
    if (arbData.lastUpdated) setCountdown(30);
  }, [arbData.lastUpdated]);

  const arbs = arbData.data?.arbs ?? [];
  const diffs = diffData.data?.diffs ?? [];
  const volumes = diffData.data?.volumes ?? [];
  const pairs = pairsData.data?.pairs ?? [];
  const matchedPairs = arbData.data?.matchedPairs ?? diffData.data?.matchedPairs ?? 0;
  const polyScanned = arbData.data?.polymarketsScanned ?? 0;
  const kalshiScanned = arbData.data?.kalshiMarketsScanned ?? 0;

  const tabs: { id: typeof tab; label: string; count: number }[] = [
    { id: "arb", label: "Arb", count: arbs.length },
    { id: "diff", label: "Diff", count: diffs.length },
    { id: "vol", label: "Vol", count: volumes.length },
    { id: "pairs", label: "Pairs", count: pairsData.data?.total ?? 0 },
  ];

  return (
    <div className="space-y-5">
      {/* Section header */}
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100 tracking-tight">
            Cross-Platform Arbitrage
          </h2>
          <p className="text-xs text-zinc-500 mt-0.5">
            {matchedPairs > 0 ? (
              <>
                <span className="text-zinc-400 font-mono tabular-nums">{matchedPairs}</span>{" "}
                matched pairs across{" "}
                <span className="text-violet-400/70 font-mono tabular-nums">{polyScanned.toLocaleString()}</span>{" "}
                Polymarket &{" "}
                <span className="text-cyan-400/70 font-mono tabular-nums">{kalshiScanned.toLocaleString()}</span>{" "}
                Kalshi markets
              </>
            ) : (
              "Scanning Polymarket & Kalshi for cross-venue opportunities..."
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div
              className={`w-2 h-2 rounded-full ${
                !paused && arbData.lastUpdated ? "bg-emerald-400 status-live" : "bg-zinc-600"
              }`}
            />
            <span className="text-xs text-zinc-500 font-medium">
              {paused ? "Paused" : arbData.lastUpdated ? `Refresh in ${countdown}s` : "Loading..."}
            </span>
          </div>
          {arbData.data && (
            <>
              <div className="w-px h-4 bg-zinc-800" />
              <span className="text-xs text-zinc-600 font-mono tabular-nums">
                {new Date(arbData.data.timestamp).toLocaleTimeString()}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="glass-card rounded-xl p-1.5 inline-flex gap-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 rounded-lg text-[13px] font-medium transition-all duration-200 ${
              tab === t.id
                ? "bg-orange-500/15 text-orange-400 shadow-inner shadow-orange-500/5"
                : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]"
            }`}
          >
            {t.label}
            {t.count > 0 && (
              <span
                className={`ml-2 text-[11px] px-1.5 py-0.5 rounded-md ${
                  tab === t.id ? "bg-orange-500/20 text-orange-300" : "bg-zinc-800 text-zinc-500"
                }`}
              >
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Loading */}
      {arbData.loading && !arbData.data ? (
        <div className="glass-card rounded-xl p-16 flex flex-col items-center gap-3">
          <div className="w-5 h-5 border-2 border-zinc-700 border-t-orange-400 rounded-full animate-spin" />
          <span className="text-xs text-zinc-500">Matching events across platforms...</span>
        </div>
      ) : (
        <>
          {/* ──── ARB TAB ──── */}
          {tab === "arb" && (
            <div className="glass-card rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/[0.06]">
                    <th className="px-4 py-3 text-left text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                      Event
                    </th>
                    <th className="px-4 py-3 text-center text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                      Buy YES
                    </th>
                    <th className="px-4 py-3 text-center text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                      Buy NO
                    </th>
                    <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                      Net Profit
                    </th>
                    <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                      ROI
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {arbs.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-12 text-center text-zinc-500 text-sm">
                        No cross-platform arbitrage opportunities found
                      </td>
                    </tr>
                  ) : (
                    arbs.map((arb, i) => (
                      <tr
                        key={`${arb.polymarketSlug}-${arb.kalshiTicker}-${i}`}
                        className="data-row border-b border-white/[0.03] last:border-0"
                      >
                        {/* Event */}
                        <td className="px-4 py-3 max-w-xs">
                          <div className="text-[13px] text-zinc-200 font-medium leading-snug line-clamp-2">
                            {arb.event}
                          </div>
                          <div className="flex items-center gap-2 mt-1.5">
                            <CategoryBadge category={arb.category} />
                            <span className="text-[9px] text-zinc-600 font-mono">
                              {(arb.similarityScore * 100).toFixed(0)}% match
                            </span>
                          </div>
                        </td>

                        {/* Buy YES */}
                        <td className="px-4 py-3 text-center">
                          <div className="flex flex-col items-center gap-1">
                            <VenueBadge venue={arb.buyYesVenue} />
                            <span className="font-mono text-emerald-400 text-[13px] tabular-nums font-medium">
                              {(arb.buyYesPrice * 100).toFixed(1)}&cent;
                            </span>
                          </div>
                        </td>

                        {/* Buy NO */}
                        <td className="px-4 py-3 text-center">
                          <div className="flex flex-col items-center gap-1">
                            <VenueBadge venue={arb.buyNoVenue} />
                            <span className="font-mono text-red-400 text-[13px] tabular-nums font-medium">
                              {(arb.buyNoPrice * 100).toFixed(1)}&cent;
                            </span>
                          </div>
                        </td>

                        {/* Net Profit */}
                        <td className="px-4 py-3 text-right">
                          <span
                            className={`font-mono tabular-nums text-[13px] font-semibold ${
                              arb.netProfit > 0 ? "text-emerald-400" : "text-zinc-500"
                            }`}
                          >
                            +{(arb.netProfit * 100).toFixed(1)}&cent;
                          </span>
                        </td>

                        {/* ROI */}
                        <td className="px-4 py-3 text-right">
                          <span
                            className={`px-2.5 py-1 rounded-md text-[11px] font-bold tabular-nums ${
                              arb.roi > 0.03
                                ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/20"
                                : arb.roi > 0.01
                                ? "bg-amber-500/15 text-amber-400 border border-amber-500/20"
                                : "bg-zinc-800 text-zinc-400 border border-zinc-700"
                            }`}
                          >
                            {(arb.roi * 100).toFixed(1)}%
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* ──── DIFF TAB ──── */}
          {tab === "diff" && (
            <div className="glass-card rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/[0.06]">
                    <th className="px-4 py-3 text-left text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                      Event
                    </th>
                    <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                      Kalshi
                    </th>
                    <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                      Polymarket
                    </th>
                    <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                      Diff
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {diffs.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-4 py-12 text-center text-zinc-500 text-sm">
                        No price differences found
                      </td>
                    </tr>
                  ) : (
                    diffs.map((d, i) => {
                      const kalshiCheaper = d.diff < 0;
                      return (
                        <tr
                          key={`${d.event}-${i}`}
                          className="data-row border-b border-white/[0.03] last:border-0"
                        >
                          <td className="px-4 py-3 max-w-xs">
                            <div className="text-[13px] text-zinc-200 font-medium leading-snug line-clamp-2">
                              {d.event}
                            </div>
                            <div className="mt-1">
                              <CategoryBadge category={d.category} />
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <span
                              className={`font-mono tabular-nums text-[13px] ${
                                kalshiCheaper ? "text-cyan-400 font-semibold" : "text-zinc-400"
                              }`}
                            >
                              {(d.kalshiPrice * 100).toFixed(1)}&cent;
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <span
                              className={`font-mono tabular-nums text-[13px] ${
                                !kalshiCheaper ? "text-violet-400 font-semibold" : "text-zinc-400"
                              }`}
                            >
                              {(d.polymarketPrice * 100).toFixed(1)}&cent;
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <span
                                className={`font-mono tabular-nums text-[13px] font-semibold ${
                                  Math.abs(d.diff) > 0.05
                                    ? "text-amber-400"
                                    : Math.abs(d.diff) > 0.02
                                    ? "text-zinc-300"
                                    : "text-zinc-500"
                                }`}
                              >
                                {d.diff > 0 ? "+" : ""}
                                {(d.diff * 100).toFixed(1)}&cent;
                              </span>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* ──── VOL TAB ──── */}
          {tab === "vol" && (
            <div className="glass-card rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/[0.06]">
                    <th className="px-4 py-3 text-left text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                      Event
                    </th>
                    <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                      Poly Vol 24h
                    </th>
                    <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                      Kalshi Vol 24h
                    </th>
                    <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                      Poly Liq
                    </th>
                    <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                      Kalshi Liq
                    </th>
                    <th className="px-4 py-3 text-center text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                      Skew
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {volumes.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-12 text-center text-zinc-500 text-sm">
                        No volume data available
                      </td>
                    </tr>
                  ) : (
                    volumes.map((v, i) => {
                      // Volume bar — what fraction goes to Polymarket vs Kalshi
                      const totalVol = v.polymarketVolume24h + v.kalshiVolume24h;
                      const polyPct = totalVol > 0 ? (v.polymarketVolume24h / totalVol) * 100 : 50;

                      return (
                        <tr
                          key={`${v.event}-${i}`}
                          className="data-row border-b border-white/[0.03] last:border-0"
                        >
                          <td className="px-4 py-3 max-w-xs">
                            <div className="text-[13px] text-zinc-200 font-medium leading-snug line-clamp-2">
                              {v.event}
                            </div>
                            <div className="mt-1">
                              <CategoryBadge category={v.category} />
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-violet-400 tabular-nums text-[13px]">
                            {formatUsd(v.polymarketVolume24h)}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-cyan-400 tabular-nums text-[13px]">
                            {formatUsd(v.kalshiVolume24h)}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-zinc-400 tabular-nums text-[13px]">
                            {formatUsd(v.polymarketLiquidity)}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-zinc-400 tabular-nums text-[13px]">
                            {formatUsd(v.kalshiLiquidity)}
                          </td>
                          <td className="px-4 py-3">
                            {/* Volume skew bar */}
                            <div className="w-full flex items-center gap-1.5">
                              <span className="text-[9px] text-violet-400/60 font-mono w-8 text-right">
                                {polyPct.toFixed(0)}%
                              </span>
                              <div className="flex-1 h-2 rounded-full bg-zinc-800 overflow-hidden flex">
                                <div
                                  className="h-full bg-gradient-to-r from-violet-500 to-violet-400 rounded-l-full transition-all duration-500"
                                  style={{ width: `${polyPct}%` }}
                                />
                                <div
                                  className="h-full bg-gradient-to-r from-cyan-400 to-cyan-500 rounded-r-full transition-all duration-500"
                                  style={{ width: `${100 - polyPct}%` }}
                                />
                              </div>
                              <span className="text-[9px] text-cyan-400/60 font-mono w-8">
                                {(100 - polyPct).toFixed(0)}%
                              </span>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* ──── PAIRS TAB ──── */}
          {tab === "pairs" && (
            <div className="space-y-3">
              {/* Filter controls */}
              <div className="flex items-center gap-2">
                {(["all", "arb", "no-arb"] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setPairsFilter(f)}
                    className={`px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all duration-200 ${
                      pairsFilter === f
                        ? "bg-orange-500/15 text-orange-400"
                        : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]"
                    }`}
                  >
                    {f === "all" ? "All" : f === "arb" ? "Has Arb" : "No Arb"}
                    {pairsData.data && (
                      <span className={`ml-1.5 text-[10px] ${pairsFilter === f ? "text-orange-300/70" : "text-zinc-600"}`}>
                        {f === "all" ? pairsData.data.total : pairsData.data.filtered}
                      </span>
                    )}
                  </button>
                ))}
              </div>

              <div className="glass-card rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/[0.06]">
                      <th className="px-4 py-3 text-left text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                        Polymarket
                      </th>
                      <th className="px-4 py-3 text-left text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                        Kalshi
                      </th>
                      <th className="px-4 py-3 text-center text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                        Match
                      </th>
                      <th className="px-4 py-3 text-center text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                        Prices
                      </th>
                      <th className="px-4 py-3 text-center text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                        Links
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {pairs.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-4 py-12 text-center text-zinc-500 text-sm">
                          No matched pairs found
                        </td>
                      </tr>
                    ) : (
                      pairs.map((p, i) => (
                        <tr
                          key={i}
                          className={`data-row border-b border-white/[0.03] last:border-0 ${
                            p.hasArb ? "bg-emerald-500/[0.03]" : ""
                          }`}
                        >
                          {/* Polymarket title */}
                          <td className="px-4 py-3 max-w-[280px]">
                            <div className="text-[13px] text-violet-300 font-medium leading-snug line-clamp-2">
                              {p.polymarketTitle}
                            </div>
                            <div className="flex items-center gap-2 mt-1">
                              <CategoryBadge category={p.category} />
                              {p.hasArb && (
                                <span className="px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">
                                  ARB
                                </span>
                              )}
                            </div>
                          </td>

                          {/* Kalshi title */}
                          <td className="px-4 py-3 max-w-[280px]">
                            <div className="text-[13px] text-cyan-300 font-medium leading-snug line-clamp-2">
                              {p.kalshiTitle}
                            </div>
                          </td>

                          {/* Similarity score */}
                          <td className="px-4 py-3 text-center">
                            <span
                              className={`px-2 py-1 rounded-md text-[11px] font-bold tabular-nums font-mono ${
                                p.similarityScore >= 0.8
                                  ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/20"
                                  : p.similarityScore >= 0.6
                                  ? "bg-amber-500/15 text-amber-400 border border-amber-500/20"
                                  : "bg-zinc-800 text-zinc-400 border border-zinc-700"
                              }`}
                            >
                              {(p.similarityScore * 100).toFixed(0)}%
                            </span>
                          </td>

                          {/* Prices */}
                          <td className="px-4 py-3 text-center">
                            <div className="flex flex-col items-center gap-0.5">
                              <span className="text-[10px] text-zinc-500">Poly</span>
                              <span className="font-mono text-violet-400 text-[12px] tabular-nums">
                                {(p.polyYesBid * 100).toFixed(0)}-{(p.polyYesAsk * 100).toFixed(0)}c
                              </span>
                              <span className="text-[10px] text-zinc-500 mt-0.5">Kalshi</span>
                              <span className="font-mono text-cyan-400 text-[12px] tabular-nums">
                                {(p.kalshiYesBid * 100).toFixed(0)}-{(p.kalshiYesAsk * 100).toFixed(0)}c
                              </span>
                            </div>
                          </td>

                          {/* Links */}
                          <td className="px-4 py-3 text-center">
                            <div className="flex flex-col items-center gap-1.5">
                              <a
                                href={p.polymarketUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[10px] text-violet-400/70 hover:text-violet-300 underline underline-offset-2 transition-colors"
                              >
                                Polymarket
                              </a>
                              <a
                                href={p.kalshiUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[10px] text-cyan-400/70 hover:text-cyan-300 underline underline-offset-2 transition-colors"
                              >
                                Kalshi
                              </a>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
