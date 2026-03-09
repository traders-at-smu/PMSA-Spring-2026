import { spawn } from "child_process";
import path from "path";
import axios from "axios";
import { getSettings } from "../runtimeSettings";
import type { MatchedPairInfo } from "../crossPlatformScreener";

const KALSHI_API = "https://api.elections.kalshi.com/trade-api/v2";
const POLY_GAMMA = "https://gamma-api.polymarket.com";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 8_000;

interface RawPair {
  pair_id: string;
  kalshi_ticker: string;
  poly_slug: string;
  title: string;
  kalshi_url: string;
  poly_url: string;
  resolution_time_utc: string;
  category: string;
}

interface Cache {
  pairs: MatchedPairInfo[];
  expiresAt: number;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function toNum(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}

function parseStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.map((x) => String(x));
    } catch {
      return [];
    }
  }
  return [];
}

function isYesLabel(label: string): boolean {
  const x = label.trim().toLowerCase();
  return x === "yes" || x === "y" || x === "true";
}

function isNoLabel(label: string): boolean {
  const x = label.trim().toLowerCase();
  return x === "no" || x === "n" || x === "false";
}

function extractPolyYesQuotes(poly: any): { yesBid: number; yesAsk: number } {
  const outcomes = parseStringArray(poly?.outcomes);
  const outcomePrices = parseStringArray(poly?.outcomePrices).map(toNum);
  const yesIdx = outcomes.findIndex(isYesLabel);
  const noIdx = outcomes.findIndex(isNoLabel);

  const rawBestBid = clamp01(toNum(poly?.bestBid));
  const rawBestAsk = clamp01(toNum(poly?.bestAsk));

  let yesBid = rawBestBid;
  let yesAsk = rawBestAsk;

  // Gamma bestBid/bestAsk is for outcomes[0]. If outcomes[0] is NO, invert to YES.
  if (outcomes.length >= 2 && noIdx === 0 && yesIdx === 1) {
    yesBid = rawBestAsk > 0 ? 1 - rawBestAsk : 0;
    yesAsk = rawBestBid > 0 ? 1 - rawBestBid : 0;
  }

  const yesMidFromOutcome =
    yesIdx >= 0 ? clamp01(toNum(outcomePrices[yesIdx])) : 0;
  const noMidFromOutcome =
    noIdx >= 0 ? clamp01(toNum(outcomePrices[noIdx])) : 0;
  const yesMidFallback =
    yesMidFromOutcome > 0
      ? yesMidFromOutcome
      : noMidFromOutcome > 0
        ? 1 - noMidFromOutcome
        : 0;

  if (yesBid <= 0) yesBid = yesMidFallback;
  if (yesAsk <= 0) yesAsk = yesMidFallback;

  if (yesBid > yesAsk && yesAsk > 0) {
    const lo = Math.min(yesBid, yesAsk);
    const hi = Math.max(yesBid, yesAsk);
    yesBid = lo;
    yesAsk = hi;
  }

  return { yesBid: clamp01(yesBid), yesAsk: clamp01(yesAsk) };
}

function extractKalshiYesQuotes(kalshi: any): { yesBid: number; yesAsk: number } {
  const rawYesBid = toNum(kalshi?.yes_bid_dollars);
  const rawYesAsk = toNum(kalshi?.yes_ask_dollars);
  const rawNoBid = toNum(kalshi?.no_bid_dollars);
  const rawNoAsk = toNum(kalshi?.no_ask_dollars);

  // Kalshi has historically sent either cents (1..99) or dollar-normalized (0..1) prices.
  const scale = [rawYesBid, rawYesAsk, rawNoBid, rawNoAsk].some((v) => v > 1) ? 100 : 1;

  return {
    yesBid: clamp01(rawYesBid / scale),
    yesAsk: clamp01(rawYesAsk / scale),
  };
}

export class ManualPairsService {
  private cache: Cache | null = null;

  // Resolve paths relative to repo root (V1/src/services → V1/src → V1 → repo root)
  private readonly xlsxPath = path.resolve(__dirname, "../../../V2/Pairs_for_Kalshi_and_Polymarket.xlsx");
  private readonly scriptPath = path.resolve(__dirname, "../../python/read_manual_pairs.py");

  async getPairs(): Promise<MatchedPairInfo[]> {
    if (this.cache && Date.now() < this.cache.expiresAt) {
      return this.cache.pairs;
    }

    const raw = await this.readExcelPairs();
    const pairs = await this.fetchLivePrices(raw);
    this.cache = { pairs, expiresAt: Date.now() + CACHE_TTL_MS };
    console.log(`  Manual pairs: loaded ${pairs.length} pairs from Excel`);
    return pairs;
  }

