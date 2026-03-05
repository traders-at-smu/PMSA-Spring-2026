export interface TargetPosition {
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  currentValue: number;
  title: string;
  outcome: string;
  outcomeIndex: number;
  slug: string;
  endDate: string;
  proxyWallet: string;
}

export interface MyPosition {
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  currentValue: number;
  title: string;
  outcome: string;
  outcomeIndex: number;
}

export interface MarketInfo {
  conditionId: string;
  questionId: string;
  clobTokenIds: string[];
  outcomes: string[];
  outcomePrices: string[];
  negRisk: boolean;
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
  orderPriceMinTickSize: number;
  title: string;
  slug: string;
}

export interface TradeAction {
  type: "BUY" | "SELL";
  tokenId: string;
  conditionId: string;
  size: number;
  price: number;
  title: string;
  outcome: string;
  negRisk: boolean;
  tickSize: string;
}

export interface PositionDiff {
  conditionId: string;
  asset: string;
  title: string;
  outcome: string;
  outcomeIndex: number;
  targetSize: number;
  mySize: number;
  diff: number; // positive = need to buy more, negative = need to sell
  curPrice: number;
}

export interface RpcConfig {
  rpcUrls: string[];
}

export interface TradeRecord {
  timestamp: Date;
  type: "BUY" | "SELL";
  conditionId: string;
  asset: string;
  title: string;
  outcome: string;
  size: number;
  price: number;
  orderId?: string;
  status: "SUCCESS" | "FAILED" | "PENDING";
  errorMessage?: string;
}

export interface RedemptionRecord {
  timestamp: Date;
  conditionId: string;
  title: string;
  outcome: string;
  tokensRedeemed: number;
  usdcReceived: number;
  txHash?: string;
  status: "SUCCESS" | "FAILED";
}

// ---- Dashboard Types ----

export interface LeaderboardEntry {
  rank: number;
  proxyWallet: string;
  userName: string;
  pnl: number;
  vol: number;
  profileImage: string;
  xUsername: string;
  verifiedBadge: boolean;
}

export interface TraderProfile extends LeaderboardEntry {
  portfolioValue: number;
  topPositions: {
    title: string;
    outcome: string;
    size: number;
    curPrice: number;
    cashPnl: number;
    percentPnl: number;
  }[];
}

export interface TradeAlert {
  trader: string;
  traderName: string;
  profileImage: string;
  side: "BUY" | "SELL";
  size: number;
  price: number;
  cashValue: number;
  market: string;
  outcome: string;
  conditionId: string;
  marketEndDate: string;
  hoursToExpiry: number;
  timestamp: string;
  isNewAccount: boolean;
  accountAgeDays: number;
  isFirstLargeBet: boolean;
  transactionHash: string;
  /** Aggregation fields — present when multiple smaller trades are grouped */
  isAggregated?: boolean;
  tradeCount?: number;
  avgPrice?: number;
  /** Insider-suspicion score 0–100, computed from heuristic signals */
  suspicionScore?: number;
  /** Breakdown of which signals fired */
  suspicionSignals?: string[];
}

export interface ScreenerResults {
  topSpreads: {
    rank: number;
    market: string;
    conditionId: string;
    bestBid: number;
    bestAsk: number;
    spread: number;
    spreadPct: string;
    midpoint: number;
    volume24hr: number;
    liquidity: number;
    bidDepth?: number;
    askDepth?: number;
  }[];
  binaryArbs: {
    market: string;
    slug?: string;
    marketUrl?: string;
    conditionId: string;
    yesPrice: number;
    noPrice: number;
    yesBid?: number;
    yesAsk?: number;
    noBid?: number;
    noAsk?: number;
    yesTokenId?: string;
    noTokenId?: string;
    negRisk?: boolean;
    sum: number;
    deviation: number;
    type: "BUY_BOTH" | "SELL_BOTH";
    profitPerDollar: number;
    bidDepth?: number;
    askDepth?: number;
  }[];
  negRiskArbs: {
    event: string;
    eventUrl?: string;
    numOutcomes: number;
    sumMidpoints: number;
    sumBestAsk: number;
    sumBestBid: number;
    type: "BUY_ALL_YES" | "SELL_ALL_YES";
    profitPerDollar: number;
    outcomes: {
      conditionId?: string;
      question: string;
      slug?: string;
      marketUrl?: string;
      groupTitle: string;
      yesPrice: number;
      bestBid: number;
      bestAsk: number;
      spread: number;
      yesTokenId?: string;
    }[];
  }[];
  marketsScanned: number;
  timestamp: string;
}

