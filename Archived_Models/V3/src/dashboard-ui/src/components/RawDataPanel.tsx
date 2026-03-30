import { Fragment, useEffect, useMemo, useState } from "react";

interface RawContractsResponse {
  timestamp: string;
  counts: {
    polymarket: number;
    kalshi: number;
  };
  polymarket: Array<Record<string, any>>;
  kalshi: Array<Record<string, any>>;
}

const PAGE_SIZE = 100;

function fmtNum(value: unknown, digits = 2): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function fmtCentsToDollars(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `$${(n / 100).toFixed(2)}`;
}

function fmtIso(value: unknown): string {
  if (!value) return "-";
  const d = new Date(String(value));
  if (!Number.isFinite(d.getTime())) return String(value);
  return d.toLocaleString();
}

async function api<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export function RawDataPanel({ paused }: { paused: boolean }) {
  const [data, setData] = useState<RawContractsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [polyQuery, setPolyQuery] = useState("");
  const [kalshiQuery, setKalshiQuery] = useState("");
  const [polyPage, setPolyPage] = useState(1);
  const [kalshiPage, setKalshiPage] = useState(1);
  const [expandedPoly, setExpandedPoly] = useState<string | null>(null);
  const [expandedKalshi, setExpandedKalshi] = useState<string | null>(null);

  const load = async (force = false) => {
    setLoading(true);
    try {
      const next = await api<RawContractsResponse>(`/api/raw/contracts${force ? "?force=true" : ""}`);
      setData(next);
      setError(null);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(false);
  }, []);

  useEffect(() => {
    if (paused) return;
    const timer = window.setInterval(() => {
      void load(false);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [paused]);

  const polyFiltered = useMemo(() => {
    if (!data?.polymarket) return [];
    const q = polyQuery.trim().toLowerCase();
    if (!q) return data.polymarket;
    return data.polymarket.filter((m) => {
      const text = `${m.question || ""} ${m.conditionId || ""} ${m.slug || ""}`.toLowerCase();
      return text.includes(q);
    });
  }, [data?.polymarket, polyQuery]);

  const kalshiFiltered = useMemo(() => {
    if (!data?.kalshi) return [];
    const q = kalshiQuery.trim().toLowerCase();
    if (!q) return data.kalshi;
    return data.kalshi.filter((m) => {
      const text = `${m.title || ""} ${m.subtitle || ""} ${m.ticker || ""} ${m.event_ticker || ""}`.toLowerCase();
      return text.includes(q);
    });
  }, [data?.kalshi, kalshiQuery]);

  const polyPages = Math.max(1, Math.ceil(polyFiltered.length / PAGE_SIZE));
  const kalshiPages = Math.max(1, Math.ceil(kalshiFiltered.length / PAGE_SIZE));

  useEffect(() => {
    setPolyPage((p) => Math.min(p, polyPages));
  }, [polyPages]);
  useEffect(() => {
    setKalshiPage((p) => Math.min(p, kalshiPages));
  }, [kalshiPages]);

  const polyPageRows = polyFiltered.slice((polyPage - 1) * PAGE_SIZE, polyPage * PAGE_SIZE);
  const kalshiPageRows = kalshiFiltered.slice((kalshiPage - 1) * PAGE_SIZE, kalshiPage * PAGE_SIZE);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="text-sm font-medium text-zinc-100">Raw Contract Feed</div>
          <button
            onClick={() => void load(true)}
            disabled={loading}
            className="px-3 py-1.5 rounded-md bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 text-xs disabled:opacity-50"
          >
            {loading ? "Refreshing..." : "Force Refresh"}
          </button>
          <div className="text-xs text-zinc-500 ml-auto">
            {paused ? "Paused" : "Live"} | {data ? `Polymarket ${data.counts.polymarket} | Kalshi ${data.counts.kalshi}` : "Loading..."}
          </div>
        </div>
        {data?.timestamp && (
          <div className="mt-2 text-xs text-zinc-500">Last update: {new Date(data.timestamp).toLocaleTimeString()}</div>
        )}
        {error && <div className="mt-2 text-sm text-red-300">{error}</div>}
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <h3 className="text-sm font-medium text-zinc-200">Polymarket Raw Contracts</h3>
          <span className="text-xs text-zinc-500">{polyFiltered.length} matches</span>
          <input
            value={polyQuery}
            onChange={(e) => {
              setPolyQuery(e.target.value);
              setPolyPage(1);
            }}
            placeholder="Search question, conditionId, slug..."
            className="ml-auto w-full md:w-96 bg-zinc-900 border border-zinc-700 text-sm rounded px-2 py-1.5"
          />
        </div>
        <div className="max-h-[420px] overflow-auto rounded border border-zinc-800/70">
          <table className="w-full text-xs">
            <thead className="bg-zinc-900/80 text-zinc-400 uppercase tracking-wider sticky top-0">
              <tr>
                <th className="px-2 py-2 text-left">Question</th>
                <th className="px-2 py-2 text-left">Condition</th>
                <th className="px-2 py-2 text-right">Bid</th>
                <th className="px-2 py-2 text-right">Ask</th>
                <th className="px-2 py-2 text-right">Spread</th>
                <th className="px-2 py-2 text-right">Liquidity</th>
                <th className="px-2 py-2 text-right">24h Vol</th>
                <th className="px-2 py-2 text-left">End</th>
                <th className="px-2 py-2 text-center">Raw</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/40">
              {polyPageRows.length === 0 ? (
                <tr><td colSpan={9} className="px-2 py-6 text-center text-zinc-500">No contracts found.</td></tr>
              ) : polyPageRows.map((m, idx) => {
                const key = String(m.conditionId || m.id || idx);
                const open = expandedPoly === key;
                return (
                  <Fragment key={key}>
                    <tr className="align-top hover:bg-zinc-800/30">
                      <td className="px-2 py-2 text-zinc-200 max-w-[360px] truncate">{m.question || "-"}</td>
                      <td className="px-2 py-2 font-mono text-zinc-400 max-w-[220px] truncate">{m.conditionId || "-"}</td>
                      <td className="px-2 py-2 text-right text-emerald-300">{fmtNum(m.bestBid, 4)}</td>
                      <td className="px-2 py-2 text-right text-red-300">{fmtNum(m.bestAsk, 4)}</td>
                      <td className="px-2 py-2 text-right text-amber-300">{fmtNum(m.spread, 4)}</td>
                      <td className="px-2 py-2 text-right text-zinc-300">{fmtNum(m.liquidity, 0)}</td>
                      <td className="px-2 py-2 text-right text-zinc-300">{fmtNum(m.volume24hr, 0)}</td>
                      <td className="px-2 py-2 text-zinc-400 whitespace-nowrap">{fmtIso(m.endDate)}</td>
                      <td className="px-2 py-2 text-center">
                        <button
                          onClick={() => setExpandedPoly(open ? null : key)}
                          className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                        >
                          {open ? "Hide" : "Show"}
                        </button>
                      </td>
                    </tr>
                    {open && (
                      <tr className="bg-zinc-950/50">
                        <td colSpan={9} className="px-2 py-2">
                          <pre className="text-[11px] text-zinc-400 overflow-auto">{JSON.stringify(m, null, 2)}</pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="mt-2 flex items-center justify-end gap-2 text-xs">
          <button
            onClick={() => setPolyPage((p) => Math.max(1, p - 1))}
            disabled={polyPage <= 1}
            className="px-2 py-1 rounded bg-zinc-800 text-zinc-300 disabled:opacity-40"
          >
            Prev
          </button>
          <span className="text-zinc-500">Page {polyPage} / {polyPages}</span>
          <button
            onClick={() => setPolyPage((p) => Math.min(polyPages, p + 1))}
            disabled={polyPage >= polyPages}
            className="px-2 py-1 rounded bg-zinc-800 text-zinc-300 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <h3 className="text-sm font-medium text-zinc-200">Kalshi Raw Contracts</h3>
          <span className="text-xs text-zinc-500">{kalshiFiltered.length} matches</span>
          <input
            value={kalshiQuery}
            onChange={(e) => {
              setKalshiQuery(e.target.value);
              setKalshiPage(1);
            }}
            placeholder="Search title, ticker, event..."
            className="ml-auto w-full md:w-96 bg-zinc-900 border border-zinc-700 text-sm rounded px-2 py-1.5"
          />
        </div>
        <div className="max-h-[420px] overflow-auto rounded border border-zinc-800/70">
          <table className="w-full text-xs">
            <thead className="bg-zinc-900/80 text-zinc-400 uppercase tracking-wider sticky top-0">
              <tr>
                <th className="px-2 py-2 text-left">Title</th>
                <th className="px-2 py-2 text-left">Ticker</th>
                <th className="px-2 py-2 text-right">YES Bid</th>
                <th className="px-2 py-2 text-right">YES Ask</th>
                <th className="px-2 py-2 text-right">NO Bid</th>
                <th className="px-2 py-2 text-right">NO Ask</th>
                <th className="px-2 py-2 text-right">Liquidity</th>
                <th className="px-2 py-2 text-left">Close</th>
                <th className="px-2 py-2 text-center">Raw</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/40">
              {kalshiPageRows.length === 0 ? (
                <tr><td colSpan={9} className="px-2 py-6 text-center text-zinc-500">No contracts found.</td></tr>
              ) : kalshiPageRows.map((m, idx) => {
                const key = String(m.ticker || idx);
                const open = expandedKalshi === key;
                return (
                  <Fragment key={key}>
                    <tr className="align-top hover:bg-zinc-800/30">
                      <td className="px-2 py-2 text-zinc-200 max-w-[360px] truncate">{m.title || m.subtitle || "-"}</td>
                      <td className="px-2 py-2 font-mono text-zinc-400">{m.ticker || "-"}</td>
                      <td className="px-2 py-2 text-right text-emerald-300">{fmtCentsToDollars(m.yes_bid_dollars)}</td>
                      <td className="px-2 py-2 text-right text-red-300">{fmtCentsToDollars(m.yes_ask_dollars)}</td>
                      <td className="px-2 py-2 text-right text-emerald-300">{fmtCentsToDollars(m.no_bid_dollars)}</td>
                      <td className="px-2 py-2 text-right text-red-300">{fmtCentsToDollars(m.no_ask_dollars)}</td>
                      <td className="px-2 py-2 text-right text-zinc-300">{fmtNum(m.liquidity_dollars, 0)}</td>
                      <td className="px-2 py-2 text-zinc-400 whitespace-nowrap">{fmtIso(m.close_time)}</td>
                      <td className="px-2 py-2 text-center">
                        <button
                          onClick={() => setExpandedKalshi(open ? null : key)}
                          className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                        >
                          {open ? "Hide" : "Show"}
                        </button>
                      </td>
                    </tr>
                    {open && (
                      <tr className="bg-zinc-950/50">
                        <td colSpan={9} className="px-2 py-2">
                          <pre className="text-[11px] text-zinc-400 overflow-auto">{JSON.stringify(m, null, 2)}</pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="mt-2 flex items-center justify-end gap-2 text-xs">
          <button
            onClick={() => setKalshiPage((p) => Math.max(1, p - 1))}
            disabled={kalshiPage <= 1}
            className="px-2 py-1 rounded bg-zinc-800 text-zinc-300 disabled:opacity-40"
          >
            Prev
          </button>
          <span className="text-zinc-500">Page {kalshiPage} / {kalshiPages}</span>
          <button
            onClick={() => setKalshiPage((p) => Math.min(kalshiPages, p + 1))}
            disabled={kalshiPage >= kalshiPages}
            className="px-2 py-1 rounded bg-zinc-800 text-zinc-300 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
