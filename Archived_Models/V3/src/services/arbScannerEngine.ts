/**
 * Arb Scanner Engine — depth-walking arbitrage calculator.
 * Ported from /arb-scanner/src/lib/arbitrage.ts + types.ts
 * Pure stateless math — no external dependencies.
 */

// ---- Types ----

export interface OrderBookLevel {
  price: number; // 0-1 range (e.g., 0.42 = 42 cents)
  size: number;  // number of contracts
}

export interface ArbResult {
  hasArb: boolean;
  kalshiSide: "yes" | "no";
  polySide: "yes" | "no";
  fills: ArbFill[];
  totalContracts: number;
  totalCostKalshi: number;
  totalCostPoly: number;
  totalCost: number;
  totalPayout: number;
  totalProfit: number;
  profitPct: number;
  totalFees: number;
  kalshiDepth: number;
  polyDepth: number;
  thinSide: string | null;
  bestKalshiAsk: number;
  bestPolyAsk: number;
  bestKalshiFee: number;
  bestPolyFee: number;
  bestTotalCost: number;
  bestEdge: number;
  avgCostPerContract: number;
  marginalEdge: number;
  breakLevel: number;
  walkRows: WalkRow[];
}

export interface WalkRow {
  n: number;
  kalshiPrice: number;
  polyPrice: number;
  levelQty: number;
  levelCost: number;
  avgCost: number;
  marginalEdge: number;
  cumProfit: number;
}

export interface ArbFill {
  contracts: number;
  kalshiPrice: number;
  polyPrice: number;
  combinedPrice: number;
  costKalshi: number;
  costPoly: number;
  totalCost: number;
  payout: number;
  profit: number;
}

// ---- Constants ----

const KALSHI_FEE_RATE = 0.07;
const POLY_FEE = 0.0002;
const THIN_DEPTH_USD = 500;

// ---- Helpers ----

function flatten(levels: OrderBookLevel[]): number[] {
  const stream: number[] = [];
  for (const { price, size } of levels) {
    for (let i = 0; i < Math.floor(size); i++) {
      stream.push(price);
    }
  }
  return stream;
}

function kalshiFeePerContract(price: number): number {
  const raw = KALSHI_FEE_RATE * price * (1 - price);
  return Math.ceil(raw * 100) / 100;
}

export function contractCost(kp: number, pp: number): { cost: number; kFee: number; pFee: number } {
  const kFee = kalshiFeePerContract(kp);
  const pFee = POLY_FEE * pp;
  return { cost: kp + pp + kFee + pFee, kFee, pFee };
}

function bookDepthUSD(levels: OrderBookLevel[]): number {
  return levels.reduce((sum, l) => sum + l.price * l.size, 0);
}

function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---- Core Engine ----

export function calculateArbitrage(
  kalshiAsks: OrderBookLevel[],
  polyAsks: OrderBookLevel[],
  kalshiSide: "yes" | "no",
  polySide: "yes" | "no"
): ArbResult {
  const ys = flatten(kalshiAsks);
  const ns = flatten(polyAsks);
  const cap = Math.min(ys.length, ns.length);

  if (cap === 0) {
    return emptyResult(kalshiSide, polySide, kalshiAsks, polyAsks);
  }

  const fills: ArbFill[] = [];
  const walkRows: WalkRow[] = [];
  let totalContracts = 0;
  let totalCostKalshi = 0;
  let totalCostPoly = 0;
  let totalFees = 0;
  let cumTotalCost = 0;
  let breakLevel = 0;

  let currentKPrice = -1;
  let currentPPrice = -1;
  let currentFill: ArbFill | null = null;
  let lastEdge = 0;

  for (let i = 0; i < cap; i++) {
    const kp = ys[i];
    const pp = ns[i];
    const { cost, kFee, pFee } = contractCost(kp, pp);
    const edge = 1.0 - cost;

    if (edge <= 0 && breakLevel === 0) {
      breakLevel = i + 1;
    }

    if (edge <= 0) break;

    const fee = kFee + pFee;

    if (kp === currentKPrice && pp === currentPPrice && currentFill) {
      currentFill.contracts += 1;
      currentFill.costKalshi += kp;
      currentFill.costPoly += pp;
      currentFill.totalCost += cost;
      currentFill.payout += 1.0;
      currentFill.profit += edge;
    } else {
      currentFill = {
        contracts: 1,
        kalshiPrice: kp,
        polyPrice: pp,
        combinedPrice: kp + pp,
        costKalshi: kp,
        costPoly: pp,
        totalCost: cost,
        payout: 1.0,
        profit: edge,
      };
      fills.push(currentFill);
      currentKPrice = kp;
      currentPPrice = pp;
    }

    totalContracts += 1;
    totalCostKalshi += kp;
    totalCostPoly += pp;
    totalFees += fee;
    cumTotalCost += cost;
    lastEdge = edge;
  }

  let cumN = 0;
  let cumCost = 0;
  let cumProfit = 0;
  for (const f of fills) {
    cumN += f.contracts;
    cumCost += f.totalCost;
    cumProfit += f.profit;
    const { cost: levelCost } = contractCost(f.kalshiPrice, f.polyPrice);
    walkRows.push({
      n: cumN,
      kalshiPrice: f.kalshiPrice,
      polyPrice: f.polyPrice,
      levelQty: f.contracts,
      levelCost,
      avgCost: cumCost / cumN,
      marginalEdge: 1.0 - levelCost,
      cumProfit,
    });
  }

  const totalCost = totalCostKalshi + totalCostPoly + totalFees;
  const totalPayout = totalContracts * 1.0;
  const totalProfit = totalPayout - totalCost;

  const kalshiDepth = bookDepthUSD(kalshiAsks);
  const polyDepth = bookDepthUSD(polyAsks);
  const kThin = kalshiDepth < THIN_DEPTH_USD;
  const pThin = polyDepth < THIN_DEPTH_USD;
  const thinSide = kThin && pThin ? "Both" : kThin ? "Kalshi" : pThin ? "Poly" : null;

  const bestKalshiAsk = ys.length > 0 ? ys[0] : 0;
  const bestPolyAsk = ns.length > 0 ? ns[0] : 0;
  const bestKalshiFee = bestKalshiAsk > 0 ? kalshiFeePerContract(bestKalshiAsk) : 0;
  const bestPolyFee = POLY_FEE * bestPolyAsk;
  const bestTotalCost = bestKalshiAsk + bestPolyAsk + bestKalshiFee + bestPolyFee;
  const bestEdge = 1.0 - bestTotalCost;

  return {
    hasArb: fills.length > 0,
    kalshiSide,
    polySide,
    fills,
    walkRows,
    totalContracts,
    totalCostKalshi,
    totalCostPoly,
    totalCost,
    totalPayout,
    totalProfit,
    profitPct: totalCost > 0 ? (totalProfit / totalCost) * 100 : 0,
    totalFees,
    kalshiDepth,
    polyDepth,
    thinSide,
    bestKalshiAsk,
    bestPolyAsk,
    bestKalshiFee,
    bestPolyFee,
    bestTotalCost,
    bestEdge,
    avgCostPerContract: totalContracts > 0 ? totalCost / totalContracts : 0,
    marginalEdge: lastEdge,
    breakLevel,
  };
}

