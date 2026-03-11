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
  kalshiFee?: number;
  polymarketFee?: number;
  strategy?: string;
  stopReason?: string;
  daysToResolution?: number;
  endDate?: string;
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

// ---- Demo Data removed — show empty state when no live arbs ----

// ---- Component ----

export function CrossPlatformPanel({ paused }: { paused: boolean }) {
  const [tab, setTab] = useState<"arb" | "pairs" | "signal">("arb");
  const [countdown, setCountdown] = useState(30);
  const [pairsFilter, setPairsFilter] = useState<"all" | "arb" | "no-arb">("all");
  const [now, setNow] = useState(Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const [notificationsOn, setNotificationsOn] = useState(false);
  const [lastNotifiedArbs, setLastNotifiedArbs] = useState<Set<string>>(new Set());
  const [telegramStatus, setTelegramStatus] = useState<{ configured: boolean; enabled: boolean; chatId: string } | null>(null);
  const [telegramTesting, setTelegramTesting] = useState(false);
  type SortCol = "event" | "buyYes" | "buyNo" | "resolves" | "contracts" | "totalProfit" | "fees" | "annEdge";
  const [sortCol, setSortCol] = useState<SortCol>("annEdge");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  function handleSort(col: SortCol) {
    if (sortCol === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("desc"); }
  }

  function sortArbs(list: CrossPlatformArb[]): CrossPlatformArb[] {
    return [...list].sort((a, b) => {
      let va = 0, vb = 0;
      if (sortCol === "event") return sortDir === "asc" ? a.event.localeCompare(b.event) : b.event.localeCompare(a.event);
      if (sortCol === "buyYes") { va = a.buyYesPrice; vb = b.buyYesPrice; }
      if (sortCol === "buyNo") { va = a.buyNoPrice; vb = b.buyNoPrice; }
      if (sortCol === "resolves") { va = a.daysToResolution ?? 9999; vb = b.daysToResolution ?? 9999; }
      if (sortCol === "contracts") { va = a.contracts ?? 0; vb = b.contracts ?? 0; }
      if (sortCol === "totalProfit") { va = a.edgeDollar ?? 0; vb = b.edgeDollar ?? 0; }
      if (sortCol === "fees") { va = (a.kalshiFee ?? 0) + (a.polymarketFee ?? 0); vb = (b.kalshiFee ?? 0) + (b.polymarketFee ?? 0); }
      if (sortCol === "annEdge") { va = a.annualizedEdge ?? 0; vb = b.annualizedEdge ?? 0; }
      return sortDir === "asc" ? va - vb : vb - va;
    });
  }
  const [verifiedPairKeys, setVerifiedPairKeys] = useState<Set<string>>(new Set());

  const arbData = usePolling<ArbResponse>("/api/cross-platform/arbs", 30_000, paused);
  const pairsData = usePolling<PairsResponse>(`/api/cross-platform/pairs?filter=all`, 30_000, paused);
  const signalData = usePolling<SignalResponse>("/api/cross-platform/signals", 30_000, paused);
  const runtimeData = usePolling<RuntimeControlResponse>("/api/execution/runtime-control", 10_000, paused);

  const handleForceRefresh = async () => {
    setRefreshing(true);
    try {
      await fetch("/api/cross-platform/refresh", { method: "POST" });
      arbData.refetch();
      pairsData.refetch();
      signalData.refetch();
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
      arbData.refetch();
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

  const liveArbs = arbData.data?.arbs ?? [];
  const arbs = liveArbs;
  const allPairs = pairsData.data?.pairs ?? [];
  const pairs = pairsFilter === "arb"
    ? allPairs.filter(p => p.hasArb)
    : pairsFilter === "no-arb"
    ? allPairs.filter(p => !p.hasArb)
    : allPairs;
  const matchedPairs = arbData.data?.matchedPairs ?? 0;
  const polyScanned = arbData.data?.polymarketsScanned ?? 0;
  const kalshiScanned = arbData.data?.kalshiMarketsScanned ?? 0;

  const tabs: { id: typeof tab; label: string; count: number }[] = [
    { id: "arb", label: "Arb", count: arbs.length },
    { id: "pairs", label: "Pairs", count: allPairs.length },
    { id: "signal", label: "Signal", count: signalData.data?.stats.currentLive ?? 0 },
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
                  <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Resolves</th>
                  <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Contracts</th>
                  <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Total Profit</th>
                  <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Fees</th>
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
                      <div className="h-4 w-16 bg-zinc-800 rounded animate-pulse ml-auto" />
                    </td>
                    <td className="px-4 py-4 text-right">
                      <div className="h-4 w-10 bg-zinc-800 rounded animate-pulse ml-auto" />
                    </td>
                    <td className="px-4 py-4 text-right">
                      <div className="h-4 w-14 bg-zinc-800 rounded animate-pulse ml-auto" />
                    </td>
                    <td className="px-4 py-4 text-right">
                      <div className="h-4 w-14 bg-zinc-800 rounded animate-pulse ml-auto" />
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
              {arbs.length === 0 && arbData.data != null && (
                <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-zinc-800/50 border border-white/[0.06]">
                  <span className="text-[12px] text-zinc-500">
                    No live arbitrage opportunities right now. The scanner is running — opportunities will appear here when found.
                  </span>
                </div>
              )}
              {arbs.length > 0 && (
              <div className="glass-card rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/[0.06]">
                    <th className="px-2 py-3 text-center text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold w-10" title="Manually verify this pair for trading">
                      <svg className="w-3.5 h-3.5 mx-auto text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
                    </th>
                    {([["event","Event","left"],["buyYes","Buy YES","center"],["buyNo","Buy NO","center"],["resolves","Resolves","right"],["contracts","Contracts","right"],["totalProfit","Total Profit","right"],["fees","Fees","right"],["annEdge","Ann. Edge","right"]] as [SortCol,string,string][]).map(([col, label, align]) => (
                      <th key={col} onClick={() => handleSort(col)} className={`px-4 py-3 text-${align} text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold cursor-pointer hover:text-zinc-300 select-none transition-colors`}>
                        <span className="inline-flex items-center gap-1 justify-${align}">
                          {label}
                          {sortCol === col ? (
                            <svg className="w-3 h-3 text-zinc-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              {sortDir === "desc" ? <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /> : <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />}
                            </svg>
                          ) : (
                            <svg className="w-3 h-3 text-zinc-700 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 9l4-4 4 4M8 15l4 4 4-4" /></svg>
                          )}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortArbs(arbs).map((arb, i) => {
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
                            {arb.polymarketUrl && (
                              <a href={arb.polymarketUrl} target="_blank" rel="noreferrer" className="text-[9px] text-violet-400/50 hover:text-violet-400 font-mono transition-colors" title="Open Polymarket">PM↗</a>
                            )}
                            {arb.kalshiUrl && (
                              <a href={arb.kalshiUrl} target="_blank" rel="noreferrer" className="text-[9px] text-cyan-400/50 hover:text-cyan-400 font-mono transition-colors" title="Open Kalshi">KA↗</a>
                            )}
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

                        {/* Resolves */}
                        <td className="px-4 py-3 text-right">
                          {arb.endDate ? (
                            <div className="flex flex-col items-end gap-0.5">
                              <span className="font-mono text-[12px] text-zinc-300 tabular-nums">
                                {new Date(arb.endDate).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" })}
                              </span>
                              {arb.daysToResolution != null && (
                                <span className={`text-[10px] font-mono tabular-nums ${
                                  arb.daysToResolution < 7 ? "text-amber-400" : "text-zinc-500"
                                }`}>
                                  {arb.daysToResolution < 1
                                    ? `${Math.round(arb.daysToResolution * 24)}h`
                                    : `${Math.round(arb.daysToResolution)}d`}
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="text-[11px] text-red-400/70 font-mono">no date</span>
                          )}
                        </td>

                        {/* Contracts */}
                        <td className="px-4 py-3 text-right">
                          <span className="font-mono tabular-nums text-[13px] text-zinc-300">
                            {arb.contracts ?? "\u2014"}
                          </span>
                        </td>

                        {/* Total Profit $ (depth-walked) */}
                        <td className="px-4 py-3 text-right">
                          {arb.edgeDollar != null ? (
                            <span className={`font-mono tabular-nums text-[13px] font-semibold ${
                              arb.edgeDollar > 0 ? "text-emerald-400" : "text-zinc-500"
                            }`}>
                              {arb.edgeDollar > 0 ? "+" : ""}${arb.edgeDollar.toFixed(2)}
                            </span>
                          ) : (
                            <span className="text-zinc-600">{"\u2014"}</span>
                          )}
                        </td>

                        {/* Fees */}
                        <td className="px-4 py-3 text-right">
                          {(arb.kalshiFee != null || arb.polymarketFee != null) ? (
                            <div className="flex flex-col items-end gap-0.5">
                              <span className="font-mono text-[11px] text-cyan-400/70 tabular-nums">
                                K: ${(arb.kalshiFee ?? 0).toFixed(2)}
                              </span>
                              <span className="font-mono text-[11px] text-violet-400/70 tabular-nums">
                                P: ${(arb.polymarketFee ?? 0).toFixed(2)}
                              </span>
                            </div>
                          ) : (
                            <span className="text-zinc-600">{"\u2014"}</span>
                          )}
                        </td>

                        {/* Ann. Edge % */}
                        <td className="px-4 py-3 text-right">
                          {arb.annualizedEdge != null && arb.annualizedEdge > 0 ? (
                            <span className={`px-2 py-0.5 rounded-md text-[11px] font-bold tabular-nums ${
                              arb.annualizedEdge > 0.5
                                ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/20"
                                : arb.annualizedEdge > 0.1
                                ? "bg-amber-500/15 text-amber-400 border border-amber-500/20"
                                : "bg-zinc-800 text-zinc-400 border border-zinc-700"
                            }`}>
                              {(arb.annualizedEdge * 100).toFixed(0)}%
                            </span>
                          ) : arb.endDate ? (
                            <span className="text-zinc-600 text-[11px]">0%</span>
                          ) : (
                            <span className="text-red-400/60 text-[10px] font-mono">no date</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
              )}
            </div>
          )}

          {/* ──── PAIRS TAB ──── */}
          {tab === "pairs" && (
            <div className="space-y-3">
              {/* Filter bar */}
              <div className="flex items-center gap-2">
                {(["all", "arb", "no-arb"] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setPairsFilter(f)}
                    className={`px-3 py-1 rounded-lg text-[11px] font-semibold transition-all ${
                      pairsFilter === f
                        ? "bg-[#CC0035]/15 text-[#ff3d6a] border border-[#CC0035]/20"
                        : "bg-zinc-800/60 text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    {f === "all" ? "All" : f === "arb" ? "Has Arb" : "No Arb"}
                  </button>
                ))}
                <span className="text-[11px] text-zinc-600 ml-1">
                  {pairs.length} / {allPairs.length} pairs
                </span>
                {pairsData.data?.source && (
                  <span className={`ml-1 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider ${
                    pairsData.data.source === "manual"
                      ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                      : "bg-violet-500/10 text-violet-400 border border-violet-500/20"
                  }`}>
                    {pairsData.data.source === "manual" ? "MANUAL" : "AI"}
                  </span>
                )}
              </div>

              {pairs.length === 0 ? (
                <div className="px-4 py-10 text-center text-zinc-500 text-sm glass-card rounded-xl">
                  No pairs to display
                </div>
              ) : (
                <div className="glass-card rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/[0.06]">
                        <th className="px-4 py-3 text-left text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Event</th>
                        <th className="px-4 py-3 text-center text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Poly YES</th>
                        <th className="px-4 py-3 text-center text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Poly NO</th>
                        <th className="px-4 py-3 text-center text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Kalshi YES</th>
                        <th className="px-4 py-3 text-center text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Kalshi NO</th>
                        <th className="px-4 py-3 text-center text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Arb</th>
                        <th className="px-4 py-3 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Match</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pairs.map((p, i) => (
                        <tr key={`${p.polymarketSlug}-${p.kalshiTicker}-${i}`} className="data-row border-b border-white/[0.03] last:border-0">
                          <td className="px-4 py-3 max-w-xs">
                            <div className="text-[13px] text-zinc-200 font-medium leading-snug line-clamp-2">
                              {p.polymarketTitle || p.kalshiTitle}
                            </div>
                            <div className="flex items-center gap-2 mt-1">
                              <CategoryBadge category={p.category} />
                              <a href={p.polymarketUrl} target="_blank" rel="noreferrer" className="text-[9px] text-violet-400/60 font-mono hover:text-violet-400 transition-colors">{p.polymarketSlug}</a>
                              <span className="text-zinc-700">·</span>
                              <a href={p.kalshiUrl} target="_blank" rel="noreferrer" className="text-[9px] text-cyan-400/60 font-mono hover:text-cyan-400 transition-colors">{p.kalshiTicker}</a>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <div className="flex flex-col items-center gap-0.5">
                              <span className="font-mono text-[12px] text-zinc-300 tabular-nums">
                                {p.polyYesBid > 0 ? `${(p.polyYesBid * 100).toFixed(1)}` : "—"}
                                <span className="text-zinc-600">/</span>
                                {p.polyYesAsk > 0 ? `${(p.polyYesAsk * 100).toFixed(1)}` : "—"}¢
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <div className="flex flex-col items-center gap-0.5">
                              <span className="font-mono text-[12px] text-zinc-500 tabular-nums">
                                {p.polyYesAsk > 0 ? `${((1 - p.polyYesAsk) * 100).toFixed(1)}` : "—"}
                                <span className="text-zinc-600">/</span>
                                {p.polyYesBid > 0 ? `${((1 - p.polyYesBid) * 100).toFixed(1)}` : "—"}¢
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <div className="flex flex-col items-center gap-0.5">
                              <span className="font-mono text-[12px] text-zinc-300 tabular-nums">
                                {p.kalshiYesBid > 0 ? `${(p.kalshiYesBid * 100).toFixed(1)}` : "—"}
                                <span className="text-zinc-600">/</span>
                                {p.kalshiYesAsk > 0 ? `${(p.kalshiYesAsk * 100).toFixed(1)}` : "—"}¢
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <div className="flex flex-col items-center gap-0.5">
                              <span className="font-mono text-[12px] text-zinc-500 tabular-nums">
                                {p.kalshiYesAsk > 0 ? `${((1 - p.kalshiYesAsk) * 100).toFixed(1)}` : "—"}
                                <span className="text-zinc-600">/</span>
                                {p.kalshiYesBid > 0 ? `${((1 - p.kalshiYesBid) * 100).toFixed(1)}` : "—"}¢
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-center">
                            {p.hasArb ? (
                              <span className="px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">ARB</span>
                            ) : (
                              <span className="text-zinc-700 text-[10px]">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <span className="font-mono text-[11px] text-zinc-500 tabular-nums">
                              {(p.similarityScore * 100).toFixed(0)}%
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

        </>
      )}
    </div>
  );
}
