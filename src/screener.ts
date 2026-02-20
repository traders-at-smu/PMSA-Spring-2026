import axios from "axios";
import { ClobClient, Side } from "@polymarket/clob-client";

const GAMMA_API_URL = process.env.GAMMA_API_URL || "https://gamma-api.polymarket.com";
const CLOB_HTTP_URL = process.env.CLOB_HTTP_URL || "https://clob.polymarket.com";
const CHAIN_ID = 137;

// ---- Types ----

interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  groupItemTitle: string;
  outcomePrices: string[];
  bestBid: number;
  bestAsk: number;
  spread: number;
  lastTradePrice: number;
  clobTokenIds: string[];
  outcomes: string[];
  negRisk: boolean;
  negRiskMarketID: string;
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
  orderPriceMinTickSize: number;
  volume: string;
  volume24hr: number;
  liquidity: string;
}

interface SpreadOpportunity {
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
  yesTokenId: string;
  noTokenId: string;
  bidDepth?: number;
  askDepth?: number;
}

interface BinaryArbOpportunity {
  market: string;
  conditionId: string;
  yesPrice: number;
  noPrice: number;
  sum: number;
  deviation: number;
  type: "BUY_BOTH" | "SELL_BOTH";
  profitPerDollar: number;
}

interface NegRiskArbOpportunity {
  event: string;
  negRiskMarketId: string;
  numOutcomes: number;
  sumMidpoints: number;
  sumBestAsk: number;
  sumBestBid: number;
  type: "BUY_ALL_YES" | "SELL_ALL_YES";
  profitPerDollar: number;
  outcomes: {
    question: string;
    groupTitle: string;
    yesPrice: number;
    bestBid: number;
    bestAsk: number;
    spread: number;
  }[];
}

// ---- Screener ----

export class ArbitrageScreener {
  private gammaApiUrl: string;
  private clobClient: ClobClient | null = null;
  private cachedMarkets: GammaMarket[] | null = null;

  constructor() {
    this.gammaApiUrl = GAMMA_API_URL;
  }

  private async initClobClient(): Promise<ClobClient> {
    if (this.clobClient) return this.clobClient;

    // Unauthenticated client for read-only market data
    this.clobClient = new ClobClient(CLOB_HTTP_URL, CHAIN_ID);
    return this.clobClient;
  }

  async fetchAllActiveMarkets(): Promise<GammaMarket[]> {
    if (this.cachedMarkets) return this.cachedMarkets;
    const allMarkets: GammaMarket[] = [];
    let offset = 0;
    const limit = 500;

    while (true) {
      const resp = await axios.get(`${this.gammaApiUrl}/markets`, {
        params: {
          active: true,
          closed: false,
          limit,
          offset,
        },
      });

      if (!resp.data || resp.data.length === 0) break;

      // Gamma API returns outcomePrices and clobTokenIds as JSON strings
      for (const m of resp.data) {
        if (typeof m.outcomePrices === "string") {
          try { m.outcomePrices = JSON.parse(m.outcomePrices); } catch { m.outcomePrices = []; }
        }
        if (typeof m.clobTokenIds === "string") {
          try { m.clobTokenIds = JSON.parse(m.clobTokenIds); } catch { m.clobTokenIds = []; }
        }
      }

      allMarkets.push(...resp.data);
      if (resp.data.length < limit) break;
      offset += limit;
    }

    this.cachedMarkets = allMarkets.filter((m) => m.acceptingOrders);
    return this.cachedMarkets;
  }

  // ---- 1. Top Spread Markets ----

  async findTopSpreads(count: number = 3): Promise<SpreadOpportunity[]> {
    console.log("Scanning for markets with biggest spreads...");
    const markets = await this.fetchAllActiveMarkets();

    const withSpreads: SpreadOpportunity[] = [];

    for (const m of markets) {
      if (
        m.spread == null ||
        m.spread <= 0 ||
        m.bestBid == null ||
        m.bestAsk == null
      )
        continue;

      const liquidity = parseFloat(m.liquidity || "0");
      // Filter for markets with at least some liquidity
      if (liquidity < 100) continue;

      const midpoint = (m.bestBid + m.bestAsk) / 2;
      const spreadPct = midpoint > 0 ? (m.spread / midpoint) * 100 : 0;

      withSpreads.push({
        rank: 0,
        market: m.question,
        conditionId: m.conditionId,
        bestBid: m.bestBid,
        bestAsk: m.bestAsk,
        spread: m.spread,
        spreadPct: spreadPct.toFixed(1),
        midpoint,
        volume24hr: m.volume24hr || 0,
        liquidity,
        yesTokenId: m.clobTokenIds?.[0] || "",
        noTokenId: m.clobTokenIds?.[1] || "",
      });
    }

    // Sort by absolute spread descending
    withSpreads.sort((a, b) => b.spread - a.spread);

    const top = withSpreads.slice(0, count);
    top.forEach((s, i) => (s.rank = i + 1));

    // Enrich top results with orderbook depth from CLOB
    const client = await this.initClobClient();
    for (const opp of top) {
      if (!opp.yesTokenId) continue;
      try {
        const book = await client.getOrderBook(opp.yesTokenId);
        opp.bidDepth = book.bids.reduce(
          (sum, b) => sum + parseFloat(b.size) * parseFloat(b.price),
          0
        );
        opp.askDepth = book.asks.reduce(
          (sum, a) => sum + parseFloat(a.size) * parseFloat(a.price),
          0
        );
      } catch {
        // Orderbook fetch failed, continue without depth data
      }
    }

    return top;
  }

