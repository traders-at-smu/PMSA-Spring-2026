import { useState, useEffect, useRef } from "react";
import { useSSE } from "../hooks/useSSE";

interface TradeAlert {
  trader: string;
  traderName: string;
  profileImage: string;
  side: "BUY" | "SELL";
  size: number;
  price: number;
  cashValue: number;
  market: string;
  outcome: string;
  conditionId: string;
  marketEndDate: string;
  hoursToExpiry: number;
  timestamp: string;
  isNewAccount: boolean;
  accountAgeDays: number;
  isFirstLargeBet: boolean;
  transactionHash: string;
}

function formatUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function shortenAddress(addr: string): string {
  if (!addr) return "";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function TradeAlerts({ paused }: { paused: boolean }) {
  const { data: sseAlerts, connected } = useSSE<TradeAlert[]>("/api/alerts/stream", paused);
  const [alerts, setAlerts] = useState<TradeAlert[]>([]);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const seenTxs = useRef(new Set<string>());

  // Initial fetch
  useEffect(() => {
    fetch("/api/alerts")
      .then((r) => r.json())
      .then((data: TradeAlert[]) => {
        setAlerts(data);
        data.forEach((a) => seenTxs.current.add(a.transactionHash));
        setInitialLoaded(true);
      })
      .catch(() => setInitialLoaded(true));
  }, []);

  // Merge SSE updates
  useEffect(() => {
    if (!sseAlerts || !initialLoaded) return;
    setAlerts((prev) => {
      const newAlerts = sseAlerts.filter((a) => !seenTxs.current.has(a.transactionHash));
      newAlerts.forEach((a) => seenTxs.current.add(a.transactionHash));
      const merged = [...newAlerts, ...prev];
      return merged.slice(0, 200);
    });
  }, [sseAlerts, initialLoaded]);

  return (
    <div className="space-y-4">
      {/* Status bar */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full ${
              connected ? "bg-emerald-400 animate-pulse" : "bg-zinc-600"
            }`}
          />
          <span className="text-xs text-zinc-500">
            {connected ? "Live stream connected" : paused ? "Stream paused" : "Connecting..."}
          </span>
        </div>
        <span className="text-xs text-zinc-600">
          {alerts.length} alert{alerts.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Alert cards */}
      <div className="space-y-3">
        {!initialLoaded ? (
          <div className="text-center text-zinc-500 py-12">Loading alerts...</div>
        ) : alerts.length === 0 ? (
          <div className="text-center text-zinc-500 py-12">
            No large trades on expiring markets detected yet.
            <br />
            <span className="text-xs text-zinc-600">Monitoring for $5k+ bets on markets ending within 48h</span>
          </div>
        ) : (
          alerts.map((alert) => (
            <div
              key={alert.transactionHash}
              className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 hover:border-zinc-700 transition-colors"
            >
              <div className="flex items-start justify-between gap-4">
                {/* Left: Trader + badges */}
                <div className="flex items-start gap-3 min-w-0">
                  {alert.profileImage ? (
                    <img
                      src={alert.profileImage}
                      alt=""
                      className="w-10 h-10 rounded-full bg-zinc-700 shrink-0"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-zinc-700 flex items-center justify-center text-sm text-zinc-400 shrink-0">
                      ?
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-zinc-100">
                        {alert.traderName || shortenAddress(alert.trader)}
                      </span>
                      {alert.isNewAccount && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400 uppercase tracking-wider">
                          New Account
                        </span>
                      )}
                      {alert.isFirstLargeBet && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-400 uppercase tracking-wider">
                          First Large Bet
                        </span>
                      )}
                    </div>
                    {alert.isNewAccount && (
                      <span className="text-xs text-zinc-500">
                        Account age: {alert.accountAgeDays} day{alert.accountAgeDays !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                </div>

                {/* Right: Side + amount */}
                <div className="flex items-center gap-3 shrink-0">
                  <span
                    className={`px-2 py-1 rounded-md text-xs font-bold ${
                      alert.side === "BUY"
                        ? "bg-emerald-500/20 text-emerald-400"
                        : "bg-red-500/20 text-red-400"
                    }`}
                  >
                    {alert.side}
                  </span>
                  <span className="text-lg font-semibold font-mono text-zinc-100">
                    {formatUsd(alert.cashValue)}
                  </span>
                </div>
              </div>

              {/* Market info */}
              <div className="mt-3 pl-13">
                <div className="text-sm text-zinc-200">{alert.market}</div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1.5 text-xs text-zinc-500">
                  <span>
                    Outcome:{" "}
                    <span className="text-zinc-300">{alert.outcome}</span>
                  </span>
                  <span>
                    Price:{" "}
                    <span className="text-zinc-300 font-mono">
                      {(alert.price * 100).toFixed(1)}¢
                    </span>
                  </span>
                  <span>
                    Expires in:{" "}
                    <span
                      className={`font-mono ${
                        alert.hoursToExpiry < 12 ? "text-amber-400" : "text-zinc-300"
                      }`}
                    >
                      {alert.hoursToExpiry.toFixed(1)}h
                    </span>
                  </span>
                  <span>{timeAgo(alert.timestamp)}</span>
                  <a
                    href={`https://polygonscan.com/tx/${alert.transactionHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-violet-400 hover:text-violet-300"
                  >
                    tx ↗
                  </a>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
