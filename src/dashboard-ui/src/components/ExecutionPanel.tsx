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

interface TradeLeg {
  venue: "POLYMARKET" | "KALSHI";
  side: "BUY";
  instrument: string;
  outcome: string;
  bestBid?: number;
  bestAsk?: number;
  price: number;
  contracts: number;
  notionalUsd: number;
  tokenId?: string;
  conditionId?: string;
  ticker?: string;
  negRisk?: boolean;
}

interface TradePlan {
  id: string;
  venue: "POLYMARKET" | "KALSHI";
  strategy: "BINARY_BUY_BOTH" | "EVENT_BUY_ALL_YES";
  title: string;
  contractUrl?: string;
  expiryDate?: string;
  status: PlanStatus;
  executable: boolean;
  fillProb20s: number;
  expectedNetEdge: number;
  estimatedFeesUsd: number;
  expectedGrossProfitUsd: number;
  expectedNetProfitUsd: number;
  recommendedCapUsd: number;
  modelInputs: { snapshots: number };
  legs: TradeLeg[];
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

interface MiguelStatus {
  running: boolean;
  pairsCount: number;
  opportunitiesCount: number;
  logs: string[];
}

interface RuntimeLogsResponse {
  ok: boolean;
  path: string;
  tradeLogPath?: string;
  lines: string[];
  errorLines: string[];
}

type PlanFilter = "ALL" | "READY" | "EXECUTED" | "FAILED" | "SKIPPED";

const money = (n: number) =>
  n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const cents = (p: number) => `${(p * 100).toFixed(1)}c`;

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
    return "Request timed out; backend may still be refreshing. Retrying automatically.";
  }
  if (err instanceof TypeError) {
    return `Dashboard API unreachable on ${window.location.origin}`;
  }
  if (err instanceof Error) return err.message;
  return "Unknown request error";
}

function statusPill(status: PlanStatus | ExecutionRecord["status"]): string {
  if (status === "READY" || status === "SUCCESS") return "bg-emerald-500/20 text-emerald-300";
  if (status === "EXECUTED") return "bg-blue-500/20 text-blue-300";
  if (status === "FAILED") return "bg-red-500/20 text-red-300";
  return "bg-zinc-700/40 text-zinc-400";
}

