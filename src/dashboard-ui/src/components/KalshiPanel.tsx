import { useState } from "react";
import { usePolling } from "../hooks/usePolling";

interface KalshiSpread {
  rank: number;
  ticker: string;
  market: string;
  category: string;
  yesBid: number;
  yesAsk: number;
  spread: number;
  spreadPct: string;
  midpoint: number;
  volume24h: number;
  liquidity: number;
  bidDepthDollars?: number;
  askDepthDollars?: number;
  closeTime: string;
  kalshiUrl: string;
}

interface KalshiBinaryArb {
  ticker: string;
  market: string;
  category: string;
  yesPrice: number;
  noPrice: number;
  sum: number;
  deviation: number;
  type: "BUY_BOTH" | "SELL_BOTH";
  profitPerDollar: number;
  kalshiUrl: string;
}

interface KalshiEventArb {
  eventTicker: string;
  eventTitle: string;
  numOutcomes: number;
  sumYesMidpoints: number;
  sumYesAsks: number;
  sumYesBids: number;
  type: "BUY_ALL_YES" | "SELL_ALL_YES";
  profitPerDollar: number;
  outcomes: {
    ticker: string;
    title: string;
    yesPrice: number;
    yesBid: number;
    yesAsk: number;
    spread: number;
  }[];
}

interface KalshiScreenerData {
  topSpreads: KalshiSpread[];
  binaryMispricing: KalshiBinaryArb[];
  eventGroupArbs: KalshiEventArb[];
  marketsScanned: number;
  timestamp: string;
}

function formatUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

