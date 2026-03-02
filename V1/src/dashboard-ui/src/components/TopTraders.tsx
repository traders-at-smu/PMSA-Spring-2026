import { useState, useEffect, useCallback } from "react";

interface LeaderboardEntry {
  rank: number;
  proxyWallet: string;
  userName: string;
  pnl: number;
  vol: number;
  profileImage: string;
  xUsername: string;
  verifiedBadge: boolean;
}

interface TraderProfile extends LeaderboardEntry {
  portfolioValue: number;
  topPositions: {
    title: string;
    outcome: string;
    size: number;
    curPrice: number;
    cashPnl: number;
    percentPnl: number;
  }[];
}

type OrderBy = "PNL" | "VOL";
type TimePeriod = "DAY" | "WEEK" | "MONTH" | "ALL";

const timePeriods: { id: TimePeriod; label: string }[] = [
  { id: "DAY", label: "24h" },
  { id: "WEEK", label: "7d" },
  { id: "MONTH", label: "30d" },
  { id: "ALL", label: "All" },
];

function formatUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function shortenAddress(addr: string): string {
  if (!addr) return "";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function TopTraders() {
  const [traders, setTraders] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [orderBy, setOrderBy] = useState<OrderBy>("PNL");
  const [timePeriod, setTimePeriod] = useState<TimePeriod>("ALL");
  const [sortCol, setSortCol] = useState<"pnl" | "vol">("pnl");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [expandedTrader, setExpandedTrader] = useState<string | null>(null);
  const [traderProfile, setTraderProfile] = useState<TraderProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);

  const fetchTraders = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/traders?orderBy=${orderBy}&timePeriod=${timePeriod}&limit=50`);
      const data = await res.json();
      setTraders(data);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [orderBy, timePeriod]);

  useEffect(() => {
    fetchTraders();
  }, [fetchTraders]);

  const sorted = [...traders].sort((a, b) => {
    const val = sortCol === "pnl" ? a.pnl - b.pnl : a.vol - b.vol;
    return sortDir === "desc" ? -val : val;
  });

  const toggleSort = (col: "pnl" | "vol") => {
    if (sortCol === col) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortCol(col);
      setSortDir("desc");
    }
  };

  const handleRowClick = async (address: string) => {
    if (expandedTrader === address) {
      setExpandedTrader(null);
      setTraderProfile(null);
      return;
    }
    setExpandedTrader(address);
    setProfileLoading(true);
    try {
      const res = await fetch(`/api/traders/${address}`);
      const data = await res.json();
      setTraderProfile(data);
    } catch {
      setTraderProfile(null);
    } finally {
      setProfileLoading(false);
    }
  };

  const sortIndicator = (col: "pnl" | "vol") => {
    if (sortCol !== col) return "";
    return sortDir === "desc" ? " ↓" : " ↑";
  };

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500 uppercase tracking-wider">Rank by</span>
          <div className="flex gap-1">
            {(["PNL", "VOL"] as OrderBy[]).map((o) => (
              <button
                key={o}
                onClick={() => setOrderBy(o)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  orderBy === o
                    ? "bg-violet-500/20 text-violet-400"
                    : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {o === "PNL" ? "Profit" : "Volume"}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500 uppercase tracking-wider">Period</span>
          <div className="flex gap-1">
            {timePeriods.map((tp) => (
              <button
                key={tp.id}
                onClick={() => setTimePeriod(tp.id)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  timePeriod === tp.id
                    ? "bg-violet-500/20 text-violet-400"
                    : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {tp.label}
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={fetchTraders}
          className="ml-auto px-3 py-1.5 rounded-md text-xs font-medium bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-zinc-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-zinc-900/60 text-zinc-400 text-xs uppercase tracking-wider">
              <th className="px-4 py-3 text-left w-12">#</th>
              <th className="px-4 py-3 text-left">Trader</th>
              <th
                className="px-4 py-3 text-right cursor-pointer hover:text-zinc-200 select-none"
                onClick={() => toggleSort("pnl")}
              >
                PnL{sortIndicator("pnl")}
              </th>
              <th
                className="px-4 py-3 text-right cursor-pointer hover:text-zinc-200 select-none"
                onClick={() => toggleSort("vol")}
              >
                Volume{sortIndicator("vol")}
              </th>
              <th className="px-4 py-3 text-left hidden lg:table-cell">X / Social</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/50">
            {loading ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-zinc-500">
                  Loading traders...
                </td>
              </tr>
            ) : sorted.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-zinc-500">
                  No traders found
                </td>
              </tr>
            ) : (
              sorted.map((t) => (
                <>
                  <tr
                    key={t.proxyWallet}
                    onClick={() => handleRowClick(t.proxyWallet)}
                    className="hover:bg-zinc-800/40 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3 text-zinc-500 font-mono">{t.rank}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {t.profileImage ? (
                          <img
                            src={t.profileImage}
                            alt=""
                            className="w-8 h-8 rounded-full bg-zinc-700"
                          />
                        ) : (
                          <div className="w-8 h-8 rounded-full bg-zinc-700 flex items-center justify-center text-xs text-zinc-400">
                            ?
                          </div>
                        )}
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium text-zinc-100">
                              {t.userName || shortenAddress(t.proxyWallet)}
                            </span>
                            {t.verifiedBadge && (
                              <span className="text-blue-400 text-xs">✓</span>
                            )}
                          </div>
                          <span className="text-xs text-zinc-500 font-mono">
                            {shortenAddress(t.proxyWallet)}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      <span className={t.pnl >= 0 ? "text-emerald-400" : "text-red-400"}>
                        {t.pnl >= 0 ? "+" : ""}
                        {formatUsd(t.pnl)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-zinc-300">
                      {formatUsd(t.vol)}
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      {t.xUsername ? (
                        <a
                          href={`https://x.com/${t.xUsername}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="text-xs text-violet-400 hover:text-violet-300"
                        >
                          @{t.xUsername}
                        </a>
                      ) : (
                        <span className="text-xs text-zinc-600">—</span>
                      )}
                    </td>
                  </tr>

                  {/* Expanded detail row */}
                  {expandedTrader === t.proxyWallet && (
                    <tr key={`${t.proxyWallet}-detail`}>
                      <td colSpan={5} className="bg-zinc-900/40 px-6 py-4">
                        {profileLoading ? (
                          <div className="text-zinc-500 text-sm">Loading profile...</div>
                        ) : traderProfile ? (
                          <div className="space-y-3">
                            <div className="flex items-center gap-6 text-sm">
                              <div>
                                <span className="text-zinc-500">Portfolio Value: </span>
                                <span className="text-zinc-200 font-mono">
                                  {formatUsd(traderProfile.portfolioValue)}
                                </span>
                              </div>
                            </div>

                            {traderProfile.topPositions.length > 0 && (
                              <div>
                                <h4 className="text-xs text-zinc-500 uppercase tracking-wider mb-2">
                                  Top Positions
                                </h4>
                                <div className="grid gap-2">
                                  {traderProfile.topPositions.map((pos, i) => (
                                    <div
                                      key={i}
                                      className="flex items-center justify-between bg-zinc-800/50 rounded-lg px-4 py-2 text-sm"
                                    >
                                      <div className="flex-1 min-w-0">
                                        <div className="text-zinc-200 truncate">{pos.title}</div>
                                        <div className="text-xs text-zinc-500">{pos.outcome}</div>
                                      </div>
                                      <div className="flex items-center gap-6 ml-4 shrink-0">
                                        <div className="text-right">
                                          <div className="text-zinc-400 text-xs">Size</div>
                                          <div className="font-mono text-zinc-200">
                                            {formatUsd(pos.size * pos.curPrice)}
                                          </div>
                                        </div>
                                        <div className="text-right">
                                          <div className="text-zinc-400 text-xs">PnL</div>
                                          <div
                                            className={`font-mono ${
                                              pos.cashPnl >= 0 ? "text-emerald-400" : "text-red-400"
                                            }`}
                                          >
                                            {pos.cashPnl >= 0 ? "+" : ""}
                                            {formatUsd(pos.cashPnl)}
                                          </div>
                                        </div>
                                        <div className="text-right">
                                          <div className="text-zinc-400 text-xs">%</div>
                                          <div
                                            className={`font-mono ${
                                              pos.percentPnl >= 0
                                                ? "text-emerald-400"
                                                : "text-red-400"
                                            }`}
                                          >
                                            {pos.percentPnl >= 0 ? "+" : ""}
                                            {pos.percentPnl.toFixed(1)}%
                                          </div>
                                        </div>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="text-zinc-500 text-sm">Failed to load profile</div>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
