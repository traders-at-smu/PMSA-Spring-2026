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

interface MiguelStatus {
  running: boolean;
  pairsCount: number;
  opportunitiesCount: number;
  logs: string[];
}

const money = (n: number) =>
  n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });

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

export function ExecutionPanel({ paused }: { paused: boolean }) {
  const [state, setState] = useState<ExecutionState | null>(null);
  const [miguelStatus, setMiguelStatus] = useState<MiguelStatus | null>(null);
  const [sectionDRows, setSectionDRows] = useState<any[]>([]);
  const [phase, setPhase] = useState<PanelPhase>("bootstrapping");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const backoffRef = useRef(1000);
  const retryTimerRef = useRef<number | null>(null);

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

  const loadMiguel = useCallback(async () => {
    try {
      const status = await api<any>("/api/miguel/status", undefined, 20_000);
      setMiguelStatus(status);
      const top = await api<any>("/api/miguel/model-v1/top?limit=3", undefined, 30_000);
      setSectionDRows(Array.isArray(top?.rows) ? top.rows : []);
    } catch {
      // best effort
    }
  }, []);

  useEffect(() => {
    if (paused) return;
    void loadState();
    void loadMiguel();
    const poll = window.setInterval(() => {
      void loadState();
      void loadMiguel();
    }, 20_000);
    return () => {
      window.clearInterval(poll);
      clearRetry();
    };
  }, [paused, loadState, loadMiguel]);

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

  if (!state) {
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
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs text-zinc-500 uppercase tracking-wider">Mode</label>
          <select
            className="bg-zinc-900 border border-zinc-700 text-sm rounded px-2 py-1"
            value={state.settings.mode}
            onChange={(e) => updateSettings({ mode: e.target.value as ExecutionMode })}
            disabled={loading}
          >
            <option value="PAPER">Paper</option>
            <option value="LIVE">Live</option>
          </select>

          <label className="text-xs text-zinc-500 uppercase tracking-wider">Bankroll</label>
          <input
            type="number"
            className="w-28 bg-zinc-900 border border-zinc-700 text-sm rounded px-2 py-1"
            value={Math.round(state.settings.bankrollUsd)}
            onChange={(e) => updateSettings({ bankrollUsd: Number(e.target.value || 0) })}
            disabled={loading}
          />

          <label className="text-xs text-zinc-500 uppercase tracking-wider">Min Net Edge</label>
          <input
            type="number"
            step="0.001"
            className="w-24 bg-zinc-900 border border-zinc-700 text-sm rounded px-2 py-1"
            value={state.settings.minNetEdge}
            onChange={(e) => updateSettings({ minNetEdge: Number(e.target.value || 0) })}
            disabled={loading}
          />

          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={state.settings.autoExecute}
              onChange={(e) => updateSettings({ autoExecute: e.target.checked })}
              disabled={loading}
            />
            Auto execute
          </label>

          <button
            onClick={refreshPlans}
            disabled={loading}
            className="ml-auto px-3 py-1.5 rounded-md bg-violet-500/20 text-violet-300 hover:bg-violet-500/30 text-sm"
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
          <a
            href="/api/arbitrage/execution/export/plans.csv"
            className="px-3 py-1.5 rounded-md bg-zinc-800 text-zinc-300 hover:bg-zinc-700 text-sm"
          >
            Export Plans CSV
          </a>
          <a
            href="/api/arbitrage/execution/export/history.csv"
            className="px-3 py-1.5 rounded-md bg-zinc-800 text-zinc-300 hover:bg-zinc-700 text-sm"
          >
            Export Log CSV
          </a>
          <a
            href="/api/arbitrage/execution/export/history.json"
            className="px-3 py-1.5 rounded-md bg-zinc-800 text-zinc-300 hover:bg-zinc-700 text-sm"
          >
            Export Log JSON
          </a>
        </div>

        <div className="mt-3 flex flex-wrap gap-6 text-sm text-zinc-400">
          <span>Model: <span className="text-zinc-200">{state.modelEngine || "python:model_v1"}</span></span>
          <span>Phase: <span className="text-zinc-200">{statusLabel}</span></span>
          <span>Ready plans: <span className="text-zinc-200">{readyPlans.length}</span></span>
          <span>Paper PnL: <span className={state.paperPnlUsd >= 0 ? "text-emerald-400" : "text-red-400"}>{money(state.paperPnlUsd)}</span></span>
          <span>Refresh Seq: <span className="text-zinc-300">{state.refreshSeq}</span></span>
          {state.lastRefreshDurationMs != null && <span>Last duration: <span className="text-zinc-300">{state.lastRefreshDurationMs}ms</span></span>}
          {state.lastRefreshAt && <span>Last refresh: <span className="text-zinc-300">{new Date(state.lastRefreshAt).toLocaleTimeString()}</span></span>}
        </div>
        {state.modelInvocation && (
          <div className="mt-2 text-xs text-zinc-500">
            Model last call: {state.modelInvocation.lastInvocationAt ? new Date(state.modelInvocation.lastInvocationAt).toLocaleTimeString() : "never"}
            {state.modelInvocation.lastInvocationError ? ` | error: ${state.modelInvocation.lastInvocationError}` : ""}
          </div>
        )}

        {(error || state.refreshError) && <div className="mt-3 text-sm text-red-400">{error || state.refreshError}</div>}

        {state.liveReadiness.reasons.length > 0 && (
          <div className="mt-3 text-xs text-zinc-500">{state.liveReadiness.reasons.join(" | ")}</div>
        )}
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium text-zinc-200 mr-2">Miguel Pipeline + Section D</h3>
          <button onClick={() => runMiguelAction("/api/miguel/pairs/rebuild")} disabled={loading} className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-xs">Rebuild Pairs</button>
          <button onClick={() => runMiguelAction("/api/miguel/live-quotes/start")} disabled={loading} className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-xs">Start Quotes</button>
          <button onClick={() => runMiguelAction("/api/miguel/live-quotes/stop")} disabled={loading} className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-xs">Stop Quotes</button>
          <button onClick={() => runMiguelAction("/api/miguel/opportunities/rebuild")} disabled={loading} className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-xs">Rebuild Opportunities</button>
        </div>
        <div className="mt-2 text-xs text-zinc-400">
          Running: <span className="text-zinc-200">{miguelStatus?.running ? "yes" : "no"}</span>
          {" | "}Pairs: <span className="text-zinc-200">{miguelStatus?.pairsCount ?? 0}</span>
          {" | "}Opportunities: <span className="text-zinc-200">{miguelStatus?.opportunitiesCount ?? 0}</span>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-zinc-500">
                <th className="text-left py-1">Market</th>
                <th className="text-right py-1">Raw Edge</th>
                <th className="text-right py-1">Slippage</th>
                <th className="text-right py-1">Fill 20s</th>
                <th className="text-right py-1">Net Edge</th>
                <th className="text-right py-1">Cap</th>
              </tr>
            </thead>
            <tbody>
              {sectionDRows.length === 0 ? (
                <tr><td colSpan={6} className="py-2 text-zinc-500">No Section D rows yet.</td></tr>
              ) : sectionDRows.map((row) => (
                <tr key={row.id} className="border-t border-zinc-800/50">
                  <td className="py-1 text-zinc-300">{row.market || row.pair_id}</td>
                  <td className="py-1 text-right text-zinc-300">{((Number(row.edge_raw) || 0) * 100).toFixed(2)}%</td>
                  <td className="py-1 text-right text-zinc-300">{(((row.modelDecision?.expected_slippage ?? 0) as number) * 100).toFixed(3)}%</td>
                  <td className="py-1 text-right text-zinc-300">{(((row.modelDecision?.fill_prob_20s ?? 0) as number) * 100).toFixed(1)}%</td>
                  <td className="py-1 text-right text-amber-300">{(((row.modelDecision?.expected_net_edge ?? 0) as number) * 100).toFixed(3)}%</td>
                  <td className="py-1 text-right text-emerald-400">{money(Number(row.modelDecision?.recommended_cap ?? 0))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl border border-zinc-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-zinc-900/60 text-zinc-400 text-xs uppercase tracking-wider">
              <th className="px-4 py-3 text-left">Opportunity</th>
              <th className="px-4 py-3 text-left">Venue</th>
              <th className="px-4 py-3 text-right">Cap</th>
              <th className="px-4 py-3 text-right">Net Edge</th>
              <th className="px-4 py-3 text-right">Fill 20s</th>
              <th className="px-4 py-3 text-right">Snapshots</th>
              <th className="px-4 py-3 text-right">Est. Net PnL</th>
              <th className="px-4 py-3 text-center">Status</th>
              <th className="px-4 py-3 text-center w-24">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/50">
            {state.plans.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-zinc-500">No plans yet. Refresh plans to generate opportunities.</td>
              </tr>
            ) : (
              state.plans.map((plan) => (
                <tr key={plan.id} className="hover:bg-zinc-800/40 transition-colors">
                  <td className="px-4 py-3 text-zinc-200 max-w-sm">
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
                    <div className="text-xs text-zinc-500">{plan.strategy.replaceAll("_", " ")}</div>
                  </td>
                  <td className="px-4 py-3 text-zinc-300">{plan.venue}</td>
                  <td className="px-4 py-3 text-right font-mono text-zinc-200">{money(plan.recommendedCapUsd)}</td>
                  <td className="px-4 py-3 text-right font-mono text-amber-300">{(plan.expectedNetEdge * 100).toFixed(2)}%</td>
                  <td className="px-4 py-3 text-right font-mono text-zinc-300">{(plan.fillProb20s * 100).toFixed(0)}%</td>
                  <td className="px-4 py-3 text-right font-mono text-zinc-400">{plan.modelInputs.snapshots}</td>
                  <td className="px-4 py-3 text-right font-mono text-emerald-400">{money(plan.expectedNetProfitUsd)}</td>
                  <td className="px-4 py-3 text-center">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                      plan.status === "READY" ? "bg-emerald-500/20 text-emerald-400"
                        : plan.status === "EXECUTED" ? "bg-blue-500/20 text-blue-300"
                        : plan.status === "FAILED" ? "bg-red-500/20 text-red-400"
                        : "bg-zinc-700/40 text-zinc-400"
                    }`}>{plan.status}</span>
                  </td>
                  <td className="px-4 py-3 text-center">
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
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <h3 className="text-sm font-medium text-zinc-200 mb-2">Recent Executions</h3>
        {state.history.length === 0 ? (
          <div className="text-sm text-zinc-500">No execution history yet.</div>
        ) : (
          <div className="space-y-1.5 text-sm">
            {state.history.slice(0, 8).map((h) => (
              <div key={`${h.planId}-${h.timestamp}`} className="flex items-center justify-between gap-3">
                <div className="text-zinc-300 truncate">{h.message}</div>
                <div className="text-zinc-500 shrink-0">{new Date(h.timestamp).toLocaleTimeString()}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
