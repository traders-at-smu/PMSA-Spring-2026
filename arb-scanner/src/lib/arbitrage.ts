import { OrderBookLevel, ArbResult, ArbFill, WalkRow } from "./types";

// Fee constants
const KALSHI_FEE_RATE = 0.07; // Kalshi taker fee rate
const POLY_FEE        = 0.0002; // Polymarket 2 bps

// $ depth below which a side is considered "thin"
const THIN_DEPTH_USD = 500;

/**
 * Flatten order book levels into individual contract prices.
 * Input: levels sorted cheapest-first (ascending price), each { price, size }
 * Output: array of prices, one per contract
 */
function flatten(levels: OrderBookLevel[]): number[] {
  const stream: number[] = [];
  for (const { price, size } of levels) {
    for (let i = 0; i < Math.floor(size); i++) {
      stream.push(price);
    }
  }
  return stream;
}

/**
 * Kalshi taker fee per contract (in dollar terms, 0-1 range).
 * Formula: ceil_to_cent(0.07 × P × (1 - P))
 * where P is the contract price in 0-1 range.
 * The ceil is to the nearest cent (0.01).
 */
function kalshiFeePerContract(price: number): number {
  const raw = KALSHI_FEE_RATE * price * (1 - price);
  return Math.ceil(raw * 100) / 100; // round up to nearest cent
}

/** Per-contract cost including fees for both sides */
export function contractCost(kp: number, pp: number): { cost: number; kFee: number; pFee: number } {
  const kFee = kalshiFeePerContract(kp);
  const pFee = POLY_FEE * pp;
  return { cost: kp + pp + kFee + pFee, kFee, pFee };
}

/** Total $ depth of an ask book */
function bookDepthUSD(levels: OrderBookLevel[]): number {
  return levels.reduce((sum, l) => sum + l.price * l.size, 0);
}

/**
 * Walk two ask-side order books contract-by-contract.
 *
 * Kalshi fee: ceil(0.07 × P × (1-P)) per contract (rounded up to nearest cent).
 * Poly fee: 0.02% (2bps) of notional.
 *
 * Computes:
 *  - fills (grouped by price pair)
 *  - walkRows (per-fill-level cumulative analysis)
 *  - N_max: max contracts where marginal cost < 1
 *  - breakLevel: first contract # where marginal cost >= 1
 *  - avgCostPerContract at N_max
 *  - marginalEdge at N_max
 */
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
  let breakLevel = 0; // 0 = never breaks within depth

  // Group consecutive contracts at the same price pair into fills
  let currentKPrice = -1;
  let currentPPrice = -1;
  let currentFill: ArbFill | null = null;
  let lastEdge = 0;

  for (let i = 0; i < cap; i++) {
    const kp = ys[i];
    const pp = ns[i];
    const { cost, kFee, pFee } = contractCost(kp, pp);
    const edge = 1.0 - cost;

    // Track break level: first contract where marginal cost >= 1
    if (edge <= 0 && breakLevel === 0) {
      breakLevel = i + 1; // 1-indexed
    }

    // Stop accumulating profitable fills once edge goes negative
    if (edge <= 0) break;

    const fee = kFee + pFee;

    // If same price pair as current fill, accumulate
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

  // Build walkRows from fills (cumulative view per price level)
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

  // Dollar depth for thin-book detection
  const kalshiDepth = bookDepthUSD(kalshiAsks);
  const polyDepth = bookDepthUSD(polyAsks);
  const kThin = kalshiDepth < THIN_DEPTH_USD;
  const pThin = polyDepth < THIN_DEPTH_USD;
  const thinSide = kThin && pThin ? "Both" : kThin ? "Kalshi" : pThin ? "Poly" : null;

  // Best-ask breakdown (always computed so UI can show cost even when no arb)
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

  // Best-ask breakdown even for empty/no-arb results
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

/**
 * Given raw Kalshi bids and Polymarket asks, check both arb directions.
 *
 * Kalshi orderbook returns BIDS only:
 *   yes[] = YES bids (people wanting to BUY yes)
 *   no[]  = NO bids  (people wanting to BUY no)
 *
 * The reciprocal relationship:
 *   YES ask at price X  =  NO bid at price (1-X)
 *   NO  ask at price X  =  YES bid at price (1-X)
 *
 * So to BUY YES on Kalshi → take from NO bids, flipped: kalshiBidsToAsks(noBids)
 *    to BUY NO  on Kalshi → take from YES bids, flipped: kalshiBidsToAsks(yesBids)
 *
 * Direction A: Buy YES on Kalshi + Buy NO on Polymarket
 * Direction B: Buy NO on Kalshi  + Buy YES on Polymarket
 */
export function findBothArbitrages(
  kalshiYesBids: OrderBookLevel[],
  kalshiNoBids: OrderBookLevel[],
  polyYesAsks: OrderBookLevel[],
  polyNoAsks: OrderBookLevel[]
): { arbA: ArbResult; arbB: ArbResult } {
  // Derive Kalshi asks from opposite-side bids
  const kalshiYesAsks = kalshiBidsToAsks(kalshiNoBids);  // flip NO bids → YES asks
  const kalshiNoAsks  = kalshiBidsToAsks(kalshiYesBids); // flip YES bids → NO asks

  // Direction A: Buy YES on Kalshi + Buy NO on Polymarket
  const arbA = calculateArbitrage(kalshiYesAsks, polyNoAsks, "yes", "no");
  // Direction B: Buy NO on Kalshi + Buy YES on Polymarket
  const arbB = calculateArbitrage(kalshiNoAsks, polyYesAsks, "no", "yes");

  return { arbA, arbB };
}

/**
 * Kalshi only returns bids. Convert bids to asks for the opposite side.
 * A YES bid at price X = NO ask at (1 - X).
 * So kalshi YES bids → NO asks (sorted ascending).
 * And kalshi NO bids → YES asks (sorted ascending).
 */
export function kalshiBidsToAsks(
  bids: OrderBookLevel[]
): OrderBookLevel[] {
  return bids
    .map((b) => ({
      price: roundCents(1 - b.price),
      size: b.size,
    }))
    .sort((a, b) => a.price - b.price);
}

function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}
