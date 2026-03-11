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
  polymarketLiquidity: number;
  kalshiLiquidity: number;
  polymarketVolume24h: number;
  kalshiVolume24h: number;
  contracts?: number;
  kpTotalCost?: number;
  edgeDollar?: number;
  edgePct?: number;
  annualizedEdge?: number;
  strategy?: string;
  stopReason?: string;
  daysToResolution?: number;
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
  polymarketSlug: string;
  kalshiTicker: string;
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

interface ArbSignal {
  key: string;
  event: string;
  polymarketSlug: string;
  kalshiTicker: string;
  category: string;
  buyYesVenue: "POLYMARKET" | "KALSHI";
  buyNoVenue: "POLYMARKET" | "KALSHI";
  polymarketUrl: string;
  kalshiUrl: string;
  similarityScore: number;
  status: "LIVE" | "CLOSED";
  firstSeenAt: string;
  lastSeenAt: string;
  closedAt: string | null;
  peakRoi: number;
  peakNetProfit: number;
  currentRoi: number;
  currentNetProfit: number;
  currentBuyYesPrice: number;
  currentBuyNoPrice: number;
  durationSec: number;
  ticksSeen: number;
}

interface SignalResponse {
  liveSignals: ArbSignal[];
  closedSignals: ArbSignal[];
  stats: {
    totalSignalsEver: number;
    currentLive: number;
    avgDurationSec: number;
    avgPeakRoi: number;
  };
  lastTickAt: string | null;
}

interface OpenPosition {
  id: string;
  openedAt: string;
  endDate: string;
  event: string;
  category: string;
  polymarketSlug: string;
  kalshiTicker: string;
  buyYesVenue: "POLYMARKET" | "KALSHI";
  buyYesPrice: number;
  buyNoVenue: "POLYMARKET" | "KALSHI";
  buyNoPrice: number;
  contracts: number;
  costUsd: number;
  feesUsd: number;
  expectedProfitUsd: number;
  daysToExpiry: number;
}

interface ResolvedTrade {
  id: string;
  openedAt: string;
  resolvedAt: string;
  event: string;
  category: string;
  polymarketSlug: string;
  kalshiTicker: string;
  buyYesVenue: "POLYMARKET" | "KALSHI";
  buyYesPrice: number;
  buyNoVenue: "POLYMARKET" | "KALSHI";
  buyNoPrice: number;
  contracts: number;
  costUsd: number;
  feesUsd: number;
  profitUsd: number;
  payoutUsd: number;
  holdDays: number;
  annualizedRoi: number;
}

interface EquitySnapshot {
  timestamp: string;
  balance: number;
  portfolioValue: number;
  lockedCapital: number;
  openPositions: number;
  cumulativeProfit: number;
}

interface PaperAccountResponse {
  startingBalance: number;
  availableBalance: number;
  lockedCapital: number;
  portfolioValue: number;
  unrealizedProfit: number;
  realizedProfit: number;
  totalFees: number;
  totalTrades: number;
  openPositionCount: number;
  resolvedTradeCount: number;
  winRate: number;
  maxDrawdown: number;
  annualizedRoi: number;
  avgHoldDays: number;
  openPositions: OpenPosition[];
  resolvedTrades: ResolvedTrade[];
  equityCurve: EquitySnapshot[];
  startedAt: string;
}

interface RuntimeControlResponse {
  mode: "paper" | "live";
  armLive: boolean;
  hasToken: boolean;
  tokenMasked: string | null;
  tokenExpiresAt: string | null;
  updatedAt: string;
  verifiedOnly: boolean;
}

interface RiskStatusResponse {
  circuitBreakerActive: boolean;
  currentExposure: number;
  maxTotalExposure: number;
  currentDrawdownPct: number;
  maxDrawdownPct: number;
  openPositionCount: number;
  maxPositionsPerPair: number;
}

interface V2PortfolioSummary {
  openPositionCount: number;
  totalValue: number;
  totalCost: number;
  totalUnrealizedPnl: number;
  totalRealizedPnl: number;
  totalPnl: number;
}

interface V2Position {
  pairId: string;
  venue: "kalshi" | "polymarket";
  side: "yes" | "no";
  contracts: number;
  avgEntryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  source: string;
  status: string;
  openedAt: string;
}

interface V2Order {
  id: number;
  cycleId: string;
  pairId: string;
  venue: string;
  side: string;
  contracts: number;
  price: number;
  status: string;
  idempotencyKey: string;
  createdAt: string;
}

// ---- Helpers ----

