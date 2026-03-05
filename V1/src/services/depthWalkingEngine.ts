/**
 * Depth-walking arbitrage engine — port of V2/src/strategy_model.py + fees.py.
 *
 * Pure stateless functions. Walks order book levels contract-by-contract,
 * computing fees at each level, and stops when arbitrage edge disappears.
 */

import type {
  ArbStrategy,
  DepthLevel,
  DepthWalkResult,
  FeeConfig,
  KalshiFeeConfig,
  OpportunityDecision,
  PairSnapshot,
  PolymarketCategoryFee,
  PolymarketFeeConfig,
  PositionMetrics,
  StopReason,
  StrategyParams,
} from "../types";

// ---- Fee Calculations (port of V2/src/fees.py) ----

export function computeKalshiFee(
  contracts: number,
  price: number,
  rate = 0.07,
  roundMode: "ceil_cent" | "round_cent" | "none" = "ceil_cent"
): number {
  const fee = rate * contracts * price * (1.0 - price);
  if (roundMode === "ceil_cent") return Math.ceil(fee * 100) / 100;
  if (roundMode === "round_cent") return Math.round(fee * 100) / 100;
  return fee;
}

export function computePolymarketFee(
  contracts: number,
  price: number,
  feeRate: number,
  exponent: number,
  makerRebate = 0
): number {
  let fee = contracts * feeRate * Math.pow(price * (1 - price), exponent);
  if (makerRebate > 0) fee *= 1.0 - makerRebate;
  return Math.max(0, fee);
}

// ---- Depth Level Helpers ----

export function normalizeDepthLevels(levels: unknown[]): DepthLevel[] {
  if (!Array.isArray(levels)) return [];
  const agg = new Map<number, number>();

  for (const level of levels) {
    if (typeof level !== "object" || level === null) continue;
    const lev = level as Record<string, unknown>;
    const price = Math.round(Number(lev.price ?? 0) * 1e6) / 1e6;
    const size = Math.floor(Number(lev.size ?? lev.contracts ?? 0));
    if (size <= 0 || price < 0 || price > 1) continue;
    agg.set(price, (agg.get(price) ?? 0) + size);
  }

  return Array.from(agg.entries())
    .map(([price, size]) => ({ price, size }))
    .sort((a, b) => a.price - b.price);
}

export function fallbackLevels(price: number, minContracts: number): DepthLevel[] {
  const p = Math.max(0, Math.min(1, price));
  return [{ price: Math.round(p * 1e6) / 1e6, size: Math.max(1, minContracts) }];
}

// ---- Position Metrics (port of V2 _position_metrics) ----

function positionMetrics(
  contracts: number,
  kalshiSpend: number,
  polymarketSpend: number,
  days: number,
  kalshiFeeConfig: KalshiFeeConfig,
  polyFeeConfig: PolymarketFeeConfig,
  categoryFee: PolymarketCategoryFee
): PositionMetrics {
  if (contracts <= 0) {
    return {
      kalshiFee: 0, polymarketFee: 0, kpCost: 0,
      edgeDollar: 0, edgePct: 0, annualizedEdge: 0,
      avgKalshiPrice: 0, avgPolymarketPrice: 0,
    };
  }

  const avgK = kalshiSpend / contracts;
  const avgP = polymarketSpend / contracts;

  const kalshiFee = kalshiFeeConfig.enabled
    ? computeKalshiFee(contracts, avgK, kalshiFeeConfig.rate, kalshiFeeConfig.roundMode)
    : 0;

  const polymarketFee = polyFeeConfig.enabled
    ? computePolymarketFee(contracts, avgP, categoryFee.feeRate, categoryFee.exponent, categoryFee.makerRebate ?? 0)
    : 0;

  const kpCost = kalshiSpend + polymarketSpend + kalshiFee + polymarketFee;
  const edgeDollar = contracts - kpCost;
  const edgePct = kpCost > 0 ? edgeDollar / kpCost : 0;
  const annualizedEdge = days > 0 ? (edgePct * 365) / days : 0;

  return {
    kalshiFee, polymarketFee, kpCost,
    edgeDollar, edgePct, annualizedEdge,
    avgKalshiPrice: avgK, avgPolymarketPrice: avgP,
  };
}

// ---- Core Depth Walk (port of V2 _walk_depth_until_arb_ends) ----

