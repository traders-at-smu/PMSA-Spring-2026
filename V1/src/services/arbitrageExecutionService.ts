import axios from "axios";
import fs from "fs";
import path from "path";
import { ArbitrageScreener, BinaryArbOpportunity, NegRiskArbOpportunity } from "../screener";
import { KalshiBinaryMispricing, KalshiEventGroupArb, KalshiScreener } from "../kalshiScreener";
import { CrossPlatformScreener, CrossPlatformArb } from "../crossPlatformScreener";
import { getSettings, validateSettingsForMode } from "../runtimeSettings";
import { ModelBatchItem, PythonModelClient } from "./pythonModelClient";

const MAX_HISTORY = 25;
const REFRESH_TIMEOUT_MS = 120_000; // 2 min – events-based Kalshi fetch takes ~15s

type Venue = "POLYMARKET" | "KALSHI" | "CROSS";
type Strategy = "BINARY_BUY_BOTH" | "EVENT_BUY_ALL_YES" | "CROSS_PLATFORM";
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
  venue: Venue;
  side: "BUY";
  instrument: string;
  outcome: string;
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

function roundContracts(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value * 100) / 100;
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

export class ArbitrageExecutionService {
  private polymarketScreener = new ArbitrageScreener();
  private kalshiScreener = new KalshiScreener();
  private modelClient = new PythonModelClient();
  private snapshots = new Map<string, RecentSnapshot[]>();
  private paperExecutedPlanIds = new Set<string>();
  private crossPlatformScreener: CrossPlatformScreener | null = null;
  private polymarketClientPromise: Promise<PolymarketClientLike | null> | null = null;
  private refreshInFlight: Promise<ExecutionState> | null = null;
  private executionLogPath: string;

  private state: ExecutionState;