  invalidateCache(): void {
    this.cache = null;
  }

  private readExcelPairs(): Promise<RawPair[]> {
    const settings = getSettings();
    const pythonExe = settings.python.pythonExecutable || "python";

    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";

      const child = spawn(pythonExe, [this.scriptPath, this.xlsxPath], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      child.on("error", reject);
      child.on("close", (code: number) => {
        if (code !== 0) {
          return reject(new Error(`read_manual_pairs.py exited ${code}: ${stderr.trim()}`));
        }
        try {
          const parsed = JSON.parse(stdout);
          if (parsed && typeof parsed === "object" && "error" in parsed) {
            return reject(new Error(parsed.error));
          }
          resolve(parsed as RawPair[]);
        } catch (e) {
          reject(new Error(`Failed to parse pairs JSON: ${e}`));
        }
      });
    });
  }

  private async fetchLivePrices(rawPairs: RawPair[]): Promise<MatchedPairInfo[]> {
    const results: MatchedPairInfo[] = [];
    for (let i = 0; i < rawPairs.length; i += CONCURRENCY) {
      const batch = rawPairs.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(batch.map((p) => this.enrichPair(p)));
      for (const s of settled) {
        if (s.status === "fulfilled" && s.value) results.push(s.value);
        else if (s.status === "rejected") {
          console.warn("  Manual pairs: failed to enrich pair:", (s as PromiseRejectedResult).reason?.message);
        }
      }
    }
    return results;
  }

  private async enrichPair(pair: RawPair): Promise<MatchedPairInfo | null> {
    const [kalshiResult, polyResult] = await Promise.allSettled([
      this.fetchKalshiMarket(pair.kalshi_ticker),
      this.fetchPolyMarket(pair.poly_slug),
    ]);

    const kalshi = kalshiResult.status === "fulfilled" ? kalshiResult.value : null;
    const poly = polyResult.status === "fulfilled" ? polyResult.value : null;

    // Skip pairs where both APIs failed — no useful data to show
    if (!kalshi && !poly) return null;

    const kalshiQuotes = kalshi ? extractKalshiYesQuotes(kalshi) : { yesBid: 0, yesAsk: 0 };
    const polyQuotes = poly ? extractPolyYesQuotes(poly) : { yesBid: 0, yesAsk: 0 };
    const kalshiYesBid = kalshiQuotes.yesBid;
    const kalshiYesAsk = kalshiQuotes.yesAsk;
    const polyYesBid = polyQuotes.yesBid;
    const polyYesAsk = polyQuotes.yesAsk;

    // Arb: total cost of buying YES on one venue + NO on the other < $1
    // NO cost on venue X = 1 - YES bid on venue X  (using bid as NO ask approximation)
    const arbCost1 = polyYesAsk > 0 && kalshiYesBid > 0 ? polyYesAsk + (1 - kalshiYesBid) : 1;
    const arbCost2 = kalshiYesAsk > 0 && polyYesBid > 0 ? kalshiYesAsk + (1 - polyYesBid) : 1;
    const hasArb = arbCost1 < 0.995 || arbCost2 < 0.995;

    return {
      polymarketTitle: poly?.question || pair.title || pair.poly_slug,
      kalshiTitle: kalshi?.title || pair.title || pair.kalshi_ticker,
      polymarketUrl: pair.poly_url || `https://polymarket.com/market/${pair.poly_slug}`,
      kalshiUrl: pair.kalshi_url || `https://kalshi.com/markets/${pair.kalshi_ticker}`,
      polymarketSlug: pair.poly_slug,
      kalshiTicker: pair.kalshi_ticker,
      similarityScore: 1.0, // manually curated pairs always get full score
      category: pair.category || "manual",
      polyYesBid,
      polyYesAsk,
      kalshiYesBid,
      kalshiYesAsk,
      hasArb,
    };
  }

  private async fetchKalshiMarket(ticker: string): Promise<any> {
    const resp = await axios.get(`${KALSHI_API}/markets/${ticker}`, { timeout: REQUEST_TIMEOUT_MS });
    return resp.data?.market ?? null;
  }

  private async fetchPolyMarket(slug: string): Promise<any> {
    const resp = await axios.get(`${POLY_GAMMA}/markets`, {
      params: { slug },
      timeout: REQUEST_TIMEOUT_MS,
    });
    const data = resp.data;
    if (Array.isArray(data) && data.length > 0) return data[0];
    if (data && typeof data === "object" && data.conditionId) return data;
    return null;
  }
}
