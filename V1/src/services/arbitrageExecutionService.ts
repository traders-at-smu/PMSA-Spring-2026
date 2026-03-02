import axios from "axios";
import fs from "fs";
import path from "path";
import { ArbitrageScreener, BinaryArbOpportunity, NegRiskArbOpportunity } from "../screener";
import { KalshiBinaryMispricing, KalshiEventGroupArb, KalshiScreener } from "../kalshiScreener";
import { getSettings, hasKalshiLiveTradingCredentials, validateSettingsForMode } from "../runtimeSettings";
import { ModelBatchItem, PythonModelClient } from "./pythonModelClient";

const MAX_HISTORY = 25;
const REFRESH_TIMEOUT_MS = 300_000;
const POLYMARKET_REFRESH_TIMEOUT_MS = 60_000;
const KALSHI_REFRESH_TIMEOUT_MS = 240_000;
const KALSHI_QUICK_WAIT_MS = 5_000;
const MAX_CAP_RATIO = 0.20;
const MIN_VALID_SUM_ASKS = 0.2;
const MAX_VALID_SUM_ASKS = 1.2;
const MAX_VALID_GROSS_EDGE = 1.0;
const MAX_VALID_MODEL_NET_EDGE = 0.5;
const MAX_MODEL_ITEMS = 150;
const MAX_SNAPSHOT_KEYS = 5_000;
const CROSS_MIN_BOX_COST = 0.5;
const CROSS_MAX_BOX_COST = 0.995;
const CROSS_MIN_DAYS_TO_RESOLUTION = 0.1;
const CROSS_MAX_DAYS_TO_RESOLUTION = 120;
const CROSS_MAX_PAIRS = 1200;

type Venue = "POLYMARKET" | "KALSHI" | "CROSS";
type LegVenue = "POLYMARKET" | "KALSHI";
type Strategy = "BINARY_BUY_BOTH" | "EVENT_BUY_ALL_YES" | "CROSS_MARKET_BOX";
export type ExecutionMode = "PAPER" | "LIVE";
export type PlanStatus = "READY" | "EXECUTED" | "FAILED" | "SKIPPED";

interface LobMetrics {
  topBookDepthUsd: number;
  depthWithinProfitableBandUsd: number;
  edgePersistence: number;
}

interface RecentSnapshot {
  timestamp: string;
  grossEdgePerDollar: number;
}

interface ModelDecision {
  expected_slippage: number;
  fill_prob_20s: number;
  expected_net_edge: number;
  recommended_cap: number;
}

export interface ExecutionSettings {
  mode: ExecutionMode;
  autoExecute: boolean;
  bankrollUsd: number;
  minNetEdge: number;
  defaultLegTickSize: string;
  kalshiUseMakerFees: boolean;
}

export interface TradeLeg {
  venue: LegVenue;
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

export interface TradePlan {
  id: string;
  venue: Venue;
  strategy: Strategy;
  title: string;
  contractUrl?: string;
  expiryDate?: string;
  createdAt: string;
  status: PlanStatus;
  executable: boolean;
  grossEdgePerDollar: number;
  expectedSlippage: number;
  fillProb20s: number;
  expectedNetEdge: number;
  estimatedFeesUsd: number;
  expectedGrossProfitUsd: number;
  expectedNetProfitUsd: number;
  recommendedCapUsd: number;
  modelInputs: {
    snapshots: number;
    topBookDepthUsd: number;
    profitableDepthUsd: number;
    edgePersistence: number;
  };
  legs: TradeLeg[];
  reason?: string;
}

export interface ExecutionRecord {
  planId: string;
  timestamp: string;
  mode: ExecutionMode;
  status: "SUCCESS" | "FAILED" | "SKIPPED";
  message: string;
  orderIds: string[];
  expectedNetProfitUsd: number;
  realizedProfitUsd: number;
}

export interface ExecutionState {
  settings: ExecutionSettings;
  modelEngine: string;
  modelInvocation: {
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

interface PolymarketClientLike {
  initialize(): Promise<void>;
  ensureApprovals(): Promise<void>;
  placeBuyOrder(
    tokenId: string,
    price: number,
    size: number,
    negRisk: boolean,
    tickSize: string
  ): Promise<string | null>;
}

interface CrossMarketPairCandidate {
  pairId: string;
  title: string;
  bestDirection: "BUY_KY_PN" | "BUY_KN_PY";
  bestCostC1: number;
  edgePerContractC1: number;
  edgePctC1: number;
  selectedKalFeeC1: number;
  daysToResolution: number;
  expiryDate?: string;
  topBookDepthUsd: number;
  depthWithinProfitableBandUsd: number;
  edgePersistence: number;
  polyConditionId: string;
  polyYesTokenId?: string;
  polyNoTokenId?: string;
  polyYesBid: number;
  polyYesAsk: number;
  polyNoBid: number;
  polyNoAsk: number;
  polyMarketUrl?: string;
  kalshiTicker: string;
  kalshiYesBid: number;
  kalshiYesAsk: number;
  kalshiNoBid: number;
  kalshiNoAsk: number;
  kalshiMarketUrl: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function ceilToCent(value: number): number {
  return Math.ceil(value * 100) / 100;
}

function calcKalshiFee(contracts: number, price: number, maker: boolean): number {
  const k = maker ? 0.0175 : 0.07;
  return ceilToCent(k * contracts * price * (1 - price));
}

function calcKalshiCrossFee(contracts: number, price: number): number {
  return ceilToCent(0.007 * contracts * price * (1 - price));
}

function roundContracts(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value * 100) / 100;
}

function isValidPrice(p: number): boolean {
  return Number.isFinite(p) && p >= 0.01 && p <= 0.99;
}

function isSaneDecision(decision: ModelDecision | undefined): decision is ModelDecision {
  if (!decision) return false;
  return (
    Number.isFinite(decision.expected_slippage) &&
    Number.isFinite(decision.fill_prob_20s) &&
    Number.isFinite(decision.expected_net_edge) &&
    Number.isFinite(decision.recommended_cap)
  );
}

function isValidSumAsks(sumAsks: number): boolean {
  return Number.isFinite(sumAsks) && sumAsks >= MIN_VALID_SUM_ASKS && sumAsks <= MAX_VALID_SUM_ASKS;
}

function isValidGrossEdge(edge: number): boolean {
  return Number.isFinite(edge) && edge > 0 && edge <= MAX_VALID_GROSS_EDGE;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise
      .then((val) => {
        clearTimeout(timer);
        resolve(val);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function asNum(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function parseIsoUtc(raw: string | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

export class ArbitrageExecutionService {
  private polymarketScreener = new ArbitrageScreener();
  private kalshiScreener = new KalshiScreener();
  private modelClient = new PythonModelClient();
  private snapshots = new Map<string, RecentSnapshot[]>();
  private paperExecutedPlanIds = new Set<string>();
  private polymarketClientPromise: Promise<PolymarketClientLike | null> | null = null;
  private refreshInFlight: Promise<ExecutionState> | null = null;
  private kalshiBackgroundInFlight: Promise<void> | null = null;
  private executionLogPath: string;
  private tradeLogPath: string;
  private crossOpportunities: TradePlan[] = [];

  private state: ExecutionState;

  constructor() {
    const settings = getSettings();
    const logDir = path.resolve(process.cwd(), "logs");
    const tradeLogDir = path.join(logDir, "trades");
    fs.mkdirSync(logDir, { recursive: true });
    fs.mkdirSync(tradeLogDir, { recursive: true });
    this.executionLogPath = path.join(logDir, "execution-history.jsonl");
    this.tradeLogPath = path.join(tradeLogDir, `trade-log-${this.sessionStamp()}-p${process.pid}.txt`);
    fs.writeFileSync(this.tradeLogPath, `[${new Date().toISOString()}] INFO Trade log session started\n`, "utf8");
    this.state = {
      settings: {
        mode: settings.execution.mode,
        autoExecute: settings.execution.autoExecute,
        bankrollUsd: settings.execution.bankrollUsd,
        minNetEdge: settings.execution.minNetEdge,
        defaultLegTickSize: settings.execution.defaultLegTickSize,
        kalshiUseMakerFees: settings.execution.kalshiUseMakerFees,
      },
      modelEngine: "python:model_v1",
      modelInvocation: {
        lastInvocationAt: null,
        lastInvocationError: null,
      },
      plans: [],
      history: [],
      paperPnlUsd: 0,
      lastRefreshAt: null,
      refreshing: false,
      refreshSeq: 0,
      liveReadiness: {
        polymarketReady: false,
        kalshiReady: false,
        reasons: [],
      },
    };
    this.state.liveReadiness = this.computeLiveReadiness();
  }

  getState(): ExecutionState {
    this.state.liveReadiness = this.computeLiveReadiness();
    const modelStatus = this.modelClient.getStatus();
    this.state.modelEngine = modelStatus.modelEngine;
    this.state.modelInvocation = {
      lastInvocationAt: modelStatus.lastInvocationAt,
      lastInvocationError: modelStatus.lastInvocationError,
    };
    return this.state;
  }

  updateSettings(next: Partial<ExecutionSettings>): ExecutionState {
    this.state.settings = {
      ...this.state.settings,
      ...next,
      bankrollUsd: clamp(next.bankrollUsd ?? this.state.settings.bankrollUsd, 100, 5_000_000),
      minNetEdge: clamp(next.minNetEdge ?? this.state.settings.minNetEdge, 0, 0.5),
    };
    this.state.liveReadiness = this.computeLiveReadiness();
    return this.state;
  }

  async refreshPlans(): Promise<ExecutionState> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }
    this.state.refreshing = true;
    this.state.refreshSeq += 1;
    this.state.refreshStartedAt = new Date().toISOString();
    const startedAt = Date.now();

    this.refreshInFlight = this.refreshPlansInternal(startedAt);
    try {
      return await this.refreshInFlight;
    } finally {
      this.state.refreshing = false;
      this.state.refreshCompletedAt = new Date().toISOString();
      this.state.lastRefreshDurationMs = Date.now() - startedAt;
      this.refreshInFlight = null;
    }
  }

  refreshPlansInBackground(): void {
    void this.refreshPlans();
  }

  private async refreshPlansInternal(startedAt: number): Promise<ExecutionState> {
    const priorPlans = this.state.plans;
    const priorPoly = priorPlans.filter((p) => p.venue === "POLYMARKET");
    const priorKalshi = priorPlans.filter((p) => p.venue === "KALSHI");
    const priorCross = priorPlans.filter((p) => p.venue === "CROSS");
    const warnings: string[] = [];
    const refreshSeqAtStart = this.state.refreshSeq;

    try {
      const kalshiCycleStartedAt = Date.now();
      const polyPromise = withTimeout(
        this.getPolymarketExecutionCandidates(),
        POLYMARKET_REFRESH_TIMEOUT_MS,
        "Polymarket refresh"
      );
      const crossPromise = withTimeout(
        this.getCrossMarketExecutionCandidates(),
        POLYMARKET_REFRESH_TIMEOUT_MS,
        "Cross-market refresh"
      );
      const shouldStartKalshi = !this.kalshiBackgroundInFlight;
      const kalshiPromise = shouldStartKalshi
        ? withTimeout(this.getKalshiExecutionCandidates(), KALSHI_REFRESH_TIMEOUT_MS, "Kalshi refresh")
        : null;

      const polyResult = await polyPromise.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason) => ({ status: "rejected" as const, reason })
      );
      const crossResult = await crossPromise.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason) => ({ status: "rejected" as const, reason })
      );

      // Do not block full refresh waiting for slow Kalshi responses.
      // Publish plans as soon as we have Polymarket + any quickly available Kalshi data.
      let kalshiResult:
        | { status: "fulfilled"; value: { binaryArbs: KalshiBinaryMispricing[]; eventArbs: KalshiEventGroupArb[] } }
        | { status: "rejected"; reason: any }
        | { status: "pending" }
        | { status: "skipped" };
      if (!kalshiPromise) {
        kalshiResult = { status: "skipped" };
        warnings.push("Kalshi refresh already running in background; reused previous Kalshi plans");
      } else {
        const kalshiQuickResult = await Promise.race([
          kalshiPromise.then(
            (value) => ({ status: "fulfilled" as const, value }),
            (reason) => ({ status: "rejected" as const, reason })
          ),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), KALSHI_QUICK_WAIT_MS)),
        ]);
        kalshiResult = kalshiQuickResult ?? { status: "pending" as const };
      }

