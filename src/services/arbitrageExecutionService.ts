import axios from "axios";
import { ArbitrageScreener, BinaryArbOpportunity, NegRiskArbOpportunity } from "../screener";
import { KalshiBinaryMispricing, KalshiEventGroupArb, KalshiScreener } from "../kalshiScreener";
import { getSettings, validateSettingsForMode } from "../runtimeSettings";

const MODEL_MAX_CAP_RATIO = 0.2;
const MAX_HISTORY = 25;
const REFRESH_TIMEOUT_MS = 90_000;

type Venue = "POLYMARKET" | "KALSHI";
type Strategy = "BINARY_BUY_BOTH" | "EVENT_BUY_ALL_YES";
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
  private snapshots = new Map<string, RecentSnapshot[]>();
  private polymarketClientPromise: Promise<PolymarketClientLike | null> | null = null;
  private refreshInFlight: Promise<ExecutionState> | null = null;

  private state: ExecutionState;

  constructor() {
    const settings = getSettings();
    this.state = {
      settings: {
        mode: settings.execution.mode,
        autoExecute: settings.execution.autoExecute,
        bankrollUsd: settings.execution.bankrollUsd,
        minNetEdge: settings.execution.minNetEdge,
        defaultLegTickSize: settings.execution.defaultLegTickSize,
        kalshiUseMakerFees: settings.execution.kalshiUseMakerFees,
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
    const warnings: string[] = [];

    try {
      const [polyResult, kalshiResult] = await withTimeout(
        Promise.allSettled([
          withTimeout(this.getPolymarketExecutionCandidates(), 60_000, "Polymarket refresh"),
          withTimeout(this.getKalshiExecutionCandidates(), 60_000, "Kalshi refresh"),
        ]),
        REFRESH_TIMEOUT_MS,
        "Execution refresh"
      );

      let polyPlans: TradePlan[] = [];
      if (polyResult.status === "fulfilled") {
        const data = polyResult.value;
        for (const arb of data.binaryArbs) {
          const plan = this.buildPolymarketBinaryPlan(arb);
          if (plan) polyPlans.push(plan);
        }
        for (const arb of data.negRiskArbs) {
          const plan = this.buildPolymarketEventPlan(arb);
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
          const plan = this.buildKalshiBinaryPlan(arb);
          if (plan) kalshiPlans.push(plan);
        }
        for (const arb of data.eventArbs) {
          const plan = this.buildKalshiEventPlan(arb);
          if (plan) kalshiPlans.push(plan);
        }
      } else {
        warnings.push(`Kalshi refresh failed: ${kalshiResult.reason?.message || kalshiResult.reason}`);
        kalshiPlans = priorKalshi;
      }

      const plans = [...polyPlans, ...kalshiPlans]
        .sort((a, b) => b.expectedNetProfitUsd - a.expectedNetProfitUsd)
        .slice(0, 60);

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
      plan.status = "EXECUTED";
      const realized = plan.expectedNetProfitUsd;
      this.state.paperPnlUsd += realized;
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
    if ((plan.venue === "POLYMARKET" && !readiness.polymarketReady) || (plan.venue === "KALSHI" && !readiness.kalshiReady)) {
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
    const current = this.snapshots.get(opportunityId) || [];
    current.push({ timestamp: new Date().toISOString(), grossEdgePerDollar });
    const trimmed = current.slice(-3);
    this.snapshots.set(opportunityId, trimmed);
    return trimmed;
  }

  private modelDecision(
    grossEdgePerDollar: number,
    lobMetrics: LobMetrics,
    recentSnapshots: RecentSnapshot[]
  ): ModelDecision {
    const persistence = recentSnapshots.length === 0
      ? lobMetrics.edgePersistence
      : recentSnapshots.filter((s) => s.grossEdgePerDollar > 0).length / recentSnapshots.length;

    const effectiveDepth = Math.max(1, Math.min(lobMetrics.topBookDepthUsd, lobMetrics.depthWithinProfitableBandUsd));
    const depthRatio = clamp(effectiveDepth / (this.state.settings.bankrollUsd * MODEL_MAX_CAP_RATIO), 0, 1);

    const fillProb = clamp(depthRatio * 0.7 + persistence * 0.3, 0.05, 0.99);
    const slippageMultiplier = clamp(1 - depthRatio, 0.08, 1);
    const expectedSlippage = grossEdgePerDollar * 0.35 * slippageMultiplier;
    const expectedNetEdge = grossEdgePerDollar - expectedSlippage;

    const edgeStrengthScaled = clamp(expectedNetEdge / 0.05, 0, 1);
    const recommendedCap = this.state.settings.bankrollUsd * Math.min(
      MODEL_MAX_CAP_RATIO,
      fillProb * edgeStrengthScaled
    );

    return {
      expected_slippage: Math.max(0, expectedSlippage),
      fill_prob_20s: fillProb,
      expected_net_edge: expectedNetEdge,
      recommended_cap: Math.max(0, recommendedCap),
    };
  }

  private buildPolymarketBinaryPlan(arb: BinaryArbOpportunity): TradePlan | null {
    if (arb.type !== "BUY_BOTH") return null;
    if (!arb.yesTokenId || !arb.noTokenId || arb.yesAsk <= 0 || arb.noAsk <= 0) return null;

    const grossEdge = (1 - (arb.yesAsk + arb.noAsk)) / Math.max(arb.yesAsk + arb.noAsk, 0.0001);
    if (grossEdge <= 0) return null;

    const id = `poly-binary-${arb.conditionId}`;
    const snapshots = this.recordSnapshot(id, grossEdge);
    const topDepth = (arb.bidDepth || 0) + (arb.askDepth || 0);
    const profitableDepth = Math.min(arb.bidDepth || 0, arb.askDepth || 0);

    const decision = this.modelDecision(grossEdge, {
      topBookDepthUsd: topDepth,
      depthWithinProfitableBandUsd: profitableDepth,
      edgePersistence: 0,
    }, snapshots);

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

  private buildPolymarketEventPlan(arb: NegRiskArbOpportunity): TradePlan | null {
    if (arb.type !== "BUY_ALL_YES") return null;
    const outcomes = arb.outcomes.filter((o) => o.bestAsk > 0 && !!o.yesTokenId && !!o.conditionId);
    if (outcomes.length < 2) return null;

    const grossEdge = (1 - arb.sumBestAsk) / Math.max(arb.sumBestAsk, 0.0001);
    if (grossEdge <= 0) return null;

    const id = `poly-event-${arb.negRiskMarketId}`;
    const snapshots = this.recordSnapshot(id, grossEdge);

    const depthWithinBand = outcomes.reduce((sum, o) => sum + Math.max(0, Math.min(o.bestAsk, o.bestBid)), 0) * 1000;
    const topDepth = outcomes.reduce((sum, o) => sum + Math.max(o.bestAsk, o.bestBid) * 1000, 0);

    const decision = this.modelDecision(grossEdge, {
      topBookDepthUsd: topDepth,
      depthWithinProfitableBandUsd: depthWithinBand,
      edgePersistence: 0,
    }, snapshots);

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

  private buildKalshiBinaryPlan(arb: KalshiBinaryMispricing): TradePlan | null {
    if (arb.type !== "BUY_BOTH") return null;
    if (arb.yesAsk <= 0 || arb.noAsk <= 0) return null;

    const grossEdge = (1 - (arb.yesAsk + arb.noAsk)) / Math.max(arb.yesAsk + arb.noAsk, 0.0001);
    if (grossEdge <= 0) return null;

    const id = `kalshi-binary-${arb.ticker}`;
    const snapshots = this.recordSnapshot(id, grossEdge);
    const depthWithinBand = (arb.liquidity || 0) * 0.02;

    const decision = this.modelDecision(grossEdge, {
      topBookDepthUsd: arb.liquidity || 0,
      depthWithinProfitableBandUsd: depthWithinBand,
      edgePersistence: 0,
    }, snapshots);

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

  private buildKalshiEventPlan(arb: KalshiEventGroupArb): TradePlan | null {
    if (arb.type !== "BUY_ALL_YES") return null;
    const outcomes = arb.outcomes.filter((o) => o.yesAsk > 0 && !!o.ticker);
    if (outcomes.length < 2) return null;

    const grossEdge = (1 - arb.sumYesAsks) / Math.max(arb.sumYesAsks, 0.0001);
    if (grossEdge <= 0) return null;

    const id = `kalshi-event-${arb.eventTicker}`;
    const snapshots = this.recordSnapshot(id, grossEdge);

    const topDepth = outcomes.length * 1500;
    const depthWithinBand = outcomes.length * 800;

    const decision = this.modelDecision(grossEdge, {
      topBookDepthUsd: topDepth,
      depthWithinProfitableBandUsd: depthWithinBand,
      edgePersistence: 0,
    }, snapshots);

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

  private pushHistory(record: ExecutionRecord): ExecutionRecord {
    this.state.history = [record, ...this.state.history].slice(0, MAX_HISTORY);
    return record;
  }
}
