export interface OrderBookLevel {
  price: number; // 0-1 range (e.g., 0.42 = 42 cents)
  size: number;  // number of contracts
}

export interface OrderBook {
  asks: OrderBookLevel[]; // sorted low to high (best ask first)
  bids: OrderBookLevel[]; // sorted high to low (best bid first)
}

export interface MarketPair {
  kalshiTicker: string;
  polyTokenId: string;
  title: string;
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
  kalshiDepth: number;        // total $ depth on the Kalshi ask side used
  polyDepth: number;          // total $ depth on the Poly ask side used
  thinSide: string | null;    // which side is thin (null = neither), e.g. "Kalshi" / "Poly" / "Both"
  // Best-ask breakdown (always populated if books have depth)
  bestKalshiAsk: number;      // best (cheapest) ask on Kalshi side
  bestPolyAsk: number;        // best (cheapest) ask on Poly side
  bestKalshiFee: number;      // Kalshi fee at best ask price
  bestPolyFee: number;        // Poly fee at best ask price
  bestTotalCost: number;      // bestKalshiAsk + bestPolyAsk + fees
  bestEdge: number;           // 1.0 - bestTotalCost (negative = no arb)
  // Enhanced N_max analysis
  avgCostPerContract: number; // avg cost per contract at N_max
  marginalEdge: number;       // edge on the last (N_max-th) contract
  breakLevel: number;         // contract # where cost first crosses $1 (0 = no break within depth)
  walkRows: WalkRow[];        // per-fill cumulative walk for display
}

export interface WalkRow {
  n: number;           // cumulative contracts after this fill
  kalshiPrice: number; // kalshi ask price this level
  polyPrice: number;   // poly ask price this level
  levelQty: number;    // contracts at this price pair
  levelCost: number;   // cost per contract at this level (incl fees)
  avgCost: number;     // running avg cost per contract
  marginalEdge: number;// edge on this level = 1 - levelCost
  cumProfit: number;   // cumulative profit
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

export interface KalshiMarket {
  ticker: string;
  title: string;
  event_ticker: string;
  yes_bid: number;
  no_bid: number;
  volume: number;
  status: string;
}

export interface PolyMarket {
  condition_id: string;
  question: string;
  tokens: { token_id: string; outcome: string }[];
  active: boolean;
}
