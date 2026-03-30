import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  const endMs = p.endDate ? Date.parse(p.endDate) : NaN;
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
  const [state, setState] = useState<ExecutionState | null>(null);
  const [phase, setPhase] = useState<PanelPhase>("bootstrapping");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const backoffRef = useRef(1000);
  const retryTimerRef = useRef<number | null>(null);

  // Pair source & selection state
  const [pairSource, setPairSource] = useState<PairSource>("both");
  const [manualPairs, setManualPairs] = useState<ManualPair[]>([]);
  const [selectedPairs, setSelectedPairs] = useState<Set<string>>(new Set());
  const [pairsLoading, setPairsLoading] = useState(false);

  // Verified pairs tracking
  const [verifiedKeys, setVerifiedKeys] = useState<Set<string>>(new Set());

  // Scan status (lightweight polling)
  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null);
  const lastScanRef = useRef<string | null>(null);

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

  const [pairsError, setPairsError] = useState<string | null>(null);

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
      // Auto-reload pairs when a new scan completes
      if (status.lastScanAt && status.lastScanAt !== lastScanRef.current) {
        lastScanRef.current = status.lastScanAt;
        void loadPairs();
      }
    } catch {
      // Non-critical — ignore status fetch failures
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
    // State + pairs: 30s, scan status: 10s (lightweight — no API calls on backend)
    const statePoll = window.setInterval(() => {
      void loadState();
    }, 30_000);
    const statusPoll = window.setInterval(() => {
      void loadScanStatus();
    }, 10_000);
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

  const statusLabel =
    phase === "bootstrapping" ? "Bootstrapping" :
    phase === "refreshing" ? "Refreshing" :
    phase === "degraded" ? "Degraded" : "Ready";

  if (!state) {
    return (
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
    );
  }

  const hasRunnableSnapshot = readyPlans.length > 0;

  return (
    <div className="space-y-4">
      {/* ── Settings Bar ── */}
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

          {/* Separator */}
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

          {/* Spacer */}
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

      {/* ── Manual Pair Selection ── */}
      <Section
        title="Pair Selection"
        badge={`${arbPairs.length} arbs / ${manualPairs.length} total`}
        defaultOpen={true}
      >
        {/* Selection Controls */}
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

        {/* Pairs Table */}
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
                        {fmtDaysShort(p.endDate)}
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

      {/* ── Trade Plans ── */}
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

      {/* ── Execution History ── */}
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

      {/* ── Export Links ── */}
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