  constructor() {
    const settings = getSettings();
    const logDir = path.resolve(process.cwd(), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    this.executionLogPath = path.join(logDir, "execution-history.jsonl");
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

  setCrossPlatformScreener(screener: CrossPlatformScreener): void {
    this.crossPlatformScreener = screener;
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

    try {
      const [polyResult, kalshiResult, crossResult] = await withTimeout(
        Promise.allSettled([
          withTimeout(this.getPolymarketExecutionCandidates(), 60_000, "Polymarket refresh"),
          withTimeout(this.getKalshiExecutionCandidates(), 90_000, "Kalshi refresh"),
          withTimeout(this.getCrossPlatformExecutionCandidates(), 90_000, "Cross-platform refresh"),
        ]),
        REFRESH_TIMEOUT_MS,
        "Execution refresh"
      );

      const polyData = polyResult.status === "fulfilled" ? polyResult.value : null;
      const kalshiData = kalshiResult.status === "fulfilled" ? kalshiResult.value : null;
      const decisionMap = await this.buildModelDecisionMap(polyData, kalshiData, warnings);

      let polyPlans: TradePlan[] = [];
      if (polyResult.status === "fulfilled") {
        const data = polyResult.value;
        for (const arb of data.binaryArbs) {
          const plan = this.buildPolymarketBinaryPlan(
            arb,
            decisionMap.get(`poly-binary-${arb.conditionId}`)
          );
          if (plan) polyPlans.push(plan);
        }
        for (const arb of data.negRiskArbs) {
          const plan = this.buildPolymarketEventPlan(
            arb,
            decisionMap.get(`poly-event-${arb.negRiskMarketId}`)
          );
          if (plan) polyPlans.push(plan);
        }
      } else {
        warnings.push(`Polymarket refresh failed: ${polyResult.reason?.message || polyResult.reason}`);
        polyPlans = priorPoly;
      }

      let kalshiPlans: TradePlan[] = [];
      if (kalshiResult.status === "fulfilled") {
        const data = kalshiResult.value;
        for (const arb of data.binaryArbs) {
          const plan = this.buildKalshiBinaryPlan(
            arb,
            decisionMap.get(`kalshi-binary-${arb.ticker}`)
          );
          if (plan) kalshiPlans.push(plan);
        }
        for (const arb of data.eventArbs) {
          const plan = this.buildKalshiEventPlan(
            arb,
            decisionMap.get(`kalshi-event-${arb.eventTicker}`)
          );
          if (plan) kalshiPlans.push(plan);
        }
      } else {
        warnings.push(`Kalshi refresh failed: ${kalshiResult.reason?.message || kalshiResult.reason}`);
        kalshiPlans = priorKalshi;
      }

      let crossPlans: TradePlan[] = [];
      if (crossResult.status === "fulfilled") {
        for (const arb of crossResult.value) {
          const plan = this.buildCrossPlatformPlan(arb);
          if (plan) crossPlans.push(plan);
        }
      } else {
        warnings.push(`Cross-platform refresh failed: ${(crossResult as PromiseRejectedResult).reason?.message || (crossResult as PromiseRejectedResult).reason}`);
        crossPlans = priorCross;
      }

      const plans = [...polyPlans, ...kalshiPlans, ...crossPlans]
        .sort((a, b) => b.expectedNetProfitUsd - a.expectedNetProfitUsd)
        .slice(0, 60);

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
      this.state.liveReadiness = this.computeLiveReadiness();

      if (this.state.settings.autoExecute) {
        await this.executeTopPlans(3);
      }
    } catch (err: any) {
      this.state.refreshError = err?.message || "Failed to refresh opportunities";
    }

    return this.state;
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

  private async getCrossPlatformExecutionCandidates(): Promise<CrossPlatformArb[]> {
    if (!this.crossPlatformScreener) return [];
    const results = await this.crossPlatformScreener.getResults();
    return results.arbs.filter(
      (a) =>
        a.netProfit > 0.001 &&    // At least 0.1 cent net profit
        a.polyYesTokenId &&
        a.buyYesPrice >= 0.01 &&  // Min 1 cent per leg
        a.buyNoPrice >= 0.01 &&
        (a.buyYesPrice + a.buyNoPrice) >= 0.10 && // Min 10 cents total cost
        a.similarityScore >= 0.25  // High-confidence match
    );
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
    const venueNotReady =
      (plan.venue === "POLYMARKET" && !readiness.polymarketReady) ||
      (plan.venue === "KALSHI" && !readiness.kalshiReady) ||
      (plan.venue === "CROSS" && (!readiness.polymarketReady || !readiness.kalshiReady));
    if (venueNotReady) {
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
    for (const plan of this.state.plans) {
      if (records.length >= limit) break;
      if (plan.status !== "READY") continue;
      records.push(await this.executePlan(plan.id));
    }
    return records;
  }

  private recordSnapshot(opportunityId: string, grossEdgePerDollar: number): RecentSnapshot[] {
    const current = this.snapshots.get(opportunityId) || [];
    current.push({ timestamp: new Date().toISOString(), grossEdgePerDollar });
    const trimmed = current.slice(-3);
    this.snapshots.set(opportunityId, trimmed);
    return trimmed;
  }

  private async buildModelDecisionMap(
    polyData: { binaryArbs: BinaryArbOpportunity[]; negRiskArbs: NegRiskArbOpportunity[] } | null,
    kalshiData: { binaryArbs: KalshiBinaryMispricing[]; eventArbs: KalshiEventGroupArb[] } | null,
    warnings: string[]
  ): Promise<Map<string, ModelDecision>> {
    const items: ModelBatchItem[] = [];

    if (polyData) {
      for (const arb of polyData.binaryArbs) {
        if (arb.type !== "BUY_BOTH" || !arb.yesTokenId || !arb.noTokenId || arb.yesAsk <= 0 || arb.noAsk <= 0) continue;
        const id = `poly-binary-${arb.conditionId}`;
        const sumAsks = arb.yesAsk + arb.noAsk;
        const grossEdge = (1 - sumAsks) / Math.max(sumAsks, 0.0001);
        if (grossEdge <= 0) continue;
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
        if (grossEdge <= 0) continue;
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
        if (grossEdge <= 0) continue;
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
        if (grossEdge <= 0) continue;
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

    if (items.length === 0) {
      return new Map<string, ModelDecision>();
    }

    try {
      const decisions = await this.modelClient.evaluateBatch(items, this.state.settings.bankrollUsd);
      return new Map(decisions.map((d) => [d.id, d.decision]));
    } catch (err: any) {
      warnings.push(`Model v1 bridge failed: ${err?.message || err}`);
      return new Map<string, ModelDecision>();
    }
  }

  private buildPolymarketBinaryPlan(arb: BinaryArbOpportunity, decision?: ModelDecision): TradePlan | null {
    if (arb.type !== "BUY_BOTH") return null;
    if (!arb.yesTokenId || !arb.noTokenId || arb.yesAsk <= 0 || arb.noAsk <= 0) return null;

    const grossEdge = (1 - (arb.yesAsk + arb.noAsk)) / Math.max(arb.yesAsk + arb.noAsk, 0.0001);
    if (grossEdge <= 0) return null;

    const id = `poly-binary-${arb.conditionId}`;
    const snapshots = this.snapshots.get(id) || [];
    const topDepth = (arb.bidDepth || 0) + (arb.askDepth || 0);
    const profitableDepth = Math.min(arb.bidDepth || 0, arb.askDepth || 0);
    if (!decision) return null;

    const recommendedCapUsd = decision.recommended_cap;
    const contracts = roundContracts(recommendedCapUsd / (arb.yesAsk + arb.noAsk));

    const legs: TradeLeg[] = [
      {
        venue: "POLYMARKET",
        side: "BUY",
        instrument: arb.market,
        outcome: "YES",
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
    const outcomes = arb.outcomes.filter((o) => o.bestAsk > 0 && !!o.yesTokenId && !!o.conditionId);
    if (outcomes.length < 2) return null;

    const grossEdge = (1 - arb.sumBestAsk) / Math.max(arb.sumBestAsk, 0.0001);
    if (grossEdge <= 0) return null;

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
    if (arb.yesAsk <= 0 || arb.noAsk <= 0) return null;

    const grossEdge = (1 - (arb.yesAsk + arb.noAsk)) / Math.max(arb.yesAsk + arb.noAsk, 0.0001);
    if (grossEdge <= 0) return null;

    const id = `kalshi-binary-${arb.ticker}`;
    const snapshots = this.snapshots.get(id) || [];
    const depthWithinBand = (arb.liquidity || 0) * 0.02;
    if (!decision) return null;

    const recommendedCapUsd = decision.recommended_cap;
    const contracts = roundContracts(recommendedCapUsd / (arb.yesAsk + arb.noAsk));

    const feeYes = calcKalshiFee(contracts, arb.yesAsk, this.state.settings.kalshiUseMakerFees);
    const feeNo = calcKalshiFee(contracts, arb.noAsk, this.state.settings.kalshiUseMakerFees);
    const estimatedFeesUsd = feeYes + feeNo;

    const legs: TradeLeg[] = [
      {
        venue: "KALSHI",
        side: "BUY",
        instrument: arb.market,
        outcome: "YES",
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
    const outcomes = arb.outcomes.filter((o) => o.yesAsk > 0 && !!o.ticker);
    if (outcomes.length < 2) return null;

    const grossEdge = (1 - arb.sumYesAsks) / Math.max(arb.sumYesAsks, 0.0001);
    if (grossEdge <= 0) return null;

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

  private buildCrossPlatformPlan(arb: CrossPlatformArb): TradePlan | null {
    if (arb.netProfit <= 0) return null;

    const totalCostPerContract = arb.buyYesPrice + arb.buyNoPrice;
    if (totalCostPerContract <= 0) return null;

    const id = `cross-${arb.polymarketSlug}-${arb.kalshiTicker}`;
    const grossEdge = arb.grossProfit / totalCostPerContract;

    // Size: how many contracts can we buy with our bankroll?
    const contracts = roundContracts(this.state.settings.bankrollUsd / totalCostPerContract);
    if (contracts <= 0) return null;

    // Determine which outcome to buy on each venue
    const polyOutcome = arb.buyYesVenue === "POLYMARKET" ? "YES" : "NO";
    const kalshiOutcome = arb.buyYesVenue === "KALSHI" ? "YES" : "NO";
    const polyPrice = arb.buyYesVenue === "POLYMARKET" ? arb.buyYesPrice : arb.buyNoPrice;
    const kalshiPrice = arb.buyYesVenue === "KALSHI" ? arb.buyYesPrice : arb.buyNoPrice;

    // Token ID: if buying YES on Poly, use yesTokenId; if buying NO, use noTokenId
    const polyTokenId = polyOutcome === "YES" ? arb.polyYesTokenId : arb.polyNoTokenId;
    if (!polyTokenId || !arb.kalshiTicker) return null;

    // Calculate fees
    const polyFee = polyPrice * 0.001 * contracts; // Polymarket 0.1% taker
    const kalshiFee = calcKalshiFee(contracts, kalshiPrice, this.state.settings.kalshiUseMakerFees);
    const estimatedFeesUsd = polyFee + kalshiFee;

    const expectedNetProfitUsd = contracts * arb.netProfit;
    const expectedGrossProfitUsd = contracts * arb.grossProfit;

    const legs: TradeLeg[] = [
      {
        venue: "POLYMARKET",
        side: "BUY",
        instrument: arb.event,
        outcome: polyOutcome,
        price: polyPrice,
        contracts,
        notionalUsd: contracts * polyPrice,
        tokenId: polyTokenId,
        conditionId: arb.polyConditionId,
        negRisk: arb.polyNegRisk,
      },
      {
        venue: "KALSHI",
        side: "BUY",
        instrument: arb.event,
        outcome: kalshiOutcome,
        price: kalshiPrice,
        contracts,
        notionalUsd: contracts * kalshiPrice,
        ticker: arb.kalshiTicker,
      },
    ];

    const hasLegs = legs.every((l) => l.contracts > 0 && l.price > 0);

    return {
      id,
      venue: "CROSS",
      strategy: "CROSS_PLATFORM",
      title: `${arb.event} (${arb.buyYesVenue} YES / ${arb.buyNoVenue} NO)`,
      contractUrl: arb.polymarketUrl || arb.kalshiUrl || undefined,
      createdAt: new Date().toISOString(),
      status: hasLegs && expectedNetProfitUsd > 0 ? "READY" : "SKIPPED",
      executable: hasLegs,
      grossEdgePerDollar: grossEdge,
      expectedSlippage: 0,
      fillProb20s: 1,
      expectedNetEdge: arb.netProfit / totalCostPerContract,
      estimatedFeesUsd,
      expectedGrossProfitUsd,
      expectedNetProfitUsd,
      recommendedCapUsd: contracts * totalCostPerContract,
      modelInputs: {
        snapshots: 0,
        topBookDepthUsd: 0,
        profitableDepthUsd: 0,
        edgePersistence: 0,
      },
      legs,
      reason: hasLegs
        ? expectedNetProfitUsd > 0
          ? undefined
          : "Net profit negative after fees"
        : "Missing execution data (tokenId or ticker)",
    };
  }

  private finalizePlan(input: {
    id: string;
    venue: Venue;
    strategy: Strategy;
    title: string;
    contractUrl?: string;
    grossEdgePerDollar: number;
    decision: ModelDecision;
    estimatedFeesUsd: number;
    recommendedCapUsd: number;
    legs: TradeLeg[];
    modelInputs: TradePlan["modelInputs"];
  }): TradePlan {
    const hasLegs = input.legs.length > 0 && input.legs.every((l) => l.contracts > 0 && l.price > 0);
    const feePerDollar = input.estimatedFeesUsd / Math.max(input.recommendedCapUsd, 1);
    const expectedNetEdge = input.decision.expected_net_edge - feePerDollar;
    const thresholdOk = expectedNetEdge >= this.state.settings.minNetEdge;

    return {
      id: input.id,
      venue: input.venue,
      strategy: input.strategy,
      title: input.title,
      contractUrl: input.contractUrl,
      createdAt: new Date().toISOString(),
      status: hasLegs && thresholdOk ? "READY" : "SKIPPED",
      executable: hasLegs,
      grossEdgePerDollar: input.grossEdgePerDollar,
      expectedSlippage: input.decision.expected_slippage,
      fillProb20s: input.decision.fill_prob_20s,
      expectedNetEdge,
      estimatedFeesUsd: input.estimatedFeesUsd,
      expectedGrossProfitUsd: input.recommendedCapUsd * input.grossEdgePerDollar,
      expectedNetProfitUsd: input.recommendedCapUsd * expectedNetEdge,
      recommendedCapUsd: input.recommendedCapUsd,
      modelInputs: input.modelInputs,
      legs: input.legs,
      reason: hasLegs
        ? thresholdOk
          ? undefined
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

    const kalshiReady = Boolean(
      (settings.apiKeys.kalshi.tradingApiUrl || settings.apiKeys.kalshi.apiUrl) &&
      settings.apiKeys.kalshi.apiKey &&
      settings.apiKeys.kalshi.apiSecret
    );

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

  private pushHistory(record: ExecutionRecord): ExecutionRecord {
    this.state.history = [record, ...this.state.history].slice(0, MAX_HISTORY);
    try {
      fs.appendFileSync(this.executionLogPath, `${JSON.stringify(record)}\n`, "utf8");
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
