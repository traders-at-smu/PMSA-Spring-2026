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
