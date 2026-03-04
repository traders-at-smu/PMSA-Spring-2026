import { useState, useEffect, useCallback, useRef } from "react";

interface CopyTarget {
  address: string;
  name: string;
  setAt: string;
}

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

  // Copy target state
  const [copyTarget, setCopyTarget] = useState<CopyTarget | null>(null);
  const [copyLoading, setCopyLoading] = useState(false);
  const copyTargetFetched = useRef(false);

  useEffect(() => {
    if (copyTargetFetched.current) return;
    copyTargetFetched.current = true;
    fetch("/api/copy-trading/target")
      .then((r) => r.json())
      .then((d) => setCopyTarget(d.target || null))
      .catch(() => {});
  }, []);

  const handleCopyTrader = async (address: string, name: string) => {
    setCopyLoading(true);
    try {
      const res = await fetch("/api/copy-trading/target", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, name }),
      });
      const data = await res.json();
      setCopyTarget(data.target || null);
    } catch {
      // silently fail
    } finally {
      setCopyLoading(false);
    }
  };

  const handleStopCopying = async () => {
    setCopyLoading(true);
    try {
      await fetch("/api/copy-trading/target", { method: "DELETE" });
      setCopyTarget(null);
    } catch {
      // silently fail
    } finally {
      setCopyLoading(false);
    }
  };

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

  const SortIcon = ({ col }: { col: "pnl" | "vol" }) => {
    if (sortCol !== col) return <span className="text-zinc-700 ml-1">&darr;</span>;
    return (
      <span className="text-emerald-400 ml-1">
        {sortDir === "desc" ? "\u2193" : "\u2191"}
      </span>
    );
  };

  return (
    <div className="space-y-5">
      {/* Section header */}
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100 tracking-tight">Leaderboard</h2>
          <p className="text-xs text-zinc-500 mt-0.5">Top Polymarket traders by {orderBy === "PNL" ? "profit" : "volume"}</p>
        </div>
        <button
          onClick={fetchTraders}
          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/[0.04] text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.07] border border-white/[0.06] transition-all"
        >
          Refresh
        </button>
      </div>

      {/* Copy target banner */}
      {copyTarget && (
        <div className="glass-card rounded-xl p-3 flex items-center justify-between border border-emerald-500/20 bg-emerald-500/[0.04]">
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 rounded-full bg-emerald-400 status-live" />
            <span className="text-xs text-emerald-400 font-medium">
              Currently copying:{" "}
              <span className="text-emerald-300 font-semibold">
                {copyTarget.name || shortenAddress(copyTarget.address)}
              </span>
              <span className="text-emerald-500/60 font-mono ml-1.5">
                ({shortenAddress(copyTarget.address)})
              </span>
            </span>
          </div>
          <button
            onClick={handleStopCopying}
            disabled={copyLoading}
            className="px-3 py-1 rounded-lg text-[11px] font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20 transition-all disabled:opacity-40"
          >
            Stop Copying
          </button>
        </div>
      )}

      {/* Controls */}
      <div className="glass-card rounded-xl p-3 flex flex-wrap items-center gap-5">
        <div className="flex items-center gap-2.5">
          <span className="text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Rank by</span>
          <div className="flex gap-1">
            {(["PNL", "VOL"] as OrderBy[]).map((o) => (
              <button
                key={o}
                onClick={() => setOrderBy(o)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 ${
                  orderBy === o
                    ? "bg-emerald-500/15 text-emerald-400 shadow-inner shadow-emerald-500/5"
                    : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]"
                }`}
              >
                {o === "PNL" ? "Profit" : "Volume"}
              </button>
            ))}
          </div>
        </div>

        <div className="w-px h-5 bg-zinc-800 hidden sm:block" />

        <div className="flex items-center gap-2.5">
          <span className="text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Period</span>
          <div className="flex gap-1">
            {timePeriods.map((tp) => (
              <button
                key={tp.id}
                onClick={() => setTimePeriod(tp.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 ${
                  timePeriod === tp.id
                    ? "bg-emerald-500/15 text-emerald-400 shadow-inner shadow-emerald-500/5"
                    : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]"
                }`}
              >
                {tp.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="glass-card rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/[0.06]">
              <th className="px-4 py-3 text-left text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold w-14">#</th>
              <th className="px-4 py-3 text-left text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Trader</th>
              <th
                className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold cursor-pointer hover:text-zinc-300 select-none transition-colors"
                onClick={() => toggleSort("pnl")}
              >
                PnL <SortIcon col="pnl" />
              </th>
              <th
                className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold cursor-pointer hover:text-zinc-300 select-none transition-colors"
                onClick={() => toggleSort("vol")}
              >
                Volume <SortIcon col="vol" />
              </th>
              <th className="px-4 py-3 text-left text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold hidden lg:table-cell">Social</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} className="px-4 py-16 text-center">
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-5 h-5 border-2 border-zinc-700 border-t-emerald-400 rounded-full animate-spin" />
                    <span className="text-xs text-zinc-500">Loading traders...</span>
                  </div>
                </td>
              </tr>
            ) : sorted.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-16 text-center text-zinc-500 text-sm">
                  No traders found
                </td>
              </tr>
            ) : (
              sorted.map((t, idx) => (
                <>
                  <tr
                    key={t.proxyWallet}
                    onClick={() => handleRowClick(t.proxyWallet)}
                    className="data-row cursor-pointer border-b border-white/[0.03] last:border-0"
                    style={{ animationDelay: `${idx * 20}ms` }}
                  >
                    <td className="px-4 py-3.5">
                      <span className={`font-mono text-xs ${t.rank <= 3 ? "text-amber-400 font-bold" : "text-zinc-600"}`}>
                        {t.rank}
                      </span>
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-3">
                        {t.profileImage ? (
                          <img
                            src={t.profileImage}
                            alt=""
                            className="w-9 h-9 rounded-full ring-1 ring-white/[0.08] object-cover"
                          />
                        ) : (
                          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-zinc-700 to-zinc-800 ring-1 ring-white/[0.08] flex items-center justify-center text-[11px] text-zinc-500 font-medium">
                            {(t.userName || "?").charAt(0).toUpperCase()}
                          </div>
                        )}
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium text-zinc-100 text-[13px]">
                              {t.userName || shortenAddress(t.proxyWallet)}
                            </span>
                            {t.verifiedBadge && (
                              <svg className="w-3.5 h-3.5 text-blue-400" viewBox="0 0 20 20" fill="currentColor">
                                <path fillRule="evenodd" d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                              </svg>
                            )}
                          </div>
                          <span className="text-[11px] text-zinc-600 font-mono">
                            {shortenAddress(t.proxyWallet)}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      <span className={`font-mono text-[13px] font-medium ${t.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        {t.pnl >= 0 ? "+" : ""}
                        {formatUsd(t.pnl)}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono text-[13px] text-zinc-400">
                      {formatUsd(t.vol)}
                    </td>
                    <td className="px-4 py-3.5 hidden lg:table-cell">
                      {t.xUsername ? (
                        <a
                          href={`https://x.com/${t.xUsername}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="text-xs text-violet-400/80 hover:text-violet-300 transition-colors font-medium"
                        >
                          @{t.xUsername}
                        </a>
                      ) : (
                        <span className="text-xs text-zinc-700">&mdash;</span>
                      )}
                    </td>
                  </tr>

                  {/* Expanded detail row */}
                  {expandedTrader === t.proxyWallet && (
                    <tr key={`${t.proxyWallet}-detail`}>
                      <td colSpan={5} className="px-0 py-0">
                        <div className="mx-4 my-3 rounded-xl bg-white/[0.02] border border-white/[0.06] p-5">
                          {profileLoading ? (
                            <div className="flex items-center gap-3 text-zinc-500 text-sm">
                              <div className="w-4 h-4 border-2 border-zinc-700 border-t-emerald-400 rounded-full animate-spin" />
                              Loading profile...
                            </div>
                          ) : traderProfile ? (
                            <div className="space-y-4">
                              {/* Portfolio summary + copy button */}
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-8">
                                  <div>
                                    <div className="text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Portfolio Value</div>
                                    <div className="text-lg font-semibold font-mono text-zinc-100 mt-0.5">
                                      {formatUsd(traderProfile.portfolioValue)}
                                    </div>
                                  </div>
                                </div>
                                {copyTarget?.address === t.proxyWallet.toLowerCase() ? (
                                  <div className="flex items-center gap-2">
                                    <span className="px-3 py-1.5 rounded-lg text-[11px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                                      Currently Copying
                                    </span>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleStopCopying();
                                      }}
                                      disabled={copyLoading}
                                      className="px-3 py-1.5 rounded-lg text-[11px] font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20 transition-all disabled:opacity-40"
                                    >
                                      Stop
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleCopyTrader(t.proxyWallet, t.userName);
                                    }}
                                    disabled={copyLoading}
                                    className="px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border border-emerald-500/20 transition-all disabled:opacity-40"
                                  >
                                    Copy This Trader
                                  </button>
                                )}
                              </div>

                              {/* Positions */}
                              {traderProfile.topPositions.length > 0 && (
                                <div>
                                  <h4 className="text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold mb-3">
                                    Top Positions
                                  </h4>
                                  <div className="space-y-2">
                                    {traderProfile.topPositions.map((pos, i) => (
                                      <div
                                        key={i}
                                        className="flex items-center justify-between bg-white/[0.02] border border-white/[0.04] rounded-lg px-4 py-3 text-sm"
                                      >
                                        <div className="flex-1 min-w-0 mr-4">
                                          <div className="text-zinc-200 text-[13px] truncate">{pos.title}</div>
                                          <div className="text-[11px] text-zinc-600 mt-0.5">{pos.outcome}</div>
                                        </div>
                                        <div className="flex items-center gap-8 shrink-0">
                                          <div className="text-right">
                                            <div className="text-[10px] text-zinc-600 uppercase tracking-wider">Size</div>
                                            <div className="font-mono text-[13px] text-zinc-300">
                                              {formatUsd(pos.size * pos.curPrice)}
                                            </div>
                                          </div>
                                          <div className="text-right">
                                            <div className="text-[10px] text-zinc-600 uppercase tracking-wider">PnL</div>
                                            <div
                                              className={`font-mono text-[13px] font-medium ${
                                                pos.cashPnl >= 0 ? "text-emerald-400" : "text-red-400"
                                              }`}
                                            >
                                              {pos.cashPnl >= 0 ? "+" : ""}
                                              {formatUsd(pos.cashPnl)}
                                            </div>
                                          </div>
                                          <div className="text-right">
                                            <div className="text-[10px] text-zinc-600 uppercase tracking-wider">Return</div>
                                            <div
                                              className={`font-mono text-[13px] font-medium ${
                                                pos.percentPnl >= 0 ? "text-emerald-400" : "text-red-400"
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
                        </div>
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
