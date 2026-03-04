import { useState } from "react";
import { usePolling } from "../hooks/usePolling";

interface SpreadEntry {
  rank: number;
  market: string;
  conditionId: string;
  bestBid: number;
  bestAsk: number;
  spread: number;
  spreadPct: string;
  midpoint: number;
  volume24hr: number;
  liquidity: number;
  bidDepth?: number;
  askDepth?: number;
}

interface BinaryArb {
  market: string;
  conditionId: string;
  yesPrice: number;
  noPrice: number;
  sum: number;
  deviation: number;
  type: "BUY_BOTH" | "SELL_BOTH";
  profitPerDollar: number;
}

interface NegRiskArb {
  event: string;
  numOutcomes: number;
  sumMidpoints: number;
  sumBestAsk: number;
  sumBestBid: number;
  type: "BUY_ALL_YES" | "SELL_ALL_YES";
  profitPerDollar: number;
  outcomes: {
    question: string;
    groupTitle: string;
    yesPrice: number;
    bestBid: number;
    bestAsk: number;
    spread: number;
  }[];
}

interface ScreenerResults {
  topSpreads: SpreadEntry[];
  binaryArbs: BinaryArb[];
  negRiskArbs: NegRiskArb[];
  marketsScanned: number;
  timestamp: string;
}

function formatUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