function formatUsd(n: number): string {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s}s`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function SignalHealthBadge({ signal }: { signal: ArbSignal }) {
  const isNew = signal.durationSec < 120;
  const isClosing = signal.peakRoi > 0 && signal.currentRoi < signal.peakRoi * 0.5;
  const isAging = signal.durationSec > 600;

  if (isClosing) {
    return (
      <span className="px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider bg-red-500/15 text-red-400 border border-red-500/25">
        CLOSING
      </span>
    );
  }
  if (isNew) {
    return (
      <span className="px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">
        NEW
      </span>
    );
  }
  if (isAging) {
    return (
      <span className="px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider bg-amber-500/15 text-amber-400 border border-amber-500/25">
        AGING
      </span>
    );
  }
  return (
    <span className="px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider bg-zinc-700/30 text-zinc-400 border border-zinc-600/30">
      ACTIVE
    </span>
  );
}

function EquityChart({ curve, startingBalance }: { curve: EquitySnapshot[]; startingBalance: number }) {
  if (curve.length < 2) {
    return (
      <div className="glass-card rounded-xl p-12 flex items-center justify-center">
        <span className="text-zinc-500 text-sm">Waiting for trades to build equity curve...</span>
      </div>
    );
  }

  const W = 800;
  const H = 200;
  const PAD_X = 50;
  const PAD_Y = 20;

  const values = curve.map((s) => s.portfolioValue ?? s.balance);
  const minVal = Math.min(...values, startingBalance) * 0.999;
  const maxVal = Math.max(...values, startingBalance) * 1.001;
  const range = maxVal - minVal || 1;

  const toX = (i: number) => PAD_X + ((W - PAD_X * 2) * i) / (curve.length - 1);
  const toY = (b: number) => PAD_Y + (H - PAD_Y * 2) * (1 - (b - minVal) / range);

  const points = values.map((v, i) => `${toX(i)},${toY(v)}`).join(" ");
  const areaPoints = `${toX(0)},${toY(minVal)} ${points} ${toX(values.length - 1)},${toY(minVal)}`;
  const baselineY = toY(startingBalance);
  const currentVal = values[values.length - 1];
  const isUp = currentVal >= startingBalance;

  return (
    <div className="glass-card rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">
          Portfolio Value
        </span>
        <span className={`text-sm font-bold font-mono tabular-nums ${isUp ? "text-emerald-400" : "text-red-400"}`}>
          ${currentVal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 200 }}>
        <defs>
          <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={isUp ? "#10b981" : "#ef4444"} stopOpacity="0.25" />
            <stop offset="100%" stopColor={isUp ? "#10b981" : "#ef4444"} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {/* Baseline */}
        <line
          x1={PAD_X} y1={baselineY} x2={W - PAD_X} y2={baselineY}
          stroke="#52525b" strokeWidth="1" strokeDasharray="4 4"
        />
        <text x={PAD_X - 4} y={baselineY + 3} textAnchor="end" fill="#71717a" fontSize="9" fontFamily="monospace">
          $100K
        </text>
        {/* Y-axis labels */}
        <text x={PAD_X - 4} y={PAD_Y + 3} textAnchor="end" fill="#71717a" fontSize="9" fontFamily="monospace">
          ${(maxVal / 1000).toFixed(1)}K
        </text>
        <text x={PAD_X - 4} y={H - PAD_Y + 3} textAnchor="end" fill="#71717a" fontSize="9" fontFamily="monospace">
          ${(minVal / 1000).toFixed(1)}K
        </text>
        {/* Area fill */}
        <polygon points={areaPoints} fill="url(#eqFill)" />
        {/* Line */}
        <polyline
          points={points}
          fill="none"
          stroke={isUp ? "#10b981" : "#ef4444"}
          strokeWidth="2"
          strokeLinejoin="round"
        />
        {/* Current value dot */}
        <circle
          cx={toX(values.length - 1)}
          cy={toY(currentVal)}
          r="4"
          fill={isUp ? "#10b981" : "#ef4444"}
        />
      </svg>
    </div>
  );
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

// ---- Demo Data ----

const DEMO_ARBS: CrossPlatformArb[] = [
  {
    event: "Will the Federal Reserve cut interest rates by June 2026?",
    outcome: "Yes",
    polymarketSlug: "fed-rate-cut-june-2026",
    kalshiTicker: "FED-RATE-CUT-26JUN",
    polyYesBid: 0.42, polyYesAsk: 0.44,
    kalshiYesBid: 0.38, kalshiYesAsk: 0.40,
    buyYesVenue: "KALSHI", buyYesPrice: 0.40,
    buyNoVenue: "POLYMARKET", buyNoPrice: 0.56,
    grossProfit: 0.04, netProfit: 0.035, roi: 0.0365,
    priceDiff: 0.04,
    polymarketUrl: "", kalshiUrl: "",
    similarityScore: 0.94, category: "macro",
    polymarketLiquidity: 285000, kalshiLiquidity: 142000,
    polymarketVolume24h: 52000, kalshiVolume24h: 31000,
  },
  {
    event: "Will Bitcoin exceed $150,000 before July 2026?",
    outcome: "Yes",
    polymarketSlug: "btc-150k-july-2026",
    kalshiTicker: "BTC-150K-26JUL",
    polyYesBid: 0.22, polyYesAsk: 0.24,
    kalshiYesBid: 0.19, kalshiYesAsk: 0.21,
    buyYesVenue: "KALSHI", buyYesPrice: 0.21,
    buyNoVenue: "POLYMARKET", buyNoPrice: 0.76,
    grossProfit: 0.03, netProfit: 0.026, roi: 0.0268,
    priceDiff: 0.03,
    polymarketUrl: "", kalshiUrl: "",
    similarityScore: 0.97, category: "crypto",
    polymarketLiquidity: 520000, kalshiLiquidity: 89000,
    polymarketVolume24h: 180000, kalshiVolume24h: 45000,
  },
  {
    event: "Will a Trump-backed candidate win the 2026 Georgia Senate special election?",
    outcome: "Yes",
    polymarketSlug: "georgia-senate-special-2026",
    kalshiTicker: "GA-SEN-SPECIAL-26",
    polyYesBid: 0.61, polyYesAsk: 0.63,
    kalshiYesBid: 0.57, kalshiYesAsk: 0.59,
    buyYesVenue: "KALSHI", buyYesPrice: 0.59,
    buyNoVenue: "POLYMARKET", buyNoPrice: 0.37,
    grossProfit: 0.04, netProfit: 0.034, roi: 0.0354,
    priceDiff: 0.04,
    polymarketUrl: "", kalshiUrl: "",
    similarityScore: 0.88, category: "politics",
    polymarketLiquidity: 410000, kalshiLiquidity: 195000,
    polymarketVolume24h: 92000, kalshiVolume24h: 67000,
  },
  {
    event: "Will the US unemployment rate exceed 5% in Q2 2026?",
    outcome: "Yes",
    polymarketSlug: "us-unemployment-5pct-q2-2026",
    kalshiTicker: "UNEMP-5PCT-26Q2",
    polyYesBid: 0.14, polyYesAsk: 0.16,
    kalshiYesBid: 0.11, kalshiYesAsk: 0.13,
    buyYesVenue: "KALSHI", buyYesPrice: 0.13,
    buyNoVenue: "POLYMARKET", buyNoPrice: 0.84,
    grossProfit: 0.03, netProfit: 0.025, roi: 0.0258,
    priceDiff: 0.03,
    polymarketUrl: "", kalshiUrl: "",
    similarityScore: 0.91, category: "macro",
    polymarketLiquidity: 175000, kalshiLiquidity: 98000,
    polymarketVolume24h: 28000, kalshiVolume24h: 19000,
  },
];

// ---- Component ----

export function CrossPlatformPanel({ paused }: { paused: boolean }) {
  const [tab, setTab] = useState<"arb" | "diff" | "vol" | "pairs" | "signal" | "account" | "exec">("arb");
  const [countdown, setCountdown] = useState(30);
  const [pairsFilter, setPairsFilter] = useState<"all" | "arb" | "no-arb">("all");
  const [now, setNow] = useState(Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [notificationsOn, setNotificationsOn] = useState(false);
  const [lastNotifiedArbs, setLastNotifiedArbs] = useState<Set<string>>(new Set());
  const [telegramStatus, setTelegramStatus] = useState<{ configured: boolean; enabled: boolean; chatId: string } | null>(null);
  const [telegramTesting, setTelegramTesting] = useState(false);

  const [armToken, setArmToken] = useState<string | null>(null);
  const [typedConfirm, setTypedConfirm] = useState("");
  const [executing, setExecuting] = useState(false);
  const [executionResult, setExecutionResult] = useState<any>(null);
  const [verifiedPairKeys, setVerifiedPairKeys] = useState<Set<string>>(new Set());

  const arbData = usePolling<ArbResponse>("/api/cross-platform/arbs", 30_000, paused);
  const diffData = usePolling<DiffResponse>("/api/cross-platform/diffs", 30_000, paused);
  const pairsData = usePolling<PairsResponse>(`/api/cross-platform/pairs?filter=${pairsFilter}`, 30_000, paused);
  const signalData = usePolling<SignalResponse>("/api/cross-platform/signals", 30_000, paused);
  const accountData = usePolling<PaperAccountResponse>("/api/paper-account/state", 30_000, paused);
  const runtimeData = usePolling<RuntimeControlResponse>("/api/execution/runtime-control", 5_000, paused);
  const riskData = usePolling<RiskStatusResponse>("/api/risk/status", 10_000, paused);
  const v2Portfolio = usePolling<V2PortfolioSummary>("/api/portfolio/summary", 15_000, paused);
  const v2Positions = usePolling<V2Position[]>("/api/portfolio/positions", 15_000, paused);
  const v2Orders = usePolling<V2Order[]>("/api/orders?limit=50", 15_000, paused);

  const handleForceRefresh = async () => {
    setRefreshing(true);
    try {
      await fetch("/api/cross-platform/refresh", { method: "POST" });
      // Re-fetch all data after cache invalidation
      arbData.refetch();
      diffData.refetch();
      pairsData.refetch();
      signalData.refetch();
      accountData.refetch();
      setCountdown(30);
    } catch (_) {}
    setRefreshing(false);
  };

  // Live duration ticker (for scan age + signal durations)
  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [paused]);

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

  // Browser notifications for new arb opportunities
  useEffect(() => {
    if (!notificationsOn || !arbData.data) return;

    const currentKeys = new Set(
      arbData.data.arbs.map((a) => `${a.polymarketSlug}|${a.kalshiTicker}`)
    );
    const newArbs = arbData.data.arbs.filter(
      (a) => !lastNotifiedArbs.has(`${a.polymarketSlug}|${a.kalshiTicker}`)
    );

    if (newArbs.length > 0 && lastNotifiedArbs.size > 0) {
      // Only notify after first load (not on initial data)
      for (const arb of newArbs.slice(0, 3)) {
        try {
          new Notification("New Arb Detected", {
            body: `${arb.event}\nROI: ${(arb.roi * 100).toFixed(1)}% | Profit: +${(arb.netProfit * 100).toFixed(1)}\u00A2`,
            icon: "/favicon.ico",
            tag: `arb-${arb.polymarketSlug}`,
          });
        } catch (_) {}
      }
      if (newArbs.length > 3) {
        try {
          new Notification("New Arbs Detected", {
            body: `${newArbs.length} new arbitrage opportunities found`,
            tag: "arb-batch",
          });
        } catch (_) {}
      }
    }

    setLastNotifiedArbs(currentKeys);
  }, [arbData.data, notificationsOn]);

  // Telegram status polling
  useEffect(() => {
    const fetchStatus = () =>
      fetch("/api/telegram/status")
        .then((r) => r.json())
        .then(setTelegramStatus)
        .catch(() => {});
    fetchStatus();
    const t = setInterval(fetchStatus, 60_000);
    return () => clearInterval(t);
  }, []);

  // Fetch verified pair keys on mount
  useEffect(() => {
    fetch("/api/cross-platform/verified-pairs")
      .then((r) => r.json())
      .then((data) => setVerifiedPairKeys(new Set(data.keys || [])))
      .catch(() => {});
  }, []);

  const handleToggleVerifiedPair = async (kalshiTicker: string, polymarketSlug: string) => {
    const pairKey = `${polymarketSlug}::${kalshiTicker}`;
    const isCurrentlyVerified = verifiedPairKeys.has(pairKey);
    try {
      const resp = await fetch("/api/cross-platform/pairs/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kalshiTicker,
          polymarketSlug,
          verified: !isCurrentlyVerified,
        }),
      });
      const data = await resp.json();
      if (data.keys) {
        setVerifiedPairKeys(new Set(data.keys));
      }
    } catch (_) {}
  };

  const handleToggleVerifiedOnly = async () => {
    const newVal = !(runtimeData.data?.verifiedOnly ?? false);
    try {
      await fetch("/api/execution/verified-only", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: newVal }),
      });
      runtimeData.refetch();
    } catch (_) {}
  };

  const handleTelegramTest = async () => {
    setTelegramTesting(true);
    try {
      const resp = await fetch("/api/telegram/test", { method: "POST" });
      const data = await resp.json();
      if (data.ok) {
        alert("Test message sent! Check your Telegram.");
      } else {
        alert(`Telegram test failed: ${data.error || "Unknown error"}`);
      }
    } catch (err) {
      alert("Failed to send test message");
    }
    setTelegramTesting(false);
  };

  const handleTelegramToggle = async () => {
    if (!telegramStatus?.configured) return;
    try {
      const resp = await fetch("/api/telegram/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !telegramStatus.enabled }),
      });
      const data = await resp.json();
      setTelegramStatus(data);
    } catch (_) {}
  };

  const handleToggleNotifications = async () => {
    if (!notificationsOn) {
      if (Notification.permission === "default") {
        const perm = await Notification.requestPermission();
        if (perm !== "granted") return;
      } else if (Notification.permission === "denied") {
        return;
      }
      setNotificationsOn(true);
    } else {
      setNotificationsOn(false);
    }
  };

  const handleResetAccount = async () => {
    if (!confirm("Reset paper account to $100,000? All trade history will be cleared.")) return;
    setResetting(true);
    try {
      await fetch("/api/paper-account/reset", { method: "POST" });
      accountData.refetch();
    } catch (_) {}
    setResetting(false);
  };

  const handleModeSwitch = async (mode: "paper" | "live") => {
    try {
      await fetch("/api/execution/mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      runtimeData.refetch();
    } catch (_) {}
  };

  const handleArmLive = async () => {
    try {
      const resp = await fetch("/api/execution/arm-live", { method: "POST" });
      const data = await resp.json();
      setArmToken(data.token);
      runtimeData.refetch();
    } catch (_) {}
  };

  const handleDisarmLive = async () => {
    try {
      await fetch("/api/execution/disarm-live", { method: "POST" });
      setArmToken(null);
      setTypedConfirm("");
      runtimeData.refetch();
    } catch (_) {}
  };

  const handleExecute = async () => {
    if (executing) return;
    setExecuting(true);
    setExecutionResult(null);
    try {
      // Gather tradable arbs — server pre-filters to manual or AI pairs based on verifiedOnly flag
      const tradableDecisions = (arbData.data?.arbs ?? [])
        .filter((a) => {
          return !!(a.contracts && a.contracts > 0 && a.edgeDollar && a.edgeDollar > 0);
        })
        .map((a) => ({
          pair_id: `${a.polymarketSlug}::${a.kalshiTicker}`,
          strategy: a.strategy ?? "BUY_KY_BUY_PN",
          contracts: a.contracts ?? 0,
          kp_total_cost: a.kpTotalCost ?? 0,
          edge_dollar: a.edgeDollar ?? 0,
          edge_pct: a.edgePct ?? 0,
          annualized_edge: a.annualizedEdge ?? 0,
          kalshi_side: (a.strategy ?? "").includes("KY") ? "yes" : "no",
          polymarket_side: (a.strategy ?? "").includes("PY") ? "yes" : "no",
          kalshi_price: a.buyYesVenue === "KALSHI" ? a.buyYesPrice : a.buyNoPrice,
          polymarket_price: a.buyYesVenue === "POLYMARKET" ? a.buyYesPrice : a.buyNoPrice,
          trade: true,
          reasons: [],
          metadata: {},
        }));

      const resp = await fetch("/api/execution/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decisions: tradableDecisions,
          typedConfirm: typedConfirm || undefined,
        }),
      });
      const data = await resp.json();
      setExecutionResult(data);
      // Refresh related data
      v2Portfolio.refetch();
      v2Positions.refetch();
      v2Orders.refetch();
      riskData.refetch();
    } catch (err) {
      setExecutionResult({ error: String(err) });
    }
    setExecuting(false);
  };

  const liveArbs = arbData.data?.arbs ?? [];
  const showingDemo = liveArbs.length === 0 && arbData.data != null;
  const arbs = showingDemo ? DEMO_ARBS : liveArbs;
  const diffs = diffData.data?.diffs ?? [];
  const volumes = diffData.data?.volumes ?? [];
  const pairs = pairsData.data?.pairs ?? [];
  const matchedPairs = arbData.data?.matchedPairs ?? diffData.data?.matchedPairs ?? 0;
  const polyScanned = arbData.data?.polymarketsScanned ?? 0;
  const kalshiScanned = arbData.data?.kalshiMarketsScanned ?? 0;

  const tabs: { id: typeof tab; label: string; count: number }[] = [
    { id: "arb", label: showingDemo ? "Arb (Demo)" : "Arb", count: arbs.length },
    { id: "diff", label: "Diff", count: diffs.length },
    { id: "vol", label: "Vol", count: volumes.length },
    { id: "pairs", label: "Pairs", count: pairsData.data?.total ?? 0 },
    { id: "signal", label: "Signal", count: signalData.data?.stats.currentLive ?? 0 },
    { id: "account", label: "Account", count: accountData.data?.openPositionCount ?? 0 },
    { id: "exec", label: "Execution", count: riskData.data?.openPositionCount ?? 0 },
  ];

  return (
    <div className="space-y-5">
      {/* Section header */}
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-lg font-serif text-zinc-100 tracking-tight">
            Cross-Platform Scanner
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
          {/* Manual refresh */}
          <button
            onClick={handleForceRefresh}
            disabled={refreshing || paused}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all ${
              refreshing
                ? "bg-[#CC0035]/10 text-[#CC0035] cursor-wait"
                : "bg-zinc-800/80 text-zinc-400 hover:bg-zinc-700/80 hover:text-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed"
            }`}
          >
            <svg
              className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {refreshing ? "Scanning..." : "Refresh"}
          </button>

          {/* Notifications toggle */}
          <button
            onClick={handleToggleNotifications}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all ${
              notificationsOn
                ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/20"
                : "bg-zinc-800/80 text-zinc-500 hover:bg-zinc-700/80 hover:text-zinc-300"
            }`}
            title={notificationsOn ? "Notifications on — click to disable" : "Enable browser notifications for new arbs"}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              {notificationsOn ? (
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
              )}
            </svg>
            {notificationsOn ? "Alerts On" : "Alerts"}
          </button>

          {/* Telegram indicator */}
          {telegramStatus && (
            <div className="flex items-center gap-1">
              <button
                onClick={telegramStatus.configured ? handleTelegramToggle : undefined}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all ${
                  telegramStatus.configured && telegramStatus.enabled
                    ? "bg-[#0088cc]/15 text-[#29b6f6] border border-[#0088cc]/20"
                    : telegramStatus.configured
                    ? "bg-zinc-800/80 text-zinc-500 hover:bg-zinc-700/80 hover:text-zinc-300"
                    : "bg-zinc-800/40 text-zinc-600 cursor-default"
                }`}
                title={
                  telegramStatus.configured
                    ? telegramStatus.enabled
                      ? `Telegram ON (chat ${telegramStatus.chatId}) — click to disable`
                      : "Telegram OFF — click to enable"
                    : "Add TELEGRAM_BOT_TOKEN & TELEGRAM_CHAT_ID to .env"
                }
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
                </svg>
                {telegramStatus.configured
                  ? telegramStatus.enabled ? "TG On" : "TG Off"
                  : "TG"}
              </button>
              {telegramStatus.configured && telegramStatus.enabled && (
                <button
                  onClick={handleTelegramTest}
                  disabled={telegramTesting}
                  className="px-2 py-1.5 rounded-lg text-[10px] font-semibold bg-zinc-800/80 text-zinc-500 hover:bg-zinc-700/80 hover:text-zinc-300 transition-all"
                  title="Send test message to Telegram"
                >
                  {telegramTesting ? "..." : "Test"}
                </button>
              )}
            </div>
          )}

          <div className="w-px h-4 bg-zinc-800" />

          {/* AI / Manual pair source toggle (prominent, always visible) */}
          <div className="flex gap-0.5 bg-zinc-900 rounded-lg p-0.5">
            <button
              onClick={() => { if (runtimeData.data?.verifiedOnly) handleToggleVerifiedOnly(); }}
              className={`px-3 py-1 rounded-md text-[11px] font-semibold transition-all ${
                !runtimeData.data?.verifiedOnly
                  ? "bg-violet-500/15 text-violet-400 shadow-inner"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
              title="Use all AI-matched pairs"
            >
              AI Pairs
            </button>
            <button
              onClick={() => { if (!runtimeData.data?.verifiedOnly) handleToggleVerifiedOnly(); }}
              className={`px-3 py-1 rounded-md text-[11px] font-semibold transition-all ${
                runtimeData.data?.verifiedOnly
                  ? "bg-emerald-500/15 text-emerald-400 shadow-inner"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
              title="Use only manually verified pairs"
            >
              Manual
            </button>
          </div>

          <div className="w-px h-4 bg-zinc-800" />

          <div className="flex items-center gap-2">
            <div
              className={`w-2 h-2 rounded-full ${
                !paused && arbData.lastUpdated ? "bg-emerald-400 status-live" : "bg-zinc-600"
              }`}
            />
            <span className="text-xs text-zinc-500 font-medium">
              {paused ? "Paused" : arbData.lastUpdated ? `Next in ${countdown}s` : "Loading..."}
            </span>
          </div>
          {arbData.data && (() => {
            const scanAge = Math.floor((now - new Date(arbData.data.timestamp).getTime()) / 1000);
            const ageLabel = scanAge < 60 ? `${scanAge}s ago` : scanAge < 3600 ? `${Math.floor(scanAge / 60)}m ago` : `${Math.floor(scanAge / 3600)}h ago`;
            const ageColor = scanAge < 360 ? "text-emerald-400" : scanAge < 900 ? "text-amber-400" : "text-red-400";
            return (
              <>
                <div className="w-px h-4 bg-zinc-800" />
                <span className={`text-xs font-mono tabular-nums ${ageColor}`} title={`Last scan: ${new Date(arbData.data.timestamp).toLocaleTimeString()}`}>
                  Scanned {ageLabel}
                </span>
              </>
            );
          })()}
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
                ? "bg-[#CC0035]/15 text-[#ff3d6a] shadow-inner shadow-[#CC0035]/5"
                : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]"
            }`}
          >
            {t.label}
            {t.count > 0 && (
              <span
                className={`ml-2 text-[11px] px-1.5 py-0.5 rounded-md ${
                  tab === t.id ? "bg-[#CC0035]/20 text-[#ff3d6a]" : "bg-zinc-800 text-zinc-500"
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
        <div className="space-y-4">
          {/* Loading header */}
          <div className="glass-card rounded-xl p-5 flex items-center gap-4">
            <div className="w-5 h-5 border-2 border-zinc-700 border-t-[#CC0035] rounded-full animate-spin shrink-0" />
            <div className="flex-1">
              <div className="text-sm text-zinc-300 font-medium">Scanning markets across platforms...</div>
              <div className="text-[11px] text-zinc-500 mt-0.5">
                Fetching Polymarket & Kalshi data, matching events, computing arbitrage opportunities.
                First load takes ~15-30s.
              </div>
            </div>
          </div>
          {/* Skeleton table */}
          <div className="glass-card rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.06]">
                  <th className="px-4 py-3 text-left text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Event</th>
                  <th className="px-4 py-3 text-center text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Buy YES</th>
                  <th className="px-4 py-3 text-center text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Buy NO</th>
                  <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Net Profit</th>
                  <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">ROI</th>
                  <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Contracts</th>
                  <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Edge</th>
                  <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Ann. Edge</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="border-b border-white/[0.03] last:border-0">
                    <td className="px-4 py-4 max-w-xs">
                      <div className="h-3.5 w-48 bg-zinc-800 rounded animate-pulse" />
                      <div className="h-2.5 w-24 bg-zinc-800/60 rounded animate-pulse mt-2" />
                    </td>
                    <td className="px-4 py-4 text-center">
                      <div className="h-4 w-12 bg-zinc-800 rounded animate-pulse mx-auto" />
                    </td>
                    <td className="px-4 py-4 text-center">
                      <div className="h-4 w-12 bg-zinc-800 rounded animate-pulse mx-auto" />
                    </td>
                    <td className="px-4 py-4 text-right">
                      <div className="h-4 w-10 bg-zinc-800 rounded animate-pulse ml-auto" />
                    </td>
                    <td className="px-4 py-4 text-right">
                      <div className="h-5 w-14 bg-zinc-800 rounded-md animate-pulse ml-auto" />
                    </td>
                    <td className="px-4 py-4 text-right">
                      <div className="h-4 w-10 bg-zinc-800 rounded animate-pulse ml-auto" />
                    </td>
                    <td className="px-4 py-4 text-right">
                      <div className="h-4 w-10 bg-zinc-800 rounded animate-pulse ml-auto" />
                    </td>
                    <td className="px-4 py-4 text-right">
                      <div className="h-5 w-14 bg-zinc-800 rounded-md animate-pulse ml-auto" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <>
          {/* ──── ARB TAB ──── */}
          {tab === "arb" && (
            <div className="space-y-3">
              {showingDemo && (
                <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-amber-500/[0.06] border border-amber-500/15">
                  <span className="px-2 py-0.5 rounded text-[9px] font-bold tracking-wider bg-amber-500/15 text-amber-400 border border-amber-500/25">
                    DEMO
                  </span>
                  <span className="text-[12px] text-zinc-400">
                    No live arbitrage opportunities right now. Showing example data to illustrate the scanner.
                  </span>
                </div>
              )}
              <div className="glass-card rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/[0.06]">
                    <th className="px-2 py-3 text-center text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold w-10" title="Manually verify this pair for trading">
                      <svg className="w-3.5 h-3.5 mx-auto text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
                    </th>
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
                      Liquidity
                    </th>
                    <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                      Net Profit
                    </th>
                    <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                      ROI
                    </th>
                    <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                      Contracts
                    </th>
                    <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                      Edge
                    </th>
                    <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                      Ann. Edge
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {arbs.map((arb, i) => {
                    const pairKey = `${arb.polymarketSlug}::${arb.kalshiTicker}`;
                    const isVerified = verifiedPairKeys.has(pairKey);
                    return (
                      <tr
                        key={`${arb.polymarketSlug}-${arb.kalshiTicker}-${i}`}
                        className={`data-row border-b border-white/[0.03] last:border-0 ${isVerified ? "bg-emerald-500/[0.03]" : ""}`}
                      >
                        {/* Verified Checkbox */}
                        <td className="px-2 py-3 text-center">
                          <button
                            onClick={() => handleToggleVerifiedPair(arb.kalshiTicker, arb.polymarketSlug)}
                            className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-all ${
                              isVerified
                                ? "bg-emerald-500/20 border-emerald-500/50 text-emerald-400"
                                : "border-zinc-700 text-transparent hover:border-zinc-500"
                            }`}
                            title={isVerified ? "Verified — click to unverify" : "Click to manually verify this pair"}
                          >
                            {isVerified && (
                              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                              </svg>
                            )}
                          </button>
                        </td>
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

                        {/* Liquidity */}
                        <td className="px-4 py-3 text-right">
                          <div className="flex flex-col items-end gap-0.5">
                            <span className="font-mono text-violet-400/70 text-[11px] tabular-nums">
                              {formatUsd(arb.polymarketLiquidity)}
                            </span>
                            <span className="font-mono text-cyan-400/70 text-[11px] tabular-nums">
                              {formatUsd(arb.kalshiLiquidity)}
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

                        {/* Contracts */}
                        <td className="px-4 py-3 text-right">
                          <span className="font-mono tabular-nums text-[13px] text-zinc-300">
                            {arb.contracts ?? "\u2014"}
                          </span>
                        </td>

                        {/* Edge $ */}
                        <td className="px-4 py-3 text-right">
                          {arb.edgeDollar != null ? (
                            <span className={`font-mono tabular-nums text-[13px] font-semibold ${
                              arb.edgeDollar > 0 ? "text-emerald-400" : "text-zinc-500"
                            }`}>
                              {arb.edgeDollar > 0 ? "+" : ""}{arb.edgeDollar.toFixed(2)}
                            </span>
                          ) : (
                            <span className="text-zinc-600">{"\u2014"}</span>
                          )}
                        </td>

                        {/* Ann. Edge % */}
                        <td className="px-4 py-3 text-right">
                          {arb.annualizedEdge != null ? (
                            <span className={`px-2 py-0.5 rounded-md text-[11px] font-bold tabular-nums ${
                              arb.annualizedEdge > 0.5
                                ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/20"
                                : arb.annualizedEdge > 0.1
                                ? "bg-amber-500/15 text-amber-400 border border-amber-500/20"
                                : "bg-zinc-800 text-zinc-400 border border-zinc-700"
                            }`}>
                              {(arb.annualizedEdge * 100).toFixed(0)}%
                            </span>
                          ) : (
                            <span className="text-zinc-600">{"\u2014"}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
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

          {/* ──── SIGNAL TAB ──── */}
          {tab === "signal" && (
            <div className="space-y-5">
              {/* Stats cards */}
              <div className="grid grid-cols-4 gap-3">
                {[
                  {
                    label: "Live Signals",
                    value: signalData.data?.stats.currentLive ?? 0,
                    accent: "text-emerald-400",
                  },
                  {
                    label: "Total Tracked",
                    value: signalData.data?.stats.totalSignalsEver ?? 0,
                    accent: "text-zinc-200",
                  },
                  {
                    label: "Avg Duration",
                    value: formatDuration(signalData.data?.stats.avgDurationSec ?? 0),
                    accent: "text-amber-400",
                  },
                  {
                    label: "Avg Peak ROI",
                    value: `${((signalData.data?.stats.avgPeakRoi ?? 0) * 100).toFixed(1)}%`,
                    accent: "text-orange-400",
                  },
                ].map((stat) => (
                  <div
                    key={stat.label}
                    className="glass-card rounded-xl p-4 flex flex-col items-center gap-1"
                  >
                    <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">
                      {stat.label}
                    </span>
                    <span className={`text-xl font-bold font-mono tabular-nums ${stat.accent}`}>
                      {stat.value}
                    </span>
                  </div>
                ))}
              </div>

              {/* Live Signals */}
              <div>
                <h3 className="text-sm font-semibold text-zinc-300 mb-2">
                  Live Signals
                  <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded-md bg-emerald-500/15 text-emerald-400">
                    {signalData.data?.liveSignals.length ?? 0}
                  </span>
                </h3>
                <div className="glass-card rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/[0.06]">
                        <th className="px-4 py-3 text-left text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                          Event
                        </th>
                        <th className="px-4 py-3 text-center text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                          Health
                        </th>
                        <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                          First Seen
                        </th>
                        <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                          Duration
                        </th>
                        <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                          ROI
                        </th>
                        <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                          Peak ROI
                        </th>
                        <th className="px-4 py-3 text-center text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                          Buy YES
                        </th>
                        <th className="px-4 py-3 text-center text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                          Buy NO
                        </th>
                        <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                          Ticks
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {(signalData.data?.liveSignals ?? []).length === 0 ? (
                        <tr>
                          <td colSpan={9} className="px-4 py-12 text-center text-zinc-500 text-sm">
                            No live signals — waiting for arbs to appear...
                          </td>
                        </tr>
                      ) : (
                        (signalData.data?.liveSignals ?? []).map((sig) => {
                          const liveDuration =
                            sig.durationSec +
                            Math.max(0, Math.floor((now - Date.parse(sig.lastSeenAt)) / 1000));
                          return (
                            <tr
                              key={sig.key}
                              className="data-row border-b border-white/[0.03] last:border-0"
                            >
                              <td className="px-4 py-3 max-w-[260px]">
                                <div className="text-[13px] text-zinc-200 font-medium leading-snug line-clamp-2">
                                  {sig.event}
                                </div>
                                <div className="flex items-center gap-2 mt-1">
                                  <CategoryBadge category={sig.category} />
                                  <span className="text-[9px] text-zinc-600 font-mono">
                                    {(sig.similarityScore * 100).toFixed(0)}% match
                                  </span>
                                </div>
                              </td>
                              <td className="px-4 py-3 text-center">
                                <SignalHealthBadge signal={{ ...sig, durationSec: liveDuration }} />
                              </td>
                              <td className="px-4 py-3 text-right">
                                <span className="text-[12px] text-zinc-400 font-mono tabular-nums">
                                  {new Date(sig.firstSeenAt).toLocaleTimeString()}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-right">
                                <span className="font-mono tabular-nums text-[13px] text-zinc-200 font-medium">
                                  {formatDuration(liveDuration)}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-right">
                                <span
                                  className={`font-mono tabular-nums text-[13px] font-semibold ${
                                    sig.currentRoi > 0.03
                                      ? "text-emerald-400"
                                      : sig.currentRoi > 0.01
                                      ? "text-amber-400"
                                      : "text-zinc-400"
                                  }`}
                                >
                                  {(sig.currentRoi * 100).toFixed(1)}%
                                </span>
                              </td>
                              <td className="px-4 py-3 text-right">
                                <span className="font-mono tabular-nums text-[13px] text-zinc-400">
                                  {(sig.peakRoi * 100).toFixed(1)}%
                                </span>
                              </td>
                              <td className="px-4 py-3 text-center">
                                <div className="flex flex-col items-center gap-0.5">
                                  <VenueBadge venue={sig.buyYesVenue} />
                                  <span className="font-mono text-emerald-400 text-[12px] tabular-nums">
                                    {(sig.currentBuyYesPrice * 100).toFixed(1)}&cent;
                                  </span>
                                </div>
                              </td>
                              <td className="px-4 py-3 text-center">
                                <div className="flex flex-col items-center gap-0.5">
                                  <VenueBadge venue={sig.buyNoVenue} />
                                  <span className="font-mono text-red-400 text-[12px] tabular-nums">
                                    {(sig.currentBuyNoPrice * 100).toFixed(1)}&cent;
                                  </span>
                                </div>
                              </td>
                              <td className="px-4 py-3 text-right">
                                <span className="font-mono tabular-nums text-[12px] text-zinc-500">
                                  {sig.ticksSeen}
                                </span>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Closed Signals */}
              <div>
                <h3 className="text-sm font-semibold text-zinc-300 mb-2">
                  Recent Closed
                  <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded-md bg-zinc-800 text-zinc-500">
                    {signalData.data?.closedSignals.length ?? 0}
                  </span>
                </h3>
                <div className="glass-card rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/[0.06]">
                        <th className="px-4 py-3 text-left text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                          Event
                        </th>
                        <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                          First Seen
                        </th>
                        <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                          Closed At
                        </th>
                        <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                          Lasted
                        </th>
                        <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                          Peak ROI
                        </th>
                        <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                          Peak Profit
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {(signalData.data?.closedSignals ?? []).length === 0 ? (
                        <tr>
                          <td colSpan={6} className="px-4 py-12 text-center text-zinc-500 text-sm">
                            No closed signals yet
                          </td>
                        </tr>
                      ) : (
                        (signalData.data?.closedSignals ?? []).map((sig, i) => (
                          <tr
                            key={`${sig.key}-${i}`}
                            className="data-row border-b border-white/[0.03] last:border-0"
                          >
                            <td className="px-4 py-3 max-w-[280px]">
                              <div className="text-[13px] text-zinc-400 font-medium leading-snug line-clamp-2">
                                {sig.event}
                              </div>
                              <div className="mt-1">
                                <CategoryBadge category={sig.category} />
                              </div>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <span className="text-[12px] text-zinc-500 font-mono tabular-nums">
                                {new Date(sig.firstSeenAt).toLocaleTimeString()}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <span className="text-[12px] text-zinc-500 font-mono tabular-nums">
                                {sig.closedAt
                                  ? new Date(sig.closedAt).toLocaleTimeString()
                                  : "—"}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <span className="font-mono tabular-nums text-[13px] text-zinc-300">
                                {formatDuration(sig.durationSec)}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <span
                                className={`font-mono tabular-nums text-[13px] font-semibold ${
                                  sig.peakRoi > 0.03
                                    ? "text-emerald-400"
                                    : sig.peakRoi > 0.01
                                    ? "text-amber-400"
                                    : "text-zinc-400"
                                }`}
                              >
                                {(sig.peakRoi * 100).toFixed(1)}%
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <span className="font-mono tabular-nums text-[13px] text-zinc-400">
                                +{(sig.peakNetProfit * 100).toFixed(1)}&cent;
                              </span>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* ──── ACCOUNT TAB ──── */}
          {tab === "account" && (
            <div className="space-y-5">
              {/* Account header with reset */}
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-zinc-300">Paper Trading Account</h3>
                  <p className="text-[11px] text-zinc-600 mt-0.5">
                    Started {accountData.data?.startedAt ? new Date(accountData.data.startedAt).toLocaleDateString() : "—"}
                  </p>
                </div>
                <button
                  onClick={handleResetAccount}
                  disabled={resetting}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 hover:text-red-300 transition-all disabled:opacity-40"
                >
                  <svg className={`w-3.5 h-3.5 ${resetting ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  {resetting ? "Resetting..." : "Reset to $100K"}
                </button>
              </div>

              {/* Stats cards — row 1: portfolio */}
              <div className="grid grid-cols-4 gap-3">
                {[
                  {
                    label: "Portfolio Value",
                    value: `$${(accountData.data?.portfolioValue ?? 100000).toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
                    accent: (accountData.data?.portfolioValue ?? 100000) >= 100000 ? "text-emerald-400" : "text-red-400",
                  },
                  {
                    label: "Available Cash",
                    value: `$${(accountData.data?.availableBalance ?? 100000).toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
                    accent: "text-zinc-200",
                  },
                  {
                    label: "Locked Capital",
                    value: `$${(accountData.data?.lockedCapital ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
                    accent: (accountData.data?.lockedCapital ?? 0) > 0 ? "text-amber-400" : "text-zinc-500",
                  },
                  {
                    label: "Unrealized P&L",
                    value: `$${(accountData.data?.unrealizedProfit ?? 0).toFixed(2)}`,
                    accent: (accountData.data?.unrealizedProfit ?? 0) >= 0 ? "text-emerald-400" : "text-red-400",
                  },
                ].map((stat) => (
                  <div
                    key={stat.label}
                    className="glass-card rounded-xl p-4 flex flex-col items-center gap-1"
                  >
                    <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">
                      {stat.label}
                    </span>
                    <span className={`text-lg font-bold font-mono tabular-nums ${stat.accent}`}>
                      {stat.value}
                    </span>
                  </div>
                ))}
              </div>

              {/* Stats cards — row 2: performance */}
              <div className="grid grid-cols-6 gap-3">
                {[
                  {
                    label: "Realized P&L",
                    value: `$${(accountData.data?.realizedProfit ?? 0).toFixed(2)}`,
                    accent: (accountData.data?.realizedProfit ?? 0) >= 0 ? "text-emerald-400" : "text-red-400",
                  },
                  {
                    label: "Annualized ROI",
                    value: `${((accountData.data?.annualizedRoi ?? 0) * 100).toFixed(1)}%`,
                    accent: (accountData.data?.annualizedRoi ?? 0) >= 0 ? "text-emerald-400" : "text-red-400",
                  },
                  {
                    label: "Win Rate",
                    value: `${((accountData.data?.winRate ?? 0) * 100).toFixed(1)}%`,
                    accent: "text-amber-400",
                  },
                  {
                    label: "Max Drawdown",
                    value: `${((accountData.data?.maxDrawdown ?? 0) * 100).toFixed(2)}%`,
                    accent: "text-red-400",
                  },
                  {
                    label: "Avg Hold",
                    value: `${(accountData.data?.avgHoldDays ?? 0).toFixed(1)}d`,
                    accent: "text-zinc-300",
                  },
                  {
                    label: "Trades",
                    value: `${accountData.data?.openPositionCount ?? 0} open / ${accountData.data?.resolvedTradeCount ?? 0} resolved`,
                    accent: "text-zinc-300",
                  },
                ].map((stat) => (
                  <div
                    key={stat.label}
                    className="glass-card rounded-xl p-3 flex flex-col items-center gap-1"
                  >
                    <span className="text-[9px] text-zinc-500 uppercase tracking-wider font-semibold">
                      {stat.label}
                    </span>
                    <span className={`text-sm font-bold font-mono tabular-nums ${stat.accent}`}>
                      {stat.value}
                    </span>
                  </div>
                ))}
              </div>

              {/* Equity Curve */}
              <EquityChart
                curve={accountData.data?.equityCurve ?? []}
                startingBalance={accountData.data?.startingBalance ?? 100000}
              />

              {/* Open Positions */}
              <div>
                <h3 className="text-sm font-semibold text-zinc-300 mb-2">
                  Open Positions
                  <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded-md bg-amber-500/10 text-amber-400 border border-amber-500/20">
                    {accountData.data?.openPositions.length ?? 0} active
                  </span>
                </h3>
                <div className="glass-card rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/[0.06]">
                        <th className="px-4 py-3 text-left text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Opened</th>
                        <th className="px-4 py-3 text-left text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Event</th>
                        <th className="px-4 py-3 text-center text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Buy YES</th>
                        <th className="px-4 py-3 text-center text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Buy NO</th>
                        <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Contracts</th>
                        <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Cost</th>
                        <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Exp. Profit</th>
                        <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Expires</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(accountData.data?.openPositions ?? []).length === 0 ? (
                        <tr>
                          <td colSpan={8} className="px-4 py-10 text-center text-zinc-500 text-sm">
                            No open positions — capital is fully available
                          </td>
                        </tr>
                      ) : (
                        (accountData.data?.openPositions ?? []).map((p) => (
                          <tr key={p.id} className="data-row border-b border-white/[0.03] last:border-0">
                            <td className="px-4 py-3">
                              <span className="text-[12px] text-zinc-500 font-mono">
                                {new Date(p.openedAt).toLocaleDateString()}
                              </span>
                            </td>
                            <td className="px-4 py-3 max-w-[200px]">
                              <div className="text-[13px] text-zinc-200 font-medium leading-snug line-clamp-1">{p.event}</div>
                              <div className="mt-0.5"><CategoryBadge category={p.category} /></div>
                            </td>
                            <td className="px-4 py-3 text-center">
                              <div className="flex flex-col items-center gap-0.5">
                                <VenueBadge venue={p.buyYesVenue} />
                                <span className="font-mono text-emerald-400 text-[12px] tabular-nums">{(p.buyYesPrice * 100).toFixed(1)}&cent;</span>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-center">
                              <div className="flex flex-col items-center gap-0.5">
                                <VenueBadge venue={p.buyNoVenue} />
                                <span className="font-mono text-red-400 text-[12px] tabular-nums">{(p.buyNoPrice * 100).toFixed(1)}&cent;</span>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <span className="font-mono tabular-nums text-[13px] text-zinc-300">{p.contracts}</span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <span className="font-mono tabular-nums text-[13px] text-zinc-400">${p.costUsd.toFixed(2)}</span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <span className="font-mono tabular-nums text-[13px] font-semibold text-emerald-400">
                                +${p.expectedProfitUsd.toFixed(2)}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <div className="flex flex-col items-end gap-0.5">
                                <span className="text-[12px] text-zinc-400 font-mono">
                                  {new Date(p.endDate).toLocaleDateString()}
                                </span>
                                <span className={`text-[10px] font-semibold ${
                                  p.daysToExpiry <= 3 ? "text-red-400" : p.daysToExpiry <= 7 ? "text-amber-400" : "text-zinc-500"
                                }`}>
                                  {p.daysToExpiry}d left
                                </span>
                              </div>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Resolved Trades */}
              <div>
                <h3 className="text-sm font-semibold text-zinc-300 mb-2">
                  Resolved Trades
                  <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded-md bg-zinc-800 text-zinc-500">
                    {accountData.data?.resolvedTrades.length ?? 0}
                  </span>
                </h3>
                <div className="glass-card rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/[0.06]">
                        <th className="px-4 py-3 text-left text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Resolved</th>
                        <th className="px-4 py-3 text-left text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Event</th>
                        <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Contracts</th>
                        <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Cost</th>
                        <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Payout</th>
                        <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Profit</th>
                        <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Hold</th>
                        <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Ann. ROI</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(accountData.data?.resolvedTrades ?? []).length === 0 ? (
                        <tr>
                          <td colSpan={8} className="px-4 py-10 text-center text-zinc-500 text-sm">
                            No resolved trades yet — positions settle on their end date
                          </td>
                        </tr>
                      ) : (
                        (accountData.data?.resolvedTrades ?? []).map((t) => (
                          <tr key={t.id} className="data-row border-b border-white/[0.03] last:border-0">
                            <td className="px-4 py-3">
                              <span className="text-[12px] text-zinc-500 font-mono">
                                {new Date(t.resolvedAt).toLocaleDateString()}
                              </span>
                            </td>
                            <td className="px-4 py-3 max-w-[200px]">
                              <div className="text-[13px] text-zinc-200 font-medium leading-snug line-clamp-1">{t.event}</div>
                              <div className="mt-0.5"><CategoryBadge category={t.category} /></div>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <span className="font-mono tabular-nums text-[13px] text-zinc-300">{t.contracts}</span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <span className="font-mono tabular-nums text-[13px] text-zinc-400">${t.costUsd.toFixed(2)}</span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <span className="font-mono tabular-nums text-[13px] text-zinc-300">${t.payoutUsd.toFixed(2)}</span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <span className={`font-mono tabular-nums text-[13px] font-semibold ${
                                t.profitUsd > 0 ? "text-emerald-400" : "text-red-400"
                              }`}>
                                {t.profitUsd >= 0 ? "+" : ""}${t.profitUsd.toFixed(2)}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <span className="font-mono tabular-nums text-[13px] text-zinc-400">{t.holdDays}d</span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <span className={`font-mono tabular-nums text-[13px] font-semibold ${
                                t.annualizedRoi > 0 ? "text-emerald-400" : "text-red-400"
                              }`}>
                                {(t.annualizedRoi * 100).toFixed(1)}%
                              </span>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* ──── EXECUTION TAB ──── */}
          {tab === "exec" && (
            <div className="space-y-5">

              {/* ── A. Execution Controls ── */}
              <div className="glass-card rounded-xl p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-zinc-300">Execution Controls</h3>
                  {runtimeData.data && (
                    <span className="text-[10px] text-zinc-600 font-mono">
                      Updated {new Date(runtimeData.data.updatedAt).toLocaleTimeString()}
                    </span>
                  )}
                </div>

                {/* Mode Toggle */}
                <div className="flex items-center gap-3">
                  <span className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold w-16">Mode</span>
                  <div className="flex gap-1 bg-zinc-900 rounded-lg p-0.5">
                    <button
                      onClick={() => handleModeSwitch("paper")}
                      className={`px-4 py-1.5 rounded-md text-[12px] font-semibold transition-all ${
                        runtimeData.data?.mode === "paper"
                          ? "bg-amber-500/15 text-amber-400 shadow-inner"
                          : "text-zinc-500 hover:text-zinc-300"
                      }`}
                    >
                      Paper
                    </button>
                    <button
                      onClick={() => handleModeSwitch("live")}
                      className={`px-4 py-1.5 rounded-md text-[12px] font-semibold transition-all ${
                        runtimeData.data?.mode === "live"
                          ? "bg-[#CC0035]/15 text-[#ff3d6a] shadow-inner"
                          : "text-zinc-500 hover:text-zinc-300"
                      }`}
                    >
                      Live
                    </button>
                  </div>
                  {runtimeData.data?.mode === "live" && (
                    <span className="px-2 py-0.5 rounded text-[9px] font-bold tracking-wider bg-[#CC0035]/15 text-[#CC0035] border border-[#CC0035]/25 animate-pulse">
                      LIVE MODE
                    </span>
                  )}
                </div>

                {/* Verified Only Toggle */}
                <div className="flex items-center gap-3">
                  <span className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold w-16">Source</span>
                  <div className="flex gap-1 bg-zinc-900 rounded-lg p-0.5">
                    <button
                      onClick={() => { if (runtimeData.data?.verifiedOnly) handleToggleVerifiedOnly(); }}
                      className={`px-4 py-1.5 rounded-md text-[12px] font-semibold transition-all ${
                        !runtimeData.data?.verifiedOnly
                          ? "bg-violet-500/15 text-violet-400 shadow-inner"
                          : "text-zinc-500 hover:text-zinc-300"
                      }`}
                    >
                      All Pairs
                    </button>
                    <button
                      onClick={() => { if (!runtimeData.data?.verifiedOnly) handleToggleVerifiedOnly(); }}
                      className={`px-4 py-1.5 rounded-md text-[12px] font-semibold transition-all ${
                        runtimeData.data?.verifiedOnly
                          ? "bg-emerald-500/15 text-emerald-400 shadow-inner"
                          : "text-zinc-500 hover:text-zinc-300"
                      }`}
                    >
                      Verified Only
                    </button>
                  </div>
                  {runtimeData.data?.verifiedOnly && (
                    <span className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[9px] font-bold tracking-wider bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                      </svg>
                      MANUAL ONLY
                    </span>
                  )}
                  {!runtimeData.data?.verifiedOnly && (
                    <span className="text-[10px] text-zinc-600">
                      Trading from all AI-matched pairs
                    </span>
                  )}
                </div>

                {/* Verified pair count */}
                {runtimeData.data?.verifiedOnly && (
                  <div className="flex items-center gap-2 pl-[calc(4rem+0.75rem)]">
                    <span className="text-[11px] text-zinc-500">
                      {verifiedPairKeys.size} pair{verifiedPairKeys.size !== 1 ? "s" : ""} manually verified
                    </span>
                    {verifiedPairKeys.size === 0 && (
                      <span className="text-[10px] text-amber-400">
                        — go to the Arb tab and check pairs to verify them
                      </span>
                    )}
                  </div>
                )}

                {/* ARM LIVE Controls */}
                {runtimeData.data?.mode === "live" && (
                  <div className="space-y-3 border-t border-white/[0.06] pt-4">
                    <div className="flex items-center gap-3">
                      <span className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold w-16">Arm</span>
                      {!runtimeData.data?.armLive ? (
                        <button
                          onClick={handleArmLive}
                          className="px-4 py-1.5 rounded-lg text-[12px] font-bold bg-[#CC0035]/10 text-[#CC0035] border border-[#CC0035]/25 hover:bg-[#CC0035]/20 transition-all"
                        >
                          ARM LIVE
                        </button>
                      ) : (
                        <div className="flex items-center gap-3">
                          <span className="flex items-center gap-2">
                            <span className="relative flex h-3 w-3">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                              <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500"></span>
                            </span>
                            <span className="text-[12px] font-bold text-red-400">ARMED</span>
                          </span>
                          <button
                            onClick={handleDisarmLive}
                            className="px-3 py-1 rounded-lg text-[11px] font-semibold bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 transition-all"
                          >
                            Disarm
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Token display when armed */}
                    {runtimeData.data?.armLive && armToken && (
                      <div className="bg-zinc-900/50 rounded-lg p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">Confirmation Token</span>
                          {runtimeData.data.tokenExpiresAt && (
                            <span className="text-[10px] text-red-400 font-mono">
                              Expires {new Date(runtimeData.data.tokenExpiresAt).toLocaleTimeString()}
                            </span>
                          )}
                        </div>
                        <div className="font-mono text-[13px] text-amber-400 bg-zinc-950 rounded px-3 py-2 select-all break-all">
                          {armToken}
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            placeholder="Type token to confirm..."
                            value={typedConfirm}
                            onChange={(e) => setTypedConfirm(e.target.value)}
                            className="flex-1 px-3 py-1.5 rounded-lg bg-zinc-950 border border-zinc-700 text-[12px] text-zinc-200 font-mono placeholder:text-zinc-600 focus:outline-none focus:border-[#CC0035]/50"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Execute Button */}
                <div className="border-t border-white/[0.06] pt-4 flex items-center gap-4">
                  <button
                    onClick={handleExecute}
                    disabled={
                      executing ||
                      (runtimeData.data?.mode === "live" && (!runtimeData.data?.armLive || !typedConfirm))
                    }
                    className={`px-6 py-2 rounded-lg text-[13px] font-bold transition-all ${
                      executing
                        ? "bg-zinc-800 text-zinc-500 cursor-wait"
                        : runtimeData.data?.mode === "live"
                        ? "bg-[#CC0035] text-white hover:bg-[#CC0035]/90 disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed"
                        : "bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/25 disabled:opacity-40"
                    }`}
                  >
                    {executing ? (
                      <span className="flex items-center gap-2">
                        <span className="w-4 h-4 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
                        Executing...
                      </span>
                    ) : runtimeData.data?.mode === "live" ? (
                      "Execute LIVE"
                    ) : (
                      "Execute Paper"
                    )}
                  </button>

                  {/* Tradable count */}
                  {(() => {
                    const isVO = runtimeData.data?.verifiedOnly ?? false;
                    const tradable = (arbData.data?.arbs ?? []).filter(
                      (a) => !!(a.contracts && a.contracts > 0 && a.edgeDollar && a.edgeDollar > 0)
                    );
                    return (
                      <span className="text-[11px] text-zinc-500">
                        {tradable.length} tradable arb{tradable.length !== 1 ? "s" : ""} queued
                        {isVO && <span className="text-emerald-400/70 ml-1">(manual pairs)</span>}
                      </span>
                    );
                  })()}
                </div>

                {/* Execution Result */}
                {executionResult && (
                  <div className={`rounded-lg p-3 text-[12px] font-mono ${
                    executionResult.error
                      ? "bg-red-500/10 border border-red-500/20 text-red-400"
                      : "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400"
                  }`}>
                    {executionResult.error ? (
                      <span>Error: {executionResult.error}</span>
                    ) : (
                      <div className="space-y-1">
                        <div>Cycle: <span className="text-zinc-300">{executionResult.cycleId}</span></div>
                        <div>Mode: <span className="text-zinc-300">{executionResult.mode}</span></div>
                        {executionResult.results && (
                          <div>Results: <span className="text-zinc-300">{executionResult.results.length} order(s)</span></div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* ── B. Risk Status Card ── */}
              <div className="glass-card rounded-xl p-5 space-y-4">
                <h3 className="text-sm font-semibold text-zinc-300">Risk Status</h3>
                <div className="grid grid-cols-4 gap-4">
                  {/* Circuit Breaker */}
                  <div className="flex flex-col items-center gap-2">
                    <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">Circuit Breaker</span>
                    <div className="flex items-center gap-2">
                      <span className={`w-3 h-3 rounded-full ${
                        riskData.data?.circuitBreakerActive ? "bg-red-500 animate-pulse" : "bg-emerald-500"
                      }`} />
                      <span className={`text-sm font-bold ${
                        riskData.data?.circuitBreakerActive ? "text-red-400" : "text-emerald-400"
                      }`}>
                        {riskData.data?.circuitBreakerActive ? "TRIPPED" : "OK"}
                      </span>
                    </div>
                  </div>

                  {/* Exposure */}
                  <div className="flex flex-col gap-2">
                    <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold text-center">Exposure</span>
                    <div className="space-y-1">
                      <div className="flex justify-between text-[10px] font-mono">
                        <span className="text-zinc-400">${(riskData.data?.currentExposure ?? 0).toFixed(0)}</span>
                        <span className="text-zinc-600">${(riskData.data?.maxTotalExposure ?? 0).toFixed(0)}</span>
                      </div>
                      <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${
                            (riskData.data?.currentExposure ?? 0) / (riskData.data?.maxTotalExposure || 1) > 0.8
                              ? "bg-red-500" : "bg-emerald-500"
                          }`}
                          style={{ width: `${Math.min(100, ((riskData.data?.currentExposure ?? 0) / (riskData.data?.maxTotalExposure || 1)) * 100)}%` }}
                        />
                      </div>
                    </div>
                  </div>

                  {/* Drawdown */}
                  <div className="flex flex-col gap-2">
                    <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold text-center">Drawdown</span>
                    <div className="space-y-1">
                      <div className="flex justify-between text-[10px] font-mono">
                        <span className="text-zinc-400">{((riskData.data?.currentDrawdownPct ?? 0) * 100).toFixed(1)}%</span>
                        <span className="text-zinc-600">{((riskData.data?.maxDrawdownPct ?? 0) * 100).toFixed(1)}%</span>
                      </div>
                      <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${
                            (riskData.data?.currentDrawdownPct ?? 0) / (riskData.data?.maxDrawdownPct || 1) > 0.8
                              ? "bg-red-500" : "bg-amber-500"
                          }`}
                          style={{ width: `${Math.min(100, ((riskData.data?.currentDrawdownPct ?? 0) / (riskData.data?.maxDrawdownPct || 1)) * 100)}%` }}
                        />
                      </div>
                    </div>
                  </div>

                  {/* Position Count */}
                  <div className="flex flex-col items-center gap-2">
                    <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">Positions</span>
                    <span className="text-xl font-bold font-mono tabular-nums text-zinc-200">
                      {riskData.data?.openPositionCount ?? 0}
                    </span>
                    <span className="text-[10px] text-zinc-600 font-mono">
                      max {riskData.data?.maxPositionsPerPair ?? 0}/pair
                    </span>
                  </div>
                </div>
              </div>

              {/* ── C. V2 Portfolio Summary ── */}
              <div className="grid grid-cols-5 gap-3">
                {[
                  {
                    label: "Total Value",
                    value: `$${(v2Portfolio.data?.totalValue ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                    accent: "text-zinc-200",
                  },
                  {
                    label: "Total Cost",
                    value: `$${(v2Portfolio.data?.totalCost ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                    accent: "text-zinc-400",
                  },
                  {
                    label: "Unrealized P&L",
                    value: `${(v2Portfolio.data?.totalUnrealizedPnl ?? 0) >= 0 ? "+" : ""}$${(v2Portfolio.data?.totalUnrealizedPnl ?? 0).toFixed(2)}`,
                    accent: (v2Portfolio.data?.totalUnrealizedPnl ?? 0) >= 0 ? "text-emerald-400" : "text-red-400",
                  },
                  {
                    label: "Realized P&L",
                    value: `${(v2Portfolio.data?.totalRealizedPnl ?? 0) >= 0 ? "+" : ""}$${(v2Portfolio.data?.totalRealizedPnl ?? 0).toFixed(2)}`,
                    accent: (v2Portfolio.data?.totalRealizedPnl ?? 0) >= 0 ? "text-emerald-400" : "text-red-400",
                  },
                  {
                    label: "Total P&L",
                    value: `${(v2Portfolio.data?.totalPnl ?? 0) >= 0 ? "+" : ""}$${(v2Portfolio.data?.totalPnl ?? 0).toFixed(2)}`,
                    accent: (v2Portfolio.data?.totalPnl ?? 0) >= 0 ? "text-emerald-400" : "text-red-400",
                  },
                ].map((stat) => (
                  <div
                    key={stat.label}
                    className="glass-card rounded-xl p-4 flex flex-col items-center gap-1"
                  >
                    <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">
                      {stat.label}
                    </span>
                    <span className={`text-lg font-bold font-mono tabular-nums ${stat.accent}`}>
                      {stat.value}
                    </span>
                  </div>
                ))}
              </div>

              {/* ── D. V2 Positions Table ── */}
              <div>
                <h3 className="text-sm font-semibold text-zinc-300 mb-2">
                  Open Positions (V2)
                  <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded-md bg-amber-500/10 text-amber-400 border border-amber-500/20">
                    {v2Positions.data?.length ?? 0}
                  </span>
                </h3>
                <div className="glass-card rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/[0.06]">
                        <th className="px-4 py-3 text-left text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Pair</th>
                        <th className="px-4 py-3 text-center text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Venue</th>
                        <th className="px-4 py-3 text-center text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Side</th>
                        <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Contracts</th>
                        <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Entry</th>
                        <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Current</th>
                        <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Unreal. P&L</th>
                        <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Opened</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(v2Positions.data ?? []).length === 0 ? (
                        <tr>
                          <td colSpan={8} className="px-4 py-10 text-center text-zinc-500 text-sm">
                            No open V2 positions
                          </td>
                        </tr>
                      ) : (
                        (v2Positions.data ?? []).map((pos, i) => (
                          <tr key={`${pos.pairId}-${pos.venue}-${i}`} className="data-row border-b border-white/[0.03] last:border-0">
                            <td className="px-4 py-3 max-w-[200px]">
                              <div className="text-[13px] text-zinc-200 font-medium leading-snug line-clamp-1 font-mono">
                                {pos.pairId}
                              </div>
                              <div className="flex items-center gap-2 mt-0.5">
                                <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider ${
                                  pos.status === "open"
                                    ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/25"
                                    : "bg-zinc-700/30 text-zinc-500 border border-zinc-600/30"
                                }`}>{pos.status.toUpperCase()}</span>
                                <span className="text-[9px] text-zinc-600">{pos.source}</span>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-center">
                              <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider ${
                                pos.venue === "kalshi"
                                  ? "bg-cyan-500/15 text-cyan-400 border border-cyan-500/25"
                                  : "bg-violet-500/15 text-violet-400 border border-violet-500/25"
                              }`}>
                                {pos.venue === "kalshi" ? "Kalshi" : "Poly"}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-center">
                              <span className={`text-[12px] font-semibold ${
                                pos.side === "yes" ? "text-emerald-400" : "text-red-400"
                              }`}>
                                {pos.side.toUpperCase()}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <span className="font-mono tabular-nums text-[13px] text-zinc-300">{pos.contracts}</span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <span className="font-mono tabular-nums text-[13px] text-zinc-400">
                                {(pos.avgEntryPrice * 100).toFixed(1)}&cent;
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <span className="font-mono tabular-nums text-[13px] text-zinc-300">
                                {(pos.currentPrice * 100).toFixed(1)}&cent;
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <span className={`font-mono tabular-nums text-[13px] font-semibold ${
                                pos.unrealizedPnl >= 0 ? "text-emerald-400" : "text-red-400"
                              }`}>
                                {pos.unrealizedPnl >= 0 ? "+" : ""}${pos.unrealizedPnl.toFixed(2)}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <span className="text-[12px] text-zinc-500 font-mono">
                                {new Date(pos.openedAt).toLocaleDateString()}
                              </span>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* ── E. Recent Orders Table ── */}
              <div>
                <h3 className="text-sm font-semibold text-zinc-300 mb-2">
                  Recent Orders
                  <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded-md bg-zinc-800 text-zinc-500">
                    {v2Orders.data?.length ?? 0}
                  </span>
                </h3>
                <div className="glass-card rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/[0.06]">
                        <th className="px-4 py-3 text-left text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">ID</th>
                        <th className="px-4 py-3 text-left text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Cycle</th>
                        <th className="px-4 py-3 text-left text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Pair</th>
                        <th className="px-4 py-3 text-center text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Venue</th>
                        <th className="px-4 py-3 text-center text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Side</th>
                        <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Contracts</th>
                        <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Price</th>
                        <th className="px-4 py-3 text-center text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Status</th>
                        <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(v2Orders.data ?? []).length === 0 ? (
                        <tr>
                          <td colSpan={9} className="px-4 py-10 text-center text-zinc-500 text-sm">
                            No orders yet
                          </td>
                        </tr>
                      ) : (
                        (v2Orders.data ?? []).map((order) => (
                          <tr key={order.id} className="data-row border-b border-white/[0.03] last:border-0">
                            <td className="px-4 py-3">
                              <span className="font-mono text-[12px] text-zinc-500">{order.id}</span>
                            </td>
                            <td className="px-4 py-3">
                              <span className="font-mono text-[11px] text-zinc-500 truncate max-w-[80px] block">
                                {order.cycleId.slice(0, 8)}
                              </span>
                            </td>
                            <td className="px-4 py-3 max-w-[160px]">
                              <span className="text-[12px] text-zinc-300 font-mono line-clamp-1">{order.pairId}</span>
                            </td>
                            <td className="px-4 py-3 text-center">
                              <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider ${
                                order.venue.toLowerCase() === "kalshi"
                                  ? "bg-cyan-500/15 text-cyan-400 border border-cyan-500/25"
                                  : "bg-violet-500/15 text-violet-400 border border-violet-500/25"
                              }`}>
                                {order.venue}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-center">
                              <span className={`text-[12px] font-semibold ${
                                order.side.toLowerCase() === "yes" ? "text-emerald-400" : "text-red-400"
                              }`}>
                                {order.side.toUpperCase()}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <span className="font-mono tabular-nums text-[13px] text-zinc-300">{order.contracts}</span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <span className="font-mono tabular-nums text-[13px] text-zinc-400">
                                {(order.price * 100).toFixed(1)}&cent;
                              </span>
                            </td>
                            <td className="px-4 py-3 text-center">
                              <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider ${
                                order.status === "filled"
                                  ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/25"
                                  : order.status === "pending"
                                  ? "bg-amber-500/15 text-amber-400 border border-amber-500/25"
                                  : order.status === "rejected" || order.status === "failed"
                                  ? "bg-red-500/15 text-red-400 border border-red-500/25"
                                  : "bg-zinc-700/30 text-zinc-500 border border-zinc-600/30"
                              }`}>
                                {order.status.toUpperCase()}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <span className="text-[12px] text-zinc-500 font-mono">
                                {new Date(order.createdAt).toLocaleString()}
                              </span>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

            </div>
          )}
        </>
      )}
    </div>
  );
}