// ---- Kalshi Types ----

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  series_ticker?: string; // Stamped from parent event during fetch
  title: string;
  subtitle: string;
  category: string;
  status: string;
  market_type: string;
  yes_bid_dollars: number;
  yes_ask_dollars: number;
  no_bid_dollars: number;
  no_ask_dollars: number;
  volume_24h_fp: number;
  open_interest_fp: number;
  liquidity_dollars: number;
  close_time: string;
  latest_expiration_time: string;
  created_time?: string;
  open_time?: string;
}

export interface KalshiSpreadOpportunity {
  rank: number;
  ticker: string;
  market: string;
  category: string;
  yesBid: number;
  yesAsk: number;
  spread: number;
  spreadPct: string;
  midpoint: number;
  volume24h: number;
  liquidity: number;
  bidDepthDollars?: number;
  askDepthDollars?: number;
  closeTime: string;
  kalshiUrl: string;
}

export interface KalshiBinaryMispricing {
  ticker: string;
  market: string;
  category: string;
  yesPrice: number;
  noPrice: number;
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
  sum: number;
  deviation: number;
  type: "BUY_BOTH" | "SELL_BOTH";
  profitPerDollar: number;
  liquidity: number;
  kalshiUrl: string;
}

export interface KalshiEventGroupArb {
  eventTicker: string;
  eventTitle: string;
  numOutcomes: number;
  sumYesMidpoints: number;
  sumYesAsks: number;
  sumYesBids: number;
  type: "BUY_ALL_YES" | "SELL_ALL_YES";
  profitPerDollar: number;
  outcomes: {
    ticker: string;
    title: string;
    yesPrice: number;
    yesBid: number;
    yesAsk: number;
    spread: number;
  }[];
}

export interface KalshiScreenerResults {
  topSpreads: KalshiSpreadOpportunity[];
  binaryMispricing: KalshiBinaryMispricing[];
  eventGroupArbs: KalshiEventGroupArb[];
  marketsScanned: number;
  timestamp: string;
}

export interface KalshiNewMarket {
  ticker: string;
  title: string;
  category: string;
  createdTime: string;
  openTime: string;
  closeTime: string;
  yesBid: number;
  yesAsk: number;
  volume24h: number;
  liquidity: number;
  kalshiUrl: string;
}

// ---- Cross-Platform Types ----

export interface CrossPlatformArb {
  event: string;
  outcome: string;
  polymarketSlug: string;
  kalshiTicker: string;
  polyYesBid: number;
  polyYesAsk: number;
  kalshiYesBid: number;
  kalshiYesAsk: number;
  buyYesVenue: "POLYMARKET" | "KALSHI";
  buyYesPrice: number;
  buyNoVenue: "POLYMARKET" | "KALSHI";
  buyNoPrice: number;
  grossProfit: number;
  netProfit: number;
  roi: number;
  priceDiff: number;
  polymarketUrl: string;
  kalshiUrl: string;
  similarityScore: number;
  category: string;
  // Execution data for Polymarket leg
  polyConditionId: string;
  polyYesTokenId: string;
  polyNoTokenId: string;
  polyNegRisk: boolean;
}

export interface PriceDiff {
  event: string;
  outcome: string;
  kalshiPrice: number;
  polymarketPrice: number;
  diff: number;
  diffPct: number;
  polymarketUrl: string;
  kalshiUrl: string;
  category: string;
}

export interface VolumePair {
  event: string;
  kalshiTicker: string;
  polymarketSlug: string;
  kalshiVolume24h: number;
  polymarketVolume24h: number;
  kalshiLiquidity: number;
  polymarketLiquidity: number;
  volumeDiff: number;
  polymarketUrl: string;
  kalshiUrl: string;
  category: string;
  similarityScore: number;
}

export interface CrossPlatformResults {
  arbs: CrossPlatformArb[];
  diffs: PriceDiff[];
  volumes: VolumePair[];
  matchedPairs: number;
  polymarketsScanned: number;
  kalshiMarketsScanned: number;
  timestamp: string;
}