      const polyData = polyResult.status === "fulfilled" ? polyResult.value : null;
      const kalshiData = kalshiResult.status === "fulfilled" ? kalshiResult.value : null;
      if (polyData || kalshiData || crossResult.status === "fulfilled") {
        const crossCount = crossResult.status === "fulfilled" ? crossResult.value.length : 0;
        console.log(
          `Opportunity scan results | poly: binary=${polyData?.binaryArbs.length || 0}, event=${polyData?.negRiskArbs.length || 0} | kalshi: binary=${kalshiData?.binaryArbs.length || 0}, event=${kalshiData?.eventArbs.length || 0} | cross=${crossCount}`
        );
      }
      if (kalshiResult.status === "pending") {
        warnings.push(`Kalshi refresh still running; published partial plans after ${KALSHI_QUICK_WAIT_MS}ms`);
      }
      const crossData = crossResult.status === "fulfilled" ? crossResult.value : null;
      const decisionMap = await this.buildModelDecisionMap(polyData, kalshiData, crossData, warnings);
      console.log(`Model decisions returned: ${decisionMap.size}`);

      let polyPlans = polyData ? this.buildPolymarketPlans(polyData, decisionMap) : [];
      if (polyResult.status === "rejected") {
        warnings.push(`Polymarket refresh failed: ${polyResult.reason?.message || polyResult.reason}`);
        polyPlans = priorPoly;
      }

      let kalshiPlans: TradePlan[] = kalshiData ? this.buildKalshiPlans(kalshiData, decisionMap) : [];
      if (kalshiResult.status === "fulfilled") {
        const elapsedMs = Date.now() - kalshiCycleStartedAt;
        console.log(
          `Kalshi refresh cycle completed in ${elapsedMs}ms | binary=${kalshiData?.binaryArbs.length || 0}, event=${kalshiData?.eventArbs.length || 0}`
        );
      } else if (kalshiResult.status === "rejected") {
        warnings.push(`Kalshi refresh failed: ${kalshiResult.reason?.message || kalshiResult.reason}`);
        kalshiPlans = priorKalshi;
      } else if (kalshiResult.status === "pending" || kalshiResult.status === "skipped") {
        kalshiPlans = priorKalshi;
      }

      let crossPlans: TradePlan[] = crossData ? this.buildCrossPlans(crossData, decisionMap) : [];
      if (crossResult.status === "rejected") {
        warnings.push(`Cross-market refresh failed: ${crossResult.reason?.message || crossResult.reason}`);
        crossPlans = priorCross;
      }
      this.crossOpportunities = [...crossPlans];

      await this.applyPlanSet([...polyPlans, ...kalshiPlans, ...crossPlans], startedAt, warnings, true);

      if (kalshiResult.status === "pending" && kalshiPromise) {
        const bgPromise = kalshiPromise
          .then(async (lateKalshiData) => {
            if (this.state.refreshSeq !== refreshSeqAtStart) return;
            const elapsedMs = Date.now() - kalshiCycleStartedAt;
            console.log(
              `Kalshi refresh cycle completed in ${elapsedMs}ms (background) | binary=${lateKalshiData.binaryArbs.length}, event=${lateKalshiData.eventArbs.length}`
            );
            const lateWarnings: string[] = [];
            const lateDecisionMap = await this.buildModelDecisionMap(polyData, lateKalshiData, crossData, lateWarnings);
            const latePolyPlans = polyData ? this.buildPolymarketPlans(polyData, lateDecisionMap) : priorPoly;
            const lateKalshiPlans = this.buildKalshiPlans(lateKalshiData, lateDecisionMap);
            const lateCrossPlans = crossData ? this.buildCrossPlans(crossData, lateDecisionMap) : priorCross;
            this.crossOpportunities = [...lateCrossPlans];
            await this.applyPlanSet([...latePolyPlans, ...lateKalshiPlans, ...lateCrossPlans], startedAt, lateWarnings, false);
            console.log(
              `Applied late Kalshi update | binary=${lateKalshiData.binaryArbs.length}, event=${lateKalshiData.eventArbs.length}`
            );
          })
          .catch((err: any) => {
            if (this.state.refreshSeq !== refreshSeqAtStart) return;
            const msg = err?.message || String(err);
            console.warn(`Late Kalshi refresh failed: ${msg}`);
          })
          .finally(() => {
            if (this.kalshiBackgroundInFlight === bgPromise) {
              this.kalshiBackgroundInFlight = null;
            }
          });
        this.kalshiBackgroundInFlight = bgPromise;
      }
    } catch (err: any) {
      this.state.refreshError = err?.message || "Failed to refresh opportunities";
      console.error(`Execution refresh failed: ${this.state.refreshError}`);
    }

