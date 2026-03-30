import axios from "axios";
import { getSettings } from "./runtimeSettings";
import {
  KalshiMarket,
  KalshiSpreadOpportunity,
  KalshiScreenerResults,
  KalshiNewMarket,
} from "./types";

const MIN_LIQUIDITY = parseInt(process.env.KALSHI_MIN_LIQUIDITY || "100000");

/** Build a working Kalshi web URL. Links to the series page. */
function kalshiWebUrl(m: KalshiMarket): string {
  const series = (m.series_ticker || "").toLowerCase();
  if (series) return `https://kalshi.com/markets/${series}`;
  // Derive series from event_ticker: KXFED-26DEC → kxfed
  const et = (m.event_ticker || m.ticker).toLowerCase();
  const dashIdx = et.indexOf("-");
  if (dashIdx > 0 && /^2[0-9]/.test(et.slice(dashIdx + 1))) {
    return `https://kalshi.com/markets/${et.slice(0, dashIdx)}`;
  }
  return `https://kalshi.com/markets/${et}`;
}
const RATE_LIMIT_DELAY = 100; // ms between requests

// ---- Screener ----

export class KalshiScreener {
  private apiUrl: string;
  private cachedMarkets: KalshiMarket[] | null = null;
  private cacheExpiry: number = 0;
  private fetchInFlight: Promise<KalshiMarket[]> | null = null;
  private readonly CACHE_TTL = 300_000; // 5 min – full fetch takes ~6 min, no point expiring sooner
  private readonly MAX_RETRIES = 5;

  constructor() {
    const settings = getSettings();
    this.apiUrl = settings.externalApis.kalshiApiUrl || settings.apiKeys.kalshi.apiUrl;
  }

  // ---- Market Fetching (cursor-based pagination) ----

  async fetchAllActiveMarkets(): Promise<KalshiMarket[]> {
    if (this.cachedMarkets && Date.now() < this.cacheExpiry) {
      return this.cachedMarkets;
    }
    if (this.fetchInFlight) {
      return this.fetchInFlight;
    }

    this.fetchInFlight = this.fetchAllActiveMarketsInternal();
    try {
      return await this.fetchInFlight;
    } finally {
      this.fetchInFlight = null;
    }
  }

  private async fetchAllActiveMarketsInternal(): Promise<KalshiMarket[]> {
    // Use the /events endpoint with nested markets to avoid fetching 470k+ sports
    // parlay markets from /markets. The events endpoint returns ~31k real markets
    // in ~14 seconds vs ~341 seconds for the full /markets crawl.
    const allMarkets: KalshiMarket[] = [];
    let cursor: string | undefined = undefined;
    let pages = 0;
    const t0 = Date.now();

    while (true) {
      const params: Record<string, any> = {
        limit: 200,
        status: "open",
        with_nested_markets: true,
      };
      if (cursor) params.cursor = cursor;

      const data: any = await this.getWithRetry(`${this.apiUrl}/events`, { params });
      const events: any[] = data?.events || [];
      const nextCursor: string | undefined = data?.cursor;

      if (events.length === 0) break;
      pages++;

      for (const event of events) {
        const markets: KalshiMarket[] = event.markets || [];
        const seriesTicker: string = event.series_ticker || "";
        for (const m of markets) {
          m.series_ticker = seriesTicker;
        }
        allMarkets.push(...markets);
      }

      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;

      // Yield to event loop between pages
      await new Promise((r) => setTimeout(r, RATE_LIMIT_DELAY));
    }

    this.cachedMarkets = allMarkets;
    this.cacheExpiry = Date.now() + this.CACHE_TTL;
    console.log(`  Fetched ${allMarkets.length} active Kalshi markets in ${((Date.now() - t0) / 1000).toFixed(1)}s (${pages} pages via /events)`);
    return this.cachedMarkets;
  }

  // ---- Helpers ----

  private centsToNorm(cents: number): number {
    return (cents || 0) / 100;
  }

  private isOpenByTime(closeTime?: string): boolean {
    if (!closeTime) return true;
    const ts = Date.parse(closeTime);
    if (!Number.isFinite(ts)) return true;
    return ts > Date.now();
  }

