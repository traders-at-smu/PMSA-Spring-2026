import { useRef, useEffect, useState } from "react";
import { usePolling } from "../hooks/usePolling";

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
  isAggregated?: boolean;
  tradeCount?: number;
  avgPrice?: number;
  suspicionScore?: number;
  suspicionSignals?: string[];
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

const SPORTS_KEYWORDS = [
  // Leagues
  "nba", "nfl", "mlb", "nhl", "mls", "wnba", "ncaa", "pga", "atp", "wta",
  "serie a", "la liga", "bundesliga", "ligue 1", "eredivisie", "liga mx",
  "super bowl", "world series", "stanley cup", "world cup",
  "premier league", "champions league", "uefa", "fifa",
  "mvp", "playoffs", "championship", "finals", "pennant",
  // NBA teams
  "lakers", "celtics", "warriors", "knicks", "nets", "heat",
  "bulls", "76ers", "sixers", "suns", "bucks", "clippers",
  "mavericks", "mavs", "nuggets", "timberwolves", "grizzlies",
  "pelicans", "thunder", "blazers", "spurs", "rockets", "raptors",
  "pacers", "cavaliers", "cavs", "hawks", "hornets", "pistons",
  "magic", "wizards", "kings",
  // NFL teams
  "chiefs", "eagles", "49ers", "cowboys", "packers", "ravens",
  "bills", "dolphins", "patriots", "jets", "steelers", "bengals",
  "browns", "colts", "texans", "jaguars", "titans", "broncos",
  "chargers", "raiders", "seahawks", "rams", "cardinals",
  "commanders", "giants", "bears", "lions", "vikings", "saints",
  "buccaneers", "bucs", "falcons", "panthers",
  // MLB teams
  "yankees", "dodgers", "mets", "red sox", "cubs", "astros",
  "braves", "phillies", "padres", "guardians", "brewers",
  "orioles", "twins", "mariners", "rays", "blue jays",
  "diamondbacks", "d-backs", "reds", "pirates", "royals",
  "white sox", "rockies", "marlins", "nationals", "athletics",
  "tigers",
  // NHL teams
  "bruins", "penguins", "capitals", "flyers", "oilers", "flames",
  "canucks", "senators", "canadiens", "maple leafs", "hurricanes",
  "lightning", "stars", "blues", "wild", "kraken", "coyotes",
  "sharks", "ducks", "blackhawks", "red wings", "blue jackets",
  "islanders", "predators", "avalanche", "sabres", "devils",
  "rangers", "panthers",
  // Sports terms
  "game", "match", "season", "draft", "touchdown",
  "home run", "slam dunk", "halftime", "overtime",
  "tennis", "golf", "boxing", "ufc", "mma", "wrestling",
  "f1", "formula 1", "nascar", "olympics", "cricket",
  "soccer", "football", "baseball", "basketball", "hockey",
  "rugby", "lacrosse", "volleyball",
  // Soccer clubs (international — catches "Will X FC win" style markets)
  " fc ", " sc ", " cf ", " ac ",
  "fluminense", "flamengo", "palmeiras", "corinthians", "santos",
  "boca juniors", "river plate", "barcelona", "real madrid", "atletico",
  "juventus", "inter milan", "ac milan", "bayern", "dortmund",
  "psg", "paris saint", "arsenal", "chelsea", "liverpool",
  "manchester united", "manchester city", "tottenham",
];

/** Regex to catch "X vs Y" or "X vs. Y" matchup-style sports markets */
const VS_PATTERN = /\bvs\.?\s/i;
/** Non-sports "vs" markets to whitelist (court cases, policy debates, etc.) */
const VS_WHITELIST = ["supreme court", "scotus", "sec vs", "ftx", "regulation", "lawsuit", "court"];

/** Regex for "Will X win on YYYY-MM-DD?" style sports markets */
const WILL_WIN_PATTERN = /will .+ win on \d{4}-\d{2}-\d{2}/i;

/** Regex for short-term crypto price markets: "Solana Up or Down - February 25, 7:25PM-7:30PM ET" */
const CRYPTO_SHORT_TERM_PATTERN = /\b(up or down|higher or lower)\b.*\d{1,2}:\d{2}\s*(am|pm)/i;
const CRYPTO_KEYWORDS = ["solana", "bitcoin", "ethereum", "btc", "eth", "sol", "xrp", "doge", "bnb", "ada"];

