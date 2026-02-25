import { useEffect, useState } from "react";
import { useSSE } from "../hooks/useSSE";

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
  nextRefreshAt?: string;
  refreshEverySeconds?: number;
}

function formatUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

export function KalshiPanel({ paused }: { paused: boolean }) {
  const { data, connected } = useSSE<KalshiScreenerData>("/api/kalshi/screener/stream", paused);
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null);
  const [section, setSection] = useState<"spreads" | "binary" | "events">("spreads");
  const [secondsToRefresh, setSecondsToRefresh] = useState<number>(0);

  const screener = data;

  useEffect(() => {
    if (!screener?.nextRefreshAt) {
      setSecondsToRefresh(0);
      return;
    }
    const tick = () => {
      const delta = Math.ceil((new Date(screener.nextRefreshAt as string).getTime() - Date.now()) / 1000);
      setSecondsToRefresh(Math.max(0, delta));
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [screener?.nextRefreshAt]);

  const sections: { id: typeof section; label: string; count: number }[] = [
    { id: "spreads", label: "Top Spreads", count: screener?.topSpreads.length ?? 0 },
    { id: "binary", label: "Binary Mispricing", count: screener?.binaryMispricing.length ?? 0 },
    { id: "events", label: "Event Group Arb", count: screener?.eventGroupArbs.length ?? 0 },
  ];

  return (
    <div className="space-y-4">
      {/* Status */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full ${
              connected ? "bg-teal-400 animate-pulse" : "bg-zinc-600"
            }`}
          />
          <span className="text-xs text-zinc-500">
            {connected ? "Live" : paused ? "Paused" : "Connecting..."}
          </span>
          {screener && (
            <span className="text-xs text-zinc-600">
              {screener.marketsScanned} markets scanned
              {" | "}
              next ping in {secondsToRefresh}s
            </span>
          )}
        </div>
        {screener && (
          <span className="text-xs text-zinc-600 font-mono">
            {new Date(screener.timestamp).toLocaleTimeString()}
          </span>
        )}
      </div>

      {/* Section tabs */}
      <div className="flex gap-1">
        {sections.map((s) => (
          <button
            key={s.id}
            onClick={() => setSection(s.id)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              section === s.id
                ? "bg-teal-500/20 text-teal-400"
                : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {s.label}
            {s.count > 0 && (
              <span className="ml-1.5 text-xs text-zinc-500">({s.count})</span>
            )}
          </button>
        ))}
      </div>

      {!screener ? (
        <div className="text-center text-zinc-500 py-12">Loading Kalshi screener data...</div>
      ) : (
        <>
          {/* ---- Top Spreads ---- */}
          {section === "spreads" && (
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {screener.topSpreads.length === 0 ? (
                <div className="col-span-full text-center text-zinc-500 py-8">
                  No spread opportunities found
                </div>
              ) : (
                screener.topSpreads.map((s) => (
                  <div
                    key={s.ticker}
                    className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 hover:border-zinc-700 transition-colors"
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div className="text-sm text-zinc-200 font-medium line-clamp-2 flex-1 mr-2">
                        {s.market}
                      </div>
                      {s.category && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-teal-500/15 text-teal-400 uppercase tracking-wider shrink-0">
                          {s.category}
                        </span>
                      )}
                    </div>

                    <div className="grid grid-cols-3 gap-3 text-center">
                      <div>
                        <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Bid</div>
                        <div className="font-mono text-emerald-400">
                          {(s.yesBid * 100).toFixed(1)}¢
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Ask</div>
                        <div className="font-mono text-red-400">
                          {(s.yesAsk * 100).toFixed(1)}¢
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Spread</div>
                        <div className="font-mono text-amber-400 font-semibold">
                          {s.spreadPct}%
                        </div>
                      </div>
                    </div>

                    <div className="flex justify-between mt-3 pt-3 border-t border-zinc-800 text-xs text-zinc-500">
                      <span>
                        Liq: <span className="text-zinc-400">{formatUsd(s.liquidity)}</span>
                      </span>
                      <span>
                        Vol 24h: <span className="text-zinc-400">{formatUsd(s.volume24h)}</span>
                      </span>
                    </div>

                    {(s.bidDepthDollars || s.askDepthDollars) && (
                      <div className="flex justify-between mt-1 text-xs text-zinc-600">
                        <span>Bid depth: {s.bidDepthDollars ? formatUsd(s.bidDepthDollars) : "—"}</span>
                        <span>Ask depth: {s.askDepthDollars ? formatUsd(s.askDepthDollars) : "—"}</span>
                      </div>
                    )}

                    <div className="mt-2 text-right">
                      <a
                        href={s.kalshiUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-teal-400 hover:text-teal-300"
                      >
                        View on Kalshi ↗
                      </a>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* ---- Binary Mispricing ---- */}
          {section === "binary" && (
            <div className="rounded-xl border border-zinc-800 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-zinc-900/60 text-zinc-400 text-xs uppercase tracking-wider">
                    <th className="px-4 py-3 text-left">Market</th>
                    <th className="px-4 py-3 text-left">Category</th>
                    <th className="px-4 py-3 text-right">YES</th>
                    <th className="px-4 py-3 text-right">NO</th>
                    <th className="px-4 py-3 text-right">Sum</th>
                    <th className="px-4 py-3 text-right">Dev</th>
                    <th className="px-4 py-3 text-center">Signal</th>
                    <th className="px-4 py-3 text-right">Profit/$</th>
                    <th className="px-4 py-3 text-center w-10"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/50">
                  {screener.binaryMispricing.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-4 py-8 text-center text-zinc-500">
                        No binary mispricing opportunities found
                      </td>
                    </tr>
                  ) : (
                    screener.binaryMispricing.map((arb) => (
                      <tr key={arb.ticker} className="hover:bg-zinc-800/40 transition-colors">
                        <td className="px-4 py-3 text-zinc-200 max-w-xs truncate">{arb.market}</td>
                        <td className="px-4 py-3">
                          {arb.category && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-teal-500/15 text-teal-400 uppercase">
                              {arb.category}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-emerald-400">
                          {(arb.yesPrice * 100).toFixed(1)}¢
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-red-400">
                          {(arb.noPrice * 100).toFixed(1)}¢
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-zinc-300">
                          {arb.sum.toFixed(4)}
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-mono ${
                            Math.abs(arb.deviation) > 0.02 ? "text-amber-400" : "text-zinc-400"
                          }`}
                        >
                          {arb.deviation > 0 ? "+" : ""}
                          {(arb.deviation * 100).toFixed(2)}%
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span
                            className={`px-2 py-0.5 rounded text-xs font-medium ${
                              arb.type === "BUY_BOTH"
                                ? "bg-emerald-500/20 text-emerald-400"
                                : "bg-red-500/20 text-red-400"
                            }`}
                          >
                            {arb.type === "BUY_BOTH" ? "Buy Both" : "Sell Both"}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-amber-400">
                          {(arb.profitPerDollar * 100).toFixed(2)}¢
                        </td>
                        <td className="px-4 py-3 text-center">
                          <a
                            href={arb.kalshiUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-teal-400 hover:text-teal-300 text-xs"
                          >
                            ↗
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
                <div className="text-center text-zinc-500 py-8">
                  No event group arbitrage opportunities found
                </div>
              ) : (
                screener.eventGroupArbs.map((arb) => (
                  <div
                    key={arb.eventTicker}
                    className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden"
                  >
                    <button
                      onClick={() =>
                        setExpandedEvent(expandedEvent === arb.eventTicker ? null : arb.eventTicker)
                      }
                      className="w-full p-4 hover:bg-zinc-800/30 transition-colors text-left"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <div className="text-sm text-zinc-200 font-medium">{arb.eventTitle}</div>
                          <div className="flex items-center gap-4 mt-1.5 text-xs text-zinc-500">
                            <span>{arb.numOutcomes} outcomes</span>
                            <span>
                              Sum asks:{" "}
                              <span className="font-mono text-zinc-400">
                                {arb.sumYesAsks.toFixed(4)}
                              </span>
                            </span>
                            <span>
                              Sum bids:{" "}
                              <span className="font-mono text-zinc-400">
                                {arb.sumYesBids.toFixed(4)}
                              </span>
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <span
                            className={`px-2 py-0.5 rounded text-xs font-medium ${
                              arb.type === "BUY_ALL_YES"
                                ? "bg-emerald-500/20 text-emerald-400"
                                : "bg-red-500/20 text-red-400"
                            }`}
                          >
                            {arb.type === "BUY_ALL_YES" ? "Buy All YES" : "Sell All YES"}
                          </span>
                          <span className="font-mono text-amber-400 text-sm font-semibold">
                            {(arb.profitPerDollar * 100).toFixed(2)}¢/$
                          </span>
                          <span className="text-zinc-600 text-sm">
                            {expandedEvent === arb.eventTicker ? "▲" : "▼"}
                          </span>
                        </div>
                      </div>
                    </button>

                    {expandedEvent === arb.eventTicker && (
                      <div className="border-t border-zinc-800 p-4">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-zinc-500 text-xs uppercase tracking-wider">
                              <th className="pb-2 text-left">Outcome</th>
                              <th className="pb-2 text-right">YES Price</th>
                              <th className="pb-2 text-right">Bid</th>
                              <th className="pb-2 text-right">Ask</th>
                              <th className="pb-2 text-right">Spread</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-zinc-800/50">
                            {arb.outcomes.map((o) => (
                              <tr key={o.ticker} className="text-zinc-300">
                                <td className="py-2 pr-4 text-zinc-200 max-w-xs truncate">
                                  {o.title}
                                </td>
                                <td className="py-2 text-right font-mono">
                                  {(o.yesPrice * 100).toFixed(1)}¢
                                </td>
                                <td className="py-2 text-right font-mono text-emerald-400">
                                  {(o.yesBid * 100).toFixed(1)}¢
                                </td>
                                <td className="py-2 text-right font-mono text-red-400">
                                  {(o.yesAsk * 100).toFixed(1)}¢
                                </td>
                                <td
                                  className={`py-2 text-right font-mono ${
                                    o.spread > 0.05 ? "text-amber-400" : "text-zinc-500"
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