  private async getWithRetry<T = any>(
    url: string,
    config?: { params?: Record<string, any> }
  ): Promise<T> {
    let attempt = 0;
    let delayMs = 1000;
    while (true) {
      try {
        const resp = await axios.get(url, { ...config, timeout: 15000 });
        return resp.data as T;
      } catch (err: any) {
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        const retryable = status === 429 || status === 503 || status === 504;
        if (!retryable || attempt >= this.MAX_RETRIES) {
          throw err;
        }
        console.log(`  Kalshi rate-limited/unavailable (${status}), retrying in ${delayMs}ms...`);
        await new Promise((r) => setTimeout(r, delayMs));
        attempt += 1;
        delayMs = Math.min(delayMs * 2, 8000);
      }
    }
  }

  private async fetchOrderbook(ticker: string, depth: number = 10) {
    try {
      const data: any = await this.getWithRetry(`${this.apiUrl}/markets/${ticker}/orderbook`, {
        params: { depth },
      });
      return data?.orderbook_fp || data?.orderbook || null;
    } catch {
      return null;
    }
  }

  // ---- 1. Top Spread Markets ----

  async findTopSpreads(count: number = 10): Promise<KalshiSpreadOpportunity[]> {
    console.log("Scanning Kalshi for markets with biggest spreads...");
    const markets = await this.fetchAllActiveMarkets();
    const opportunities: KalshiSpreadOpportunity[] = [];

    for (const m of markets) {
      if (!this.isOpenByTime(m.close_time)) continue;
      if ((m.liquidity_dollars || 0) < MIN_LIQUIDITY) continue;
      if (!m.yes_bid_dollars || !m.yes_ask_dollars) continue;

      const yesBid = this.centsToNorm(m.yes_bid_dollars);
      const yesAsk = this.centsToNorm(m.yes_ask_dollars);
      const spread = yesAsk - yesBid;
      if (spread <= 0) continue;

      const midpoint = (yesBid + yesAsk) / 2;
      const spreadPct = midpoint > 0 ? (spread / midpoint) * 100 : 0;

      opportunities.push({
        rank: 0,
        ticker: m.ticker,
        market: m.title || m.subtitle || m.ticker,
        category: m.category || "",
        yesBid,
        yesAsk,
        spread,
        spreadPct: spreadPct.toFixed(1),
        midpoint,
        volume24h: (m.volume_24h_fp || 0) / 100, // cents to dollars
        liquidity: m.liquidity_dollars || 0,
        closeTime: m.close_time || "",
        kalshiUrl: kalshiWebUrl(m),
      });
    }

    // Sort by absolute spread descending
    opportunities.sort((a, b) => b.spread - a.spread);
    const top = opportunities.slice(0, count);
    top.forEach((o, i) => (o.rank = i + 1));
    console.log(`Kalshi spread scan complete: ${opportunities.length} candidates, returning top ${top.length}`);

    // Enrich top results with orderbook depth
    for (const opp of top) {
      const book = await this.fetchOrderbook(opp.ticker);
      if (book) {
        opp.bidDepthDollars = (book.yes || []).reduce(
          (sum: number, lvl: any) => sum + ((lvl.price || 0) * (lvl.count || lvl.contracts || lvl.quantity || 0)) / 100,
          0
        );
        opp.askDepthDollars = (book.no || []).reduce(
          (sum: number, lvl: any) => sum + ((lvl.price || 0) * (lvl.count || lvl.contracts || lvl.quantity || 0)) / 100,
          0
        );
      }
      await new Promise((r) => setTimeout(r, RATE_LIMIT_DELAY));
    }

    return top;
  }

  // ---- 2. Binary YES/NO Mispricing ----

