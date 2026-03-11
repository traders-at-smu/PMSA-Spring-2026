import { useState, useEffect } from "react";
import { usePolling } from "../hooks/usePolling";

// ---- Types ----

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

interface ArbData {
  arbs: Array<{
    polymarketSlug: string;
    kalshiTicker: string;
    contracts?: number;
    edgeDollar?: number;
    edgePct?: number;
    annualizedEdge?: number;
    kpTotalCost?: number;
    strategy?: string;
    buyYesVenue?: "POLYMARKET" | "KALSHI";
    buyYesPrice?: number;
    buyNoPrice?: number;
  }>;
}

interface ManualPair {
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
  resolutionTimeUtc?: string;
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

interface PaperAccountState {
  startingBalance: number;
  availableBalance: number;
  lockedCapital: number;
  portfolioValue: number;
  unrealizedProfit: number;
  realizedProfit: number;
  totalFees: number;
  openPositionCount: number;
  resolvedTradeCount: number;
  winRate: number;
  annualizedRoi: number;
  avgHoldDays: number;
  openPositions: OpenPosition[];
}

// ---- Helpers ----

function fmtDays(endDate: string): string {
  const ms = Date.parse(endDate) - Date.now();
  if (!Number.isFinite(ms)) return "—";
  const days = ms / 86_400_000;
  if (days < 0) return "expired";
  if (days < 1) return `${Math.round(days * 24)}h`;
  return `${Math.round(days)}d`;
}

function estimatedArr(pos: OpenPosition): number {
  const endMs = Date.parse(pos.endDate);
  if (!Number.isFinite(endMs)) return 0;
  const holdDays = Math.max(0.5, (endMs - Date.parse(pos.openedAt)) / 86_400_000);
  const roi = pos.costUsd > 0 ? pos.expectedProfitUsd / pos.costUsd : 0;
  return Math.pow(1 + roi, 365 / holdDays) - 1;
}

// ---- Component ----

export function ExecutionPanel({ paused }: { paused: boolean }) {
  const [armToken, setArmToken] = useState<string | null>(null);
  const [typedConfirm, setTypedConfirm] = useState("");
  const [executing, setExecuting] = useState(false);
  const [executionResult, setExecutionResult] = useState<any>(null);
  const [verifiedPairKeys, setVerifiedPairKeys] = useState<Set<string>>(new Set());
  const [manualPairs, setManualPairs] = useState<ManualPair[]>([]);
  const [loadingManualPairs, setLoadingManualPairs] = useState(false);

  const runtimeData = usePolling<RuntimeControlResponse>("/api/execution/runtime-control", 5_000, paused);
  const riskData = usePolling<RiskStatusResponse>("/api/risk/status", 10_000, paused);
  const v2Portfolio = usePolling<V2PortfolioSummary>("/api/portfolio/summary", 15_000, paused);
  const v2Positions = usePolling<V2Position[]>("/api/portfolio/positions", 15_000, paused);
  const v2Orders = usePolling<V2Order[]>("/api/orders?limit=50", 15_000, paused);
  const arbData = usePolling<ArbData>("/api/cross-platform/arbs", 30_000, paused);
  const accountData = usePolling<PaperAccountState>("/api/paper-account/state", 30_000, paused);

  // Fetch verified pair keys on mount
  useEffect(() => {
    fetch("/api/cross-platform/verified-pairs")
      .then((r) => r.json())
      .then((data) => setVerifiedPairKeys(new Set(data.keys || [])))
      .catch(() => {});
  }, []);

  // Load manual pairs when switching to manual mode
  useEffect(() => {
    if (runtimeData.data?.verifiedOnly) {
      setLoadingManualPairs(true);
      fetch("/api/cross-platform/pairs?filter=all")
        .then((r) => r.json())
        .then((data) => setManualPairs(data.pairs ?? []))
        .catch(() => {})
        .finally(() => setLoadingManualPairs(false));
    }
  }, [runtimeData.data?.verifiedOnly]);

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
      const tradableDecisions = (arbData.data?.arbs ?? [])
        .filter((a) => !!(a.contracts && a.contracts > 0 && a.edgeDollar && a.edgeDollar > 0))
        .map((a) => ({
          pairId: `${a.polymarketSlug}::${a.kalshiTicker}`,
          strategy: a.strategy ?? "BUY_KY_BUY_PN",
          contracts: a.contracts ?? 0,
          kpTotalCost: a.kpTotalCost ?? 0,
          edgeDollar: a.edgeDollar ?? 0,
          edgePct: a.edgePct ?? 0,
          annualizedEdge: a.annualizedEdge ?? 0,
          kalshiSide: (a.strategy ?? "").includes("KY") ? "yes" : "no",
          polymarketSide: (a.strategy ?? "").includes("PY") ? "yes" : "no",
          kalshiPrice: a.buyYesVenue === "KALSHI" ? (a.buyYesPrice ?? 0) : (a.buyNoPrice ?? 0),
          polymarketPrice: a.buyYesVenue === "POLYMARKET" ? (a.buyYesPrice ?? 0) : (a.buyNoPrice ?? 0),
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
      v2Portfolio.refetch();
      v2Positions.refetch();
      v2Orders.refetch();
      riskData.refetch();
    } catch (err) {
      setExecutionResult({ error: String(err) });
    }
    setExecuting(false);
  };

  const tradableArbs = (arbData.data?.arbs ?? []).filter(
    (a) => !!(a.contracts && a.contracts > 0 && a.edgeDollar && a.edgeDollar > 0)
  );
  const positions = accountData.data?.openPositions ?? [];

  return (
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

        {/* Source Toggle — AI vs Manual */}
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
              AI Pairs
            </button>
            <button
              onClick={() => { if (!runtimeData.data?.verifiedOnly) handleToggleVerifiedOnly(); }}
              className={`px-4 py-1.5 rounded-md text-[12px] font-semibold transition-all ${
                runtimeData.data?.verifiedOnly
                  ? "bg-emerald-500/15 text-emerald-400 shadow-inner"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              Manual
            </button>
          </div>
          {runtimeData.data?.verifiedOnly ? (
            <span className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[9px] font-bold tracking-wider bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
              MANUAL CSV PAIRS
            </span>
          ) : (
            <span className="text-[10px] text-zinc-600">Trading from all AI-matched pairs</span>
          )}
        </div>

        {/* Manual pairs list — shown when in manual mode */}
        {runtimeData.data?.verifiedOnly && (
          <div className="pl-[calc(4rem+0.75rem)] space-y-2">
            {loadingManualPairs ? (
              <span className="text-[11px] text-zinc-500">Loading pairs...</span>
            ) : manualPairs.length === 0 ? (
              <span className="text-[11px] text-amber-400">
                No pairs loaded — add pairs to the CSV/XLSX file and restart the server.
              </span>
            ) : (
              <div className="space-y-1">
                <span className="text-[11px] text-zinc-500">{manualPairs.length} pair{manualPairs.length !== 1 ? "s" : ""} loaded from CSV</span>
                <div className="max-h-40 overflow-y-auto space-y-1">
                  {manualPairs.map((p, i) => (
                    <div key={`${p.polymarketSlug}-${p.kalshiTicker}-${i}`} className="flex items-center justify-between px-2 py-1 rounded bg-zinc-900/60 border border-white/[0.04]">
                      <span className="text-[11px] text-zinc-300 truncate max-w-xs">{p.polymarketTitle || p.kalshiTitle || p.polymarketSlug}</span>
                      <div className="flex items-center gap-2 shrink-0 ml-2">
                        {p.hasArb && (
                          <span className="px-1 py-0.5 rounded text-[8px] font-bold tracking-wider bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">ARB</span>
                        )}
                        <span className="text-[10px] text-cyan-400/70 font-mono">{p.kalshiTicker}</span>
                        {p.resolutionTimeUtc && (
                          <span className="text-[10px] text-zinc-500 font-mono">
                            {new Date(p.resolutionTimeUtc).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
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
                <input
                  type="text"
                  placeholder="Type token to confirm..."
                  value={typedConfirm}
                  onChange={(e) => setTypedConfirm(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg bg-zinc-950 border border-zinc-700 text-[12px] text-zinc-200 font-mono placeholder:text-zinc-600 focus:outline-none focus:border-[#CC0035]/50"
                />
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

          <span className="text-[11px] text-zinc-500">
            {tradableArbs.length} tradable arb{tradableArbs.length !== 1 ? "s" : ""} queued
            {runtimeData.data?.verifiedOnly && <span className="text-emerald-400/70 ml-1">(manual pairs)</span>}
          </span>
        </div>

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

      {/* ── B. Risk Status ── */}
      <div className="glass-card rounded-xl p-5 space-y-4">
        <h3 className="text-sm font-semibold text-zinc-300">Risk Status</h3>
        <div className="grid grid-cols-4 gap-4">
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
          <div className="flex flex-col items-center gap-2">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">Positions</span>
            <span className="text-xl font-bold font-mono tabular-nums text-zinc-200">
              {riskData.data?.openPositionCount ?? 0}
            </span>
            <span className="text-[10px] text-zinc-600 font-mono">max {riskData.data?.maxPositionsPerPair ?? 0}/pair</span>
          </div>
        </div>
      </div>

      {/* ── C. Portfolio Summary ── */}
      <div className="grid grid-cols-5 gap-3">
        {[
          { label: "Total Value", value: `$${(v2Portfolio.data?.totalValue ?? 0).toFixed(2)}`, accent: "text-zinc-200" },
          { label: "Total Cost", value: `$${(v2Portfolio.data?.totalCost ?? 0).toFixed(2)}`, accent: "text-zinc-400" },
          { label: "Unrealized P&L", value: `${(v2Portfolio.data?.totalUnrealizedPnl ?? 0) >= 0 ? "+" : ""}$${(v2Portfolio.data?.totalUnrealizedPnl ?? 0).toFixed(2)}`, accent: (v2Portfolio.data?.totalUnrealizedPnl ?? 0) >= 0 ? "text-emerald-400" : "text-red-400" },
          { label: "Realized P&L", value: `${(v2Portfolio.data?.totalRealizedPnl ?? 0) >= 0 ? "+" : ""}$${(v2Portfolio.data?.totalRealizedPnl ?? 0).toFixed(2)}`, accent: (v2Portfolio.data?.totalRealizedPnl ?? 0) >= 0 ? "text-emerald-400" : "text-red-400" },
          { label: "Total P&L", value: `${(v2Portfolio.data?.totalPnl ?? 0) >= 0 ? "+" : ""}$${(v2Portfolio.data?.totalPnl ?? 0).toFixed(2)}`, accent: (v2Portfolio.data?.totalPnl ?? 0) >= 0 ? "text-emerald-400" : "text-red-400" },
        ].map((stat) => (
          <div key={stat.label} className="glass-card rounded-xl p-4 flex flex-col items-center gap-1">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">{stat.label}</span>
            <span className={`text-lg font-bold font-mono tabular-nums ${stat.accent}`}>{stat.value}</span>
          </div>
        ))}
      </div>

      {/* ── D. Holdings (Paper Account) ── */}
      <div className="glass-card rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
          <h3 className="text-[13px] font-semibold text-zinc-200">
            Open Positions
            {positions.length > 0 && (
              <span className="ml-2 text-[11px] text-zinc-500">({positions.length})</span>
            )}
          </h3>
          <div className="flex items-center gap-3">
            {accountData.data && (
              <span className="text-[10px] text-zinc-600 font-mono">
                Balance: ${accountData.data.availableBalance.toFixed(2)} available
              </span>
            )}
          </div>
        </div>
        {positions.length === 0 ? (
          <div className="px-4 py-10 text-center text-zinc-500 text-sm">No open positions</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/[0.06]">
                {["Event", "Venue", "Contracts", "Cost", "Exp. Profit", "Est. ARR", "Expires"].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const arr = estimatedArr(p);
                return (
                  <tr key={p.id} className="data-row border-b border-white/[0.03] last:border-0">
                    <td className="px-4 py-3 max-w-xs">
                      <div className="text-[13px] text-zinc-200 font-medium leading-snug line-clamp-2">{p.event}</div>
                      <div className="text-[11px] text-zinc-500 mt-0.5">{p.category}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-[11px] font-mono">
                        <span className="text-violet-400">YES@{p.buyYesVenue.slice(0, 4)}</span>
                        <span className="text-zinc-600 mx-1">·</span>
                        <span className="text-cyan-400">NO@{p.buyNoVenue.slice(0, 4)}</span>
                      </div>
                      <div className="text-[10px] text-zinc-500 mt-0.5">
                        {(p.buyYesPrice * 100).toFixed(1)}¢ + {(p.buyNoPrice * 100).toFixed(1)}¢
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono tabular-nums text-[13px] text-zinc-200">{p.contracts}</td>
                    <td className="px-4 py-3 font-mono tabular-nums text-[13px] text-zinc-200">${p.costUsd.toFixed(2)}</td>
                    <td className="px-4 py-3 font-mono tabular-nums text-[13px] text-emerald-400">${p.expectedProfitUsd.toFixed(2)}</td>
                    <td className={`px-4 py-3 font-mono tabular-nums text-[13px] ${
                      arr >= 0.5 ? "text-emerald-400" : arr >= 0.2 ? "text-amber-400" : "text-zinc-400"
                    }`}>
                      {(arr * 100).toFixed(1)}%
                    </td>
                    <td className="px-4 py-3 text-[12px] text-zinc-400 font-mono">{fmtDays(p.endDate)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── E. V2 Positions ── */}
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
                  <td colSpan={8} className="px-4 py-10 text-center text-zinc-500 text-sm">No open V2 positions</td>
                </tr>
              ) : (
                (v2Positions.data ?? []).map((pos, i) => (
                  <tr key={`${pos.pairId}-${pos.venue}-${i}`} className="data-row border-b border-white/[0.03] last:border-0">
                    <td className="px-4 py-3 max-w-[200px]">
                      <div className="text-[13px] text-zinc-200 font-medium leading-snug line-clamp-1 font-mono">{pos.pairId}</div>
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
                      <span className={`text-[12px] font-semibold ${pos.side === "yes" ? "text-emerald-400" : "text-red-400"}`}>
                        {pos.side.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="font-mono tabular-nums text-[13px] text-zinc-300">{pos.contracts}</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="font-mono tabular-nums text-[13px] text-zinc-400">{(pos.avgEntryPrice * 100).toFixed(1)}¢</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="font-mono tabular-nums text-[13px] text-zinc-300">{(pos.currentPrice * 100).toFixed(1)}¢</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={`font-mono tabular-nums text-[13px] font-semibold ${pos.unrealizedPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        {pos.unrealizedPnl >= 0 ? "+" : ""}${pos.unrealizedPnl.toFixed(2)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="text-[12px] text-zinc-500 font-mono">{new Date(pos.openedAt).toLocaleDateString()}</span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── F. Recent Orders ── */}
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
                  <td colSpan={8} className="px-4 py-10 text-center text-zinc-500 text-sm">No orders yet</td>
                </tr>
              ) : (
                (v2Orders.data ?? []).map((order) => (
                  <tr key={order.id} className="data-row border-b border-white/[0.03] last:border-0">
                    <td className="px-4 py-3">
                      <span className="font-mono text-[12px] text-zinc-500">{order.id}</span>
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
                      <span className={`text-[12px] font-semibold ${order.side.toLowerCase() === "yes" ? "text-emerald-400" : "text-red-400"}`}>
                        {order.side.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="font-mono tabular-nums text-[13px] text-zinc-300">{order.contracts}</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="font-mono tabular-nums text-[13px] text-zinc-400">{(order.price * 100).toFixed(1)}¢</span>
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
                      <span className="text-[12px] text-zinc-500 font-mono">{new Date(order.createdAt).toLocaleString()}</span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}