  // ---- 2. Binary YES/NO Mispricing ----

  async findBinaryArbitrage(): Promise<BinaryArbOpportunity[]> {
    console.log("Scanning for YES/NO mispricing in binary markets...");
    const markets = await this.fetchAllActiveMarkets();

    const opportunities: BinaryArbOpportunity[] = [];

    for (const m of markets) {
      if (m.negRisk) continue;
      if (
        !m.outcomePrices ||
        m.outcomePrices.length < 2
      )
        continue;

      const yesPrice = parseFloat(m.outcomePrices[0]);
      const noPrice = parseFloat(m.outcomePrices[1]);

      if (isNaN(yesPrice) || isNaN(noPrice)) continue;

      const sum = yesPrice + noPrice;
      const deviation = Math.abs(sum - 1.0);

      // Threshold: >1% deviation is noteworthy
      if (deviation > 0.01) {
        opportunities.push({
          market: m.question,
          conditionId: m.conditionId,
          yesPrice,
          noPrice,
          sum,
          deviation,
          type: sum < 1.0 ? "BUY_BOTH" : "SELL_BOTH",
          profitPerDollar: sum < 1.0 ? (1.0 - sum) / sum : (sum - 1.0) / sum,
        });
      }
    }

    opportunities.sort((a, b) => b.deviation - a.deviation);
    return opportunities;
  }

  // ---- 3. negRisk Cross-Outcome Arbitrage ----

  async findNegRiskArbitrage(): Promise<NegRiskArbOpportunity[]> {
    console.log("Scanning for cross-outcome arbitrage in negRisk events...");
    const markets = await this.fetchAllActiveMarkets();

    // Group by negRiskMarketID
    const groups = new Map<string, GammaMarket[]>();
    for (const m of markets) {
      if (!m.negRisk || !m.negRiskMarketID) continue;
      const group = groups.get(m.negRiskMarketID) || [];
      group.push(m);
      groups.set(m.negRiskMarketID, group);
    }

    const opportunities: NegRiskArbOpportunity[] = [];

    for (const [negRiskId, groupMarkets] of groups) {
      if (groupMarkets.length < 2) continue;

      let sumMid = 0;
      let sumBestAsk = 0;
      let sumBestBid = 0;
      const outcomeDetails: NegRiskArbOpportunity["outcomes"] = [];

      for (const m of groupMarkets) {
        const yesPrice = parseFloat(m.outcomePrices?.[0] || "0");
        sumMid += yesPrice;
        sumBestAsk += m.bestAsk || yesPrice;
        sumBestBid += m.bestBid || yesPrice;

        outcomeDetails.push({
          question: m.question,
          groupTitle: m.groupItemTitle || "",
          yesPrice,
          bestBid: m.bestBid || 0,
          bestAsk: m.bestAsk || 0,
          spread: m.spread || 0,
        });
      }

      // Buy all YES if sum of asks < 1.0 (accounting for fees ~0.5%)
      if (sumBestAsk < 0.995) {
        opportunities.push({
          event: groupMarkets[0].question.substring(0, 80),
          negRiskMarketId: negRiskId,
          numOutcomes: groupMarkets.length,
          sumMidpoints: sumMid,
          sumBestAsk,
          sumBestBid,
          type: "BUY_ALL_YES",
          profitPerDollar: (1.0 - sumBestAsk) / sumBestAsk,
          outcomes: outcomeDetails,
        });
      }

      // Sell all YES if sum of bids > 1.0
      if (sumBestBid > 1.005) {
        opportunities.push({
          event: groupMarkets[0].question.substring(0, 80),
          negRiskMarketId: negRiskId,
          numOutcomes: groupMarkets.length,
          sumMidpoints: sumMid,
          sumBestAsk,
          sumBestBid,
          type: "SELL_ALL_YES",
          profitPerDollar: (sumBestBid - 1.0) / 1.0,
          outcomes: outcomeDetails,
        });
      }
    }

    opportunities.sort((a, b) => b.profitPerDollar - a.profitPerDollar);
    return opportunities;
  }