export function walkDepthUntilArbEnds(
  kalshiLevels: DepthLevel[],
  polymarketLevels: DepthLevel[],
  days: number,
  kpMax: number,
  annualizedEdgeMin: number,
  kalshiFeeConfig: KalshiFeeConfig,
  polyFeeConfig: PolymarketFeeConfig,
  categoryFee: PolymarketCategoryFee
): DepthWalkResult {
  const totalKDepth = kalshiLevels.reduce((s, l) => s + l.size, 0);
  const totalPDepth = polymarketLevels.reduce((s, l) => s + l.size, 0);

  let kIdx = 0;
  let pIdx = 0;
  let kRemaining = kalshiLevels.length > 0 ? kalshiLevels[0].size : 0;
  let pRemaining = polymarketLevels.length > 0 ? polymarketLevels[0].size : 0;

  let contracts = 0;
  let kalshiSpend = 0;
  let polymarketSpend = 0;
  let kLimit = kalshiLevels.length > 0 ? kalshiLevels[0].price : 0;
  let pLimit = polymarketLevels.length > 0 ? polymarketLevels[0].price : 0;
  let metrics = positionMetrics(0, 0, 0, days, kalshiFeeConfig, polyFeeConfig, categoryFee);
  let stopReason: StopReason = "depth_exhausted";

  while (kIdx < kalshiLevels.length && pIdx < polymarketLevels.length) {
    // Advance depleted levels
    if (kRemaining <= 0) {
      kIdx++;
      if (kIdx >= kalshiLevels.length) { stopReason = "kalshi_depth_exhausted"; break; }
      kRemaining = kalshiLevels[kIdx].size;
      continue;
    }
    if (pRemaining <= 0) {
      pIdx++;
      if (pIdx >= polymarketLevels.length) { stopReason = "polymarket_depth_exhausted"; break; }
      pRemaining = polymarketLevels[pIdx].size;
      continue;
    }

    // Test adding one more contract
    const nextKPrice = kalshiLevels[kIdx].price;
    const nextPPrice = polymarketLevels[pIdx].price;
    const nextContracts = contracts + 1;
    const nextMetrics = positionMetrics(
      nextContracts,
      kalshiSpend + nextKPrice,
      polymarketSpend + nextPPrice,
      days,
      kalshiFeeConfig,
      polyFeeConfig,
      categoryFee
    );

    const marginalFee = (nextMetrics.kalshiFee - metrics.kalshiFee) + (nextMetrics.polymarketFee - metrics.polymarketFee);
    const marginalCost = nextKPrice + nextPPrice + marginalFee;

    if (marginalCost >= 1.0) { stopReason = "no_positive_edge"; break; }
    if (nextMetrics.kpCost >= kpMax) { stopReason = "kp_max_hit"; break; }
    if (nextMetrics.annualizedEdge < annualizedEdgeMin) { stopReason = "annualized_edge_below_min"; break; }

    // Accept the contract
    contracts = nextContracts;
    kalshiSpend += nextKPrice;
    polymarketSpend += nextPPrice;
    metrics = nextMetrics;
    kLimit = nextKPrice;
    pLimit = nextPPrice;
    kRemaining--;
    pRemaining--;
  }

  return {
    contracts,
    kalshiSpend,
    polymarketSpend,
    kalshiLimitPrice: kLimit,
    polymarketLimitPrice: pLimit,
    metrics,
    stopReason,
    contractsAvailableKalshi: totalKDepth,
    contractsAvailablePoly: totalPDepth,
  };
}

// ---- Stop Reason Text ----

export function stopReasonText(code: StopReason): string {
  switch (code) {
    case "no_positive_edge": return "Arbitrage ended: KP(c) >= c";
    case "kp_max_hit": return "Arbitrage ended: KP(c) >= KP_max";
    case "annualized_edge_below_min": return "Arbitrage ended: annualized edge below A_min";
    case "kalshi_depth_exhausted": return "Arbitrage ended: Kalshi depth exhausted";
    case "polymarket_depth_exhausted": return "Arbitrage ended: Polymarket depth exhausted";
    default: return "Arbitrage ended";
  }
}

// ---- Pair Evaluation (port of V2 evaluate_pair_snapshot) ----

function levelsForCandidate(
  snapshot: PairSnapshot,
  candidate: { kalshiSide: "yes" | "no"; polymarketSide: "yes" | "no"; kalshiPrice: number; polymarketPrice: number },
  minContracts: number
): [DepthLevel[], DepthLevel[]] {
  const kDepth = snapshot.depth?.kalshi;
  const pDepth = snapshot.depth?.polymarket;

  let kLevels = normalizeDepthLevels(
    candidate.kalshiSide === "yes" ? (kDepth?.buyYes ?? []) : (kDepth?.buyNo ?? [])
  );
  let pLevels = normalizeDepthLevels(
    candidate.polymarketSide === "yes" ? (pDepth?.yesAsks ?? []) : (pDepth?.noAsks ?? [])
  );

  if (kLevels.length === 0) kLevels = fallbackLevels(candidate.kalshiPrice, minContracts);
  if (pLevels.length === 0) pLevels = fallbackLevels(candidate.polymarketPrice, minContracts);

  return [kLevels, pLevels];
}