  async findBinaryMispricing(): Promise<KalshiBinaryMispricing[]> {
    console.log("Scanning Kalshi for YES/NO mispricing...");
    const markets = await this.fetchAllActiveMarkets();
    const opportunities: KalshiBinaryMispricing[] = [];

    for (const m of markets) {
      if (!this.isOpenByTime(m.close_time)) continue;
      if ((m.liquidity_dollars || 0) < MIN_LIQUIDITY) continue;
      if (!m.yes_bid_dollars || !m.yes_ask_dollars || !m.no_bid_dollars || !m.no_ask_dollars) continue;

      const yesMid = this.centsToNorm((m.yes_bid_dollars + m.yes_ask_dollars) / 2);
      const noMid = this.centsToNorm((m.no_bid_dollars + m.no_ask_dollars) / 2);
      const yesBid = this.centsToNorm(m.yes_bid_dollars);
      const yesAsk = this.centsToNorm(m.yes_ask_dollars);
      const noBid = this.centsToNorm(m.no_bid_dollars);
      const noAsk = this.centsToNorm(m.no_ask_dollars);
      const sum = yesMid + noMid;
      const deviation = Math.abs(sum - 1.0);

      // Threshold: >1% deviation is noteworthy
      if (deviation > 0.01) {
        opportunities.push({
          ticker: m.ticker,
          market: m.title || m.subtitle || m.ticker,
          category: m.category || "",
          closeTime: m.close_time || "",
          yesPrice: yesMid,
          noPrice: noMid,
          yesBid,
          yesAsk,
          noBid,
          noAsk,
          sum,
          deviation,
          type: sum < 1.0 ? "BUY_BOTH" : "SELL_BOTH",
          profitPerDollar: sum < 1.0 ? (1.0 - sum) / sum : (sum - 1.0) / sum,
          liquidity: m.liquidity_dollars || 0,
          kalshiUrl: kalshiWebUrl(m),
        });
      }
    }

    opportunities.sort((a, b) => b.deviation - a.deviation);
    console.log(`Kalshi binary scan complete: found ${opportunities.length} mispricing opportunities`);
    return opportunities;
  }

  // ---- 3. Event Group Arbitrage ----

  async findEventGroupArbitrage(): Promise<KalshiEventGroupArb[]> {
    console.log("Scanning Kalshi for event group arbitrage...");
    const markets = await this.fetchAllActiveMarkets();

    // Group by event_ticker
    const groups = new Map<string, KalshiMarket[]>();
    for (const m of markets) {
      if (!this.isOpenByTime(m.close_time)) continue;
      if (!m.event_ticker) continue;
      const group = groups.get(m.event_ticker) || [];
      group.push(m);
      groups.set(m.event_ticker, group);
    }

    const opportunities: KalshiEventGroupArb[] = [];

    for (const [eventTicker, groupMarkets] of groups) {
      if (groupMarkets.length < 2) continue;

      const groupLiquidity = groupMarkets.reduce(
        (s, m) => s + (m.liquidity_dollars || 0),
        0
      );
      if (groupLiquidity < MIN_LIQUIDITY) continue;

      let sumMid = 0;
      let sumAsks = 0;
      let sumBids = 0;
      const outcomeDetails: KalshiEventGroupArb["outcomes"] = [];

      for (const m of groupMarkets) {
        const yesMid = this.centsToNorm(
          ((m.yes_bid_dollars || 0) + (m.yes_ask_dollars || 0)) / 2
        );
        const yesBid = this.centsToNorm(m.yes_bid_dollars || 0);
        const yesAsk = this.centsToNorm(m.yes_ask_dollars || 0);

        sumMid += yesMid;
        sumAsks += yesAsk;
        sumBids += yesBid;

        outcomeDetails.push({
          ticker: m.ticker,
          title: m.subtitle || m.title || m.ticker,
          closeTime: m.close_time || "",
          yesPrice: yesMid,
          yesBid,
          yesAsk,
          spread: yesAsk - yesBid,
        });
      }

      // Buy all YES if sum of asks < 1.0 (accounting for fees ~0.5%)
      if (sumAsks < 0.995) {
        opportunities.push({
          eventTicker,
          eventTitle: (groupMarkets[0].title || eventTicker).substring(0, 80),
          eventCloseTime: groupMarkets
            .map((x) => x.close_time)
            .filter((x): x is string => Boolean(x))
            .sort()[0],
          numOutcomes: groupMarkets.length,
          sumYesMidpoints: sumMid,
          sumYesAsks: sumAsks,
          sumYesBids: sumBids,
          type: "BUY_ALL_YES",
          profitPerDollar: (1.0 - sumAsks) / sumAsks,
          outcomes: outcomeDetails,
        });
      }

      // Sell all YES if sum of bids > 1.0
      if (sumBids > 1.005) {
        opportunities.push({
          eventTicker,
          eventTitle: (groupMarkets[0].title || eventTicker).substring(0, 80),
          eventCloseTime: groupMarkets
            .map((x) => x.close_time)
            .filter((x): x is string => Boolean(x))
            .sort()[0],
          numOutcomes: groupMarkets.length,
          sumYesMidpoints: sumMid,
          sumYesAsks: sumAsks,
          sumYesBids: sumBids,
          type: "SELL_ALL_YES",
          profitPerDollar: (sumBids - 1.0) / 1.0,
          outcomes: outcomeDetails,
        });
      }
    }

    opportunities.sort((a, b) => b.profitPerDollar - a.profitPerDollar);
    console.log(`Kalshi event-group scan complete: found ${opportunities.length} opportunities`);
    return opportunities;
  }

