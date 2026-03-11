import { useState, useEffect } from "react";
import { usePolling } from "../hooks/usePolling";

// ---- Types ----

interface EquitySnapshot {
  timestamp: string;
  balance: number;
  portfolioValue: number;
  lockedCapital: number;
  openPositions: number;
  cumulativeProfit: number;
}

interface TopArb {
  event: string;
  roi: number;
  netProfit: number;
  buyYesVenue: "POLYMARKET" | "KALSHI";
  buyYesPrice: number;
  buyNoVenue: "POLYMARKET" | "KALSHI";
  buyNoPrice: number;
  polymarketLiquidity: number;
  kalshiLiquidity: number;
  category: string;
}

interface RecentPosition {
  id: string;
  openedAt: string;
  endDate: string;
  event: string;
  contracts: number;
  costUsd: number;
  expectedProfitUsd: number;
  daysToExpiry: number;
}

interface RecentResolved {
  id: string;
  resolvedAt: string;
  event: string;
  contracts: number;
  profitUsd: number;
  holdDays: number;
  annualizedRoi: number;
}

interface OverviewData {
  marketsScanned: { polymarket: number; kalshi: number };
  matchedPairs: number;
  liveArbs: number;
  liveSignals: number;
  totalSignalsEver: number;
  avgSignalDuration: number;
  avgPeakRoi: number;
  topArbs: TopArb[];
  totalLiquidity: number;
  account: {
    availableBalance: number;
    portfolioValue: number;
    lockedCapital: number;
    unrealizedProfit: number;
    realizedProfit: number;
    startingBalance: number;
    totalTrades: number;
    openPositionCount: number;
    resolvedTradeCount: number;
    winRate: number;
    maxDrawdown: number;
    annualizedRoi: number;
    avgHoldDays: number;
    equityCurve: EquitySnapshot[];
    recentOpenPositions: RecentPosition[];
    recentResolvedTrades: RecentResolved[];
  };
  uptimeMs: number;
  timestamp: string;
}

// ---- Helpers ----

function formatUsd(n: number): string {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
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
      {isKalshi ? "KA" : "PM"}
    </span>
  );
}

// ---- Mini Equity Chart (sparkline) ----

function MiniEquityChart({ curve, startingBalance }: { curve: EquitySnapshot[]; startingBalance: number }) {
  if (curve.length < 2) {
    return (
      <div className="h-[120px] flex items-center justify-center">
        <span className="text-zinc-600 text-xs">Waiting for data...</span>
      </div>
    );
  }

  const W = 600;
  const H = 120;
  const PAD = 8;

  const values = curve.map((s) => s.portfolioValue ?? s.balance);
  const minVal = Math.min(...values, startingBalance) * 0.999;
  const maxVal = Math.max(...values, startingBalance) * 1.001;
  const range = maxVal - minVal || 1;

  const toX = (i: number) => PAD + ((W - PAD * 2) * i) / (curve.length - 1);
  const toY = (b: number) => PAD + (H - PAD * 2) * (1 - (b - minVal) / range);

  const points = values.map((v, i) => `${toX(i)},${toY(v)}`).join(" ");
  const areaPoints = `${toX(0)},${toY(minVal)} ${points} ${toX(values.length - 1)},${toY(minVal)}`;
  const currentVal = values[values.length - 1];
  const isUp = currentVal >= startingBalance;
  const baselineY = toY(startingBalance);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 120 }}>
      <defs>
        <linearGradient id="overviewEqFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={isUp ? "#10b981" : "#ef4444"} stopOpacity="0.3" />
          <stop offset="100%" stopColor={isUp ? "#10b981" : "#ef4444"} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {/* Baseline */}
      <line
        x1={PAD} y1={baselineY} x2={W - PAD} y2={baselineY}
        stroke="#3f3f46" strokeWidth="1" strokeDasharray="3 3"
      />
      {/* Area */}
      <polygon points={areaPoints} fill="url(#overviewEqFill)" />
      {/* Line */}
      <polyline
        points={points}
        fill="none"
        stroke={isUp ? "#10b981" : "#ef4444"}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* Current dot */}
      <circle
        cx={toX(values.length - 1)}
        cy={toY(currentVal)}
        r="3"
        fill={isUp ? "#10b981" : "#ef4444"}
      />
    </svg>
  );
}

