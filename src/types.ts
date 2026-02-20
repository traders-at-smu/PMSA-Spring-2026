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