export function KalshiPanel({ paused }: { paused: boolean }) {
  const { data, lastUpdated } = usePolling<KalshiScreenerData>("/api/kalshi/screener", 60_000, paused);
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null);
  const [section, setSection] = useState<"spreads" | "binary" | "events">("spreads");

  const screener = data;

  const sections: { id: typeof section; label: string; count: number }[] = [
    { id: "spreads", label: "Top Spreads", count: screener?.topSpreads.length ?? 0 },
    { id: "binary", label: "Binary Mispricing", count: screener?.binaryMispricing.length ?? 0 },
    { id: "events", label: "Event Group Arb", count: screener?.eventGroupArbs.length ?? 0 },
  ];

  return (
    <div className="space-y-5">
      {/* Section header */}
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100 tracking-tight">Kalshi Screener</h2>
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
                !paused && lastUpdated ? "bg-teal-400 status-live" : "bg-zinc-600"
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
                ? "bg-teal-500/15 text-teal-400 shadow-inner shadow-teal-500/5"
                : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]"
            }`}
          >
            {s.label}
            {s.count > 0 && (
              <span className={`ml-2 text-[11px] px-1.5 py-0.5 rounded-md ${
                section === s.id ? "bg-teal-500/20 text-teal-300" : "bg-zinc-800 text-zinc-500"
              }`}>
                {s.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {!screener ? (
        <div className="glass-card rounded-xl p-16 flex flex-col items-center gap-3">
          <div className="w-5 h-5 border-2 border-zinc-700 border-t-teal-400 rounded-full animate-spin" />
          <span className="text-xs text-zinc-500">Loading Kalshi screener data...</span>
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
                    key={s.ticker}
                    className="glass-card rounded-xl p-4 group"
                  >
                    {/* Title + category */}
                    <div className="flex items-start justify-between mb-3">
                      <div className="text-[13px] text-zinc-200 font-medium leading-snug line-clamp-2 flex-1 mr-3">
                        {s.market}
                      </div>
                      {s.category && (
                        <span className="px-2 py-0.5 rounded-md text-[9px] font-bold bg-teal-500/15 text-teal-400 uppercase tracking-wider border border-teal-500/20 shrink-0">
                          {s.category}
                        </span>
                      )}
                    </div>

                    {/* Bid / Ask / Spread */}
                    <div className="grid grid-cols-3 gap-3">
                      <div className="bg-white/[0.02] rounded-lg p-2.5 text-center border border-white/[0.04]">
                        <div className="text-[9px] text-zinc-600 uppercase tracking-[0.12em] font-semibold">Bid</div>
                        <div className="font-mono text-emerald-400 text-sm mt-0.5 tabular-nums">
                          {(s.yesBid * 100).toFixed(1)}&cent;
                        </div>
                      </div>
                      <div className="bg-white/[0.02] rounded-lg p-2.5 text-center border border-white/[0.04]">
                        <div className="text-[9px] text-zinc-600 uppercase tracking-[0.12em] font-semibold">Ask</div>
                        <div className="font-mono text-red-400 text-sm mt-0.5 tabular-nums">
                          {(s.yesAsk * 100).toFixed(1)}&cent;
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
                        Vol 24h: <span className="text-zinc-400 font-mono tabular-nums">{formatUsd(s.volume24h)}</span>
                      </span>
                    </div>

                    {(s.bidDepthDollars || s.askDepthDollars) && (
                      <div className="flex justify-between mt-1.5 text-[11px] text-zinc-600">
                        <span>Bid depth: <span className="font-mono tabular-nums">{s.bidDepthDollars ? formatUsd(s.bidDepthDollars) : "\u2014"}</span></span>
                        <span>Ask depth: <span className="font-mono tabular-nums">{s.askDepthDollars ? formatUsd(s.askDepthDollars) : "\u2014"}</span></span>
                      </div>
                    )}

                    <div className="mt-2.5 text-right">
                      <a
                        href={s.kalshiUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-teal-400/70 hover:text-teal-300 transition-colors font-medium"
                      >
                        View on Kalshi &nearr;
                      </a>
                    </div>
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
                    <th className="px-4 py-3 text-left text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Category</th>
                    <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">YES</th>
                    <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">NO</th>
                    <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Sum</th>
                    <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Dev</th>
                    <th className="px-4 py-3 text-center text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Signal</th>
                    <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Profit/$</th>
                    <th className="px-4 py-3 text-center text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {screener.binaryMispricing.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-4 py-12 text-center text-zinc-500 text-sm">
                        No binary mispricing opportunities found
                      </td>
                    </tr>
                  ) : (
                    screener.binaryMispricing.map((arb) => (
                      <tr key={arb.ticker} className="data-row border-b border-white/[0.03] last:border-0">
                        <td className="px-4 py-3 text-zinc-200 max-w-xs truncate text-[13px]">{arb.market}</td>
                        <td className="px-4 py-3">
                          {arb.category && (
                            <span className="px-2 py-0.5 rounded-md text-[9px] font-bold bg-teal-500/15 text-teal-400 uppercase tracking-wider border border-teal-500/20">
                              {arb.category}
                            </span>
                          )}
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
                        <td className="px-4 py-3 text-center">
                          <a
                            href={arb.kalshiUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-teal-400/70 hover:text-teal-300 text-xs font-medium transition-colors"
                          >
                            &nearr;
                          </a>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* ---- Event Group Arbitrage ---- */}
          {section === "events" && (
            <div className="space-y-3">
              {screener.eventGroupArbs.length === 0 ? (
                <div className="glass-card rounded-xl p-12 text-center text-zinc-500 text-sm">
                  No event group arbitrage opportunities found
                </div>
              ) : (
                screener.eventGroupArbs.map((arb) => (
                  <div
                    key={arb.eventTicker}
                    className="glass-card rounded-xl overflow-hidden"
                  >
                    <button
                      onClick={() =>
                        setExpandedEvent(expandedEvent === arb.eventTicker ? null : arb.eventTicker)
                      }
                      className="w-full p-4 hover:bg-white/[0.02] transition-colors text-left"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <div className="text-[13px] text-zinc-200 font-medium">{arb.eventTitle}</div>
                          <div className="flex items-center gap-4 mt-2 text-xs text-zinc-500">
                            <span className="flex items-center gap-1.5">
                              <span className="w-1 h-1 rounded-full bg-zinc-600" />
                              {arb.numOutcomes} outcomes
                            </span>
                            <span>
                              Sum asks:{" "}
                              <span className="font-mono text-zinc-400 tabular-nums">
                                {arb.sumYesAsks.toFixed(4)}
                              </span>
                            </span>
                            <span>
                              Sum bids:{" "}
                              <span className="font-mono text-zinc-400 tabular-nums">
                                {arb.sumYesBids.toFixed(4)}
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
                              expandedEvent === arb.eventTicker ? "rotate-180" : ""
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

                    {expandedEvent === arb.eventTicker && (
                      <div className="border-t border-white/[0.06] p-4">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                              <th className="pb-2.5 text-left">Outcome</th>
                              <th className="pb-2.5 text-right">YES Price</th>
                              <th className="pb-2.5 text-right">Bid</th>
                              <th className="pb-2.5 text-right">Ask</th>
                              <th className="pb-2.5 text-right">Spread</th>
                            </tr>
                          </thead>
                          <tbody>
                            {arb.outcomes.map((o) => (
                              <tr key={o.ticker} className="border-t border-white/[0.03]">
                                <td className="py-2.5 pr-4 text-zinc-200 max-w-xs truncate text-[13px]">
                                  {o.title}
                                </td>
                                <td className="py-2.5 text-right font-mono tabular-nums text-[13px] text-zinc-400">
                                  {(o.yesPrice * 100).toFixed(1)}&cent;
                                </td>
                                <td className="py-2.5 text-right font-mono text-emerald-400 tabular-nums text-[13px]">
                                  {(o.yesBid * 100).toFixed(1)}&cent;
                                </td>
                                <td className="py-2.5 text-right font-mono text-red-400 tabular-nums text-[13px]">
                                  {(o.yesAsk * 100).toFixed(1)}&cent;
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