function emptyResult(
  kalshiSide: "yes" | "no",
  polySide: "yes" | "no",
  kalshiAsks: OrderBookLevel[] = [],
  polyAsks: OrderBookLevel[] = [],
): ArbResult {
  const kalshiDepth = bookDepthUSD(kalshiAsks);
  const polyDepth = bookDepthUSD(polyAsks);
  const kThin = kalshiDepth < THIN_DEPTH_USD;
  const pThin = polyDepth < THIN_DEPTH_USD;
  const thinSide = kThin && pThin ? "Both" : kThin ? "Kalshi" : pThin ? "Poly" : null;

  const ys = flatten(kalshiAsks);
  const ns = flatten(polyAsks);
  const bestKalshiAsk = ys.length > 0 ? ys[0] : 0;
  const bestPolyAsk = ns.length > 0 ? ns[0] : 0;
  const bestKalshiFee = bestKalshiAsk > 0 ? kalshiFeePerContract(bestKalshiAsk) : 0;
  const bestPolyFee = POLY_FEE * bestPolyAsk;
  const bestTotalCost = bestKalshiAsk + bestPolyAsk + bestKalshiFee + bestPolyFee;
  const bestEdge = 1.0 - bestTotalCost;

  return {
    hasArb: false,
    kalshiSide,
    polySide,
    fills: [],
    walkRows: [],
    totalContracts: 0,
    totalCostKalshi: 0,
    totalCostPoly: 0,
    totalCost: 0,
    totalPayout: 0,
    totalProfit: 0,
    profitPct: 0,
    totalFees: 0,
    kalshiDepth,
    polyDepth,
    thinSide,
    bestKalshiAsk,
    bestPolyAsk,
    bestKalshiFee,
    bestPolyFee,
    bestTotalCost,
    bestEdge,
    avgCostPerContract: 0,
    marginalEdge: 0,
    breakLevel: 0,
  };
}

export function findBothArbitrages(
  kalshiYesBids: OrderBookLevel[],
  kalshiNoBids: OrderBookLevel[],
  polyYesAsks: OrderBookLevel[],
  polyNoAsks: OrderBookLevel[]
): { arbA: ArbResult; arbB: ArbResult } {
  const kalshiYesAsks = kalshiBidsToAsks(kalshiNoBids);
  const kalshiNoAsks = kalshiBidsToAsks(kalshiYesBids);

  const arbA = calculateArbitrage(kalshiYesAsks, polyNoAsks, "yes", "no");
  const arbB = calculateArbitrage(kalshiNoAsks, polyYesAsks, "no", "yes");

  return { arbA, arbB };
}

export function kalshiBidsToAsks(bids: OrderBookLevel[]): OrderBookLevel[] {
  return bids
    .map((b) => ({
      price: roundCents(1 - b.price),
      size: b.size,
    }))
    .sort((a, b) => a.price - b.price);
}
