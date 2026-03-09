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

    const kalshiYesBid = kalshi ? (kalshi.yes_bid_dollars || 0) / 100 : 0;
    const kalshiYesAsk = kalshi ? (kalshi.yes_ask_dollars || 0) / 100 : 0;
    const polyYesBid = poly ? (poly.bestBid || 0) : 0;
    const polyYesAsk = poly ? (poly.bestAsk || 0) : 0;

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