  // ---- Full Report ----

  async runFullScreener(): Promise<void> {
    console.log("\n");
    console.log("=".repeat(80));
    console.log("  POLYMARKET ARBITRAGE SCREENER");
    console.log("  " + new Date().toISOString());
    console.log("=".repeat(80));

    // 1. Top 3 Spreads
    const topSpreads = await this.findTopSpreads(3);
    console.log("\n");
    console.log("-".repeat(80));
    console.log("  TOP 3 MARKETS BY SPREAD");
    console.log("-".repeat(80));

    if (topSpreads.length === 0) {
      console.log("  No markets with significant spreads found.");
    }

    for (const s of topSpreads) {
      console.log(`\n  #${s.rank} | Spread: $${s.spread.toFixed(4)} (${s.spreadPct}%)`);
      console.log(`     Market: ${s.market}`);
      console.log(`     Best Bid: $${s.bestBid.toFixed(4)} | Best Ask: $${s.bestAsk.toFixed(4)} | Midpoint: $${s.midpoint.toFixed(4)}`);
      console.log(`     24h Volume: $${s.volume24hr.toFixed(0)} | Liquidity: $${s.liquidity.toFixed(0)}`);
      if (s.bidDepth != null) {
        console.log(`     Bid Depth: $${s.bidDepth.toFixed(2)} | Ask Depth: $${s.askDepth?.toFixed(2)}`);
      }
      console.log(`     Condition ID: ${s.conditionId}`);
    }

    // 2. Binary YES/NO Mispricing
    const binaryArbs = await this.findBinaryArbitrage();
    console.log("\n");
    console.log("-".repeat(80));
    console.log("  BINARY MARKET YES/NO MISPRICING (sum != 1.00)");
    console.log("-".repeat(80));

    if (binaryArbs.length === 0) {
      console.log("  No binary mispricing opportunities found (>1% deviation).");
    }

    for (const arb of binaryArbs.slice(0, 10)) {
      const emoji = arb.type === "BUY_BOTH" ? "<<<" : ">>>";
      console.log(
        `\n  ${emoji} ${arb.type} | Deviation: ${(arb.deviation * 100).toFixed(2)}% | Profit/Dollar: ${(arb.profitPerDollar * 100).toFixed(2)}%`
      );
      console.log(`     Market: ${arb.market}`);
      console.log(
        `     YES: $${arb.yesPrice.toFixed(4)} + NO: $${arb.noPrice.toFixed(4)} = $${arb.sum.toFixed(4)}`
      );
    }

    // 3. negRisk Cross-Outcome
    const negRiskArbs = await this.findNegRiskArbitrage();
    console.log("\n");
    console.log("-".repeat(80));
    console.log("  NEGRISK CROSS-OUTCOME ARBITRAGE");
    console.log("-".repeat(80));

    if (negRiskArbs.length === 0) {
      console.log("  No cross-outcome arbitrage opportunities found.");
    }

    for (const arb of negRiskArbs.slice(0, 5)) {
      console.log(
        `\n  ${arb.type} | Profit/Dollar: ${(arb.profitPerDollar * 100).toFixed(2)}%`
      );
      console.log(`     Event: ${arb.event}`);
      console.log(`     Outcomes: ${arb.numOutcomes}`);
      console.log(
        `     Sum(MidYES): ${arb.sumMidpoints.toFixed(4)} | Sum(BestAsk): ${arb.sumBestAsk.toFixed(4)} | Sum(BestBid): ${arb.sumBestBid.toFixed(4)}`
      );
      console.log(`     Top outcomes by spread:`);
      const sorted = [...arb.outcomes].sort((a, b) => b.spread - a.spread);
      for (const o of sorted.slice(0, 5)) {
        console.log(
          `       ${(o.groupTitle || o.question).substring(0, 40).padEnd(42)} YES=$${o.yesPrice.toFixed(4)} Bid=$${o.bestBid.toFixed(4)} Ask=$${o.bestAsk.toFixed(4)} Spread=$${o.spread.toFixed(4)}`
        );
      }
    }

    // Summary
    console.log("\n");
    console.log("=".repeat(80));
    console.log(`  SUMMARY`);
    console.log(`  Markets scanned: ${(await this.fetchAllActiveMarkets()).length}`);
    console.log(`  Wide-spread opportunities: ${topSpreads.length}`);
    console.log(`  Binary mispricing: ${binaryArbs.length}`);
    console.log(`  NegRisk cross-outcome: ${negRiskArbs.length}`);
    console.log("=".repeat(80));
    console.log("\n");
  }
}

// Run as standalone script
if (require.main === module) {
  const screener = new ArbitrageScreener();
  screener.runFullScreener().catch((err) => {
    console.error("Screener error:", err);
    process.exit(1);
  });
}