export function ExecutionPanel({ paused }: { paused: boolean }) {
  const [state, setState] = useState<ExecutionState | null>(null);
  const [draftSettings, setDraftSettings] = useState<ExecutionSettings | null>(null);
  const [miguelStatus, setMiguelStatus] = useState<MiguelStatus | null>(null);
  const [sectionDRows, setSectionDRows] = useState<any[]>([]);
  const [planFilter, setPlanFilter] = useState<PlanFilter>("ALL");
  const [runtimeLogPath, setRuntimeLogPath] = useState<string>("");
  const [tradeLogPath, setTradeLogPath] = useState<string>("");
  const [runtimeErrorLogs, setRuntimeErrorLogs] = useState<string[]>([]);
  const [phase, setPhase] = useState<PanelPhase>("bootstrapping");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const backoffRef = useRef(1000);
  const retryTimerRef = useRef<number | null>(null);
  const hasStateRef = useRef(false);

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
      setDraftSettings((prev) => prev ?? next.settings);
      hasStateRef.current = true;
      setError(null);
      backoffRef.current = 1000;
      setPhase(next.refreshing ? "refreshing" : "ready");
    } catch (err) {
      const message = toUserError(err);
      setError(message);
      setPhase((prev) => (hasStateRef.current ? "degraded" : prev === "bootstrapping" ? "bootstrapping" : "degraded"));
      scheduleRetry(loadState);
    }
  }, [scheduleRetry]);

  const loadMiguel = useCallback(async () => {
    try {
      const status = await api<any>("/api/miguel/status", undefined, 20_000);
      setMiguelStatus(status);
      const top = await api<any>("/api/miguel/model-v1/top?limit=5", undefined, 30_000);
      setSectionDRows(Array.isArray(top?.rows) ? top.rows : []);
    } catch {
      // best effort
    }
  }, []);

  const loadRuntimeLogs = useCallback(async () => {
    try {
      const logs = await api<RuntimeLogsResponse>("/api/logs/runtime?limit=120", undefined, 15_000);
      setRuntimeLogPath(logs.path || "");
      setTradeLogPath(logs.tradeLogPath || "");
      setRuntimeErrorLogs(Array.isArray(logs.errorLines) ? logs.errorLines.slice(-12).reverse() : []);
    } catch {
      // best effort
    }
  }, []);

  useEffect(() => {
    if (paused) return;
    void loadState();
    void loadMiguel();
    void loadRuntimeLogs();

    const statePoll = window.setInterval(() => {
      void loadState();
    }, 20_000);

    const miguelPoll = window.setInterval(() => {
      void loadMiguel();
    }, 60_000);

    const logsPoll = window.setInterval(() => {
      void loadRuntimeLogs();
    }, 30_000);

    return () => {
      window.clearInterval(statePoll);
      window.clearInterval(miguelPoll);
      window.clearInterval(logsPoll);
      clearRetry();
    };
  }, [paused, loadState, loadMiguel, loadRuntimeLogs]);

  const plansFiltered = useMemo(() => {
    const plans = state?.plans ?? [];
    const withRank = [...plans].sort((a, b) => b.expectedNetProfitUsd - a.expectedNetProfitUsd);
    return planFilter === "ALL" ? withRank : withRank.filter((p) => p.status === planFilter);
  }, [state, planFilter]);

  const readyPlans = useMemo(() => state?.plans.filter((p) => p.status === "READY") ?? [], [state]);

  const applySettings = async () => {
    if (!state || !draftSettings) return;
    setLoading(true);
    try {
      const next = await api<ExecutionState>(
        "/api/arbitrage/execution/settings",
        { method: "POST", body: JSON.stringify(draftSettings) },
        20_000
      );
      setState(next);
      setDraftSettings(next.settings);
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
      const next = await api<ExecutionState>("/api/arbitrage/execution/refresh", { method: "POST" }, 12_000);
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

  const runMiguelAction = async (url: string) => {
    setLoading(true);
    try {
      await api(url, { method: "POST" }, 90_000);
      await loadMiguel();
      setError(null);
    } catch (err) {
      setError(toUserError(err));
      setPhase("degraded");
    } finally {
      setLoading(false);
    }
  };

  const statusLabel =
    phase === "bootstrapping" ? "Bootstrapping" :
    phase === "refreshing" ? "Refreshing" :
    phase === "degraded" ? "Degraded" : "Ready";

  if (!state || !draftSettings) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-6">
        <div className="text-zinc-300">{statusLabel}</div>
        <div className="mt-2 text-zinc-400">{error ?? "Loading execution state..."}</div>
        <button
          onClick={() => void loadState()}
          className="mt-3 px-3 py-1.5 rounded-md bg-violet-500/20 text-violet-300 hover:bg-violet-500/30 text-sm"
        >
          Retry now
        </button>
      </div>
    );
  }

  const hasRunnableSnapshot = readyPlans.length > 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
          <div className="text-[11px] uppercase tracking-wider text-zinc-500">Phase</div>
          <div className="mt-1 text-zinc-100 font-medium">{statusLabel}</div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
          <div className="text-[11px] uppercase tracking-wider text-zinc-500">Mode</div>
          <div className="mt-1 text-zinc-100 font-medium">{state.settings.mode}</div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
          <div className="text-[11px] uppercase tracking-wider text-zinc-500">Ready Plans</div>
          <div className="mt-1 text-zinc-100 font-medium">{readyPlans.length}</div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
          <div className="text-[11px] uppercase tracking-wider text-zinc-500">Refresh Seq</div>
          <div className="mt-1 text-zinc-100 font-medium">{state.refreshSeq}</div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
          <div className="text-[11px] uppercase tracking-wider text-zinc-500">Last Duration</div>
          <div className="mt-1 text-zinc-100 font-medium">{state.lastRefreshDurationMs != null ? `${state.lastRefreshDurationMs}ms` : "-"}</div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
          <div className="text-[11px] uppercase tracking-wider text-zinc-500">Paper PnL</div>
          <div className={`mt-1 font-medium ${state.paperPnlUsd >= 0 ? "text-emerald-300" : "text-red-300"}`}>{money(state.paperPnlUsd)}</div>
        </div>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-sm font-medium text-zinc-100">Execution Controls</h3>
          <button
            onClick={refreshPlans}
            disabled={loading}
            className="ml-auto px-3 py-1.5 rounded-md bg-violet-500/20 text-violet-300 hover:bg-violet-500/30 text-sm disabled:opacity-40"
          >
            Refresh Plans
          </button>
          <button
            onClick={executeTop}
            disabled={loading || (!hasRunnableSnapshot && state.refreshing)}
            className="px-3 py-1.5 rounded-md bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 text-sm disabled:opacity-40"
          >
            Execute Top 3
          </button>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <label className="text-xs text-zinc-400">
            <div className="mb-1 uppercase tracking-wider text-zinc-500">Mode</div>
            <select
              className="w-full bg-zinc-900 border border-zinc-700 text-sm rounded px-2 py-1.5"
              value={draftSettings.mode}
              onChange={(e) => setDraftSettings((s) => (s ? { ...s, mode: e.target.value as ExecutionMode } : s))}
              disabled={loading}
            >
              <option value="PAPER">Paper</option>
              <option value="LIVE">Live</option>
            </select>
          </label>

          <label className="text-xs text-zinc-400">
            <div className="mb-1 uppercase tracking-wider text-zinc-500">Bankroll USD</div>
            <input
              type="number"
              className="w-full bg-zinc-900 border border-zinc-700 text-sm rounded px-2 py-1.5"
              value={Math.round(draftSettings.bankrollUsd)}
              onChange={(e) => setDraftSettings((s) => (s ? { ...s, bankrollUsd: Number(e.target.value || 0) } : s))}
              disabled={loading}
            />
          </label>

          <label className="text-xs text-zinc-400">
            <div className="mb-1 uppercase tracking-wider text-zinc-500">Min Net Edge</div>
            <input
              type="number"
              step="0.001"
              className="w-full bg-zinc-900 border border-zinc-700 text-sm rounded px-2 py-1.5"
              value={draftSettings.minNetEdge}
              onChange={(e) => setDraftSettings((s) => (s ? { ...s, minNetEdge: Number(e.target.value || 0) } : s))}
              disabled={loading}
            />
          </label>

          <label className="text-xs text-zinc-400 flex items-end">
            <span className="inline-flex items-center gap-2 h-9 text-sm text-zinc-300">
              <input
                type="checkbox"
                checked={draftSettings.autoExecute}
                onChange={(e) => setDraftSettings((s) => (s ? { ...s, autoExecute: e.target.checked } : s))}
                disabled={loading}
              />
              Auto execute
            </span>
          </label>

          <div className="flex items-end gap-2">
            <button
              onClick={applySettings}
              disabled={loading}
              className="px-3 py-1.5 rounded-md bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 text-sm disabled:opacity-40"
            >
              Apply Settings
            </button>
            <button
              onClick={() => setDraftSettings(state.settings)}
              disabled={loading}
              className="px-3 py-1.5 rounded-md bg-zinc-800 text-zinc-300 hover:bg-zinc-700 text-sm disabled:opacity-40"
            >
              Reset
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 text-xs">
          <a href="/api/arbitrage/execution/export/plans.csv" className="px-2.5 py-1 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700">Plans CSV</a>
          <a href="/api/arbitrage/execution/export/history.csv" className="px-2.5 py-1 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700">History CSV</a>
          <a href="/api/arbitrage/execution/export/history.json" className="px-2.5 py-1 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700">History JSON</a>
          <a href="/api/arbitrage/execution/export/history.jsonl" className="px-2.5 py-1 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700">History JSONL</a>
        </div>

        {state.modelInvocation && (
          <div className="text-xs text-zinc-500">
            Model: {state.modelEngine || "python:model_v1"}
            {" | "}
            Last call: {state.modelInvocation.lastInvocationAt ? new Date(state.modelInvocation.lastInvocationAt).toLocaleTimeString() : "never"}
            {state.modelInvocation.lastInvocationError ? ` | error: ${state.modelInvocation.lastInvocationError}` : ""}
          </div>
        )}

        {(error || state.refreshError) && <div className="text-sm text-red-300">{error || state.refreshError}</div>}
        {state.liveReadiness.reasons.length > 0 && <div className="text-xs text-zinc-500">{state.liveReadiness.reasons.join(" | ")}</div>}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium text-zinc-200 mr-2">Miguel Pipeline + Section D</h3>
            <button onClick={() => runMiguelAction("/api/miguel/pairs/rebuild")} disabled={loading} className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-xs">Rebuild Pairs</button>
            <button onClick={() => runMiguelAction("/api/miguel/live-quotes/start")} disabled={loading} className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-xs">Start Quotes</button>
            <button onClick={() => runMiguelAction("/api/miguel/live-quotes/stop")} disabled={loading} className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-xs">Stop Quotes</button>
            <button onClick={() => runMiguelAction("/api/miguel/opportunities/rebuild")} disabled={loading} className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-xs">Rebuild Opportunities</button>
          </div>

          <div className="text-xs text-zinc-400">
            Running: <span className="text-zinc-200">{miguelStatus?.running ? "yes" : "no"}</span>
            {" | "}Pairs: <span className="text-zinc-200">{miguelStatus?.pairsCount ?? 0}</span>
            {" | "}Opportunities: <span className="text-zinc-200">{miguelStatus?.opportunitiesCount ?? 0}</span>
          </div>

          <div className="max-h-56 overflow-auto rounded border border-zinc-800/70">
            <table className="w-full text-xs">
              <thead className="bg-zinc-900/70 text-zinc-500 sticky top-0">
                <tr>
                  <th className="text-left py-2 px-2">Market</th>
                  <th className="text-right py-2 px-2">Raw Edge</th>
                  <th className="text-right py-2 px-2">Slippage</th>
                  <th className="text-right py-2 px-2">Fill</th>
                  <th className="text-right py-2 px-2">Net Edge</th>
                  <th className="text-right py-2 px-2">Cap</th>
                </tr>
              </thead>
              <tbody>
                {sectionDRows.length === 0 ? (
                  <tr><td colSpan={6} className="py-3 px-2 text-zinc-500">No Section D rows yet.</td></tr>
                ) : sectionDRows.map((row) => (
                  <tr key={row.id} className="border-t border-zinc-800/50">
                    <td className="py-1.5 px-2 text-zinc-300 max-w-[220px] truncate">{row.market || row.pair_id}</td>
                    <td className="py-1.5 px-2 text-right text-zinc-300">{((Number(row.edge_raw) || 0) * 100).toFixed(2)}%</td>
                    <td className="py-1.5 px-2 text-right text-zinc-300">{(((row.modelDecision?.expected_slippage ?? 0) as number) * 100).toFixed(3)}%</td>
                    <td className="py-1.5 px-2 text-right text-zinc-300">{(((row.modelDecision?.fill_prob_20s ?? 0) as number) * 100).toFixed(1)}%</td>
                    <td className="py-1.5 px-2 text-right text-amber-300">{(((row.modelDecision?.expected_net_edge ?? 0) as number) * 100).toFixed(3)}%</td>
                    <td className="py-1.5 px-2 text-right text-emerald-300">{money(Number(row.modelDecision?.recommended_cap ?? 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-2">
          <h3 className="text-sm font-medium text-zinc-200">Runtime Error Logs</h3>
          {runtimeLogPath && <div className="text-xs text-zinc-500">runtime: {runtimeLogPath}</div>}
          {tradeLogPath && <div className="text-xs text-zinc-500">trade: {tradeLogPath}</div>}
          {runtimeErrorLogs.length === 0 ? (
            <div className="text-sm text-zinc-500">No recent error logs.</div>
          ) : (
            <div className="space-y-1 text-xs font-mono text-red-300 max-h-72 overflow-auto pr-1">
              {runtimeErrorLogs.map((line, idx) => (
                <div key={`${idx}-${line.slice(0, 30)}`} className="whitespace-pre-wrap break-all">{line}</div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <h3 className="text-sm font-medium text-zinc-200 mr-2">Trade Plans</h3>
          {(["ALL", "READY", "EXECUTED", "FAILED", "SKIPPED"] as PlanFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => setPlanFilter(f)}
              className={`px-2.5 py-1 rounded text-xs ${planFilter === f ? "bg-violet-500/20 text-violet-300" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`}
            >
              {f}
            </button>
          ))}
          <span className="ml-auto text-xs text-zinc-500">{plansFiltered.length} shown</span>
        </div>

        <div className="max-h-[440px] overflow-auto rounded border border-zinc-800/70">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-zinc-900/80 text-zinc-400 text-xs uppercase tracking-wider sticky top-0">
                <th className="px-3 py-2 text-left">Opportunity</th>
                <th className="px-3 py-2 text-left">Venue</th>
                <th className="px-3 py-2 text-left">Expiry</th>
                <th className="px-3 py-2 text-left">Selected Quotes</th>
                <th className="px-3 py-2 text-right">Contracts / Spend</th>
                <th className="px-3 py-2 text-right">Est. Fees</th>
                <th className="px-3 py-2 text-right">Est. P&L</th>
                <th className="px-3 py-2 text-center">Status</th>
                <th className="px-3 py-2 text-center w-24">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {plansFiltered.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-zinc-500">No plans match this filter.</td>
                </tr>
              ) : (
                plansFiltered.map((plan) => {
                  const totalContracts = plan.legs.reduce((sum, leg) => sum + (Number(leg.contracts) || 0), 0);
                  const totalSpend = plan.legs.reduce((sum, leg) => sum + (Number(leg.notionalUsd) || 0), 0);
                  return (
                  <tr key={plan.id} className="hover:bg-zinc-800/30 transition-colors">
                    <td className="px-3 py-2 text-zinc-200 max-w-sm">
                      {plan.contractUrl ? (
                        <a
                          href={plan.contractUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="truncate text-violet-300 hover:text-violet-200 underline underline-offset-2"
                        >
                          {plan.title}
                        </a>
                      ) : (
                        <div className="truncate">{plan.title}</div>
                      )}
                      <div className="text-xs text-zinc-500">
                        {plan.strategy.replaceAll("_", " ")} | fill {(plan.fillProb20s * 100).toFixed(0)}% | snapshots {plan.modelInputs.snapshots}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-zinc-300">{plan.venue}</td>
                    <td className="px-3 py-2 text-zinc-300 text-xs">
                      {plan.expiryDate ? new Date(plan.expiryDate).toLocaleString() : "-"}
                    </td>
                    <td className="px-3 py-2 text-xs font-mono text-zinc-300">
                      <div className="space-y-1 max-w-[360px]">
                        {plan.legs.slice(0, 3).map((leg, idx) => (
                          <div key={`${plan.id}-leg-${idx}`} className="truncate">
                            {leg.outcome} b/a {leg.bestBid != null ? cents(leg.bestBid) : "-"} / {leg.bestAsk != null ? cents(leg.bestAsk) : "-"} buy@{cents(leg.price)}
                          </div>
                        ))}
                        {plan.legs.length > 3 && <div className="text-zinc-500">+{plan.legs.length - 3} more legs</div>}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-zinc-200">
                      <div>{totalContracts.toFixed(2)} ctr</div>
                      <div className="text-zinc-400">{money(totalSpend)}</div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-orange-300">{money(plan.estimatedFeesUsd)}</td>
                    <td className="px-3 py-2 text-right font-mono">
                      <div className={plan.expectedNetProfitUsd >= 0 ? "text-emerald-300" : "text-red-300"}>{money(plan.expectedNetProfitUsd)}</div>
                      <div className="text-zinc-400">{(plan.expectedNetEdge * 100).toFixed(2)}% net</div>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusPill(plan.status)}`}>{plan.status}</span>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <button
                        onClick={() => executeOne(plan.id)}
                        disabled={loading || !plan.executable || plan.status !== "READY" || (state.refreshing && !hasRunnableSnapshot)}
                        className="px-2 py-1 rounded text-xs bg-emerald-500/20 text-emerald-300 disabled:opacity-40"
                        title={plan.reason}
                      >
                        Execute
                      </button>
                    </td>
                  </tr>
                )})
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <h3 className="text-sm font-medium text-zinc-200 mb-2">Recent Executions</h3>
        {state.history.length === 0 ? (
          <div className="text-sm text-zinc-500">No execution history yet.</div>
        ) : (
          <div className="space-y-1.5 text-sm">
            {state.history.slice(0, 10).map((h) => (
              <div key={`${h.planId}-${h.timestamp}`} className="flex items-center justify-between gap-3 p-2 rounded border border-zinc-800/60">
                <div className="min-w-0">
                  <div className={`inline-flex px-1.5 py-0.5 rounded text-[10px] mr-2 ${statusPill(h.status)}`}>{h.status}</div>
                  <span className="text-zinc-300 break-words">{h.message}</span>
                </div>
                <div className="text-zinc-500 shrink-0">{new Date(h.timestamp).toLocaleTimeString()}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