  // ---- 4. New Markets ----

  async findNewMarkets(limit: number = 20): Promise<KalshiNewMarket[]> {
    try {
      // Fetch first page of markets — Kalshi API doesn't support sort by created_time,
      // so we fetch a batch and sort client-side
      const params: Record<string, any> = {
        limit: 200,
        status: "open",
      };

      const data: any = await this.getWithRetry(`${this.apiUrl}/markets`, { params });
      const markets: KalshiMarket[] = data?.markets || [];

      // Sort by created_time descending (newest first)
      const sorted = markets
        .filter((m) => m.created_time)
        .sort((a, b) => {
          const ta = Date.parse(a.created_time || "") || 0;
          const tb = Date.parse(b.created_time || "") || 0;
          return tb - ta;
        })
        .slice(0, limit);

      return sorted.map((m) => ({
        ticker: m.ticker,
        title: m.title || m.subtitle || m.ticker,
        category: m.category || "",
        createdTime: m.created_time || "",
        openTime: m.open_time || "",
        closeTime: m.close_time || "",
        yesBid: this.centsToNorm(m.yes_bid_dollars || 0),
        yesAsk: this.centsToNorm(m.yes_ask_dollars || 0),
        volume24h: (m.volume_24h_fp || 0) / 100,
        liquidity: m.liquidity_dollars || 0,
        kalshiUrl: kalshiWebUrl(m),
      }));
    } catch (err: any) {
      console.error("Error fetching new Kalshi markets:", err.message);
      return [];
    }
  }

  // ---- JSON Data (for API) ----

  async getScreenerData(): Promise<KalshiScreenerResults> {
    const [topSpreads, binaryMispricing, eventGroupArbs] = await Promise.all([
      this.findTopSpreads(10),
      this.findBinaryMispricing(),
      this.findEventGroupArbitrage(),
    ]);
    const markets = await this.fetchAllActiveMarkets();
    return {
      topSpreads,
      binaryMispricing,
      eventGroupArbs: eventGroupArbs.slice(0, 20),
      marketsScanned: markets.length,
      timestamp: new Date().toISOString(),
    };
  }

  // ---- Full Report (CLI) ----

