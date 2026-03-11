import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePolling } from "../hooks/usePolling";

// ---- Types ----

type ExecutionMode = "PAPER" | "LIVE";
type PlanStatus = "READY" | "EXECUTED" | "FAILED" | "SKIPPED";
type PanelPhase = "bootstrapping" | "refreshing" | "ready" | "degraded";

interface ExecutionSettings {
  mode: ExecutionMode;
  autoExecute: boolean;
  bankrollUsd: number;
  minNetEdge: number;
  kalshiUseMakerFees: boolean;
}

interface TradePlan {
  id: string;
  venue: "POLYMARKET" | "KALSHI" | "CROSS";
  strategy: "BINARY_BUY_BOTH" | "EVENT_BUY_ALL_YES" | "CROSS_PLATFORM";
  title: string;
  contractUrl?: string;
  status: PlanStatus;
  executable: boolean;
  fillProb20s: number;
  expectedNetEdge: number;
  expectedNetProfitUsd: number;
  recommendedCapUsd: number;
  modelInputs: { snapshots: number };
  reason?: string;
}

interface ExecutionRecord {
  planId: string;
  timestamp: string;
  mode: ExecutionMode;
  status: "SUCCESS" | "FAILED" | "SKIPPED";
  message: string;
}

interface ExecutionState {
  settings: ExecutionSettings;
  modelEngine?: string;
  modelInvocation?: {
    lastInvocationAt: string | null;
    lastInvocationError: string | null;
  };
  plans: TradePlan[];
  history: ExecutionRecord[];
  paperPnlUsd: number;
  lastRefreshAt: string | null;
  refreshing: boolean;
  refreshSeq: number;
  refreshStartedAt?: string;
  refreshCompletedAt?: string;
  lastRefreshDurationMs?: number;
  refreshError?: string;
  liveReadiness: {
    polymarketReady: boolean;
    kalshiReady: boolean;
    reasons: string[];
  };
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
  endDate?: string;
  resolutionTimeUtc?: string;
  _source?: "manual" | "ai";
}

type PairSource = "manual" | "ai" | "both";