export function ArbitragePanel({ paused }: { paused: boolean }) {
  const { data, lastUpdated } = usePolling<ScreenerResults>("/api/screener", 60_000, paused);
  const [expandedNegRisk, setExpandedNegRisk] = useState<string | null>(null);
  const [section, setSection] = useState<"spreads" | "binary" | "negrisk">("spreads");

  const screener = data;

  const sections: { id: typeof section; label: string; count: number }[] = [
    { id: "spreads", label: "Top Spreads", count: screener?.topSpreads.length ?? 0 },
    { id: "binary", label: "Binary Mispricing", count: screener?.binaryArbs.length ?? 0 },
    { id: "negrisk", label: "NegRisk Arb", count: screener?.negRiskArbs.length ?? 0 },
  ];

  return (
    <div className="space-y-5">
      {/* Section header */}
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100 tracking-tight">Polymarket Screener</h2>
          <p className="text-xs text-zinc-500 mt-0.5">
            Arbitrage opportunities across{" "}
            {screener ? (
              <span className="text-zinc-400 font-mono tabular-nums">{screener.marketsScanned.toLocaleString()}</span>
            ) : (
              "..."
            )}{" "}
            active markets
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div
              className={`w-2 h-2 rounded-full ${
                !paused && lastUpdated ? "bg-emerald-400 status-live" : "bg-zinc-600"
              }`}
            />
            <span className="text-xs text-zinc-500 font-medium">
              {paused ? "Paused" : lastUpdated ? "Auto-refresh" : "Loading..."}
            </span>
          </div>
          {screener && (
            <>
              <div className="w-px h-4 bg-zinc-800" />
              <span className="text-xs text-zinc-600 font-mono tabular-nums">
                {new Date(screener.timestamp).toLocaleTimeString()}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Section tabs */}
      <div className="glass-card rounded-xl p-1.5 inline-flex gap-1">
        {sections.map((s) => (
          <button
            key={s.id}
            onClick={() => setSection(s.id)}
            className={`px-4 py-2 rounded-lg text-[13px] font-medium transition-all duration-200 ${
              section === s.id
                ? "bg-violet-500/15 text-violet-400 shadow-inner shadow-violet-500/5"
                : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]"
            }`}
          >
            {s.label}
            {s.count > 0 && (
              <span className={`ml-2 text-[11px] px-1.5 py-0.5 rounded-md ${
                section === s.id ? "bg-violet-500/20 text-violet-300" : "bg-zinc-800 text-zinc-500"
              }`}>
                {s.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {!screener ? (
        <div className="glass-card rounded-xl p-16 flex flex-col items-center gap-3">
          <div className="w-5 h-5 border-2 border-zinc-700 border-t-violet-400 rounded-full animate-spin" />
          <span className="text-xs text-zinc-500">Loading screener data...</span>
        </div>
      ) : (
        <>
          {/* ---- Top Spreads ---- */}
          {section === "spreads" && (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {screener.topSpreads.length === 0 ? (
                <div className="col-span-full glass-card rounded-xl p-12 text-center text-zinc-500 text-sm">
                  No spread opportunities found
                </div>
              ) : (
                screener.topSpreads.map((s) => (
                  <div
                    key={s.conditionId}
                    className="glass-card rounded-xl p-4 group"
                  >
                    {/* Rank badge */}
                    <div className="flex items-start justify-between mb-3">
                      <div className="text-[13px] text-zinc-200 font-medium leading-snug line-clamp-2 flex-1 mr-3">
                        {s.market}
                      </div>
                      <span className="shrink-0 w-7 h-7 rounded-lg bg-violet-500/15 border border-violet-500/20 flex items-center justify-center text-[11px] font-bold text-violet-400 font-mono">
                        {s.rank}
                      </span>
                    </div>

                    {/* Bid / Ask / Spread */}
                    <div className="grid grid-cols-3 gap-3">
                      <div className="bg-white/[0.02] rounded-lg p-2.5 text-center border border-white/[0.04]">
                        <div className="text-[9px] text-zinc-600 uppercase tracking-[0.12em] font-semibold">Bid</div>
                        <div className="font-mono text-emerald-400 text-sm mt-0.5 tabular-nums">
                          {(s.bestBid * 100).toFixed(1)}&cent;
                        </div>
                      </div>
                      <div className="bg-white/[0.02] rounded-lg p-2.5 text-center border border-white/[0.04]">
                        <div className="text-[9px] text-zinc-600 uppercase tracking-[0.12em] font-semibold">Ask</div>
                        <div className="font-mono text-red-400 text-sm mt-0.5 tabular-nums">
                          {(s.bestAsk * 100).toFixed(1)}&cent;
                        </div>
                      </div>
                      <div className="bg-amber-500/[0.06] rounded-lg p-2.5 text-center border border-amber-500/10">
                        <div className="text-[9px] text-amber-500/80 uppercase tracking-[0.12em] font-semibold">Spread</div>
                        <div className="font-mono text-amber-400 text-sm mt-0.5 font-semibold tabular-nums">
                          {s.spreadPct}%
                        </div>
                      </div>
                    </div>

                    {/* Footer stats */}
                    <div className="flex justify-between mt-3 pt-3 border-t border-white/[0.04] text-xs text-zinc-500">
                      <span>
                        Liq: <span className="text-zinc-400 font-mono tabular-nums">{formatUsd(s.liquidity)}</span>
                      </span>
                      <span>
                        Vol 24h: <span className="text-zinc-400 font-mono tabular-nums">{formatUsd(s.volume24hr)}</span>
                      </span>
                    </div>

                    {(s.bidDepth || s.askDepth) && (
                      <div className="flex justify-between mt-1.5 text-[11px] text-zinc-600">
                        <span>Bid depth: <span className="font-mono tabular-nums">{s.bidDepth ? formatUsd(s.bidDepth) : "\u2014"}</span></span>
                        <span>Ask depth: <span className="font-mono tabular-nums">{s.askDepth ? formatUsd(s.askDepth) : "\u2014"}</span></span>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          {/* ---- Binary Mispricing ---- */}
          {section === "binary" && (
            <div className="glass-card rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/[0.06]">
                    <th className="px-4 py-3 text-left text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Market</th>
                    <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">YES</th>
                    <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">NO</th>
                    <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Sum</th>
                    <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Dev</th>
                    <th className="px-4 py-3 text-center text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Signal</th>
                    <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Profit/$</th>
                  </tr>
                </thead>
                <tbody>
                  {screener.binaryArbs.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-12 text-center text-zinc-500 text-sm">
                        No binary mispricing opportunities found
                      </td>
                    </tr>
                  ) : (
                    screener.binaryArbs.map((arb) => (
                      <tr
                        key={arb.conditionId}
                        className="data-row border-b border-white/[0.03] last:border-0"
                      >
                        <td className="px-4 py-3 text-zinc-200 max-w-xs truncate text-[13px]">
                          {arb.market}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-emerald-400 tabular-nums text-[13px]">
                          {(arb.yesPrice * 100).toFixed(1)}&cent;
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-red-400 tabular-nums text-[13px]">
                          {(arb.noPrice * 100).toFixed(1)}&cent;
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-zinc-400 tabular-nums text-[13px]">
                          {arb.sum.toFixed(4)}
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-mono tabular-nums text-[13px] ${
                            Math.abs(arb.deviation) > 0.02 ? "text-amber-400 font-medium" : "text-zinc-500"
                          }`}
                        >
                          {arb.deviation > 0 ? "+" : ""}
                          {(arb.deviation * 100).toFixed(2)}%
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span
                            className={`px-2.5 py-1 rounded-md text-[11px] font-semibold ${
                              arb.type === "BUY_BOTH"
                                ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/20"
                                : "bg-red-500/15 text-red-400 border border-red-500/20"
                            }`}
                          >
                            {arb.type === "BUY_BOTH" ? "Buy Both" : "Sell Both"}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-amber-400 font-medium tabular-nums text-[13px]">
                          {(arb.profitPerDollar * 100).toFixed(2)}&cent;
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* ---- NegRisk Arbitrage ---- */}
          {section === "negrisk" && (
            <div className="space-y-3">
              {screener.negRiskArbs.length === 0 ? (
                <div className="glass-card rounded-xl p-12 text-center text-zinc-500 text-sm">
                  No negRisk arbitrage opportunities found
                </div>
              ) : (
                screener.negRiskArbs.map((arb) => (
                  <div
                    key={arb.event}
                    className="glass-card rounded-xl overflow-hidden"
                  >
                    <button
                      onClick={() =>
                        setExpandedNegRisk(expandedNegRisk === arb.event ? null : arb.event)
                      }
                      className="w-full p-4 hover:bg-white/[0.02] transition-colors text-left"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <div className="text-[13px] text-zinc-200 font-medium">{arb.event}</div>
                          <div className="flex items-center gap-4 mt-2 text-xs text-zinc-500">
                            <span className="flex items-center gap-1.5">
                              <span className="w-1 h-1 rounded-full bg-zinc-600" />
                              {arb.numOutcomes} outcomes
                            </span>
                            <span>
                              Sum asks:{" "}
                              <span className="font-mono text-zinc-400 tabular-nums">
                                {arb.sumBestAsk.toFixed(4)}
                              </span>
                            </span>
                            <span>
                              Sum bids:{" "}
                              <span className="font-mono text-zinc-400 tabular-nums">
                                {arb.sumBestBid.toFixed(4)}
                              </span>
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <span
                            className={`px-2.5 py-1 rounded-md text-[11px] font-semibold ${
                              arb.type === "BUY_ALL_YES"
                                ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/20"
                                : "bg-red-500/15 text-red-400 border border-red-500/20"
                            }`}
                          >
                            {arb.type === "BUY_ALL_YES" ? "Buy All YES" : "Sell All YES"}
                          </span>
                          <span className="font-mono text-amber-400 text-sm font-semibold tabular-nums">
                            {(arb.profitPerDollar * 100).toFixed(2)}&cent;/$
                          </span>
                          <svg
                            className={`w-4 h-4 text-zinc-600 transition-transform duration-200 ${
                              expandedNegRisk === arb.event ? "rotate-180" : ""
                            }`}
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                          </svg>
                        </div>
                      </div>
                    </button>

                    {expandedNegRisk === arb.event && (
                      <div className="border-t border-white/[0.06] p-4">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                              <th className="pb-2.5 text-left">Outcome</th>
                              <th className="pb-2.5 text-right">YES Price</th>
                              <th className="pb-2.5 text-right">Best Bid</th>
                              <th className="pb-2.5 text-right">Best Ask</th>
                              <th className="pb-2.5 text-right">Spread</th>
                            </tr>
                          </thead>
                          <tbody>
                            {arb.outcomes.map((o, i) => (
                              <tr key={i} className="border-t border-white/[0.03]">
                                <td className="py-2.5 pr-4 text-zinc-200 max-w-xs truncate text-[13px]">
                                  {o.question}
                                </td>
                                <td className="py-2.5 text-right font-mono tabular-nums text-[13px] text-zinc-400">
                                  {(o.yesPrice * 100).toFixed(1)}&cent;
                                </td>
                                <td className="py-2.5 text-right font-mono text-emerald-400 tabular-nums text-[13px]">
                                  {(o.bestBid * 100).toFixed(1)}&cent;
                                </td>
                                <td className="py-2.5 text-right font-mono text-red-400 tabular-nums text-[13px]">
                                  {(o.bestAsk * 100).toFixed(1)}&cent;
                                </td>
                                <td
                                  className={`py-2.5 text-right font-mono tabular-nums text-[13px] ${
                                    o.spread > 0.05 ? "text-amber-400 font-medium" : "text-zinc-600"
                                  }`}
                                >
                                  {(o.spread * 100).toFixed(1)}%
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