export function evaluatePairSnapshot(
  snapshot: PairSnapshot,
  params: StrategyParams
): OpportunityDecision[] {
  const minContractSize = params.fixedContractSize;
  const kpMax = params.kpMaxPerTrade;
  const aMin = params.annualizedEdgeMin;
  const days = Math.max(snapshot.daysToResolution, 1e-9);

  const kalshiFeeConfig = params.fees.kalshi;
  const polyFeeConfig = params.fees.polymarket;
  const category = snapshot.category || "default";
  const categoryFee = polyFeeConfig.categories[category] ?? polyFeeConfig.default;

  const candidates: Array<{
    strategy: ArbStrategy;
    kalshiSide: "yes" | "no";
    polymarketSide: "yes" | "no";
    kalshiPrice: number;
    polymarketPrice: number;
  }> = [
    {
      strategy: "BUY_KY_BUY_PN",
      kalshiSide: "yes",
      polymarketSide: "no",
      kalshiPrice: snapshot.kalshi.yesAsk,
      polymarketPrice: snapshot.polymarket.noAsk,
    },
    {
      strategy: "BUY_KN_BUY_PY",
      kalshiSide: "no",
      polymarketSide: "yes",
      kalshiPrice: snapshot.kalshi.noAsk,
      polymarketPrice: snapshot.polymarket.yesAsk,
    },
  ];

  const decisions: OpportunityDecision[] = [];

  for (const candidate of candidates) {
    const [kLevels, pLevels] = levelsForCandidate(snapshot, candidate, minContractSize);
    const walk = walkDepthUntilArbEnds(
      kLevels, pLevels, days, kpMax, aMin,
      kalshiFeeConfig, polyFeeConfig, categoryFee
    );

    const { contracts } = walk;
    const { metrics } = walk;
    const reasons: string[] = [];

    if (contracts < minContractSize) {
      reasons.push(`Contracts before arb end (${contracts}) < fixed_contract_size (${minContractSize})`);
    }
    if (contracts === 0) {
      reasons.push(stopReasonText(walk.stopReason));
    }

    decisions.push({
      pairId: snapshot.pairId,
      strategy: candidate.strategy,
      contracts,
      kpTotalCost: round6(metrics.kpCost),
      edgeDollar: round6(metrics.edgeDollar),
      edgePct: round6(metrics.edgePct),
      annualizedEdge: round6(metrics.annualizedEdge),
      kalshiSide: candidate.kalshiSide,
      polymarketSide: candidate.polymarketSide,
      kalshiPrice: round6(contracts > 0 ? walk.kalshiLimitPrice : candidate.kalshiPrice),
      polymarketPrice: round6(contracts > 0 ? walk.polymarketLimitPrice : candidate.polymarketPrice),
      trade: reasons.length === 0,
      reasons,
      metadata: {
        daysToResolution: days,
        kalshiFee: round6(metrics.kalshiFee),
        polymarketFee: round6(metrics.polymarketFee),
        avgKalshiPrice: round6(metrics.avgKalshiPrice),
        avgPolymarketPrice: round6(metrics.avgPolymarketPrice),
        category,
        contractsAvailableKalshi: walk.contractsAvailableKalshi,
        contractsAvailablePoly: walk.contractsAvailablePoly,
        contractsBeforeArbEnds: contracts,
        fixedContractSizeMinimum: minContractSize,
        arbStopReason: walk.stopReason,
      },
    });
  }

  return decisions;
}

export function findMispricing(
  snapshots: PairSnapshot[],
  params: StrategyParams
): OpportunityDecision[] {
  const decisions: OpportunityDecision[] = [];
  for (const snapshot of snapshots) {
    decisions.push(...evaluatePairSnapshot(snapshot, params));
  }
  return decisions;
}

// ---- Default Config ----

export const DEFAULT_STRATEGY_PARAMS: StrategyParams = {
  fixedContractSize: 5,
  kpMaxPerTrade: 4.95,
  annualizedEdgeMin: 0.10,
  fees: {
    kalshi: { enabled: true, rate: 0.07, roundMode: "ceil_cent" },
    polymarket: {
      enabled: true,
      default: { feeRate: 0.0175, exponent: 1 },
      categories: {
        sports: { feeRate: 0.0175, exponent: 1, makerRebate: 0.25 },
        crypto: { feeRate: 0.25, exponent: 2, makerRebate: 0.2 },
      },
    },
  },
};

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