interface ScanStatus {
  lastScanAt: string | null;
  scanning: boolean;
  lastScanDurationMs: number;
  nextScanIn: number;
  matchedPairs: number;
  arbCount: number;
  embeddingEnabled: boolean;
  source: string;
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

const money = (n: number) =>
  n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function fmtDaysShort(endDate?: string): string {
  if (!endDate) return "--";
  const ms = Date.parse(endDate) - Date.now();
  if (!Number.isFinite(ms) || ms < 0) return "expired";
  const d = Math.ceil(ms / 86_400_000);
  if (d === 0) return "<1d";
  return `${d}d`;
}

function computeEdge(p: ManualPair): { edgePct: number; annualized: number; direction: string } {
  const cost1 = p.kalshiYesAsk > 0 && p.polyYesBid > 0
    ? p.kalshiYesAsk + (1 - p.polyYesBid) : 1;
  const cost2 = p.polyYesAsk > 0 && p.kalshiYesBid > 0
    ? p.polyYesAsk + (1 - p.kalshiYesBid) : 1;
  const useDir1 = cost1 <= cost2;
  const totalCost = useDir1 ? cost1 : cost2;
  if (totalCost >= 1) return { edgePct: 0, annualized: 0, direction: "--" };
  const edgePct = (1 - totalCost) / totalCost;
  const endMs = (p.endDate || p.resolutionTimeUtc) ? Date.parse(p.endDate || p.resolutionTimeUtc!) : NaN;
  const days = Number.isFinite(endMs) ? Math.max(0.001, (endMs - Date.now()) / 86_400_000) : 0;
  const annualized = days > 0 ? (edgePct * 365) / days : 0;
  const direction = useDir1 ? "K-YES / P-NO" : "P-YES / K-NO";
  return { edgePct, annualized, direction };
}

async function api<T>(url: string, init?: RequestInit, timeoutMs: number = 30_000): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      ...init,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed: ${res.status}`);
    }
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function toUserError(err: unknown): string {
  if (err instanceof DOMException && err.name === "AbortError") {
    return "Request timed out; backend may still be refreshing.";
  }
  if (err instanceof TypeError) {
    return `Dashboard API unreachable on ${window.location.origin}`;
  }
  if (err instanceof Error) return err.message;
  return "Unknown request error";
}

/* ── Collapsible Section ── */
function Section({
  title,
  badge,
  defaultOpen = true,
  children,
}: {
  title: string;
  badge?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-zinc-800/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-zinc-500 select-none">{open ? "▾" : "▸"}</span>
          <h3 className="text-sm font-medium text-zinc-200">{title}</h3>
          {badge && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-zinc-700/50 text-zinc-400">
              {badge}
            </span>
          )}
        </div>
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}

/* ── Main Panel ── */
export function ExecutionPanel({ paused }: { paused: boolean }) {
  // V2 execution state machine
  const [state, setState] = useState<ExecutionState | null>(null);
  const [phase, setPhase] = useState<PanelPhase>("bootstrapping");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const backoffRef = useRef(1000);
  const retryTimerRef = useRef<number | null>(null);

  // Legacy runtime controls (paper/live mode, arm-live, verified-only)
  const [armToken, setArmToken] = useState<string | null>(null);
  const [typedConfirm, setTypedConfirm] = useState("");
  const [executing, setExecuting] = useState(false);
  const [executionResult, setExecutionResult] = useState<any>(null);

  // Pair source & selection state
  const [pairSource, setPairSource] = useState<PairSource>("both");
  const [manualPairs, setManualPairs] = useState<ManualPair[]>([]);
  const [selectedPairs, setSelectedPairs] = useState<Set<string>>(new Set());
  const [pairsLoading, setPairsLoading] = useState(false);
  const [pairsError, setPairsError] = useState<string | null>(null);

  // Verified pairs tracking
  const [verifiedKeys, setVerifiedKeys] = useState<Set<string>>(new Set());

  // Scan status (lightweight polling)
  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null);
  const lastScanRef = useRef<string | null>(null);

  // Legacy polling hooks
  const runtimeData = usePolling<RuntimeControlResponse>("/api/execution/runtime-control", 5_000, paused);
  const riskData = usePolling<RiskStatusResponse>("/api/risk/status", 10_000, paused);
  const v2Portfolio = usePolling<V2PortfolioSummary>("/api/portfolio/summary", 15_000, paused);
  const v2Positions = usePolling<V2Position[]>("/api/portfolio/positions", 15_000, paused);
  const v2Orders = usePolling<V2Order[]>("/api/orders?limit=50", 15_000, paused);
  const arbData = usePolling<ArbData>("/api/cross-platform/arbs", 30_000, paused);
  const accountData = usePolling<PaperAccountState>("/api/paper-account/state", 30_000, paused);

  const clearRetry = () => {
    if (retryTimerRef.current) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  };

  const scheduleRetry = useCallback((fn: () => Promise<void>) => {
    clearRetry();
    const wait = backoffRef.current;
    backoffRef.current = Math.min(backoffRef.current * 2, 10_000);
    retryTimerRef.current = window.setTimeout(() => {
      void fn();
    }, wait);
  }, []);

  const loadState = useCallback(async () => {
    try {
      const next = await api<ExecutionState>("/api/arbitrage/execution/state", undefined, 30_000);
      setState(next);
      setError(null);
      backoffRef.current = 1000;
      setPhase(next.refreshing ? "refreshing" : "ready");
    } catch (err) {
      const message = toUserError(err);
      setError(message);
      setPhase((prev) => (state ? "degraded" : prev === "bootstrapping" ? "bootstrapping" : "degraded"));
      scheduleRetry(loadState);
    }
  }, [scheduleRetry, state]);

  const loadPairs = useCallback(async () => {
    setPairsLoading(true);
    try {
      const resp = await api<{ pairs: ManualPair[]; source: string }>(
        `/api/cross-platform/pairs?filter=all&source=${pairSource}`,
        undefined,
        20_000,
      );
      setManualPairs(resp.pairs || []);
      setPairsError(null);
    } catch (err) {
      setPairsError(toUserError(err));
    } finally {
      setPairsLoading(false);
    }
  }, [pairSource]);

  const loadScanStatus = useCallback(async () => {
    try {
      const status = await api<ScanStatus>("/api/cross-platform/status", undefined, 5_000);
      setScanStatus(status);
      if (status.lastScanAt && status.lastScanAt !== lastScanRef.current) {
        lastScanRef.current = status.lastScanAt;
        void loadPairs();
      }
    } catch {
      // Non-critical
    }
  }, [loadPairs]);

  const loadVerifiedKeys = useCallback(async () => {
    try {
      const resp = await api<{ keys: string[] }>("/api/cross-platform/verified-pairs", undefined, 5_000);
      setVerifiedKeys(new Set(resp.keys || []));
    } catch {
      // Non-critical
    }
  }, []);

  const toggleVerify = async (p: ManualPair) => {
    const vKey = `${p.polymarketSlug}::${p.kalshiTicker}`;
    const isVerified = verifiedKeys.has(vKey);
    try {
      const resp = await api<{ keys: string[] }>("/api/cross-platform/pairs/verify", {
        method: "POST",
        body: JSON.stringify({
          kalshiTicker: p.kalshiTicker,
          polymarketSlug: p.polymarketSlug,
          verified: !isVerified,
          label: p.polymarketTitle || p.kalshiTitle || "",
        }),
      });
      setVerifiedKeys(new Set(resp.keys || []));
    } catch (err) {
      setError(toUserError(err));
    }
  };

  useEffect(() => {
    if (paused) return;
    void loadState();
    void loadPairs();
    void loadScanStatus();
    void loadVerifiedKeys();
    const statePoll = window.setInterval(() => { void loadState(); }, 30_000);
    const statusPoll = window.setInterval(() => { void loadScanStatus(); }, 10_000);
    return () => {
      window.clearInterval(statePoll);
      window.clearInterval(statusPoll);
      clearRetry();
    };
  }, [paused, loadState, loadPairs, loadScanStatus]);

  const readyPlans = useMemo(() => state?.plans.filter((p) => p.status === "READY") ?? [], [state]);

  const updateSettings = async (patch: Partial<ExecutionSettings>) => {
    if (!state) return;
    setLoading(true);
    try {
      const next = await api<ExecutionState>(
        "/api/arbitrage/execution/settings",
        { method: "POST", body: JSON.stringify(patch) },
        20_000
      );
      setState(next);
      setError(null);
    } catch (err) {
      setError(toUserError(err));
      setPhase("degraded");
    } finally {
      setLoading(false);
    }
  };

  const refreshPlans = async () => {
    setLoading(true);
    try {
      const next = await api<ExecutionState>("/api/arbitrage/execution/refresh", { method: "POST" }, 10_000);
      setState(next);
      setPhase("refreshing");
      setError(null);
      window.setTimeout(() => void loadState(), 1500);
    } catch (err) {
      setError(toUserError(err));
      setPhase("degraded");
    } finally {
      setLoading(false);
    }
  };

  const executeOne = async (planId: string) => {
    setLoading(true);
    try {
      await api(`/api/arbitrage/execution/execute/${planId}`, { method: "POST" }, 30_000);
      await loadState();
    } catch (err) {
      setError(toUserError(err));
      setPhase("degraded");
    } finally {
      setLoading(false);
    }
  };

  const executeTop = async () => {
    setLoading(true);
    try {
      await api(
        "/api/arbitrage/execution/execute-top",
        { method: "POST", body: JSON.stringify({ limit: 3 }) },
        45_000
      );
      await loadState();
    } catch (err) {
      setError(toUserError(err));
      setPhase("degraded");
    } finally {
      setLoading(false);
    }
  };

  // Legacy mode/arm handlers
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

  /* ── Pair selection helpers ── */
  const pairKey = (p: ManualPair) => `${p.kalshiTicker}::${p.polymarketSlug}`;

  const togglePair = (p: ManualPair) => {
    const k = pairKey(p);
    setSelectedPairs((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const selectAllArbs = () => {
    setSelectedPairs(new Set(manualPairs.filter((p) => p.hasArb).map(pairKey)));
  };

  const clearSelection = () => setSelectedPairs(new Set());

  const selectedCount = selectedPairs.size;
  const arbPairs = manualPairs.filter((p) => p.hasArb);
  const tradableArbs = (arbData.data?.arbs ?? []).filter(
    (a) => !!(a.contracts && a.contracts > 0 && a.edgeDollar && a.edgeDollar > 0)
  );
  const positions = accountData.data?.openPositions ?? [];

  const statusLabel =
    phase === "bootstrapping" ? "Bootstrapping" :
    phase === "refreshing" ? "Refreshing" :
    phase === "degraded" ? "Degraded" : "Ready";

  const hasRunnableSnapshot = readyPlans.length > 0;

  return (
    <div className="space-y-5">

      {/* ── A. Settings Bar (V2 execution engine) ── */}
      {state && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="flex flex-wrap items-center gap-4">
            {/* Mode */}
            <div className="flex items-center gap-2">
              <label className="text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Mode</label>
              <select
                className="bg-zinc-900 border border-zinc-700 text-sm rounded px-2 py-1 text-zinc-200"
                value={state.settings.mode}
                onChange={(e) => updateSettings({ mode: e.target.value as ExecutionMode })}
                disabled={loading}
              >
                <option value="PAPER">Paper</option>
                <option value="LIVE">Live</option>
              </select>
            </div>

            {/* Bankroll */}
            <div className="flex items-center gap-2">
              <label className="text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Bankroll</label>
              <input
                type="number"
                className="w-24 bg-zinc-900 border border-zinc-700 text-sm rounded px-2 py-1 text-zinc-200 font-mono"
                value={Math.round(state.settings.bankrollUsd)}
                onChange={(e) => updateSettings({ bankrollUsd: Number(e.target.value || 0) })}
                disabled={loading}
              />
            </div>

            {/* Min Net Edge */}
            <div className="flex items-center gap-2">
              <label className="text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Min Edge</label>
              <input
                type="number"
                step="0.001"
                className="w-20 bg-zinc-900 border border-zinc-700 text-sm rounded px-2 py-1 text-zinc-200 font-mono"
                value={state.settings.minNetEdge}
                onChange={(e) => updateSettings({ minNetEdge: Number(e.target.value || 0) })}
                disabled={loading}
              />
            </div>

            {/* Auto Execute */}
            <label className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={state.settings.autoExecute}
                onChange={(e) => updateSettings({ autoExecute: e.target.checked })}
                disabled={loading}
                className="accent-[#CC0035]"
              />
              <span className="text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Auto</span>
            </label>

            <div className="w-px h-5 bg-zinc-800" />

            {/* Pair Source Toggle */}
            <div className="flex items-center gap-2">
              <label className="text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">Source</label>
              <div className="flex rounded-md overflow-hidden border border-zinc-700">
                {(["manual", "ai", "both"] as PairSource[]).map((src) => (
                  <button
                    key={src}
                    onClick={() => setPairSource(src)}
                    className={`px-2 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
                      pairSource === src
                        ? "bg-[#CC0035]/20 text-[#CC0035]"
                        : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
                    }`}
                  >
                    {src === "both" ? "All" : src === "ai" ? "AI" : "Manual"}
                  </button>
                ))}
              </div>
            </div>

            {/* AI Status Badge */}
            {scanStatus && (
              <div className="flex items-center gap-1.5">
                {scanStatus.scanning ? (
                  <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                ) : (
                  <div className="w-2 h-2 rounded-full bg-emerald-400" />
                )}
                <span className="text-[10px] text-zinc-500 font-medium">
                  AI: {scanStatus.embeddingEnabled ? "Enhanced" : "Basic"}
                </span>
              </div>
            )}

            <div className="flex-1" />

            {/* Action Buttons */}
            <button
              onClick={refreshPlans}
              disabled={loading}
              className="px-3 py-1.5 rounded-md bg-zinc-800 text-zinc-300 hover:bg-zinc-700 text-xs font-medium transition-colors"
            >
              Refresh Plans
            </button>
            <button
              onClick={executeTop}
              disabled={loading || (!hasRunnableSnapshot && state.refreshing)}
              className="px-3 py-1.5 rounded-md bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 text-xs font-medium disabled:opacity-40 transition-colors"
            >
              Execute Top 3
            </button>
          </div>

          {/* Status Row */}
          <div className="mt-3 flex flex-wrap gap-5 text-xs text-zinc-500">
            <span>Phase: <span className={phase === "ready" ? "text-emerald-400" : phase === "degraded" ? "text-red-400" : "text-zinc-300"}>{statusLabel}</span></span>
            <span>Ready: <span className="text-zinc-200">{readyPlans.length}</span></span>
            <span>Paper PnL: <span className={state.paperPnlUsd >= 0 ? "text-emerald-400" : "text-red-400"}>{money(state.paperPnlUsd)}</span></span>
            {state.lastRefreshAt && <span>Last refresh: <span className="text-zinc-300">{new Date(state.lastRefreshAt).toLocaleTimeString()}</span></span>}
            {state.lastRefreshDurationMs != null && <span>Duration: <span className="text-zinc-300">{state.lastRefreshDurationMs}ms</span></span>}
            {scanStatus && (
              <>
                <span>
                  AI scan: <span className={scanStatus.scanning ? "text-amber-400" : "text-zinc-300"}>
                    {scanStatus.scanning ? "scanning..." : scanStatus.lastScanAt ? `${Math.round((Date.now() - Date.parse(scanStatus.lastScanAt)) / 1000)}s ago` : "never"}
                  </span>
                </span>
                {scanStatus.nextScanIn > 0 && !scanStatus.scanning && (
                  <span>Next: <span className="text-zinc-300">{scanStatus.nextScanIn}s</span></span>
                )}
                <span>Matched: <span className="text-zinc-300">{scanStatus.matchedPairs}</span></span>
                <span>Arbs: <span className={scanStatus.arbCount > 0 ? "text-emerald-400" : "text-zinc-300"}>{scanStatus.arbCount}</span></span>
              </>
            )}
          </div>

          {(error || state.refreshError) && (
            <div className="mt-2 text-xs text-red-400">{error || state.refreshError}</div>
          )}
        </div>
      )}

      {/* Bootstrap/error state when V2 engine not yet loaded */}
      {!state && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-6">
          <div className="text-zinc-300">{statusLabel}</div>
          <div className="mt-2 text-zinc-400">{error ?? "Loading execution state..."}</div>
          <button
            onClick={() => void loadState()}
            className="mt-3 px-3 py-1.5 rounded-md bg-[#CC0035]/20 text-[#CC0035] hover:bg-[#CC0035]/30 text-sm"
          >
            Retry now
          </button>
        </div>
      )}

      {/* ── B. Legacy Execution Controls (mode/arm/execute) ── */}
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

      {/* ── C. Risk Status ── */}
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

      {/* ── D. Portfolio Summary ── */}
      {runtimeData.data?.mode === "paper" ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">Paper Account P&L</span>
            <span className="px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">PAPER</span>
          </div>
          <div className="grid grid-cols-5 gap-3">
            {[
              { label: "Portfolio Value", value: `$${(accountData.data?.portfolioValue ?? 0).toFixed(2)}`, accent: "text-zinc-200" },
              { label: "Available Cash", value: `$${(accountData.data?.availableBalance ?? 0).toFixed(2)}`, accent: "text-zinc-400" },
              { label: "Unrealized P&L", value: `${(accountData.data?.unrealizedProfit ?? 0) >= 0 ? "+" : ""}$${(accountData.data?.unrealizedProfit ?? 0).toFixed(2)}`, accent: (accountData.data?.unrealizedProfit ?? 0) >= 0 ? "text-emerald-400" : "text-red-400" },
              { label: "Realized P&L", value: `${(accountData.data?.realizedProfit ?? 0) >= 0 ? "+" : ""}$${(accountData.data?.realizedProfit ?? 0).toFixed(2)}`, accent: (accountData.data?.realizedProfit ?? 0) >= 0 ? "text-emerald-400" : "text-red-400" },
              { label: "Total Fees", value: `-$${(accountData.data?.totalFees ?? 0).toFixed(2)}`, accent: "text-amber-400" },
            ].map((stat) => (
              <div key={stat.label} className="glass-card rounded-xl p-4 flex flex-col items-center gap-1">
                <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">{stat.label}</span>
                <span className={`text-lg font-bold font-mono tabular-nums ${stat.accent}`}>{stat.value}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
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
      )}

      {/* ── E. Pair Selection ── */}
      <Section
        title="Pair Selection"
        badge={`${arbPairs.length} arbs / ${manualPairs.length} total`}
        defaultOpen={true}
      >
        <div className="flex items-center gap-3 mb-3">
          <button
            onClick={selectAllArbs}
            className="px-2.5 py-1 rounded text-[10px] font-medium bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 transition-colors"
          >
            Select All Arbs ({arbPairs.length})
          </button>
          <button
            onClick={clearSelection}
            className="px-2.5 py-1 rounded text-[10px] font-medium bg-zinc-800 text-zinc-400 hover:bg-zinc-700 transition-colors"
          >
            Clear
          </button>
          <button
            onClick={() => void loadPairs()}
            disabled={pairsLoading}
            className="px-2.5 py-1 rounded text-[10px] font-medium bg-zinc-800 text-zinc-400 hover:bg-zinc-700 transition-colors disabled:opacity-40"
          >
            {pairsLoading ? "Loading..." : "Refresh Pairs"}
          </button>
          {selectedCount > 0 && (
            <span className="text-xs text-[#CC0035] font-medium ml-auto">
              {selectedCount} pair{selectedCount !== 1 ? "s" : ""} selected
            </span>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                <th className="text-left py-2 pr-2 w-8"></th>
                <th className="text-left py-2 pr-3">Market</th>
                <th className="text-center py-2 px-2">Src</th>
                <th className="text-center py-2 px-2">Arb</th>
                <th className="text-right py-2 px-2">Match</th>
                <th className="text-right py-2 px-2">K YES</th>
                <th className="text-right py-2 px-2">P YES</th>
                <th className="text-right py-2 px-2">Edge</th>
                <th className="text-right py-2 px-2">Annual.</th>
                <th className="text-right py-2 px-2">Expires</th>
                <th className="text-left py-2 px-2">Direction</th>
                <th className="text-center py-2 px-2 w-14"></th>
              </tr>
            </thead>
            <tbody>
              {manualPairs.length === 0 ? (
                <tr>
                  <td colSpan={12} className="py-6 text-center">
                    {pairsLoading ? (
                      <span className="text-zinc-500">Loading pairs...</span>
                    ) : pairsError ? (
                      <div>
                        <span className="text-red-400 text-xs">{pairsError}</span>
                        <button onClick={() => void loadPairs()} className="ml-3 text-[10px] text-zinc-400 underline hover:text-zinc-200">Retry</button>
                      </div>
                    ) : (
                      <span className="text-zinc-500">
                        {pairSource === "manual"
                          ? "No manual pairs. Add pairs to Excel to get started."
                          : pairSource === "ai"
                          ? "No AI-matched pairs yet. Scanner is warming up..."
                          : "No pairs available. The scanner may still be initializing."}
                      </span>
                    )}
                  </td>
                </tr>
              ) : (
                manualPairs.map((p) => {
                  const k = pairKey(p);
                  const selected = selectedPairs.has(k);
                  const { edgePct, annualized, direction } = computeEdge(p);
                  return (
                    <tr
                      key={k}
                      onClick={() => togglePair(p)}
                      className={`border-t border-zinc-800/40 cursor-pointer transition-colors ${
                        selected ? "bg-[#CC0035]/5" : "hover:bg-zinc-800/30"
                      }`}
                    >
                      <td className="py-2 pr-2">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => togglePair(p)}
                          className="accent-[#CC0035] cursor-pointer"
                          onClick={(e) => e.stopPropagation()}
                        />
                      </td>
                      <td className="py-2 pr-3 max-w-xs">
                        <div className="truncate text-zinc-200" title={p.polymarketTitle || p.kalshiTitle}>
                          {p.polymarketTitle || p.kalshiTitle || p.kalshiTicker}
                        </div>
                        <div className="text-[10px] text-zinc-600 font-mono truncate">
                          {p.kalshiTicker} / {p.polymarketSlug}
                        </div>
                      </td>
                      <td className="py-2 px-2 text-center">
                        {p._source === "ai" ? (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-blue-500/15 text-blue-400">AI</span>
                        ) : (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-zinc-700/40 text-zinc-400">MAN</span>
                        )}
                      </td>
                      <td className="py-2 px-2 text-center">
                        {p.hasArb ? (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/20 text-emerald-400">ARB</span>
                        ) : (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-zinc-700/40 text-zinc-500">--</span>
                        )}
                      </td>
                      <td className={`py-2 px-2 text-right font-mono tabular-nums ${
                        p.similarityScore >= 0.8 ? "text-emerald-400" : p.similarityScore >= 0.4 ? "text-amber-400" : "text-zinc-500"
                      }`}>
                        {(p.similarityScore * 100).toFixed(0)}%
                      </td>
                      <td className="py-2 px-2 text-right font-mono tabular-nums text-zinc-300">
                        {(p.kalshiYesAsk * 100).toFixed(0)}¢
                      </td>
                      <td className="py-2 px-2 text-right font-mono tabular-nums text-zinc-300">
                        {(p.polyYesAsk * 100).toFixed(0)}¢
                      </td>
                      <td className={`py-2 px-2 text-right font-mono tabular-nums ${edgePct > 0 ? "text-emerald-400" : "text-zinc-500"}`}>
                        {edgePct > 0 ? pct(edgePct) : "--"}
                      </td>
                      <td className={`py-2 px-2 text-right font-mono tabular-nums ${
                        annualized > 0.5 ? "text-emerald-400" : annualized > 0.1 ? "text-amber-400" : "text-zinc-500"
                      }`}>
                        {annualized > 0 ? pct(annualized) : "--"}
                      </td>
                      <td className="py-2 px-2 text-right text-zinc-400">
                        {fmtDaysShort(p.endDate || p.resolutionTimeUtc)}
                      </td>
                      <td className="py-2 px-2 text-left text-zinc-500 text-[10px]">
                        {direction}
                      </td>
                      <td className="py-2 px-2 text-center">
                        {(() => {
                          const vKey = `${p.polymarketSlug}::${p.kalshiTicker}`;
                          const isVerified = verifiedKeys.has(vKey);
                          return (
                            <button
                              onClick={(e) => { e.stopPropagation(); void toggleVerify(p); }}
                              className={`px-1.5 py-0.5 rounded text-[9px] font-semibold transition-colors ${
                                isVerified
                                  ? "bg-emerald-500/20 text-emerald-400 hover:bg-red-500/20 hover:text-red-400"
                                  : "bg-zinc-700/40 text-zinc-500 hover:bg-emerald-500/15 hover:text-emerald-400"
                              }`}
                              title={isVerified ? "Click to unverify" : "Click to verify this pair"}
                            >
                              {isVerified ? "\u2713" : "\u002B"}
                            </button>
                          );
                        })()}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Section>

      {/* ── F. Trade Plans (V2 engine) ── */}
      {state && (
        <Section
          title="Trade Plans"
          badge={`${readyPlans.length} ready`}
          defaultOpen={true}
        >
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                  <th className="text-left py-2">Opportunity</th>
                  <th className="text-left py-2">Venue</th>
                  <th className="text-right py-2">Cap</th>
                  <th className="text-right py-2">Net Edge</th>
                  <th className="text-right py-2">Fill 20s</th>
                  <th className="text-right py-2">Est. PnL</th>
                  <th className="text-center py-2">Status</th>
                  <th className="text-center py-2 w-20">Action</th>
                </tr>
              </thead>
              <tbody>
                {state.plans.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-6 text-center text-zinc-500">
                      No plans yet. Click "Refresh Plans" to scan for opportunities.
                    </td>
                  </tr>
                ) : (
                  state.plans.map((plan) => (
                    <tr key={plan.id} className="border-t border-zinc-800/40 hover:bg-zinc-800/30 transition-colors">
                      <td className="py-2 pr-3 max-w-sm">
                        {plan.contractUrl ? (
                          <a
                            href={plan.contractUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="truncate text-zinc-200 hover:text-[#CC0035] underline underline-offset-2 transition-colors"
                          >
                            {plan.title}
                          </a>
                        ) : (
                          <div className="truncate text-zinc-200">{plan.title}</div>
                        )}
                        <div className="text-[10px] text-zinc-600">{plan.strategy.replace(/_/g, " ")}</div>
                      </td>
                      <td className="py-2 text-zinc-400">{plan.venue}</td>
                      <td className="py-2 text-right font-mono tabular-nums text-zinc-200">{money(plan.recommendedCapUsd)}</td>
                      <td className="py-2 text-right font-mono tabular-nums text-amber-300">{(plan.expectedNetEdge * 100).toFixed(2)}%</td>
                      <td className="py-2 text-right font-mono tabular-nums text-zinc-300">{(plan.fillProb20s * 100).toFixed(0)}%</td>
                      <td className="py-2 text-right font-mono tabular-nums text-emerald-400">{money(plan.expectedNetProfitUsd)}</td>
                      <td className="py-2 text-center">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                          plan.status === "READY" ? "bg-emerald-500/20 text-emerald-400"
                            : plan.status === "EXECUTED" ? "bg-blue-500/20 text-blue-300"
                            : plan.status === "FAILED" ? "bg-red-500/20 text-red-400"
                            : "bg-zinc-700/40 text-zinc-400"
                        }`}>{plan.status}</span>
                      </td>
                      <td className="py-2 text-center">
                        <button
                          onClick={() => executeOne(plan.id)}
                          disabled={loading || !plan.executable || plan.status !== "READY" || (state.refreshing && !hasRunnableSnapshot)}
                          className="px-2 py-1 rounded text-[10px] font-medium bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-40 transition-colors"
                          title={plan.reason}
                        >
                          Execute
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* ── G. Holdings (Paper Account) ── */}
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

      {/* ── H. V2 Positions ── */}
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

      {/* ── I. Recent Orders ── */}
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

      {/* ── J. Execution History (V2 engine) ── */}
      {state && (
        <Section title="Execution History" badge={`${state.history.length}`} defaultOpen={false}>
          {state.history.length === 0 ? (
            <div className="text-xs text-zinc-500">No execution history yet.</div>
          ) : (
            <div className="space-y-1 text-xs">
              {state.history.slice(0, 15).map((h) => (
                <div key={`${h.planId}-${h.timestamp}`} className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full ${
                      h.status === "SUCCESS" ? "bg-emerald-400" : h.status === "FAILED" ? "bg-red-400" : "bg-zinc-500"
                    }`} />
                    <span className="text-zinc-300 truncate">{h.message}</span>
                  </div>
                  <span className="text-zinc-600 shrink-0 font-mono tabular-nums">{new Date(h.timestamp).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      {/* ── K. Export Links ── */}
      <div className="flex flex-wrap gap-2">
        <a href="/api/arbitrage/execution/export/plans.csv" className="px-3 py-1.5 rounded-md bg-zinc-800/60 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 text-[10px] font-medium uppercase tracking-[0.08em] transition-colors">
          Export Plans CSV
        </a>
        <a href="/api/arbitrage/execution/export/history.csv" className="px-3 py-1.5 rounded-md bg-zinc-800/60 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 text-[10px] font-medium uppercase tracking-[0.08em] transition-colors">
          Export History CSV
        </a>
        <a href="/api/arbitrage/execution/export/history.json" className="px-3 py-1.5 rounded-md bg-zinc-800/60 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 text-[10px] font-medium uppercase tracking-[0.08em] transition-colors">
          Export History JSON
        </a>
      </div>
    </div>
  );
}