    return this.state;
  }

  private buildPolymarketPlans(
    data: { binaryArbs: BinaryArbOpportunity[]; negRiskArbs: NegRiskArbOpportunity[] },
    decisionMap: Map<string, ModelDecision>
  ): TradePlan[] {
    const plans: TradePlan[] = [];
    for (const arb of data.binaryArbs) {
      const plan = this.buildPolymarketBinaryPlan(arb, decisionMap.get(`poly-binary-${arb.conditionId}`));
      if (plan) plans.push(plan);
    }
    for (const arb of data.negRiskArbs) {
      const plan = this.buildPolymarketEventPlan(arb, decisionMap.get(`poly-event-${arb.negRiskMarketId}`));
      if (plan) plans.push(plan);
    }
    return plans;
  }

  private buildKalshiPlans(
    data: { binaryArbs: KalshiBinaryMispricing[]; eventArbs: KalshiEventGroupArb[] },
    decisionMap: Map<string, ModelDecision>
  ): TradePlan[] {
    const plans: TradePlan[] = [];
    for (const arb of data.binaryArbs) {
      const plan = this.buildKalshiBinaryPlan(arb, decisionMap.get(`kalshi-binary-${arb.ticker}`));
      if (plan) plans.push(plan);
    }
    for (const arb of data.eventArbs) {
      const plan = this.buildKalshiEventPlan(arb, decisionMap.get(`kalshi-event-${arb.eventTicker}`));
      if (plan) plans.push(plan);
    }
    return plans;
  }

  private buildCrossPlans(
    data: CrossMarketPairCandidate[],
    decisionMap: Map<string, ModelDecision>
  ): TradePlan[] {
    const plans: TradePlan[] = [];
    for (const arb of data) {
      const plan = this.buildCrossMarketPlan(arb, decisionMap.get(`cross-${arb.pairId}`));
      if (plan) plans.push(plan);
    }
    return plans;
  }

  private async applyPlanSet(
    incomingPlans: TradePlan[],
    startedAt: number,
    warnings: string[],
    allowAutoExecute: boolean
  ): Promise<void> {
    const plans = [...incomingPlans]
      .sort((a, b) => b.expectedNetProfitUsd - a.expectedNetProfitUsd)
      .slice(0, 60);
    const readyPlans = plans.filter((p) => p.status === "READY");
    const skippedPlans = plans.filter((p) => p.status === "SKIPPED");
    console.log(
      `Plan synthesis complete | total=${plans.length}, ready=${readyPlans.length}, skipped=${skippedPlans.length}`
    );
    if (readyPlans.length > 0) {
      const top = readyPlans[0];
      console.log(
        `Top ready plan | ${top.venue} ${top.strategy} | netEdge=${(top.expectedNetEdge * 100).toFixed(2)}% | estNet=${top.expectedNetProfitUsd.toFixed(2)}`
      );
    } else {
      console.log("No READY plans produced in this refresh cycle");
    }

    if (this.state.settings.mode === "PAPER") {
      for (const plan of plans) {
        if (this.paperExecutedPlanIds.has(plan.id) && plan.status === "READY") {
          plan.status = "SKIPPED";
          plan.reason = "Already paper-executed";
        }
      }
    }

    this.state.plans = plans;
    this.state.lastRefreshAt = new Date(startedAt).toISOString();
    this.state.refreshError = warnings.length > 0 ? warnings.join(" | ") : undefined;
    if (this.state.refreshError) {
      console.warn(`Execution refresh warning: ${this.state.refreshError}`);
    }
    this.state.liveReadiness = this.computeLiveReadiness();

    if (allowAutoExecute && this.state.settings.autoExecute) {
      await this.executeTopPlans(3);
    }
  }

  private async getPolymarketExecutionCandidates(): Promise<{
    binaryArbs: BinaryArbOpportunity[];
    negRiskArbs: NegRiskArbOpportunity[];
  }> {
    const [binaryArbs, negRiskArbs] = await Promise.all([
      this.polymarketScreener.findBinaryArbitrage(),
      this.polymarketScreener.findNegRiskArbitrage(),
    ]);
    return { binaryArbs, negRiskArbs };
  }

  private async getKalshiExecutionCandidates(): Promise<{
    binaryArbs: KalshiBinaryMispricing[];
    eventArbs: KalshiEventGroupArb[];
  }> {
    const [binaryArbs, eventArbs] = await Promise.all([
      this.kalshiScreener.findBinaryMispricing(),
      this.kalshiScreener.findEventGroupArbitrage(),
    ]);
    return { binaryArbs, eventArbs };
  }

  private parseCsv(content: string): Array<Record<string, string>> {
    const text = content.trim();
    if (!text) return [];
    const lines = text.split(/\r?\n/);
    if (lines.length < 2) return [];
    const splitCsvLine = (line: string): string[] => {
      const out: string[] = [];
      let cur = "";
      let inQuotes = false;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (ch === '"') {
          if (inQuotes && line[i + 1] === '"') {
            cur += '"';
            i += 1;
          } else {
            inQuotes = !inQuotes;
          }
        } else if (ch === "," && !inQuotes) {
          out.push(cur);
          cur = "";
        } else {
          cur += ch;
        }
      }
      out.push(cur);
      return out;
    };
    const header = splitCsvLine(lines[0]);
    return lines.slice(1).map((line) => {
      const cols = splitCsvLine(line);
      const row: Record<string, string> = {};
      header.forEach((h, i) => {
        row[h] = cols[i] ?? "";
      });
      return row;
    });
  }

  private computeDaysToResolution(expiryA?: string, expiryB?: string): number {
    const now = Date.now();
    const a = parseIsoUtc(expiryA);
    const b = parseIsoUtc(expiryB);
    const candidates = [a, b]
      .filter((d): d is Date => Boolean(d))
      .map((d) => (d.getTime() - now) / 86_400_000)
      .filter((days) => Number.isFinite(days) && days > 0);
    if (candidates.length === 0) return 0;
    return Math.min(...candidates);
  }

  private async getCrossMarketExecutionCandidates(): Promise<CrossMarketPairCandidate[]> {
    const pairsPath = path.resolve(process.cwd(), "pairs.csv");
    if (!fs.existsSync(pairsPath)) return [];

    const raw = fs.readFileSync(pairsPath, "utf8");
    const pairRows = this.parseCsv(raw).slice(0, CROSS_MAX_PAIRS);
    if (pairRows.length === 0) return [];

    const [polyMarkets, kalshiMarkets] = await Promise.all([
      this.polymarketScreener.fetchAllActiveMarkets() as Promise<Array<Record<string, any>>>,
      this.kalshiScreener.fetchAllActiveMarkets() as Promise<Array<Record<string, any>>>,
    ]);

    const polyById = new Map(polyMarkets.map((m) => [String(m.id || ""), m]));
    const kalshiByTicker = new Map(kalshiMarkets.map((m) => [String(m.ticker || ""), m]));
    const out: CrossMarketPairCandidate[] = [];

    for (const row of pairRows) {
      const pairId = row.pair_id || "";
      const polyMarketId = row.poly_market_id || "";
      const kalshiTicker = row.kalshi_market_id || "";
      if (!pairId || !polyMarketId || !kalshiTicker) continue;

      const pm = polyById.get(polyMarketId);
      const km = kalshiByTicker.get(kalshiTicker);
      if (!pm || !km) continue;

      const polyYesAsk = asNum(pm.bestAsk);
      const polyYesBid = asNum(pm.bestBid);
      const polyNoAsk = 1 - polyYesBid;
      const polyNoBid = 1 - polyYesAsk;
      const kalshiYesAsk = asNum(km.yes_ask_dollars) / 100;
      const kalshiYesBid = asNum(km.yes_bid_dollars) / 100;
      const kalshiNoAsk = asNum(km.no_ask_dollars) / 100;
      const kalshiNoBid = asNum(km.no_bid_dollars) / 100;

      if (
        !isValidPrice(polyYesAsk) ||
        !isValidPrice(polyNoAsk) ||
        !isValidPrice(kalshiYesAsk) ||
        !isValidPrice(kalshiNoAsk)
      ) {
        continue;
      }

      const feeKy = calcKalshiCrossFee(1, kalshiYesAsk);
      const feeKn = calcKalshiCrossFee(1, kalshiNoAsk);
      const kyPnCost = kalshiYesAsk + polyNoAsk + feeKy;
      const knPyCost = kalshiNoAsk + polyYesAsk + feeKn;
      const bestDirection = kyPnCost <= knPyCost ? "BUY_KY_PN" : "BUY_KN_PY";
      const bestCostC1 = Math.min(kyPnCost, knPyCost);
      if (
        !Number.isFinite(bestCostC1) ||
        bestCostC1 >= 1 ||
        bestCostC1 < CROSS_MIN_BOX_COST ||
        bestCostC1 > CROSS_MAX_BOX_COST
      ) {
        continue;
      }

      const edgePerContractC1 = 1 - bestCostC1;
      const edgePctC1 = edgePerContractC1 / Math.max(bestCostC1, 0.0001);
      if (!isValidGrossEdge(edgePerContractC1)) continue;

      const daysToResolution = this.computeDaysToResolution(row.expiry_poly_utc, row.expiry_kalshi_utc);
      if (daysToResolution < CROSS_MIN_DAYS_TO_RESOLUTION || daysToResolution > CROSS_MAX_DAYS_TO_RESOLUTION) {
        continue;
      }

      const selectedKalFeeC1 = bestDirection === "BUY_KY_PN" ? feeKy : feeKn;
      const polyDepth = Math.max(1, asNum(pm.liquidity) * 0.01 + asNum(pm.volume24hr) * 0.02);
      const kalshiDepth = Math.max(1, asNum(km.liquidity_dollars));
      const topDepth = polyDepth + kalshiDepth;
      const profitableDepth = Math.max(1, Math.min(polyDepth, kalshiDepth * 0.02));
      const expiryDate = row.expiry_poly_utc || row.expiry_kalshi_utc || "";

      out.push({
        pairId,
        title: row.title_clean || String(pm.question || km.title || kalshiTicker),
        bestDirection,
        bestCostC1,
        edgePerContractC1,
        edgePctC1,
        selectedKalFeeC1,
        daysToResolution,
        expiryDate,
        topBookDepthUsd: topDepth,
        depthWithinProfitableBandUsd: profitableDepth,
        edgePersistence: 0,
        polyConditionId: String(pm.conditionId || ""),
        polyYesTokenId: String((pm.clobTokenIds || [])[0] || ""),
        polyNoTokenId: String((pm.clobTokenIds || [])[1] || ""),
        polyYesBid,
        polyYesAsk,
        polyNoBid,
        polyNoAsk,
        polyMarketUrl: pm.slug ? `https://polymarket.com/event/${pm.slug}` : undefined,
        kalshiTicker,
        kalshiYesBid,
        kalshiYesAsk,
        kalshiNoBid,
        kalshiNoAsk,
        kalshiMarketUrl: `https://kalshi.com/markets/${encodeURIComponent(kalshiTicker)}`,
      });
    }

    out.sort((a, b) => b.edgePctC1 - a.edgePctC1);
    return out.slice(0, 300);
  }

  async executePlan(planId: string): Promise<ExecutionRecord> {
    const plan = this.state.plans.find((p) => p.id === planId);
    if (!plan) {
      return this.pushHistory({
        planId,
        timestamp: new Date().toISOString(),
        mode: this.state.settings.mode,
        status: "FAILED",
        message: "Plan not found",
        orderIds: [],
        expectedNetProfitUsd: 0,
        realizedProfitUsd: 0,
      });
    }

    if (plan.status !== "READY") {
      return this.pushHistory({
        planId: plan.id,
        timestamp: new Date().toISOString(),
        mode: this.state.settings.mode,
        status: "SKIPPED",
        message: plan.reason || `Plan status is ${plan.status}`,
        orderIds: [],
        expectedNetProfitUsd: plan.expectedNetProfitUsd,
        realizedProfitUsd: 0,
      });
    }

    if (!plan.executable) {
      plan.status = "SKIPPED";
      return this.pushHistory({
        planId: plan.id,
        timestamp: new Date().toISOString(),
        mode: this.state.settings.mode,
        status: "SKIPPED",
        message: plan.reason || "Plan has non-executable legs",
        orderIds: [],
        expectedNetProfitUsd: plan.expectedNetProfitUsd,
        realizedProfitUsd: 0,
      });
    }

    if (this.state.settings.mode === "PAPER") {
      if (this.paperExecutedPlanIds.has(plan.id)) {
        plan.status = "SKIPPED";
        plan.reason = "Already paper-executed";
        return this.pushHistory({
          planId: plan.id,
          timestamp: new Date().toISOString(),
          mode: "PAPER",
          status: "SKIPPED",
          message: "Plan already executed in paper mode",
          orderIds: [],
          expectedNetProfitUsd: plan.expectedNetProfitUsd,
          realizedProfitUsd: 0,
        });
      }

      plan.status = "EXECUTED";
      const realized = plan.expectedNetProfitUsd;
      this.state.paperPnlUsd += realized;
      this.paperExecutedPlanIds.add(plan.id);
      return this.pushHistory({
        planId: plan.id,
        timestamp: new Date().toISOString(),
        mode: "PAPER",
        status: "SUCCESS",
        message: `Paper-filled ${plan.legs.length} legs`,
        orderIds: plan.legs.map((_, i) => `paper-${plan.id}-${i + 1}`),
        expectedNetProfitUsd: plan.expectedNetProfitUsd,
        realizedProfitUsd: realized,
      });
    }

    const readiness = this.computeLiveReadiness();
    if (
      (plan.venue === "POLYMARKET" && !readiness.polymarketReady) ||
      (plan.venue === "KALSHI" && !readiness.kalshiReady) ||
      (plan.venue === "CROSS" && (!readiness.polymarketReady || !readiness.kalshiReady))
    ) {
      plan.status = "FAILED";
      return this.pushHistory({
        planId: plan.id,
        timestamp: new Date().toISOString(),
        mode: "LIVE",
        status: "FAILED",
        message: readiness.reasons.join(" | ") || "Live venue not configured",
        orderIds: [],
        expectedNetProfitUsd: plan.expectedNetProfitUsd,
        realizedProfitUsd: 0,
      });
    }

    try {
      const orderIds: string[] = [];
      for (const leg of plan.legs) {
        const orderId = leg.venue === "POLYMARKET"
          ? await this.executePolymarketLeg(leg)
          : await this.executeKalshiLeg(leg);
        if (!orderId) {
          throw new Error(`Order failed for ${leg.venue} ${leg.instrument} ${leg.outcome}`);
        }
        orderIds.push(orderId);
      }

      plan.status = "EXECUTED";
      return this.pushHistory({
        planId: plan.id,
        timestamp: new Date().toISOString(),
        mode: "LIVE",
        status: "SUCCESS",
        message: `Executed ${plan.legs.length} legs live`,
        orderIds,
        expectedNetProfitUsd: plan.expectedNetProfitUsd,
        realizedProfitUsd: 0,
      });
    } catch (err: any) {
      plan.status = "FAILED";
      return this.pushHistory({
        planId: plan.id,
        timestamp: new Date().toISOString(),
        mode: "LIVE",
        status: "FAILED",
        message: err?.message || "Execution failed",
        orderIds: [],
        expectedNetProfitUsd: plan.expectedNetProfitUsd,
        realizedProfitUsd: 0,
      });
    }
  }

  async executeTopPlans(limit: number): Promise<ExecutionRecord[]> {
    const records: ExecutionRecord[] = [];
    for (const plan of this.state.plans.slice(0, limit)) {
      if (plan.status !== "READY") continue;
      records.push(await this.executePlan(plan.id));
    }
    return records;
  }

  private recordSnapshot(opportunityId: string, grossEdgePerDollar: number): RecentSnapshot[] {
    if (!this.snapshots.has(opportunityId) && this.snapshots.size >= MAX_SNAPSHOT_KEYS) {
      const oldestKey = this.snapshots.keys().next().value as string | undefined;
      if (oldestKey) this.snapshots.delete(oldestKey);
    }
    const current = this.snapshots.get(opportunityId) || [];
    current.push({ timestamp: new Date().toISOString(), grossEdgePerDollar });
    const trimmed = current.slice(-3);
    this.snapshots.set(opportunityId, trimmed);
    return trimmed;
  }

  private async buildModelDecisionMap(
    polyData: { binaryArbs: BinaryArbOpportunity[]; negRiskArbs: NegRiskArbOpportunity[] } | null,
    kalshiData: { binaryArbs: KalshiBinaryMispricing[]; eventArbs: KalshiEventGroupArb[] } | null,
    crossData: CrossMarketPairCandidate[] | null,
    warnings: string[]
  ): Promise<Map<string, ModelDecision>> {
    const items: ModelBatchItem[] = [];

    if (polyData) {
      for (const arb of polyData.binaryArbs) {
        if (arb.type !== "BUY_BOTH" || !arb.yesTokenId || !arb.noTokenId || arb.yesAsk <= 0 || arb.noAsk <= 0) continue;
        const id = `poly-binary-${arb.conditionId}`;
        const sumAsks = arb.yesAsk + arb.noAsk;
        const grossEdge = (1 - sumAsks) / Math.max(sumAsks, 0.0001);
        if (!isValidSumAsks(sumAsks) || !isValidGrossEdge(grossEdge)) continue;
        const snapshots = this.recordSnapshot(id, grossEdge);
        const topDepth = (arb.bidDepth || 0) + (arb.askDepth || 0);
        const profitableDepth = Math.min(arb.bidDepth || 0, arb.askDepth || 0);
        items.push({
          id,
          opportunity_row: {
            id,
            venue: "POLYMARKET",
            strategy: "BINARY_BUY_BOTH",
            market: arb.market,
            yesAsk: arb.yesAsk,
            noAsk: arb.noAsk,
            bidDepth: arb.bidDepth || 0,
            askDepth: arb.askDepth || 0,
            liquidity: 0,
            profitPerDollar: grossEdge,
            numOutcomes: 2,
            sumAsks,
          },
          lob_metrics: {
            topBookDepthUsd: topDepth,
            depthWithinProfitableBandUsd: profitableDepth,
            edgePersistence: 0,
          },
          recent_snapshots: snapshots,
        });
      }

      for (const arb of polyData.negRiskArbs) {
        if (arb.type !== "BUY_ALL_YES") continue;
        const outcomes = arb.outcomes.filter((o) => o.bestAsk > 0 && !!o.yesTokenId && !!o.conditionId);
        if (outcomes.length < 2) continue;
        const id = `poly-event-${arb.negRiskMarketId}`;
        const grossEdge = (1 - arb.sumBestAsk) / Math.max(arb.sumBestAsk, 0.0001);
        if (!isValidSumAsks(arb.sumBestAsk) || !isValidGrossEdge(grossEdge)) continue;
        const snapshots = this.recordSnapshot(id, grossEdge);
        const depthWithinBand = outcomes.reduce((sum, o) => sum + Math.max(0, Math.min(o.bestAsk, o.bestBid)), 0) * 1000;
        const topDepth = outcomes.reduce((sum, o) => sum + Math.max(o.bestAsk, o.bestBid) * 1000, 0);
        items.push({
          id,
          opportunity_row: {
            id,
            venue: "POLYMARKET",
            strategy: "EVENT_BUY_ALL_YES",
            market: arb.event,
            yesAsk: 0,
            noAsk: 0,
            bidDepth: 0,
            askDepth: 0,
            liquidity: 0,
            profitPerDollar: grossEdge,
            numOutcomes: outcomes.length,
            sumAsks: arb.sumBestAsk,
          },
          lob_metrics: {
            topBookDepthUsd: topDepth,
            depthWithinProfitableBandUsd: depthWithinBand,
            edgePersistence: 0,
          },
          recent_snapshots: snapshots,
        });
      }
    }

    if (kalshiData) {
      for (const arb of kalshiData.binaryArbs) {
        if (arb.type !== "BUY_BOTH" || arb.yesAsk <= 0 || arb.noAsk <= 0) continue;
        const id = `kalshi-binary-${arb.ticker}`;
        const sumAsks = arb.yesAsk + arb.noAsk;
        const grossEdge = (1 - sumAsks) / Math.max(sumAsks, 0.0001);
        if (!isValidSumAsks(sumAsks) || !isValidGrossEdge(grossEdge)) continue;
        const snapshots = this.recordSnapshot(id, grossEdge);
        items.push({
          id,
          opportunity_row: {
            id,
            venue: "KALSHI",
            strategy: "BINARY_BUY_BOTH",
            market: arb.market,
            yesAsk: arb.yesAsk,
            noAsk: arb.noAsk,
            bidDepth: 0,
            askDepth: 0,
            liquidity: arb.liquidity || 0,
            profitPerDollar: grossEdge,
            numOutcomes: 2,
            sumAsks,
          },
          lob_metrics: {
            topBookDepthUsd: arb.liquidity || 0,
            depthWithinProfitableBandUsd: (arb.liquidity || 0) * 0.02,
            edgePersistence: 0,
          },
          recent_snapshots: snapshots,
        });
      }

      for (const arb of kalshiData.eventArbs) {
        if (arb.type !== "BUY_ALL_YES") continue;
        const outcomes = arb.outcomes.filter((o) => o.yesAsk > 0 && !!o.ticker);
        if (outcomes.length < 2) continue;
        const id = `kalshi-event-${arb.eventTicker}`;
        const grossEdge = (1 - arb.sumYesAsks) / Math.max(arb.sumYesAsks, 0.0001);
        if (!isValidSumAsks(arb.sumYesAsks) || !isValidGrossEdge(grossEdge)) continue;
        const snapshots = this.recordSnapshot(id, grossEdge);
        items.push({
          id,
          opportunity_row: {
            id,
            venue: "KALSHI",
            strategy: "EVENT_BUY_ALL_YES",
            market: arb.eventTitle,
            yesAsk: 0,
            noAsk: 0,
            bidDepth: 0,
            askDepth: 0,
            liquidity: outcomes.length * 1500,
            profitPerDollar: grossEdge,
            numOutcomes: outcomes.length,
            sumAsks: arb.sumYesAsks,
          },
          lob_metrics: {
            topBookDepthUsd: outcomes.length * 1500,
            depthWithinProfitableBandUsd: outcomes.length * 800,
            edgePersistence: 0,
          },
          recent_snapshots: snapshots,
        });
      }
    }

    if (crossData) {
      for (const arb of crossData) {
        const id = `cross-${arb.pairId}`;
        const grossEdge = (1 - arb.bestCostC1) / Math.max(arb.bestCostC1, 0.0001);
        if (!isValidSumAsks(arb.bestCostC1) || !isValidGrossEdge(grossEdge)) continue;
        const snapshots = this.recordSnapshot(id, grossEdge);
        items.push({
          id,
          opportunity_row: {
            id,
            venue: "CROSS",
            strategy: "CROSS_MARKET_BOX",
            market: arb.title,
            yesAsk: arb.kalshiYesAsk,
            noAsk: arb.polyNoAsk,
            bidDepth: arb.depthWithinProfitableBandUsd,
            askDepth: arb.topBookDepthUsd,
            liquidity: arb.topBookDepthUsd,
            profitPerDollar: arb.edgePerContractC1,
            numOutcomes: 2,
            sumAsks: arb.bestCostC1,
          },
          lob_metrics: {
            topBookDepthUsd: arb.topBookDepthUsd,
            depthWithinProfitableBandUsd: arb.depthWithinProfitableBandUsd,
            edgePersistence: arb.edgePersistence,
          },
          recent_snapshots: snapshots,
        });
      }
    }

    if (items.length === 0) {
      return new Map<string, ModelDecision>();
    }

    try {
      // Keep bridge payload bounded; excessive candidates mostly add latency.
      const limitedItems = items
        .sort((a, b) => Number(b.opportunity_row.profitPerDollar || 0) - Number(a.opportunity_row.profitPerDollar || 0))
        .slice(0, MAX_MODEL_ITEMS);
      if (items.length > limitedItems.length) {
        console.log(`Model candidate cap applied: ${limitedItems.length}/${items.length}`);
      }
      const decisions = await this.modelClient.evaluateBatch(limitedItems, this.state.settings.bankrollUsd);
      const capLimit = this.state.settings.bankrollUsd * MAX_CAP_RATIO;
      const sanitized = decisions
        .map((d) => {
          const next = d.decision;
          if (!isSaneDecision(next)) return null;
          const capped: ModelDecision = {
            expected_slippage: Math.max(0, next.expected_slippage),
            fill_prob_20s: clamp(next.fill_prob_20s, 0, 1),
            expected_net_edge: clamp(next.expected_net_edge, -MAX_VALID_MODEL_NET_EDGE, MAX_VALID_MODEL_NET_EDGE),
            recommended_cap: clamp(next.recommended_cap, 0, capLimit),
          };
          return [d.id, capped] as const;
        })
        .filter((row): row is readonly [string, ModelDecision] => Boolean(row));
      return new Map(sanitized);
    } catch (err: any) {
      warnings.push(`Model v1 bridge failed: ${err?.message || err}`);
      return new Map<string, ModelDecision>();
    }
  }

  private buildPolymarketBinaryPlan(arb: BinaryArbOpportunity, decision?: ModelDecision): TradePlan | null {
    if (arb.type !== "BUY_BOTH") return null;
    if (!arb.yesTokenId || !arb.noTokenId || arb.yesAsk <= 0 || arb.noAsk <= 0) return null;

    const sumAsks = arb.yesAsk + arb.noAsk;
    if (sumAsks < MIN_VALID_SUM_ASKS || sumAsks > MAX_VALID_SUM_ASKS) return null;
    const grossEdge = (1 - sumAsks) / Math.max(sumAsks, 0.0001);
    if (grossEdge <= 0 || grossEdge > MAX_VALID_GROSS_EDGE) return null;

    const id = `poly-binary-${arb.conditionId}`;
    const snapshots = this.snapshots.get(id) || [];
    const topDepth = (arb.bidDepth || 0) + (arb.askDepth || 0);
    const profitableDepth = Math.min(arb.bidDepth || 0, arb.askDepth || 0);
    if (!decision) return null;

    if (!isValidPrice(arb.yesAsk) || !isValidPrice(arb.noAsk)) return null;
    const recommendedCapUsd = decision.recommended_cap;
    const contracts = roundContracts(recommendedCapUsd / sumAsks);

    const legs: TradeLeg[] = [
      {
        venue: "POLYMARKET",
        side: "BUY",
        instrument: arb.market,
        outcome: "YES",
        bestBid: arb.yesBid,
        bestAsk: arb.yesAsk,
        price: arb.yesAsk,
        contracts,
        notionalUsd: contracts * arb.yesAsk,
        tokenId: arb.yesTokenId,
        conditionId: arb.conditionId,
      },
      {
        venue: "POLYMARKET",
        side: "BUY",
        instrument: arb.market,
        outcome: "NO",
        bestBid: arb.noBid,
        bestAsk: arb.noAsk,
        price: arb.noAsk,
        contracts,
        notionalUsd: contracts * arb.noAsk,
        tokenId: arb.noTokenId,
        conditionId: arb.conditionId,
      },
    ];

    return this.finalizePlan({
      id,
      venue: "POLYMARKET",
      strategy: "BINARY_BUY_BOTH",
      title: arb.market,
      contractUrl: arb.marketUrl || undefined,
      expiryDate: arb.endDate,
      grossEdgePerDollar: grossEdge,
      decision,
      estimatedFeesUsd: 0,
      recommendedCapUsd,
      legs,
      modelInputs: {
        snapshots: snapshots.length,
        topBookDepthUsd: topDepth,
        profitableDepthUsd: profitableDepth,
        edgePersistence: snapshots.filter((s) => s.grossEdgePerDollar > 0).length / Math.max(1, snapshots.length),
      },
    });
  }

  private buildPolymarketEventPlan(arb: NegRiskArbOpportunity, decision?: ModelDecision): TradePlan | null {
    if (arb.type !== "BUY_ALL_YES") return null;
    const outcomes = arb.outcomes.filter((o) => isValidPrice(o.bestAsk) && !!o.yesTokenId && !!o.conditionId);
    if (outcomes.length < 2) return null;

    if (arb.sumBestAsk < MIN_VALID_SUM_ASKS || arb.sumBestAsk > MAX_VALID_SUM_ASKS) return null;
    const grossEdge = (1 - arb.sumBestAsk) / Math.max(arb.sumBestAsk, 0.0001);
    if (grossEdge <= 0 || grossEdge > MAX_VALID_GROSS_EDGE) return null;

    const id = `poly-event-${arb.negRiskMarketId}`;
    const snapshots = this.snapshots.get(id) || [];

    const depthWithinBand = outcomes.reduce((sum, o) => sum + Math.max(0, Math.min(o.bestAsk, o.bestBid)), 0) * 1000;
    const topDepth = outcomes.reduce((sum, o) => sum + Math.max(o.bestAsk, o.bestBid) * 1000, 0);

    if (!decision) return null;

    const recommendedCapUsd = decision.recommended_cap;
    const contracts = roundContracts(recommendedCapUsd / arb.sumBestAsk);

    const legs: TradeLeg[] = outcomes.map((o) => ({
      venue: "POLYMARKET",
      side: "BUY",
      instrument: o.question,
      outcome: "YES",
      bestBid: o.bestBid,
      bestAsk: o.bestAsk,
      price: o.bestAsk,
      contracts,
      notionalUsd: contracts * o.bestAsk,
      tokenId: o.yesTokenId,
      conditionId: o.conditionId,
      negRisk: true,
    }));

    return this.finalizePlan({
      id,
      venue: "POLYMARKET",
      strategy: "EVENT_BUY_ALL_YES",
      title: arb.event,
      contractUrl: arb.eventUrl || outcomes[0]?.marketUrl || undefined,
      expiryDate: arb.eventEndDate,
      grossEdgePerDollar: grossEdge,
      decision,
      estimatedFeesUsd: 0,
      recommendedCapUsd,
      legs,
      modelInputs: {
        snapshots: snapshots.length,
        topBookDepthUsd: topDepth,
        profitableDepthUsd: depthWithinBand,
        edgePersistence: snapshots.filter((s) => s.grossEdgePerDollar > 0).length / Math.max(1, snapshots.length),
      },
    });
  }

  private buildKalshiBinaryPlan(arb: KalshiBinaryMispricing, decision?: ModelDecision): TradePlan | null {
    if (arb.type !== "BUY_BOTH") return null;
    if (!isValidPrice(arb.yesAsk) || !isValidPrice(arb.noAsk)) return null;

    const sumAsks = arb.yesAsk + arb.noAsk;
    if (sumAsks < MIN_VALID_SUM_ASKS || sumAsks > MAX_VALID_SUM_ASKS) return null;
    const grossEdge = (1 - sumAsks) / Math.max(sumAsks, 0.0001);
    if (grossEdge <= 0 || grossEdge > MAX_VALID_GROSS_EDGE) return null;

    const id = `kalshi-binary-${arb.ticker}`;
    const snapshots = this.snapshots.get(id) || [];
    const depthWithinBand = (arb.liquidity || 0) * 0.02;
    if (!decision) return null;

    const recommendedCapUsd = decision.recommended_cap;
    const contracts = roundContracts(recommendedCapUsd / sumAsks);

    const feeYes = calcKalshiFee(contracts, arb.yesAsk, this.state.settings.kalshiUseMakerFees);
    const feeNo = calcKalshiFee(contracts, arb.noAsk, this.state.settings.kalshiUseMakerFees);
    const estimatedFeesUsd = feeYes + feeNo;

    const legs: TradeLeg[] = [
      {
        venue: "KALSHI",
        side: "BUY",
        instrument: arb.market,
        outcome: "YES",
        bestBid: arb.yesBid,
        bestAsk: arb.yesAsk,
        price: arb.yesAsk,
        contracts,
        notionalUsd: contracts * arb.yesAsk,
        ticker: arb.ticker,
      },
      {
        venue: "KALSHI",
        side: "BUY",
        instrument: arb.market,
        outcome: "NO",
        bestBid: arb.noBid,
        bestAsk: arb.noAsk,
        price: arb.noAsk,
        contracts,
        notionalUsd: contracts * arb.noAsk,
        ticker: arb.ticker,
      },
    ];

    return this.finalizePlan({
      id,
      venue: "KALSHI",
      strategy: "BINARY_BUY_BOTH",
      title: arb.market,
      contractUrl: arb.kalshiUrl || undefined,
      expiryDate: arb.closeTime,
      grossEdgePerDollar: grossEdge,
      decision,
      estimatedFeesUsd,
      recommendedCapUsd,
      legs,
      modelInputs: {
        snapshots: snapshots.length,
        topBookDepthUsd: arb.liquidity || 0,
        profitableDepthUsd: depthWithinBand,
        edgePersistence: snapshots.filter((s) => s.grossEdgePerDollar > 0).length / Math.max(1, snapshots.length),
      },
    });
  }

  private buildKalshiEventPlan(arb: KalshiEventGroupArb, decision?: ModelDecision): TradePlan | null {
    if (arb.type !== "BUY_ALL_YES") return null;
    const outcomes = arb.outcomes.filter((o) => isValidPrice(o.yesAsk) && !!o.ticker);
    if (outcomes.length < 2) return null;

    if (arb.sumYesAsks < MIN_VALID_SUM_ASKS || arb.sumYesAsks > MAX_VALID_SUM_ASKS) return null;
    const grossEdge = (1 - arb.sumYesAsks) / Math.max(arb.sumYesAsks, 0.0001);
    if (grossEdge <= 0 || grossEdge > MAX_VALID_GROSS_EDGE) return null;

    const id = `kalshi-event-${arb.eventTicker}`;
    const snapshots = this.snapshots.get(id) || [];

    const topDepth = outcomes.length * 1500;
    const depthWithinBand = outcomes.length * 800;

    if (!decision) return null;

    const recommendedCapUsd = decision.recommended_cap;
    const contracts = roundContracts(recommendedCapUsd / arb.sumYesAsks);

    const legs: TradeLeg[] = outcomes.map((o) => ({
      venue: "KALSHI",
      side: "BUY",
      instrument: o.title,
      outcome: "YES",
      bestBid: o.yesBid,
      bestAsk: o.yesAsk,
      price: o.yesAsk,
      contracts,
      notionalUsd: contracts * o.yesAsk,
      ticker: o.ticker,
    }));

    const estimatedFeesUsd = legs.reduce(
      (sum, leg) => sum + calcKalshiFee(leg.contracts, leg.price, this.state.settings.kalshiUseMakerFees),
      0
    );

    return this.finalizePlan({
      id,
      venue: "KALSHI",
      strategy: "EVENT_BUY_ALL_YES",
      title: arb.eventTitle,
      contractUrl: outcomes[0]?.ticker
        ? `https://kalshi.com/markets/${encodeURIComponent(outcomes[0].ticker)}`
        : undefined,
      expiryDate: arb.eventCloseTime,
      grossEdgePerDollar: grossEdge,
      decision,
      estimatedFeesUsd,
      recommendedCapUsd,
      legs,
      modelInputs: {
        snapshots: snapshots.length,
        topBookDepthUsd: topDepth,
        profitableDepthUsd: depthWithinBand,
        edgePersistence: snapshots.filter((s) => s.grossEdgePerDollar > 0).length / Math.max(1, snapshots.length),
      },
    });
  }

  private buildCrossMarketPlan(arb: CrossMarketPairCandidate, decision?: ModelDecision): TradePlan | null {
    if (!decision) return null;
    if (!isValidSumAsks(arb.bestCostC1)) return null;
    const grossEdge = (1 - arb.bestCostC1) / Math.max(arb.bestCostC1, 0.0001);
    if (!isValidGrossEdge(grossEdge)) return null;
    if (!arb.polyConditionId || !arb.kalshiTicker) return null;

    const id = `cross-${arb.pairId}`;
    const snapshots = this.snapshots.get(id) || [];
    const recommendedCapUsd = decision.recommended_cap;
    const contracts = roundContracts(recommendedCapUsd / arb.bestCostC1);
    const selectedKalAsk = arb.bestDirection === "BUY_KY_PN" ? arb.kalshiYesAsk : arb.kalshiNoAsk;
    const selectedKalBid = arb.bestDirection === "BUY_KY_PN" ? arb.kalshiYesBid : arb.kalshiNoBid;
    const selectedKalOutcome = arb.bestDirection === "BUY_KY_PN" ? "YES" : "NO";
    const selectedPolyAsk = arb.bestDirection === "BUY_KY_PN" ? arb.polyNoAsk : arb.polyYesAsk;
    const selectedPolyBid = arb.bestDirection === "BUY_KY_PN" ? arb.polyNoBid : arb.polyYesBid;
    const selectedPolyOutcome = arb.bestDirection === "BUY_KY_PN" ? "NO" : "YES";
    const selectedPolyTokenId = arb.bestDirection === "BUY_KY_PN" ? arb.polyNoTokenId : arb.polyYesTokenId;
    if (!selectedPolyTokenId) return null;

    const estimatedFeesUsd = contracts * arb.selectedKalFeeC1;
    const legs: TradeLeg[] = [
      {
        venue: "KALSHI",
        side: "BUY",
        instrument: arb.title,
        outcome: selectedKalOutcome,
        bestBid: selectedKalBid,
        bestAsk: selectedKalAsk,
        price: selectedKalAsk,
        contracts,
        notionalUsd: contracts * selectedKalAsk,
        ticker: arb.kalshiTicker,
      },
      {
        venue: "POLYMARKET",
        side: "BUY",
        instrument: arb.title,
        outcome: selectedPolyOutcome,
        bestBid: selectedPolyBid,
        bestAsk: selectedPolyAsk,
        price: selectedPolyAsk,
        contracts,
        notionalUsd: contracts * selectedPolyAsk,
        tokenId: selectedPolyTokenId,
        conditionId: arb.polyConditionId,
      },
    ];

    const primaryUrl = arb.polyMarketUrl || arb.kalshiMarketUrl;
    return this.finalizePlan({
      id,
      venue: "CROSS",
      strategy: "CROSS_MARKET_BOX",
      title: `${arb.title} (${arb.bestDirection})`,
      contractUrl: primaryUrl || undefined,
      expiryDate: arb.expiryDate,
      grossEdgePerDollar: grossEdge,
      decision,
      estimatedFeesUsd,
      recommendedCapUsd,
      legs,
      modelInputs: {
        snapshots: snapshots.length,
        topBookDepthUsd: arb.topBookDepthUsd,
        profitableDepthUsd: arb.depthWithinProfitableBandUsd,
        edgePersistence: snapshots.filter((s) => s.grossEdgePerDollar > 0).length / Math.max(1, snapshots.length),
      },
    });
  }

  private finalizePlan(input: {
    id: string;
    venue: Venue;
    strategy: Strategy;
    title: string;
    contractUrl?: string;
    expiryDate?: string;
    grossEdgePerDollar: number;
    decision: ModelDecision;
    estimatedFeesUsd: number;
    recommendedCapUsd: number;
    legs: TradeLeg[];
    modelInputs: TradePlan["modelInputs"];
  }): TradePlan {
    const capLimit = this.state.settings.bankrollUsd * MAX_CAP_RATIO;
    const boundedCap = clamp(input.recommendedCapUsd, 0, capLimit);
    const hasLegs = input.legs.length > 0 && input.legs.every((l) => l.contracts > 0 && isValidPrice(l.price));
    const feePerDollar = input.estimatedFeesUsd / Math.max(boundedCap, 1);
    const expectedNetEdge = clamp(input.decision.expected_net_edge - feePerDollar, -MAX_VALID_MODEL_NET_EDGE, MAX_VALID_MODEL_NET_EDGE);
    const thresholdOk = expectedNetEdge >= this.state.settings.minNetEdge;
    const riskOk = input.grossEdgePerDollar > 0 && input.grossEdgePerDollar <= MAX_VALID_GROSS_EDGE;

    return {
      id: input.id,
      venue: input.venue,
      strategy: input.strategy,
      title: input.title,
      contractUrl: input.contractUrl,
      expiryDate: input.expiryDate,
      createdAt: new Date().toISOString(),
      status: hasLegs && thresholdOk && riskOk ? "READY" : "SKIPPED",
      executable: hasLegs,
      grossEdgePerDollar: input.grossEdgePerDollar,
      expectedSlippage: input.decision.expected_slippage,
      fillProb20s: input.decision.fill_prob_20s,
      expectedNetEdge,
      estimatedFeesUsd: input.estimatedFeesUsd,
      expectedGrossProfitUsd: boundedCap * input.grossEdgePerDollar,
      expectedNetProfitUsd: boundedCap * expectedNetEdge,
      recommendedCapUsd: boundedCap,
      modelInputs: input.modelInputs,
      legs: input.legs,
      reason: hasLegs
        ? thresholdOk
          ? (riskOk ? undefined : "Opportunity failed risk sanity checks")
          : "Net edge below configured threshold"
        : "Trade size rounds to zero; increase bankroll or lower min edge",
    };
  }

  private async executePolymarketLeg(leg: TradeLeg): Promise<string | null> {
    if (!leg.tokenId || leg.contracts <= 0) return null;
    const client = await this.getPolymarketClient();
    if (!client) return null;

    return client.placeBuyOrder(
      leg.tokenId,
      leg.price,
      leg.contracts,
      Boolean(leg.negRisk),
      this.state.settings.defaultLegTickSize
    );
  }

  private async getPolymarketClient(): Promise<PolymarketClientLike | null> {
    if (!this.polymarketClientPromise) {
      this.polymarketClientPromise = (async () => {
        const [{ RpcRotator }, { PolymarketClient }] = await Promise.all([
          import("../rpcRotator"),
          import("../polymarketClient"),
        ]);
        const rotator = new RpcRotator();
        const client = new PolymarketClient(rotator) as PolymarketClientLike;
        await client.initialize();
        await client.ensureApprovals();
        return client;
      })().catch(() => null);
    }
    return this.polymarketClientPromise;
  }

  private async executeKalshiLeg(leg: TradeLeg): Promise<string | null> {
    const settings = getSettings();
    const base = settings.apiKeys.kalshi.tradingApiUrl || settings.apiKeys.kalshi.apiUrl;
    if (!hasKalshiLiveTradingCredentials(settings)) return null;
    const apiKey = settings.apiKeys.kalshi.apiKey;
    const apiSecret = settings.apiKeys.kalshi.apiSecret;

    if (!base || !apiKey || !apiSecret || !leg.ticker || leg.contracts <= 0) {
      return null;
    }

    const side = leg.outcome === "NO" ? "no" : "yes";
    const payload: Record<string, any> = {
      ticker: leg.ticker,
      side,
      action: "buy",
      count: Math.max(1, Math.floor(leg.contracts)),
      type: "limit",
      client_order_id: `arb-${Date.now()}-${Math.floor(Math.random() * 10_000)}`,
    };
    if (side === "yes") payload.yes_price = Math.round(leg.price * 100);
    if (side === "no") payload.no_price = Math.round(leg.price * 100);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "KALSHI-ACCESS-KEY": apiKey,
      "KALSHI-ACCESS-SECRET": apiSecret,
    };
    if (settings.apiKeys.kalshi.apiPassphrase) {
      headers["KALSHI-ACCESS-PASSPHRASE"] = settings.apiKeys.kalshi.apiPassphrase;
    }
    if (settings.apiKeys.kalshi.bearerToken) {
      headers.Authorization = `Bearer ${settings.apiKeys.kalshi.bearerToken}`;
    }

    const endpoint = settings.apiKeys.kalshi.orderEndpoint || `${base.replace(/\/$/, "")}/portfolio/orders`;
    const resp = await axios.post(endpoint, payload, { headers, timeout: 15_000 });

    return resp.data?.order?.order_id || resp.data?.order_id || payload.client_order_id;
  }

  private computeLiveReadiness(): ExecutionState["liveReadiness"] {
    const settings = getSettings();
    const modeValidation = validateSettingsForMode(this.state.settings.mode, settings);

    const polymarketReady = Boolean(
      settings.apiKeys.polymarket.privateKey &&
      settings.apiKeys.polymarket.proxyWalletAddress &&
      settings.apiKeys.polymarket.rpcUrl
    );

    const kalshiReady = hasKalshiLiveTradingCredentials(settings);

    return {
      polymarketReady,
      kalshiReady,
      reasons: modeValidation.reasons,
    };
  }

  getHealth() {
    return {
      ok: true,
      stateSummary: {
        plans: this.state.plans.length,
        readyPlans: this.state.plans.filter((p) => p.status === "READY").length,
        refreshSeq: this.state.refreshSeq,
        refreshing: this.state.refreshing,
        lastRefreshAt: this.state.lastRefreshAt,
        refreshError: this.state.refreshError,
      },
    };
  }

  exportPlansCsv(): string {
    const header = [
      "id",
      "venue",
      "strategy",
      "title",
      "contractUrl",
      "status",
      "executable",
      "expectedNetEdge",
      "expectedNetProfitUsd",
      "recommendedCapUsd",
      "fillProb20s",
      "refreshSeq",
    ];
    const rows = this.state.plans.map((p) => [
      p.id,
      p.venue,
      p.strategy,
      p.title,
      p.contractUrl || "",
      p.status,
      String(p.executable),
      p.expectedNetEdge.toFixed(8),
      p.expectedNetProfitUsd.toFixed(8),
      p.recommendedCapUsd.toFixed(8),
      p.fillProb20s.toFixed(8),
      String(this.state.refreshSeq),
    ]);
    return [header, ...rows].map((r) => r.map(csvEscape).join(",")).join("\n");
  }

  exportHistoryCsv(): string {
    const header = [
      "timestamp",
      "planId",
      "mode",
      "status",
      "message",
      "expectedNetProfitUsd",
      "realizedProfitUsd",
      "orderIds",
    ];
    const rows = this.state.history.map((h) => [
      h.timestamp,
      h.planId,
      h.mode,
      h.status,
      h.message,
      h.expectedNetProfitUsd.toFixed(8),
      h.realizedProfitUsd.toFixed(8),
      h.orderIds.join("|"),
    ]);
    return [header, ...rows].map((r) => r.map(csvEscape).join(",")).join("\n");
  }

  exportHistoryJson(pretty = true): string {
    return JSON.stringify(this.state.history, null, pretty ? 2 : 0);
  }

  readHistoryJsonl(): string {
    if (!fs.existsSync(this.executionLogPath)) return "";
    return fs.readFileSync(this.executionLogPath, "utf8");
  }

  getExecutionLogPath(): string {
    return this.executionLogPath;
  }

  getTradeLogPath(): string {
    return this.tradeLogPath;
  }

  getCrossOpportunities(): TradePlan[] {
    return [...this.crossOpportunities].sort((a, b) => b.expectedNetProfitUsd - a.expectedNetProfitUsd);
  }

  private sessionStamp(): string {
    const d = new Date();
    const y = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
    const da = String(d.getUTCDate()).padStart(2, "0");
    const h = String(d.getUTCHours()).padStart(2, "0");
    const mi = String(d.getUTCMinutes()).padStart(2, "0");
    const s = String(d.getUTCSeconds()).padStart(2, "0");
    const ms = String(d.getUTCMilliseconds()).padStart(3, "0");
    return `${y}${mo}${da}-${h}${mi}${s}${ms}`;
  }

  private writeTradeLog(record: ExecutionRecord): void {
    const plan = this.state.plans.find((p) => p.id === record.planId);
    const line = [
      `[${record.timestamp}]`,
      `status=${record.status}`,
      `mode=${record.mode}`,
      `planId=${record.planId}`,
      `venue=${plan?.venue || "UNKNOWN"}`,
      `strategy=${plan?.strategy || "UNKNOWN"}`,
      `legs=${plan?.legs.length ?? 0}`,
      `expectedNet=${record.expectedNetProfitUsd.toFixed(2)}`,
      `realized=${record.realizedProfitUsd.toFixed(2)}`,
      `orders=${record.orderIds.join("|") || "-"}`,
      `message=${record.message}`,
    ].join(" ");
    fs.appendFileSync(this.tradeLogPath, `${line}\n`, "utf8");
  }

  private pushHistory(record: ExecutionRecord): ExecutionRecord {
    this.state.history = [record, ...this.state.history].slice(0, MAX_HISTORY);
    try {
      fs.appendFileSync(this.executionLogPath, `${JSON.stringify(record)}\n`, "utf8");
      this.writeTradeLog(record);
    } catch {
      // best-effort logging; keep runtime execution path non-fatal
    }
    return record;
  }
}

function csvEscape(value: string): string {
  const s = value ?? "";
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, "\"\"")}"`;
  }
  return s;
}
