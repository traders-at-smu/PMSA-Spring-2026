import fs from "fs";
import path from "path";
import { CrossPlatformArb } from "../crossPlatformScreener";

// ---- Types ----

/** An open position — capital locked until endDate */
export interface OpenPosition {
  id: string;
  openedAt: string;
  endDate: string; // when the contract resolves
  event: string;
  category: string;
  polymarketSlug: string;
  kalshiTicker: string;
  buyYesVenue: "POLYMARKET" | "KALSHI";
  buyYesPrice: number;
  buyNoVenue: "POLYMARKET" | "KALSHI";
  buyNoPrice: number;
  contracts: number;
  costUsd: number;
  feesUsd: number;
  expectedProfitUsd: number; // what we'll earn on resolution
  daysToExpiry: number; // days from open to resolution
}

/** A resolved trade — position has settled, profit realized */
export interface ResolvedTrade {
  id: string;
  openedAt: string;
  resolvedAt: string;
  event: string;
  category: string;
  polymarketSlug: string;
  kalshiTicker: string;
  buyYesVenue: "POLYMARKET" | "KALSHI";
  buyYesPrice: number;
  buyNoVenue: "POLYMARKET" | "KALSHI";
  buyNoPrice: number;
  contracts: number;
  costUsd: number;
  feesUsd: number;
  profitUsd: number;
  payoutUsd: number;
  holdDays: number; // actual days held
  annualizedRoi: number; // (1 + roi)^(365/holdDays) - 1
}

export interface EquitySnapshot {
  timestamp: string;
  balance: number;
  portfolioValue: number; // balance + locked capital + unrealized gains
  lockedCapital: number;
  openPositions: number;
  cumulativeProfit: number;
}

export interface PaperAccountState {
  startingBalance: number;
  availableBalance: number; // cash not locked in positions
  lockedCapital: number; // capital tied up in open positions
  portfolioValue: number; // available + locked + unrealized profit
  unrealizedProfit: number; // expected profit from open positions
  realizedProfit: number; // actual settled profit
  totalFees: number;
  totalTrades: number; // open + resolved
  openPositionCount: number;
  resolvedTradeCount: number;
  winRate: number;
  maxDrawdown: number;
  annualizedRoi: number; // weighted by capital and hold time
  avgHoldDays: number;
  openPositions: OpenPosition[];
  resolvedTrades: ResolvedTrade[]; // most recent 100
  equityCurve: EquitySnapshot[];
  startedAt: string;
}

// ---- Constants ----

const STARTING_BALANCE = 100_000;
const MAX_TRADE_USD = 100;
const MAX_RESOLVED_IN_MEMORY = 100;
const MAX_EQUITY_POINTS = 500;

// ---- Service ----

export class PaperAccountService {
  private availableBalance: number = STARTING_BALANCE;
  private openPositions: OpenPosition[] = [];
  private resolvedTrades: ResolvedTrade[] = [];
  private equityCurve: EquitySnapshot[] = [];
  private realizedProfit = 0;
  private totalFees = 0;
  private wins = 0;
  private peakPortfolioValue: number = STARTING_BALANCE;
  private maxDrawdown = 0;
  private startedAt: string;
  private positionsPath: string;
  private resolvedPath: string;
  private equityPath: string;
  private executedArbKeys = new Set<string>();