// ---- Depth-Walking Engine Types ----

export interface DepthLevel {
  price: number;  // 0.0–1.0
  size: number;   // contract count at this level
}

export type StopReason =
  | "no_positive_edge"
  | "kp_max_hit"
  | "annualized_edge_below_min"
  | "kalshi_depth_exhausted"
  | "polymarket_depth_exhausted"
  | "depth_exhausted";

export type ArbStrategy = "BUY_KY_BUY_PN" | "BUY_KN_BUY_PY";

export interface DepthWalkResult {
  contracts: number;
  kalshiSpend: number;
  polymarketSpend: number;
  kalshiLimitPrice: number;
  polymarketLimitPrice: number;
  metrics: PositionMetrics;
  stopReason: StopReason;
  contractsAvailableKalshi: number;
  contractsAvailablePoly: number;
}

export interface PositionMetrics {
  kalshiFee: number;
  polymarketFee: number;
  kpCost: number;
  edgeDollar: number;
  edgePct: number;
  annualizedEdge: number;
  avgKalshiPrice: number;
  avgPolymarketPrice: number;
}

export interface OpportunityDecision {
  pairId: string;
  strategy: ArbStrategy;
  contracts: number;
  kpTotalCost: number;
  edgeDollar: number;
  edgePct: number;
  annualizedEdge: number;
  kalshiSide: "yes" | "no";
  polymarketSide: "yes" | "no";
  kalshiPrice: number;
  polymarketPrice: number;
  trade: boolean;
  reasons: string[];
  metadata: Record<string, unknown>;
}

// ---- Fee Configuration ----

export interface KalshiFeeConfig {
  enabled: boolean;
  rate: number;
  roundMode: "ceil_cent" | "round_cent" | "none";
}

export interface PolymarketCategoryFee {
  feeRate: number;
  exponent: number;
  makerRebate?: number;
}

export interface PolymarketFeeConfig {
  enabled: boolean;
  default: PolymarketCategoryFee;
  categories: Record<string, PolymarketCategoryFee>;
}

export interface FeeConfig {
  kalshi: KalshiFeeConfig;
  polymarket: PolymarketFeeConfig;
}

export interface StrategyParams {
  fixedContractSize: number;
  kpMaxPerTrade: number;
  annualizedEdgeMin: number;
  fees: FeeConfig;
}

// ---- Risk Management Types ----

export interface RiskConfig {
  maxOpenPositionsPerPair: number;
  maxNotionalPerPair: number;
  maxTotalExposure: number;
  maxDrawdownPct: number;
  circuitBreakerCooldownMin: number;
}

export interface RiskCheckResult {
  allowed: boolean;
  reason: string;
}

// ---- Execution Engine Types ----

export type ExecutionMode = "paper" | "live";

export interface RuntimeControl {
  id: number;
  mode: ExecutionMode;
  armLive: number;
  confirmToken: string | null;
  confirmExpiresAt: string | null;
  updatedAt: string;
  verifiedOnly: boolean;
}

// ---- Position & Portfolio Types ----

export interface Position {
  id?: number;
  pairId: string;
  venue: "kalshi" | "polymarket";
  side: "yes" | "no";
  contracts: number;
  avgEntryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  source: "arb" | "copy";
  status: "open" | "closed" | "resolved";
  openedAt: string;
  closedAt: string | null;
}

export interface PortfolioSummary {
  openPositionCount: number;
  totalValue: number;
  totalCost: number;
  totalUnrealizedPnl: number;
  totalRealizedPnl: number;
  totalPnl: number;
}

// ---- Pair Snapshot (for depth-walking) ----

export interface MarketQuote {
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
}

export interface PairDepth {
  kalshi: { buyYes: DepthLevel[]; buyNo: DepthLevel[] };
  polymarket: { yesAsks: DepthLevel[]; noAsks: DepthLevel[] };
}

export interface PairSnapshot {
  pairId: string;
  kalshiTicker: string;
  polymarketSlug: string;
  polyYesTokenId: string;
  polyNoTokenId: string;
  resolutionTimeUtc: string;
  category: string;
  kalshi: MarketQuote;
  polymarket: MarketQuote;
  daysToResolution: number;
  depth: PairDepth;
}