function isNoiseMarket(market: string): boolean {
  const lower = market.toLowerCase();
  // Sports keyword match
  if (SPORTS_KEYWORDS.some((kw) => lower.includes(kw))) return true;
  // "X vs Y" pattern — sports unless it's a legal/political context
  if (VS_PATTERN.test(market) && !VS_WHITELIST.some((w) => lower.includes(w))) return true;
  // "Will X win on 2026-02-25?" pattern
  if (WILL_WIN_PATTERN.test(market)) return true;
  // Short-term crypto price markets (5 min / 1 hr windows)
  if (CRYPTO_SHORT_TERM_PATTERN.test(market) && CRYPTO_KEYWORDS.some((kw) => lower.includes(kw))) return true;
  return false;
}

interface AlertsResponse {
  alerts: TradeAlert[];
  recent: TradeAlert[];
  aggregated: TradeAlert[];
}

export function TradeAlerts({ paused }: { paused: boolean }) {
  const { data: polledData, loading, lastUpdated, refetch } = usePolling<AlertsResponse>("/api/alerts", 30_000, paused);
  const [alerts, setAlerts] = useState<TradeAlert[]>([]);
  const [recentTrades, setRecentTrades] = useState<TradeAlert[]>([]);
  const [aggregatedTrades, setAggregatedTrades] = useState<TradeAlert[]>([]);
  const seenTxs = useRef(new Set<string>());

  // --- Filter state ---
  const [showInsiderOnly, setShowInsiderOnly] = useState(false);
  const [insiderThreshold, setInsiderThreshold] = useState<30 | 50 | 70>(50);
  const [showNewAccountsOnly, setShowNewAccountsOnly] = useState(false);
  const [showFirstBetsOnly, setShowFirstBetsOnly] = useState(false);
  const [showLargeBetsOnly, setShowLargeBetsOnly] = useState(false);
  const [showExpiringSoonOnly, setShowExpiringSoonOnly] = useState(false);

  // Merge polled updates (dedup by transactionHash, filter out sports)
  useEffect(() => {
    if (!polledData) return;
    const polledAlerts = polledData.alerts || [];
    const polledRecent = polledData.recent || [];
    const polledAgg = polledData.aggregated || [];

    // Filter: no sports, no near-certain prices (>95¢)
    const isInteresting = (a: TradeAlert) => !isNoiseMarket(a.market) && a.price <= 0.95 && a.side !== "SELL";
    // Aggregated uses avgPrice instead of price
    const isInterestingAgg = (a: TradeAlert) => !isNoiseMarket(a.market) && (a.avgPrice ?? a.price) <= 0.95 && a.side !== "SELL";

    // Update recent trades
    setRecentTrades(polledRecent.filter(isInteresting));

    // Update aggregated trades
    setAggregatedTrades(polledAgg.filter(isInterestingAgg));

    // Merge expiring-market alerts
    setAlerts((prev) => {
      const filtered = polledAlerts.filter(isInteresting);
      const newAlerts = filtered.filter((a) => !seenTxs.current.has(a.transactionHash));
      newAlerts.forEach((a) => seenTxs.current.add(a.transactionHash));
      filtered.forEach((a) => seenTxs.current.add(a.transactionHash));
      const merged = [...newAlerts, ...prev];
      return merged.slice(0, 200);
    });
  }, [polledData]);

  // --- Apply insider filters ---
  const applyFilters = (list: TradeAlert[]): TradeAlert[] => {
    return list.filter((a) => {
      if (showInsiderOnly && (a.suspicionScore ?? 0) < insiderThreshold) return false;
      if (showNewAccountsOnly && !a.isNewAccount) return false;
      if (showFirstBetsOnly && !a.isFirstLargeBet) return false;
      if (showLargeBetsOnly && a.cashValue < 10000) return false;
      if (showExpiringSoonOnly && (a.hoursToExpiry <= 0 || a.hoursToExpiry > 12)) return false;
      return true;
    });
  };

  const filtersActive = showInsiderOnly || showNewAccountsOnly || showFirstBetsOnly || showLargeBetsOnly || showExpiringSoonOnly;
  const filteredAlerts = applyFilters(alerts);
  const filteredRecent = applyFilters(recentTrades);
  const filteredAgg = applyFilters(aggregatedTrades);
  const totalUnfiltered = alerts.length + recentTrades.length + aggregatedTrades.length;
  const totalFiltered = filteredAlerts.length + filteredRecent.length + filteredAgg.length;

  return (
    <div className="space-y-5">
      {/* Section header */}
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100 tracking-tight">Smart Money Alerts</h2>
          <p className="text-xs text-zinc-500 mt-0.5">Large trades &amp; accumulated positions ($5k+ total)</p>
        </div>
        {/* Status */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="relative">
              <div
                className={`w-2 h-2 rounded-full ${
                  !paused && lastUpdated ? "bg-emerald-400 status-live" : "bg-zinc-600"
                }`}
              />
            </div>
            <span className="text-xs text-zinc-500 font-medium">
              {paused ? "Paused" : lastUpdated ? "Auto-refresh" : "Loading..."}
            </span>
          </div>
          <div className="w-px h-4 bg-zinc-800" />
          <span className="text-xs text-zinc-600 font-mono tabular-nums">
            {filtersActive
              ? `${totalFiltered} / ${totalUnfiltered}`
              : `${totalUnfiltered}`}{" "}
            alert{totalUnfiltered !== 1 ? "s" : ""}
          </span>
          <div className="w-px h-4 bg-zinc-800" />
          <button
            onClick={refetch}
            disabled={loading}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-40"
            title="Refresh now"
          >
            <svg
              className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h5M20 20v-5h-5M4 9a8 8 0 0113.292-4.293M20 15a8 8 0 01-13.292 4.293" />
            </svg>
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Insider score toggle */}
        <div className="glass-card rounded-xl p-1.5 inline-flex gap-1">
          <button
            onClick={() => setShowInsiderOnly(!showInsiderOnly)}
            className={`px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all duration-200 ${
              showInsiderOnly
                ? "bg-red-500/15 text-red-400 shadow-inner shadow-red-500/5"
                : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]"
            }`}
          >
            Insider Score
          </button>
          {showInsiderOnly && (
            <>
              {([30, 50, 70] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setInsiderThreshold(t)}
                  className={`px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-all duration-200 ${
                    insiderThreshold === t
                      ? "bg-red-500/20 text-red-300"
                      : "text-zinc-600 hover:text-zinc-400 hover:bg-white/[0.04]"
                  }`}
                >
                  {t === 30 ? "Low 30+" : t === 50 ? "Med 50+" : "High 70+"}
                </button>
              ))}
            </>
          )}
        </div>

        {/* Signal filters */}
        <div className="glass-card rounded-xl p-1.5 inline-flex gap-1">
          <button
            onClick={() => setShowNewAccountsOnly(!showNewAccountsOnly)}
            className={`px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all duration-200 ${
              showNewAccountsOnly
                ? "bg-amber-500/15 text-amber-400 shadow-inner shadow-amber-500/5"
                : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]"
            }`}
          >
            New Accounts
          </button>
          <button
            onClick={() => setShowFirstBetsOnly(!showFirstBetsOnly)}
            className={`px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all duration-200 ${
              showFirstBetsOnly
                ? "bg-rose-500/15 text-rose-400 shadow-inner shadow-rose-500/5"
                : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]"
            }`}
          >
            First Bets
          </button>
          <button
            onClick={() => setShowLargeBetsOnly(!showLargeBetsOnly)}
            className={`px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all duration-200 ${
              showLargeBetsOnly
                ? "bg-emerald-500/15 text-emerald-400 shadow-inner shadow-emerald-500/5"
                : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]"
            }`}
          >
            $10k+ Bets
          </button>
          <button
            onClick={() => setShowExpiringSoonOnly(!showExpiringSoonOnly)}
            className={`px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all duration-200 ${
              showExpiringSoonOnly
                ? "bg-orange-500/15 text-orange-400 shadow-inner shadow-orange-500/5"
                : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]"
            }`}
          >
            Expiring &lt;12h
          </button>
        </div>

        {filtersActive && (
          <button
            onClick={() => {
              setShowInsiderOnly(false);
              setShowNewAccountsOnly(false);
              setShowFirstBetsOnly(false);
              setShowLargeBetsOnly(false);
              setShowExpiringSoonOnly(false);
            }}
            className="text-[11px] text-zinc-600 hover:text-zinc-400 transition-colors px-2 py-1"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Alert cards */}
      <div className="space-y-3">
        {loading && totalUnfiltered === 0 ? (
          <div className="glass-card rounded-xl p-16 flex flex-col items-center gap-3">
            <div className="w-5 h-5 border-2 border-zinc-700 border-t-amber-400 rounded-full animate-spin" />
            <span className="text-xs text-zinc-500">Loading alerts...</span>
          </div>
        ) : totalUnfiltered === 0 ? (
          <div className="glass-card rounded-xl p-16 text-center">
            <div className="text-zinc-500 text-sm">No large trades detected yet.</div>
            <div className="text-xs text-zinc-600 mt-1">Monitoring for $5k+ bets</div>
          </div>
        ) : totalFiltered === 0 && filtersActive ? (
          <div className="glass-card rounded-xl p-16 text-center">
            <div className="text-zinc-500 text-sm">No trades match the active filters.</div>
            <div className="text-xs text-zinc-600 mt-1">Try relaxing filters or lowering the insider score threshold</div>
          </div>
        ) : (
          <>
            {/* Expiring market alerts */}
            {filteredAlerts.length > 0 && (
              <>
                <div className="flex items-center gap-3">
                  <div className="h-px flex-1 bg-zinc-800" />
                  <span className="text-[11px] text-amber-400/70 font-medium uppercase tracking-wider">Expiring Market Alerts</span>
                  <div className="h-px flex-1 bg-zinc-800" />
                </div>
                {filteredAlerts.map((alert, idx) => (
                  <AlertCard key={alert.transactionHash} alert={alert} idx={idx} />
                ))}
              </>
            )}

            {/* Accumulated positions (many smaller trades) */}
            {filteredAgg.length > 0 && (
              <>
                <div className="flex items-center gap-3 pt-1">
                  <div className="h-px flex-1 bg-zinc-800" />
                  <span className="text-[11px] text-cyan-400/70 font-medium uppercase tracking-wider">Accumulated Positions</span>
                  <div className="h-px flex-1 bg-zinc-800" />
                </div>
                {filteredAgg.map((alert, idx) => (
                  <AlertCard key={`agg-${alert.transactionHash}`} alert={alert} idx={idx} />
                ))}
              </>
            )}

            {/* Recent large trades */}
            {filteredRecent.length > 0 && (
              <>
                <div className="flex items-center gap-3 pt-1">
                  <div className="h-px flex-1 bg-zinc-800" />
                  <span className="text-[11px] text-zinc-500 font-medium uppercase tracking-wider">Recent $5k+ Trades</span>
                  <div className="h-px flex-1 bg-zinc-800" />
                </div>
                {filteredRecent.map((alert, idx) => (
                  <AlertCard key={`recent-${alert.transactionHash}`} alert={alert} idx={idx} />
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function getSuspicionBadge(score: number | undefined, signals: string[] | undefined) {
  if (!score || score < 30) return null;
  const tooltip = (signals || []).join("\n");
  if (score >= 70) {
    return (
      <span
        className="px-2 py-0.5 rounded-md text-[9px] font-bold bg-red-500/15 text-red-400 uppercase tracking-wider border border-red-500/20 cursor-help"
        title={tooltip}
      >
        High Risk {score}
      </span>
    );
  }
  if (score >= 50) {
    return (
      <span
        className="px-2 py-0.5 rounded-md text-[9px] font-bold bg-orange-500/15 text-orange-400 uppercase tracking-wider border border-orange-500/20 cursor-help"
        title={tooltip}
      >
        Suspicious {score}
      </span>
    );
  }
  return (
    <span
      className="px-2 py-0.5 rounded-md text-[9px] font-bold bg-yellow-500/15 text-yellow-400 uppercase tracking-wider border border-yellow-500/20 cursor-help"
      title={tooltip}
    >
      Moderate {score}
    </span>
  );
}

function AlertCard({ alert, idx }: { alert: TradeAlert; idx: number }) {
  return (
    <div
      className="glass-card rounded-xl p-5 group"
      style={{ animationDelay: `${idx * 30}ms` }}
    >
      <div className="flex items-start justify-between gap-4">
        {/* Left: Trader + badges */}
        <div className="flex items-start gap-3.5 min-w-0">
          {alert.profileImage ? (
            <img
              src={alert.profileImage}
              alt=""
              className="w-10 h-10 rounded-full ring-1 ring-white/[0.08] object-cover shrink-0"
            />
          ) : (
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-zinc-700 to-zinc-800 ring-1 ring-white/[0.08] flex items-center justify-center text-sm text-zinc-500 shrink-0 font-medium">
              {(alert.traderName || "?").charAt(0).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-zinc-100 text-[13px]">
                {alert.traderName || shortenAddress(alert.trader)}
              </span>
              {alert.isNewAccount && (
                <span className="px-2 py-0.5 rounded-md text-[9px] font-bold bg-amber-500/15 text-amber-400 uppercase tracking-wider border border-amber-500/20">
                  New Account
                </span>
              )}
              {alert.isFirstLargeBet && (
                <span className="px-2 py-0.5 rounded-md text-[9px] font-bold bg-rose-500/15 text-rose-400 uppercase tracking-wider border border-rose-500/20">
                  First Large Bet
                </span>
              )}
              {alert.isAggregated && alert.tradeCount && (
                <span className="px-2 py-0.5 rounded-md text-[9px] font-bold bg-cyan-500/15 text-cyan-400 uppercase tracking-wider border border-cyan-500/20">
                  {alert.tradeCount} trades
                </span>
              )}
              {getSuspicionBadge(alert.suspicionScore, alert.suspicionSignals)}
            </div>
            {alert.isNewAccount && (
              <span className="text-[11px] text-zinc-600 mt-0.5 block">
                Account age: {alert.accountAgeDays} day{alert.accountAgeDays !== 1 ? "s" : ""}
              </span>
            )}
          </div>
        </div>

        {/* Right: Time ago + Side + amount */}
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-xs text-zinc-400 font-mono tabular-nums">
            {timeAgo(alert.timestamp)}
          </span>
          <span
            className={`px-2.5 py-1 rounded-lg text-[11px] font-bold tracking-wide ${
              alert.side === "BUY"
                ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/20"
                : "bg-red-500/15 text-red-400 border border-red-500/20"
            }`}
          >
            {alert.side}
          </span>
          <span className="text-lg font-semibold font-mono text-zinc-100 tabular-nums">
            {formatUsd(alert.cashValue)}
          </span>
        </div>
      </div>

      {/* Market info */}
      <div className="mt-3.5 ml-[54px]">
        <div className="text-[13px] text-zinc-300 leading-snug">{alert.market}</div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-2 text-xs">
          <span className="text-zinc-500">
            Outcome:{" "}
            <span className="text-zinc-300 font-medium">{alert.outcome}</span>
          </span>
          <span className="text-zinc-500">
            {alert.isAggregated ? "Avg Price" : "Price"}:{" "}
            <span className="text-zinc-300 font-mono tabular-nums">
              {((alert.avgPrice ?? alert.price) * 100).toFixed(1)}&cent;
            </span>
          </span>
          {alert.marketEndDate && (
            <span className="text-zinc-500">
              Resolves:{" "}
              <span className="text-zinc-300 font-mono tabular-nums">
                {new Date(alert.marketEndDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              </span>
              {alert.hoursToExpiry > 0 && (
                <span
                  className={`ml-1 font-mono tabular-nums ${
                    alert.hoursToExpiry < 12 ? "text-amber-400 font-medium" : "text-zinc-400"
                  }`}
                >
                  ({alert.hoursToExpiry.toFixed(1)}h)
                </span>
              )}
            </span>
          )}
          {!alert.marketEndDate && alert.hoursToExpiry > 0 && (
            <span className="text-zinc-500">
              Expires:{" "}
              <span
                className={`font-mono tabular-nums ${
                  alert.hoursToExpiry < 12 ? "text-amber-400 font-medium" : "text-zinc-300"
                }`}
              >
                {alert.hoursToExpiry.toFixed(1)}h
              </span>
            </span>
          )}
          {!alert.isAggregated && (
            <a
              href={`https://polygonscan.com/tx/${alert.transactionHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-violet-400/70 hover:text-violet-300 transition-colors font-medium"
            >
              tx &nearr;
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