  constructor() {
    const logDir = path.resolve(process.cwd(), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    this.positionsPath = path.join(logDir, "paper-positions.jsonl");
    this.resolvedPath = path.join(logDir, "paper-resolved.jsonl");
    this.equityPath = path.join(logDir, "paper-equity.jsonl");
    this.startedAt = new Date().toISOString();
    this.loadFromDisk();

    if (this.equityCurve.length === 0) {
      this.pushSnapshot();
    }
  }

  /** Resolve any positions whose endDate has passed */
  resolveExpired(): number {
    const now = new Date();
    let resolved = 0;

    const stillOpen: OpenPosition[] = [];
    for (const pos of this.openPositions) {
      const end = new Date(pos.endDate);
      if (end <= now) {
        // Position resolves — $1 payout per contract guaranteed
        const payoutUsd = pos.contracts * 1;
        const profitUsd = pos.expectedProfitUsd;
        this.availableBalance += payoutUsd;
        this.realizedProfit += profitUsd;
        if (profitUsd > 0) this.wins++;

        const openDate = new Date(pos.openedAt);
        const holdDays = Math.max(1, Math.round((end.getTime() - openDate.getTime()) / 86_400_000));
        const roi = pos.costUsd > 0 ? profitUsd / pos.costUsd : 0;
        const annualizedRoi = holdDays > 0 ? Math.pow(1 + roi, 365 / holdDays) - 1 : 0;

        const trade: ResolvedTrade = {
          id: pos.id,
          openedAt: pos.openedAt,
          resolvedAt: now.toISOString(),
          event: pos.event,
          category: pos.category,
          polymarketSlug: pos.polymarketSlug,
          kalshiTicker: pos.kalshiTicker,
          buyYesVenue: pos.buyYesVenue,
          buyYesPrice: pos.buyYesPrice,
          buyNoVenue: pos.buyNoVenue,
          buyNoPrice: pos.buyNoPrice,
          contracts: pos.contracts,
          costUsd: pos.costUsd,
          feesUsd: pos.feesUsd,
          profitUsd,
          payoutUsd,
          holdDays,
          annualizedRoi,
        };

        this.resolvedTrades.unshift(trade);
        this.appendLine(this.resolvedPath, trade);
        resolved++;
      } else {
        stillOpen.push(pos);
      }
    }

    if (resolved > 0) {
      this.openPositions = stillOpen;
      this.rewritePositions();
      if (this.resolvedTrades.length > MAX_RESOLVED_IN_MEMORY) {
        this.resolvedTrades = this.resolvedTrades.slice(0, MAX_RESOLVED_IN_MEMORY);
      }
      this.updateDrawdown();
      this.pushSnapshot();
    }

    return resolved;
  }

  executeTrade(arb: CrossPlatformArb): OpenPosition | null {
    const arbKey = `${arb.polymarketSlug}|${arb.kalshiTicker}`;
    if (this.executedArbKeys.has(arbKey)) return null;

    const costPerContract = arb.buyYesPrice + arb.buyNoPrice;
    if (costPerContract >= 1) return null;

    const maxNotional = Math.min(MAX_TRADE_USD, this.availableBalance);
    const contracts = Math.floor(maxNotional / costPerContract);
    if (contracts < 1) return null;

    const costUsd = contracts * costPerContract;
    const netProfitPerContract = arb.netProfit;
    const feesUsd = Math.max(0, costUsd - contracts * (1 - netProfitPerContract));
    const expectedProfitUsd = contracts * netProfitPerContract;

    // Determine end date — fallback to 30 days from now if missing
    let endDate = arb.endDate;
    if (!endDate) {
      const fallback = new Date();
      fallback.setDate(fallback.getDate() + 30);
      endDate = fallback.toISOString();
    }

    const now = new Date();
    const end = new Date(endDate);
    const daysToExpiry = Math.max(1, Math.round((end.getTime() - now.getTime()) / 86_400_000));

    // Deduct cost from available balance — capital is now LOCKED
    this.availableBalance -= costUsd;
    this.totalFees += feesUsd;
    this.executedArbKeys.add(arbKey);

    const pos: OpenPosition = {
      id: `pos-${Date.now()}-${this.openPositions.length}`,
      openedAt: now.toISOString(),
      endDate,
      event: arb.event,
      category: arb.category,
      polymarketSlug: arb.polymarketSlug,
      kalshiTicker: arb.kalshiTicker,
      buyYesVenue: arb.buyYesVenue,
      buyYesPrice: arb.buyYesPrice,
      buyNoVenue: arb.buyNoVenue,
      buyNoPrice: arb.buyNoPrice,
      contracts,
      costUsd,
      feesUsd,
      expectedProfitUsd,
      daysToExpiry,
    };

    this.openPositions.push(pos);
    this.appendLine(this.positionsPath, pos);
    this.updateDrawdown();
    this.pushSnapshot();

    return pos;
  }

  resetCycleDedup(): void {
    this.executedArbKeys.clear();
  }

  getState(): PaperAccountState {
    const lockedCapital = this.openPositions.reduce((s, p) => s + p.costUsd, 0);
    const unrealizedProfit = this.openPositions.reduce((s, p) => s + p.expectedProfitUsd, 0);
    const portfolioValue = this.availableBalance + lockedCapital + unrealizedProfit;
    const resolvedCount = this.resolvedTrades.length;
    const totalTrades = this.openPositions.length + resolvedCount;

    // Weighted annualized ROI across resolved trades
    let annualizedRoi = 0;
    if (resolvedCount > 0) {
      let totalCapDays = 0;
      let weightedReturn = 0;
      for (const t of this.resolvedTrades) {
        const capDays = t.costUsd * t.holdDays;
        totalCapDays += capDays;
        weightedReturn += t.profitUsd;
      }
      if (totalCapDays > 0) {
        // Capital-weighted average daily return, then annualize
        const totalCost = this.resolvedTrades.reduce((s, t) => s + t.costUsd, 0);
        const avgDays = totalCapDays / totalCost;
        const totalRoi = totalCost > 0 ? weightedReturn / totalCost : 0;
        annualizedRoi = avgDays > 0 ? Math.pow(1 + totalRoi, 365 / avgDays) - 1 : 0;
      }
    }

    const avgHoldDays = resolvedCount > 0
      ? this.resolvedTrades.reduce((s, t) => s + t.holdDays, 0) / resolvedCount
      : 0;

    return {
      startingBalance: STARTING_BALANCE,
      availableBalance: this.availableBalance,
      lockedCapital,
      portfolioValue,
      unrealizedProfit,
      realizedProfit: this.realizedProfit,
      totalFees: this.totalFees,
      totalTrades,
      openPositionCount: this.openPositions.length,
      resolvedTradeCount: resolvedCount,
      winRate: resolvedCount > 0 ? this.wins / resolvedCount : 0,
      maxDrawdown: this.maxDrawdown,
      annualizedRoi,
      avgHoldDays,
      openPositions: this.openPositions,
      resolvedTrades: this.resolvedTrades,
      equityCurve: this.equityCurve,
      startedAt: this.startedAt,
    };
  }

  reset(): void {
    this.availableBalance = STARTING_BALANCE;
    this.openPositions = [];
    this.resolvedTrades = [];
    this.equityCurve = [];
    this.realizedProfit = 0;
    this.totalFees = 0;
    this.wins = 0;
    this.peakPortfolioValue = STARTING_BALANCE;
    this.maxDrawdown = 0;
    this.startedAt = new Date().toISOString();
    this.executedArbKeys.clear();

    try {
      fs.writeFileSync(this.positionsPath, "", "utf8");
      fs.writeFileSync(this.resolvedPath, "", "utf8");
      fs.writeFileSync(this.equityPath, "", "utf8");
    } catch (_) {}

    this.pushSnapshot();
  }

  private updateDrawdown(): void {
    const locked = this.openPositions.reduce((s, p) => s + p.costUsd, 0);
    const unrealized = this.openPositions.reduce((s, p) => s + p.expectedProfitUsd, 0);
    const portfolioValue = this.availableBalance + locked + unrealized;
    if (portfolioValue > this.peakPortfolioValue) this.peakPortfolioValue = portfolioValue;
    const dd = (this.peakPortfolioValue - portfolioValue) / this.peakPortfolioValue;
    if (dd > this.maxDrawdown) this.maxDrawdown = dd;
  }

  private pushSnapshot(): void {
    const lockedCapital = this.openPositions.reduce((s, p) => s + p.costUsd, 0);
    const unrealized = this.openPositions.reduce((s, p) => s + p.expectedProfitUsd, 0);
    const portfolioValue = this.availableBalance + lockedCapital + unrealized;

    const snap: EquitySnapshot = {
      timestamp: new Date().toISOString(),
      balance: this.availableBalance,
      portfolioValue,
      lockedCapital,
      openPositions: this.openPositions.length,
      cumulativeProfit: this.realizedProfit,
    };
    this.equityCurve.push(snap);
    if (this.equityCurve.length > MAX_EQUITY_POINTS) {
      this.equityCurve = this.equityCurve.slice(-MAX_EQUITY_POINTS);
    }

    this.appendLine(this.equityPath, snap);
  }

  private appendLine(filePath: string, data: unknown): void {
    try {
      fs.appendFileSync(filePath, `${JSON.stringify(data)}\n`, "utf8");
    } catch (_) {}
  }

  private rewritePositions(): void {
    try {
      const content = this.openPositions.map((p) => JSON.stringify(p)).join("\n") + "\n";
      fs.writeFileSync(this.positionsPath, content, "utf8");
    } catch (_) {}
  }

  private loadFromDisk(): void {
    // Load open positions
    try {
      if (fs.existsSync(this.positionsPath)) {
        const lines = fs.readFileSync(this.positionsPath, "utf8").trim().split("\n");
        for (const line of lines) {
          if (!line) continue;
          try {
            const pos = JSON.parse(line) as OpenPosition;
            this.openPositions.push(pos);
            this.executedArbKeys.add(`${pos.polymarketSlug}|${pos.kalshiTicker}`);
          } catch (_) {}
        }
        // Deduct locked capital from balance
        const lockedCost = this.openPositions.reduce((s, p) => s + p.costUsd, 0);
        this.availableBalance -= lockedCost;
      }
    } catch (_) {}

    // Load resolved trades
    try {
      if (fs.existsSync(this.resolvedPath)) {
        const lines = fs.readFileSync(this.resolvedPath, "utf8").trim().split("\n");
        for (const line of lines) {
          if (!line) continue;
          try {
            const trade = JSON.parse(line) as ResolvedTrade;
            this.resolvedTrades.push(trade);
            this.realizedProfit += trade.profitUsd;
            this.totalFees += trade.feesUsd;
            if (trade.profitUsd > 0) this.wins++;
          } catch (_) {}
        }
        this.resolvedTrades.reverse();
        if (this.resolvedTrades.length > MAX_RESOLVED_IN_MEMORY) {
          this.resolvedTrades = this.resolvedTrades.slice(0, MAX_RESOLVED_IN_MEMORY);
        }
        // Add realized payouts to balance
        const totalPayouts = this.resolvedTrades.reduce((s, t) => s + t.payoutUsd, 0);
        this.availableBalance += totalPayouts;
      }
    } catch (_) {}

    // Load equity curve
    try {
      if (fs.existsSync(this.equityPath)) {
        const lines = fs.readFileSync(this.equityPath, "utf8").trim().split("\n");
        for (const line of lines) {
          if (!line) continue;
          try {
            this.equityCurve.push(JSON.parse(line) as EquitySnapshot);
          } catch (_) {}
        }
        if (this.equityCurve.length > MAX_EQUITY_POINTS) {
          this.equityCurve = this.equityCurve.slice(-MAX_EQUITY_POINTS);
        }
      }
    } catch (_) {}

    // Compute peak/drawdown
    for (const snap of this.equityCurve) {
      const pv = snap.portfolioValue ?? snap.balance;
      if (pv > this.peakPortfolioValue) this.peakPortfolioValue = pv;
      const dd = (this.peakPortfolioValue - pv) / this.peakPortfolioValue;
      if (dd > this.maxDrawdown) this.maxDrawdown = dd;
    }

    if (this.startedAt === new Date().toISOString() && this.resolvedTrades.length > 0) {
      this.startedAt = this.resolvedTrades[this.resolvedTrades.length - 1].openedAt;
    }

    const total = this.openPositions.length + this.resolvedTrades.length;
    if (total > 0) {
      console.log(
        `  Paper account: ${this.openPositions.length} open positions, ${this.resolvedTrades.length} resolved, balance $${this.availableBalance.toFixed(2)}`
      );
    }
  }
}