// ---- Component ----

const BOOT_STEPS = [
  { label: "Connecting to Polymarket API", duration: 2000 },
  { label: "Connecting to Kalshi API", duration: 2500 },
  { label: "Fetching market data", duration: 5000 },
  { label: "Matching events across venues", duration: 3000 },
  { label: "Computing arbitrage opportunities", duration: 2000 },
  { label: "Building dashboard", duration: 1500 },
];

function BootLoader() {
  const [step, setStep] = useState(0);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let elapsed = 0;

    const totalDuration = BOOT_STEPS.reduce((s, st) => s + st.duration, 0);
    const interval = setInterval(() => {
      if (cancelled) return;
      elapsed += 80;
      const pct = Math.min((elapsed / totalDuration) * 100, 95);
      setProgress(pct);

      // Advance step based on cumulative duration
      let cumulative = 0;
      for (let i = 0; i < BOOT_STEPS.length; i++) {
        cumulative += BOOT_STEPS[i].duration;
        if (elapsed < cumulative) { setStep(i); break; }
      }
    }, 80);

    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const currentStep = BOOT_STEPS[step];

  return (
    <div className="space-y-6">
      {/* Main boot card */}
      <div className="glass-card rounded-xl p-8 max-w-xl mx-auto mt-8">
        {/* Logo area */}
        <div className="flex items-center gap-3 mb-6">
          <svg viewBox="0 0 60 28" fill="none" xmlns="http://www.w3.org/2000/svg" className="h-5 w-auto">
            <rect x="4" y="8" width="3" height="12" rx="1" fill="#CC0035" />
            <line x1="5.5" y1="4" x2="5.5" y2="8" stroke="#CC0035" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="5.5" y1="20" x2="5.5" y2="24" stroke="#CC0035" strokeWidth="1.5" strokeLinecap="round" />
            <rect x="14" y="4" width="3" height="16" rx="1" fill="#e4e4e7" />
            <line x1="15.5" y1="1" x2="15.5" y2="4" stroke="#e4e4e7" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="15.5" y1="20" x2="15.5" y2="26" stroke="#e4e4e7" strokeWidth="1.5" strokeLinecap="round" />
            <rect x="24" y="10" width="3" height="8" rx="1" fill="#CC0035" />
            <line x1="25.5" y1="6" x2="25.5" y2="10" stroke="#CC0035" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="25.5" y1="18" x2="25.5" y2="22" stroke="#CC0035" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span className="text-sm font-serif text-zinc-300">
            Traders<span className="text-[#CC0035]">@</span>SMU
          </span>
        </div>

        {/* Current step */}
        <div className="flex items-center gap-3 mb-4">
          <div className="w-4 h-4 border-2 border-zinc-700 border-t-[#CC0035] rounded-full animate-spin shrink-0" />
          <span className="text-[13px] text-zinc-300 font-medium">{currentStep.label}</span>
        </div>

        {/* Progress bar */}
        <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden mb-3">
          <div
            className="h-full rounded-full bg-gradient-to-r from-[#CC0035] to-[#ff3d6a] transition-all duration-300 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>

        {/* Step list */}
        <div className="space-y-1.5 mt-5">
          {BOOT_STEPS.map((s, i) => (
            <div key={i} className="flex items-center gap-2.5">
              {i < step ? (
                <svg className="w-3.5 h-3.5 text-emerald-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : i === step ? (
                <div className="w-3.5 h-3.5 flex items-center justify-center shrink-0">
                  <div className="w-2 h-2 rounded-full bg-[#CC0035] animate-pulse" />
                </div>
              ) : (
                <div className="w-3.5 h-3.5 flex items-center justify-center shrink-0">
                  <div className="w-1.5 h-1.5 rounded-full bg-zinc-700" />
                </div>
              )}
              <span className={`text-[11px] ${
                i < step ? "text-zinc-500" : i === step ? "text-zinc-300" : "text-zinc-600"
              }`}>
                {s.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Skeleton grid — hints at what's coming */}
      <div className="grid grid-cols-12 gap-4 opacity-30">
        <div className="col-span-4 glass-card rounded-xl p-6 h-40 animate-pulse" />
        <div className="col-span-5 glass-card rounded-xl p-4 h-40 animate-pulse" />
        <div className="col-span-3 glass-card rounded-xl p-5 h-40 animate-pulse" />
      </div>
    </div>
  );
}

export function OverviewPanel({ paused }: { paused: boolean }) {
  const { data, loading } = usePolling<OverviewData>("/api/overview", 30_000, paused);

  if (loading && !data) {
    return <BootLoader />;
  }

  if (!data) return null;

  const portfolioValue = data.account.portfolioValue;
  const returnPct = data.account.startingBalance > 0
    ? ((portfolioValue - data.account.startingBalance) / data.account.startingBalance) * 100
    : 0;
  const isUp = portfolioValue >= data.account.startingBalance;

  return (
    <div className="space-y-6">
      {/* ── Hero Stats ── */}
      <div className="grid grid-cols-12 gap-4">
        {/* Portfolio Value — large */}
        <div className="col-span-4 glass-card rounded-xl p-6 relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/[0.04] to-transparent" />
          <div className="relative">
            <div className="text-[10px] text-zinc-500 uppercase tracking-[0.15em] font-semibold mb-1">
              Paper Portfolio
            </div>
            <div className={`text-3xl font-bold font-mono tabular-nums tracking-tight ${isUp ? "text-emerald-400" : "text-red-400"}`}>
              ${portfolioValue.toLocaleString("en-US", { maximumFractionDigits: 0 })}
            </div>
            <div className="flex items-center gap-3 mt-2">
              <span className={`text-sm font-semibold font-mono tabular-nums ${isUp ? "text-emerald-400" : "text-red-400"}`}>
                {isUp ? "+" : ""}{returnPct.toFixed(2)}%
              </span>
              <span className="text-[11px] text-zinc-600">
                from $100K
              </span>
              {data.account.annualizedRoi !== 0 && (
                <span className={`text-[11px] font-mono tabular-nums ${data.account.annualizedRoi > 0 ? "text-emerald-400" : "text-red-400"}`}>
                  ({(data.account.annualizedRoi * 100).toFixed(1)}% ann.)
                </span>
              )}
            </div>
            <div className="flex items-center gap-4 mt-3 pt-3 border-t border-white/[0.05]">
              <div>
                <div className="text-[9px] text-zinc-600 uppercase tracking-wider">Open</div>
                <div className="text-sm font-mono tabular-nums text-amber-400">{data.account.openPositionCount}</div>
              </div>
              <div>
                <div className="text-[9px] text-zinc-600 uppercase tracking-wider">Resolved</div>
                <div className="text-sm font-mono tabular-nums text-zinc-300">{data.account.resolvedTradeCount}</div>
              </div>
              <div>
                <div className="text-[9px] text-zinc-600 uppercase tracking-wider">Win Rate</div>
                <div className="text-sm font-mono tabular-nums text-amber-400">{(data.account.winRate * 100).toFixed(0)}%</div>
              </div>
              <div>
                <div className="text-[9px] text-zinc-600 uppercase tracking-wider">Max DD</div>
                <div className="text-sm font-mono tabular-nums text-red-400">{(data.account.maxDrawdown * 100).toFixed(2)}%</div>
              </div>
            </div>
          </div>
        </div>

        {/* Equity Curve */}
        <div className="col-span-5 glass-card rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] text-zinc-500 uppercase tracking-[0.15em] font-semibold">
              Equity Curve
            </span>
            <span className={`text-xs font-mono tabular-nums ${isUp ? "text-emerald-400" : "text-red-400"}`}>
              {isUp ? "+" : ""}{formatUsd(data.account.realizedProfit)} realized
            </span>
          </div>
          <MiniEquityChart
            curve={data.account.equityCurve}
            startingBalance={data.account.startingBalance}
          />
        </div>

        {/* Scanner Status */}
        <div className="col-span-3 glass-card rounded-xl p-5 flex flex-col justify-between">
          <div>
            <div className="text-[10px] text-zinc-500 uppercase tracking-[0.15em] font-semibold mb-3">
              Scanner Status
            </div>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-zinc-500">Polymarket</span>
                <span className="text-sm font-mono tabular-nums text-violet-400">
                  {data.marketsScanned.polymarket.toLocaleString()}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-zinc-500">Kalshi</span>
                <span className="text-sm font-mono tabular-nums text-cyan-400">
                  {data.marketsScanned.kalshi.toLocaleString()}
                </span>
              </div>
              <div className="h-px bg-white/[0.05]" />
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-zinc-500">Matched Pairs</span>
                <span className="text-sm font-mono tabular-nums text-zinc-200">
                  {data.matchedPairs}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-zinc-500">Live Arbs</span>
                <span className={`text-sm font-mono tabular-nums font-semibold ${data.liveArbs > 0 ? "text-emerald-400" : "text-zinc-500"}`}>
                  {data.liveArbs}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 mt-3 pt-3 border-t border-white/[0.05]">
            <div className={`w-2 h-2 rounded-full ${paused ? "bg-amber-500" : "bg-emerald-400 status-live"}`} />
            <span className="text-[10px] text-zinc-500">
              Uptime {formatUptime(data.uptimeMs)}
            </span>
          </div>
        </div>
      </div>

      {/* ── Second Row: Signals + Top Opportunities ── */}
      <div className="grid grid-cols-12 gap-4">
        {/* Signal Intelligence */}
        <div className="col-span-3 glass-card rounded-xl p-5">
          <div className="text-[10px] text-zinc-500 uppercase tracking-[0.15em] font-semibold mb-4">
            Signal Intelligence
          </div>
          <div className="space-y-4">
            <div>
              <div className="text-2xl font-bold font-mono tabular-nums text-orange-400">
                {data.liveSignals}
              </div>
              <div className="text-[10px] text-zinc-500 mt-0.5">Active signals</div>
            </div>
            <div className="h-px bg-white/[0.05]" />
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs font-mono tabular-nums text-zinc-300">{data.totalSignalsEver}</div>
                <div className="text-[9px] text-zinc-600 mt-0.5">Total Detected</div>
              </div>
              <div>
                <div className="text-xs font-mono tabular-nums text-zinc-300">
                  {data.avgSignalDuration < 60
                    ? `${Math.round(data.avgSignalDuration)}s`
                    : `${Math.round(data.avgSignalDuration / 60)}m`}
                </div>
                <div className="text-[9px] text-zinc-600 mt-0.5">Avg Duration</div>
              </div>
              <div>
                <div className="text-xs font-mono tabular-nums text-emerald-400">
                  {(data.avgPeakRoi * 100).toFixed(1)}%
                </div>
                <div className="text-[9px] text-zinc-600 mt-0.5">Avg Peak ROI</div>
              </div>
              <div>
                <div className="text-xs font-mono tabular-nums text-zinc-300">
                  {formatUsd(data.totalLiquidity)}
                </div>
                <div className="text-[9px] text-zinc-600 mt-0.5">Total Liq.</div>
              </div>
            </div>
          </div>
        </div>

        {/* Top Opportunities */}
        <div className="col-span-5 glass-card rounded-xl p-5">
          <div className="text-[10px] text-zinc-500 uppercase tracking-[0.15em] font-semibold mb-3">
            Top Opportunities
          </div>
          {data.topArbs.length === 0 ? (
            <div className="py-8 text-center text-zinc-600 text-sm">
              No arbitrage opportunities currently detected
            </div>
          ) : (
            <div className="space-y-2.5">
              {data.topArbs.map((arb, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 p-3 rounded-lg bg-white/[0.02] border border-white/[0.04] hover:border-white/[0.08] transition-colors"
                >
                  {/* Rank */}
                  <div className={`w-6 h-6 rounded-md flex items-center justify-center text-[10px] font-bold ${
                    i === 0
                      ? "bg-gradient-to-br from-amber-400 to-orange-500 text-white"
                      : "bg-zinc-800 text-zinc-500"
                  }`}>
                    {i + 1}
                  </div>
                  {/* Event */}
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] text-zinc-200 font-medium leading-snug line-clamp-1">
                      {arb.event}
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[9px] text-zinc-600 uppercase font-semibold">{arb.category}</span>
                      <span className="text-[9px] text-zinc-700">|</span>
                      <span className="text-[9px] text-zinc-600">
                        Liq: {formatUsd((arb.polymarketLiquidity || 0) + (arb.kalshiLiquidity || 0))}
                      </span>
                    </div>
                  </div>
                  {/* Venues */}
                  <div className="flex items-center gap-1.5">
                    <div className="flex flex-col items-center gap-0.5">
                      <VenueBadge venue={arb.buyYesVenue} />
                      <span className="text-[10px] font-mono text-emerald-400 tabular-nums">
                        {(arb.buyYesPrice * 100).toFixed(0)}¢
                      </span>
                    </div>
                    <span className="text-zinc-700 text-[10px]">+</span>
                    <div className="flex flex-col items-center gap-0.5">
                      <VenueBadge venue={arb.buyNoVenue} />
                      <span className="text-[10px] font-mono text-red-400 tabular-nums">
                        {(arb.buyNoPrice * 100).toFixed(0)}¢
                      </span>
                    </div>
                  </div>
                  {/* ROI */}
                  <div className={`px-2.5 py-1 rounded-md text-[11px] font-bold tabular-nums ${
                    arb.roi > 0.03
                      ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/20"
                      : arb.roi > 0.01
                      ? "bg-amber-500/15 text-amber-400 border border-amber-500/20"
                      : "bg-zinc-800 text-zinc-400 border border-zinc-700"
                  }`}>
                    {(arb.roi * 100).toFixed(1)}%
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Open Positions */}
        <div className="col-span-4 glass-card rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[10px] text-zinc-500 uppercase tracking-[0.15em] font-semibold">
              Open Positions
            </span>
            {data.account.lockedCapital > 0 && (
              <span className="text-[10px] font-mono tabular-nums text-amber-400">
                {formatUsd(data.account.lockedCapital)} locked
              </span>
            )}
          </div>
          {data.account.recentOpenPositions.length === 0 ? (
            <div className="py-8 text-center text-zinc-600 text-sm">
              No open positions
            </div>
          ) : (
            <div className="space-y-2">
              {data.account.recentOpenPositions.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-3 p-2.5 rounded-lg bg-white/[0.02] border border-white/[0.03]"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] text-zinc-300 font-medium line-clamp-1">
                      {p.event}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[9px] text-zinc-600 font-mono">
                        {p.contracts} contracts
                      </span>
                      <span className="text-[9px] text-zinc-700">|</span>
                      <span className={`text-[9px] font-semibold ${
                        p.daysToExpiry <= 3 ? "text-red-400" : p.daysToExpiry <= 7 ? "text-amber-400" : "text-zinc-500"
                      }`}>
                        {p.daysToExpiry}d left
                      </span>
                    </div>
                  </div>
                  <span className="text-[12px] font-mono tabular-nums font-semibold text-emerald-400">
                    +${p.expectedProfitUsd.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Footer: System info ── */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-4 text-[10px] text-zinc-600">
          <span>Mode: <span className="text-amber-400 font-semibold">PAPER</span></span>
          <span>Max Trade: <span className="text-zinc-400">$100</span></span>
          <span>Starting Capital: <span className="text-zinc-400">$100,000</span></span>
        </div>
        <div className="text-[10px] text-zinc-600 font-mono tabular-nums">
          Last scan: {new Date(data.timestamp).toLocaleTimeString()}
        </div>
      </div>
    </div>
  );
}
