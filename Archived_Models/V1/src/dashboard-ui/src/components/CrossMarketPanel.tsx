import { useCallback, useEffect, useMemo, useState } from "react";

interface TradeLeg {
  venue: "POLYMARKET" | "KALSHI";
  outcome: string;
  bestBid?: number;
  bestAsk?: number;
  price: number;
  contracts: number;
  notionalUsd: number;
  ticker?: string;
}

interface CrossPlan {
  id: string;
  venue: "CROSS";
  strategy: "CROSS_MARKET_BOX";
  title: string;
  contractUrl?: string;
  expiryDate?: string;
  status: "READY" | "EXECUTED" | "FAILED" | "SKIPPED";
  expectedNetEdge: number;
  estimatedFeesUsd: number;
  expectedNetProfitUsd: number;
  recommendedCapUsd: number;
  legs: TradeLeg[];
  reason?: string;
}

interface CrossResponse {
  ok: boolean;
  refreshSeq: number;
  lastRefreshAt: string | null;
  count: number;
  opportunities: CrossPlan[];
}

const money = (n: number) =>
  n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const cents = (p: number) => `${(p * 100).toFixed(1)}c`;

export function CrossMarketPanel({ paused }: { paused: boolean }) {
  const [data, setData] = useState<CrossResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/arbitrage/cross-opportunities");
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (err: any) {
      setError(err?.message || "Failed to load cross opportunities");
    }
  }, []);

  useEffect(() => {
    if (paused) return;
    void load();
    const timer = window.setInterval(() => void load(), 20_000);
    return () => window.clearInterval(timer);
  }, [paused, load]);

  const rows = useMemo(() => data?.opportunities ?? [], [data]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-xs text-zinc-500">
          {data ? `${data.count} cross opportunities | seq ${data.refreshSeq}` : "Loading..."}
          {data?.lastRefreshAt ? ` | ${new Date(data.lastRefreshAt).toLocaleTimeString()}` : ""}
        </div>
        <button
          onClick={async () => {
            setLoading(true);
            await load();
            setLoading(false);
          }}
          disabled={loading}
          className="px-3 py-1.5 rounded-md bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 text-xs disabled:opacity-40"
        >
          Refresh
        </button>
      </div>

      {error && <div className="text-sm text-red-300">{error}</div>}

      <div className="rounded-xl border border-zinc-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-zinc-900/60 text-zinc-400 text-xs uppercase tracking-wider">
              <th className="px-3 py-2 text-left">Market</th>
              <th className="px-3 py-2 text-left">Expiry</th>
              <th className="px-3 py-2 text-left">Leg Prices</th>
              <th className="px-3 py-2 text-right">Cap</th>
              <th className="px-3 py-2 text-right">Fees</th>
              <th className="px-3 py-2 text-right">Net Edge</th>
              <th className="px-3 py-2 text-right">Est. Net P&L</th>
              <th className="px-3 py-2 text-center">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/50">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-zinc-500">No cross-market opportunities found.</td>
              </tr>
            ) : rows.map((plan) => (
              <tr key={plan.id} className="hover:bg-zinc-800/40 transition-colors">
                <td className="px-3 py-2 text-zinc-200 max-w-sm">
                  {plan.contractUrl ? (
                    <a href={plan.contractUrl} target="_blank" rel="noopener noreferrer" className="text-blue-300 hover:text-blue-200 underline underline-offset-2">
                      {plan.title}
                    </a>
                  ) : plan.title}
                  {plan.reason ? <div className="text-xs text-zinc-500">{plan.reason}</div> : null}
                </td>
                <td className="px-3 py-2 text-zinc-300 text-xs">{plan.expiryDate ? new Date(plan.expiryDate).toLocaleString() : "-"}</td>
                <td className="px-3 py-2 text-xs font-mono text-zinc-300">
                  {plan.legs.map((leg, i) => (
                    <div key={`${plan.id}-leg-${i}`}>
                      {leg.venue.slice(0, 4)} {leg.outcome} b/a {leg.bestBid != null ? cents(leg.bestBid) : "-"} / {leg.bestAsk != null ? cents(leg.bestAsk) : "-"} buy@{cents(leg.price)}
                    </div>
                  ))}
                </td>
                <td className="px-3 py-2 text-right font-mono text-zinc-200">{money(plan.recommendedCapUsd)}</td>
                <td className="px-3 py-2 text-right font-mono text-orange-300">{money(plan.estimatedFeesUsd)}</td>
                <td className="px-3 py-2 text-right font-mono text-amber-300">{(plan.expectedNetEdge * 100).toFixed(2)}%</td>
                <td className={`px-3 py-2 text-right font-mono ${plan.expectedNetProfitUsd >= 0 ? "text-emerald-300" : "text-red-300"}`}>{money(plan.expectedNetProfitUsd)}</td>
                <td className="px-3 py-2 text-center">
                  <span className="px-2 py-0.5 rounded text-xs font-medium bg-zinc-700/50 text-zinc-200">{plan.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