  async runFullScreener(): Promise<void> {
    console.log("\n");
    console.log("=".repeat(80));
    console.log("  KALSHI ARBITRAGE SCREENER");
    console.log("  " + new Date().toISOString());
    console.log("=".repeat(80));

    // 1. Top Spreads
    const topSpreads = await this.findTopSpreads(3);
    console.log("\n");
    console.log("-".repeat(80));
    console.log("  TOP 3 KALSHI MARKETS BY SPREAD");
    console.log("-".repeat(80));

    if (topSpreads.length === 0) {
      console.log("  No markets with significant spreads found.");
    }

    for (const s of topSpreads) {
      console.log(`\n  #${s.rank} | Spread: ${(s.spread * 100).toFixed(1)}¢ (${s.spreadPct}%)`);
      console.log(`     Market: ${s.market}`);
      console.log(`     Category: ${s.category}`);
      console.log(`     YES Bid: ${(s.yesBid * 100).toFixed(1)}¢ | YES Ask: ${(s.yesAsk * 100).toFixed(1)}¢ | Midpoint: ${(s.midpoint * 100).toFixed(1)}¢`);
      console.log(`     24h Volume: $${s.volume24h.toFixed(0)} | Liquidity: $${s.liquidity.toFixed(0)}`);
      if (s.bidDepthDollars != null) {
        console.log(`     Bid Depth: $${s.bidDepthDollars.toFixed(2)} | Ask Depth: $${s.askDepthDollars?.toFixed(2)}`);
      }
      console.log(`     Ticker: ${s.ticker}`);
      console.log(`     URL: ${s.kalshiUrl}`);
    }

    // 2. Binary Mispricing
    const binaryArbs = await this.findBinaryMispricing();
    console.log("\n");
    console.log("-".repeat(80));
    console.log("  KALSHI BINARY YES/NO MISPRICING (sum != $1.00)");
    console.log("-".repeat(80));

    if (binaryArbs.length === 0) {
      console.log("  No binary mispricing opportunities found (>1% deviation).");
    }

    for (const arb of binaryArbs.slice(0, 10)) {
      const arrow = arb.type === "BUY_BOTH" ? "<<<" : ">>>";
      console.log(
        `\n  ${arrow} ${arb.type} | Deviation: ${(arb.deviation * 100).toFixed(2)}% | Profit/Dollar: ${(arb.profitPerDollar * 100).toFixed(2)}%`
      );
      console.log(`     Market: ${arb.market}`);
      console.log(`     Category: ${arb.category}`);
      console.log(
        `     YES: ${(arb.yesPrice * 100).toFixed(1)}¢ + NO: ${(arb.noPrice * 100).toFixed(1)}¢ = ${(arb.sum * 100).toFixed(1)}¢`
      );
      console.log(`     URL: ${arb.kalshiUrl}`);
    }

    // 3. Event Group Arbitrage
    const eventArbs = await this.findEventGroupArbitrage();
    console.log("\n");
    console.log("-".repeat(80));
    console.log("  KALSHI EVENT GROUP ARBITRAGE");
    console.log("-".repeat(80));

    if (eventArbs.length === 0) {
      console.log("  No event group arbitrage opportunities found.");
    }

    for (const arb of eventArbs.slice(0, 5)) {
      console.log(
        `\n  ${arb.type} | Profit/Dollar: ${(arb.profitPerDollar * 100).toFixed(2)}%`
      );
      console.log(`     Event: ${arb.eventTitle}`);
      console.log(`     Outcomes: ${arb.numOutcomes}`);
      console.log(
        `     Sum(MidYES): ${arb.sumYesMidpoints.toFixed(4)} | Sum(Asks): ${arb.sumYesAsks.toFixed(4)} | Sum(Bids): ${arb.sumYesBids.toFixed(4)}`
      );
      console.log(`     Top outcomes by spread:`);
      const sorted = [...arb.outcomes].sort((a, b) => b.spread - a.spread);
      for (const o of sorted.slice(0, 5)) {
        console.log(
          `       ${o.title.substring(0, 40).padEnd(42)} YES=${(o.yesPrice * 100).toFixed(1)}¢ Bid=${(o.yesBid * 100).toFixed(1)}¢ Ask=${(o.yesAsk * 100).toFixed(1)}¢ Spread=${(o.spread * 100).toFixed(1)}¢`
        );
      }
    }

    // Summary
    console.log("\n");
    console.log("=".repeat(80));
    console.log("  SUMMARY");
    console.log(`  Markets scanned: ${(await this.fetchAllActiveMarkets()).length}`);
    console.log(`  Wide-spread opportunities: ${topSpreads.length}`);
    console.log(`  Binary mispricing: ${binaryArbs.length}`);
    console.log(`  Event group arb: ${eventArbs.length}`);
    console.log("=".repeat(80));
    console.log("\n");
  }
}

export interface KalshiBinaryMispricing {
  ticker: string;
  market: string;
  category: string;
  closeTime?: string;
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
  eventCloseTime?: string;
  numOutcomes: number;
  sumYesMidpoints: number;
  sumYesAsks: number;
  sumYesBids: number;
  type: "BUY_ALL_YES" | "SELL_ALL_YES";
  profitPerDollar: number;
  outcomes: {
    ticker: string;
    title: string;
    closeTime?: string;
    yesPrice: number;
    yesBid: number;
    yesAsk: number;
    spread: number;
  }[];
}

// Run as standalone script
if (require.main === module) {
  const screener = new KalshiScreener();
  screener.runFullScreener().catch((err) => {
    console.error("Kalshi Screener error:", err);
    process.exit(1);
  });
}
