import axios from "axios";
import { ArbitrageScreener } from "./screener";
import { KalshiScreener } from "./kalshiScreener";
import { KalshiMarket } from "./types";
import { EmbeddingService } from "./services/embeddingService";
import { KimiMatchingService } from "./services/kimiMatchingService";
import type { KimiCandidate } from "./services/kimiMatchingService";
import { getSettings } from "./config";
import type { StateStore } from "./services/stateStore";
import {
  computeKalshiFee,
  computePolymarketFee,
  evaluatePairSnapshot,
  DEFAULT_STRATEGY_PARAMS,
} from "./services/depthWalkingEngine";
import type { PairSnapshot, StrategyParams, DepthLevel, PairDepth } from "./types";

// ---- Types ----

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
  // Liquidity data
  polymarketLiquidity: number;
  kalshiLiquidity: number;
  polymarketVolume24h: number;
  kalshiVolume24h: number;
  // Resolution
  endDate: string;
  // Execution data for Polymarket leg
  polyConditionId: string;
  polyYesTokenId: string;
  polyNoTokenId: string;
  polyNegRisk: boolean;
  // Depth-walking results (populated when depth data available)
  contracts?: number;
  kpTotalCost?: number;
  edgeDollar?: number;
  edgePct?: number;
  annualizedEdge?: number;
  kalshiLimitPrice?: number;
  polymarketLimitPrice?: number;
  kalshiFee?: number;
  polymarketFee?: number;
  daysToResolution?: number;
  strategy?: "BUY_KY_BUY_PN" | "BUY_KN_BUY_PY";
  stopReason?: string;
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

export interface MatchedPairInfo {
  polymarketTitle: string;
  kalshiTitle: string;
  polymarketUrl: string;
  kalshiUrl: string;
  polymarketSlug: string;
  kalshiTicker: string;
  similarityScore: number;
  category: string;
  polyYesBid: number;
  polyYesAsk: number;
  kalshiYesBid: number;
  kalshiYesAsk: number;
  hasArb: boolean;
  endDate?: string;
  // Execution data (optional — populated when available)
  polyYesTokenId?: string;
  polyNoTokenId?: string;
  polyConditionId?: string;
  polyNegRisk?: boolean;
  _source?: "manual" | "ai";
}

export interface CrossPlatformResults {
  arbs: CrossPlatformArb[];
  diffs: PriceDiff[];
  volumes: VolumePair[];
  pairs: MatchedPairInfo[];
  matchedPairs: number;
  polymarketsScanned: number;
  kalshiMarketsScanned: number;
  timestamp: string;
}

// ---- Normalized market for matching ----

interface NormalizedMarket {
  id: string;
  title: string;
  titleClean: string;
  tokens: Set<string>;
  bigrams: Set<string>;
  entities: Set<string>;
  conditions: Set<string>; // resolution conditions: dates, thresholds, counts
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
  volume24h: number;
  liquidity: number;
  url: string;
  slug: string;
  venue: "POLYMARKET" | "KALSHI";
  category: string;
  endDate: string;
  // Polymarket execution data (only set for Polymarket markets)
  clobTokenIds?: string[];
  conditionId?: string;
  negRisk?: boolean;
}

interface MatchedPair {
  polymarket: NormalizedMarket;
  kalshi: NormalizedMarket;
  similarityScore: number;
}

// ---- Text matching (improved: stopwords, synonyms, bigrams, TF-IDF) ----

// Stopwords that dilute similarity scores
const STOPWORDS = new Set([
  "will", "the", "be", "in", "on", "at", "by", "for", "of", "to", "a", "an",
  "and", "or", "is", "are", "was", "were", "this", "that", "it", "its",
  "before", "after", "during", "from", "with", "than", "not", "no", "yes",
  "does", "do", "did", "has", "have", "had", "been", "being", "would",
  "could", "should", "may", "might", "can", "shall", "above", "below",
  "more", "less", "over", "under", "between", "through", "into",
  "2024", "2025", "2026", "2027", "2028",
]);

// Synonym map: normalize variant forms to a canonical token
const SYNONYMS: Record<string, string> = {
  btc: "bitcoin", bitcoin: "bitcoin",
  eth: "ethereum", ethereum: "ethereum",
  sol: "solana", solana: "solana",
  xrp: "ripple", ripple: "ripple",
  doge: "dogecoin", dogecoin: "dogecoin",
  fed: "federal_reserve", "federal": "federal_reserve", "reserve": "federal_reserve",
  gdp: "gdp_growth",
  cpi: "consumer_price_index",
  potus: "president",
  gop: "republican", republican: "republican",
  dem: "democrat", democratic: "democrat", democrat: "democrat",
  nfl: "nfl_football",
  nba: "nba_basketball",
  mlb: "mlb_baseball",
  nhl: "nhl_hockey",
  mls: "mls_soccer",
  epl: "premier_league",
  ucl: "champions_league",
  nato: "nato_alliance",
  uk: "united_kingdom", "united_kingdom": "united_kingdom", britain: "united_kingdom",
  us: "united_states", usa: "united_states",
};

function cleanTitle(title: string): string {
  return (title || "")
    .toLowerCase()
    .replace(/['']/g, "")       // smart quotes
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTokens(title: string): { unigrams: Set<string>; bigrams: Set<string> } {
  const cleaned = cleanTitle(title);
  const words = cleaned.split(" ").filter((w) => w.length >= 2);
  const unigrams = new Set<string>();
  const bigrams = new Set<string>();

  for (const w of words) {
    if (STOPWORDS.has(w)) continue;
    const canonical = SYNONYMS[w] || w;
    unigrams.add(canonical);
  }

  // Bigrams capture multi-word entities: "rate cut", "golden boot", "art ross"
  const nonStop = words.filter((w) => !STOPWORDS.has(w));
  for (let i = 0; i < nonStop.length - 1; i++) {
    const a = SYNONYMS[nonStop[i]] || nonStop[i];
    const b = SYNONYMS[nonStop[i + 1]] || nonStop[i + 1];
    bigrams.add(`${a}_${b}`);
  }

  return { unigrams, bigrams };
}

// Extract key entities: person names (multi-cap-word), dollar amounts, years, percentages
function extractEntities(title: string): Set<string> {
  const entities = new Set<string>();
  const original = (title || "").trim();

  // Dollar amounts: "$100k", "$1.5M", "$50,000"
  const dollarRe = /\$[\d,.]+[kmb]?/gi;
  for (const m of original.matchAll(dollarRe)) {
    entities.add(m[0].toLowerCase().replace(/,/g, ""));
  }

  // Percentages: "3%", "2.5%"
  const pctRe = /[\d.]+%/g;
  for (const m of original.matchAll(pctRe)) {
    entities.add(m[0]);
  }

  // Month-year patterns: "June 2026", "Q1 2026"
  const monthYearRe = /(?:january|february|march|april|may|june|july|august|september|october|november|december|q[1-4])\s*\d{4}/gi;
  for (const m of original.matchAll(monthYearRe)) {
    entities.add(m[0].toLowerCase().replace(/\s+/g, ""));
  }

  // Score thresholds in sports: not needed, but multi-word names are valuable
  // Extract capitalized multi-word names: "Shai Gilgeous-Alexander", "Auston Matthews"
  const nameRe = /[A-Z][a-z]+(?:[-\s][A-Z][a-z]+)+/g;
  for (const m of original.matchAll(nameRe)) {
    entities.add(m[0].toLowerCase().replace(/[\s-]+/g, "_"));
  }

  return entities;
}

// Extract abbreviated name suffix from Kalshi ticker
// e.g. "KXNHLRICHARD-26-SREI" → "srei", "KXPRESNOMD-28-RC" → "rc"
function extractTickerSuffix(ticker: string): string | null {
  if (!ticker) return null;
  const parts = ticker.split("-");
  if (parts.length < 3) return null;
  const suffix = parts[parts.length - 1].toLowerCase();
  // Skip pure numbers or very short suffixes
  if (/^\d+$/.test(suffix) || suffix.length < 2) return null;
  // Skip price-like suffixes: B100, T50, etc.
  if (/^[bt]\d+/.test(suffix)) return null;
  return suffix;
}

// Compress a person name entity to Kalshi-style abbreviation
// "sam_reinhart" → "srei", "filip_forsberg" → "ffor"
function compressNameToAbbrev(entity: string): string | null {
  // Only process person name entities (multi-word, underscore separated)
  if (!entity.includes("_") || entity.startsWith("ticker:")) return null;
  const parts = entity.split("_").filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  const firstName = parts[0];
  const lastName = parts[parts.length - 1];
  if (firstName.length < 1 || lastName.length < 2) return null;
  return firstName[0] + lastName.slice(0, Math.min(3, lastName.length));
}

// Legacy wrapper for compatibility
function tokenSet(title: string): Set<string> {
  const { unigrams } = extractTokens(title);
  return unigrams;
}

// TF-IDF-weighted Jaccard: rare shared tokens count more than common ones
let _idfMap: Map<string, number> | null = null;
let _idfDocCount = 0;

function buildIdfMap(allMarkets: NormalizedMarket[]): void {
  const docFreq = new Map<string, number>();
  _idfDocCount = allMarkets.length;
  for (const m of allMarkets) {
    // Count each token once per document
    for (const t of m.tokens) {
      docFreq.set(t, (docFreq.get(t) || 0) + 1);
    }
  }
  _idfMap = new Map<string, number>();
  for (const [token, freq] of docFreq) {
    // IDF = log(N / df), clamped to [0.5, 10]
    const idf = Math.max(0.5, Math.min(10, Math.log(_idfDocCount / freq)));
    _idfMap.set(token, idf);
  }
}

function getIdf(token: string): number {
  return _idfMap?.get(token) ?? 3.0; // default IDF for unknown tokens
}

// ---- Resolution condition extraction ----
// Extract the specific conditions under which a contract resolves:
// dates, thresholds, counts, groups — two contracts on the same event
// but with different resolution conditions are NOT the same contract.

function extractResolutionConditions(title: string): Set<string> {
  const conditions = new Set<string>();
  const t = (title || "").toLowerCase().trim();

  // Specific dates: "march 4", "march 31", "june 15", "by april 1"
  // Matches "month day" patterns (not month-year which is in entities already)
  const dateDayRe = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})\b/gi;
  for (const m of t.matchAll(dateDayRe)) {
    conditions.add(`date:${m[1]}${m[2]}`);
  }

  // Numeric thresholds with direction: "above $40", "above 41.5", "below 3.5"
  // Also: "≥4.7%", "more than 41.5", "be 4.0%"
  const aboveRe = /(?:above|over|more than|≥|>=)\s*\$?([\d,.]+[kmb]?%?)/gi;
  for (const m of t.matchAll(aboveRe)) {
    conditions.add(`threshold:above_${m[1].replace(/,/g, "")}`);
  }
  const belowRe = /(?:below|under|less than|≤|<=)\s*\$?([\d,.]+[kmb]?%?)/gi;
  for (const m of t.matchAll(belowRe)) {
    conditions.add(`threshold:below_${m[1].replace(/,/g, "")}`);
  }

  // "between X and Y" — extract range
  const betweenRe = /between\s+\$?([\d,.]+[kmb]?%?)\s+and\s+\$?([\d,.]+[kmb]?%?)/gi;
  for (const m of t.matchAll(betweenRe)) {
    conditions.add(`range:${m[1].replace(/,/g, "")}_${m[2].replace(/,/g, "")}`);
  }

  // Exact percentages as resolution targets: "be 4.0%", "rate be 3.5%"
  const exactPctRe = /\bbe\s+([\d.]+%)/gi;
  for (const m of t.matchAll(exactPctRe)) {
    conditions.add(`exact:${m[1]}`);
  }

  // "exactly N awards/wins/goals"
  const exactCountRe = /exactly\s+(\d+)/gi;
  for (const m of t.matchAll(exactCountRe)) {
    conditions.add(`count:${m[1]}`);
  }

  // "N or more"
  const orMoreRe = /(\d+)\s+or\s+more/gi;
  for (const m of t.matchAll(orMoreRe)) {
    conditions.add(`min:${m[1]}`);
  }

  // "N or fewer"
  const orFewerRe = /(\d+)\s+or\s+fewer/gi;
  for (const m of t.matchAll(orFewerRe)) {
    conditions.add(`max:${m[1]}`);
  }

  // Group/pool identifiers: "Group A", "Pool B", "Group L"
  const groupRe = /\b(group|pool)\s+([a-z0-9]+)/gi;
  for (const m of t.matchAll(groupRe)) {
    conditions.add(`group:${m[1].toLowerCase()}${m[2].toLowerCase()}`);
  }

  // Sports game thresholds: "more than 41.5 regular season games"
  const moreGamesRe = /more\s+than\s+([\d.]+)\s+(?:regular\s+)?(?:season\s+)?(?:games|wins)/gi;
  for (const m of t.matchAll(moreGamesRe)) {
    conditions.add(`threshold:above_${m[1]}`);
  }

  // "by March 31", "before 2027" — deadline conditions
  const byDateRe = /\b(?:by|before)\s+((?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2})/gi;
  for (const m of t.matchAll(byDateRe)) {
    conditions.add(`deadline:${m[1].replace(/\s+/g, "")}`);
  }
  const beforeYearRe = /\bbefore\s+(\d{4})\b/gi;
  for (const m of t.matchAll(beforeYearRe)) {
    conditions.add(`deadline:${m[1]}`);
  }

  // Kalshi price-like ticker suffixes: T3.8, B70, T2439.99
  // These encode thresholds in the ticker itself
  const tickerThresholdRe = /\b[TB]([\d.]+)\b/g;
  const original = (title || "").trim();
  for (const m of original.matchAll(tickerThresholdRe)) {
    // Only if it looks like a price/threshold in a ticker context
    conditions.add(`threshold:ticker_${m[1]}`);
  }

  return conditions;
}

// Extract resolution conditions encoded in Kalshi ticker format
// Examples: KXBTCD-26MAR0617-T57249.99 → threshold $57,249
//           KXSOLE-26MAR0617-B70 → threshold above $70
//           KXECONSTATU3-26MAY-T3.8 → threshold 3.8%
function extractKalshiTickerConditions(ticker: string): Set<string> {
  const conditions = new Set<string>();
  if (!ticker) return conditions;

  const parts = ticker.split("-");
  for (const part of parts) {
    // T-prefixed: threshold (at or above this value)
    const tMatch = part.match(/^T([\d.]+)$/);
    if (tMatch) {
      conditions.add(`kalshi_threshold:${tMatch[1]}`);
    }
    // B-prefixed: barrier/boundary (above this value)
    const bMatch = part.match(/^B([\d.]+)$/);
    if (bMatch) {
      conditions.add(`kalshi_threshold:${bMatch[1]}`);
    }
  }

  // If ticker ends with a short numeric suffix after a name code, treat as a count
  // e.g., KXOSCARCOUNT-26-SEN-6 → count:6 (Sentimental Value, exactly 6 awards)
  const lastPart = parts[parts.length - 1];
  if (/^\d{1,2}$/.test(lastPart) && parts.length >= 4) {
    conditions.add(`count:${lastPart}`);
  }

  // Extract date from ticker: 26MAR0617 → March 2026, 26MAY → May 2026
  const dateMatch = ticker.match(/(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2,4})?/i);
  if (dateMatch) {
    const monthMap: Record<string, string> = {
      JAN: "january", FEB: "february", MAR: "march", APR: "april",
      MAY: "may", JUN: "june", JUL: "july", AUG: "august",
      SEP: "september", OCT: "october", NOV: "november", DEC: "december",
    };
    const month = monthMap[dateMatch[2].toUpperCase()];
    if (month && dateMatch[3]) {
      const day = dateMatch[3].slice(0, 2); // first 2 digits of remaining
      if (parseInt(day) >= 1 && parseInt(day) <= 31) {
        conditions.add(`date:${month}${day}`);
      }
    }
  }

  return conditions;
}

// ---- Action / contract-type extraction ----
// Two contracts about the same entity but different actions (win vs relegated) should NOT match.
const ACTION_GROUPS: Record<string, string> = {
  win: "win", wins: "win", winning: "win", winner: "win", champion: "win",
  lose: "lose", loss: "lose",
  relegated: "relegate", relegation: "relegate",
  "top": "top_finish", finish: "top_finish",
  scorer: "scorer", "goal": "scorer",
  nomination: "nominate", nominee: "nominate", nominated: "nominate",
  above: "price_above", below: "price_below",
  between: "price_between",
  hit: "hit_target", reach: "hit_target",
  score: "total_score", total: "total_score", over: "total_score", under: "total_score",
  spread: "spread",
  mvp: "mvp_award",
};

function extractAction(title: string): string | null {
  const words = cleanTitle(title).split(" ");
  for (const w of words) {
    if (ACTION_GROUPS[w]) return ACTION_GROUPS[w];
  }
  return null;
}

// Count shared meaningful tokens (excluding very common ones)
function countSharedTokens(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const t of a) {
    if (b.has(t)) count++;
  }
  return count;
}

// Enhanced similarity: combines weighted-Jaccard on unigrams, bigram overlap, and entity matching
function enhancedSimilarity(
  aTokens: Set<string>,
  bTokens: Set<string>,
  aBigrams: Set<string>,
  bBigrams: Set<string>,
  aEntities: Set<string>,
  bEntities: Set<string>,
  aTitle: string,
  bTitle: string,
  aConditions: Set<string>,
  bConditions: Set<string>
): number {
  if (aTokens.size === 0 || bTokens.size === 0) return 0;

  // Hard filter: need at least 2 shared tokens to even consider
  const sharedCount = countSharedTokens(aTokens, bTokens);
  if (sharedCount < 2) return 0;

  // Action mismatch penalty: "win" vs "relegated" should not match
  const aAction = extractAction(aTitle);
  const bAction = extractAction(bTitle);
  const actionMismatch = aAction && bAction && aAction !== bAction;
  if (actionMismatch) return 0; // hard reject different actions on same entity

  // Resolution condition mismatch: contracts on the same event but different conditions
  // e.g., "Bitcoin above $40 on March 4" vs "Bitcoin above $40 on March 5" → reject
  if (aConditions.size > 0 && bConditions.size > 0) {
    // Check dates: if both have date conditions, they must overlap
    const aDates = [...aConditions].filter((c) => c.startsWith("date:") || c.startsWith("deadline:"));
    const bDates = [...bConditions].filter((c) => c.startsWith("date:") || c.startsWith("deadline:"));
    if (aDates.length > 0 && bDates.length > 0) {
      const aDateSet = new Set(aDates);
      if (!bDates.some((d) => aDateSet.has(d))) return 0;
    }

    // Check thresholds/counts: if both have numeric conditions, values must match
    const THRESH_PREFIXES = ["threshold:", "exact:", "range:", "count:", "min:", "max:", "kalshi_threshold:"];
    const aThresholds = [...aConditions].filter((c) => THRESH_PREFIXES.some((p) => c.startsWith(p)));
    const bThresholds = [...bConditions].filter((c) => THRESH_PREFIXES.some((p) => c.startsWith(p)));
    if (aThresholds.length > 0 && bThresholds.length > 0) {
      // Extract raw numeric values from all threshold-like conditions for cross-format comparison
      const extractNums = (conds: string[]): Set<string> => {
        const nums = new Set<string>();
        for (const c of conds) {
          // Pull out the numeric part: "exact:4.0%" → "4.0", "kalshi_threshold:4.8" → "4.8"
          const numMatch = c.match(/([\d.]+)/);
          if (numMatch) nums.add(numMatch[1]);
        }
        return nums;
      };
      const aNums = extractNums(aThresholds);
      const bNums = extractNums(bThresholds);
      // If no numeric overlap at all, reject
      let numOverlap = false;
      for (const n of aNums) {
        if (bNums.has(n)) { numOverlap = true; break; }
      }
      if (!numOverlap) return 0;
    }

    // Check groups: "Group A" vs "Group B" → reject
    const aGroups = [...aConditions].filter((c) => c.startsWith("group:"));
    const bGroups = [...bConditions].filter((c) => c.startsWith("group:"));
    if (aGroups.length > 0 && bGroups.length > 0) {
      const aGroupSet = new Set(aGroups);
      if (!bGroups.some((g) => aGroupSet.has(g))) return 0;
    }
  }

  // 1. TF-IDF weighted Jaccard on unigrams (weight = 0.55)
  let sharedWeight = 0;
  let totalWeight = 0;
  const allTokens = new Set([...aTokens, ...bTokens]);
  for (const t of allTokens) {
    const idf = getIdf(t);
    const inA = aTokens.has(t);
    const inB = bTokens.has(t);
    totalWeight += idf;
    if (inA && inB) sharedWeight += idf;
  }
  const weightedJaccard = totalWeight > 0 ? sharedWeight / totalWeight : 0;

  // 2. Bigram overlap (weight = 0.25) — rewards phrase-level matches
  let bigramShared = 0;
  const allBigrams = new Set([...aBigrams, ...bBigrams]);
  for (const b of allBigrams) {
    if (aBigrams.has(b) && bBigrams.has(b)) bigramShared++;
  }
  const bigramScore = allBigrams.size > 0 ? bigramShared / allBigrams.size : 0;

  // 3. Entity match (weight = 0.20)
  // Separate ticker entities (player/team abbreviations) from name entities
  const aTickerEnts = [...aEntities].filter((e) => e.startsWith("ticker:"));
  const bTickerEnts = [...bEntities].filter((e) => e.startsWith("ticker:"));
  const aNonTickerEnts = [...aEntities].filter((e) => !e.startsWith("ticker:"));
  const bNonTickerEnts = [...bEntities].filter((e) => !e.startsWith("ticker:"));

  // If both sides have ticker entities, check for overlap — this is the strongest signal
  // ticker entities are like "ticker:srei" (Kalshi) vs "ticker:srei" (compressed Poly name)
  if (aTickerEnts.length > 0 && bTickerEnts.length > 0) {
    const aTickerSet = new Set(aTickerEnts);
    const tickerOverlap = bTickerEnts.some((t) => aTickerSet.has(t));
    if (!tickerOverlap) {
      // Different players/teams for same event → hard reject
      return 0;
    }
  }

  // General entity overlap (names, amounts, etc.)
  let entityShared = 0;
  const allEntities = new Set([...aNonTickerEnts, ...bNonTickerEnts]);
  for (const e of allEntities) {
    if (aEntities.has(e) && bEntities.has(e)) entityShared++;
  }
  const entityScore = allEntities.size > 0 ? entityShared / allEntities.size : 0;

  return 0.55 * weightedJaccard + 0.25 * bigramScore + 0.20 * entityScore;
}

function categoryTag(title: string): string {
  const t = title.toLowerCase();
  if (["president", "election", "senate", "house", "governor", "trump", "biden", "congress", "party", "nominee", "nomination", "primary", "caucus", "vote", "ballot", "parliament", "minister", "political", "democrat", "republican", "midterm", "electoral"].some((k) => t.includes(k)))
    return "politics";
  if (["fed", "inflation", "gdp", "unemployment", "cpi", "rates", "recession", "tariff", "interest rate", "jobs report", "payroll", "treasury", "bond", "yield", "fomc"].some((k) => t.includes(k)))
    return "macro";
  if (["nba", "nfl", "mlb", "nhl", "mls", "soccer", "mvp", "world cup", "super bowl", "trophy", "champion", "playoff", "premier league", "serie a", "la liga", "bundesliga", "ligue 1", "fa cup", "relegat", "regular season", "win the", "golden boot", "golden glove", "pga", "atp", "wta", "grand slam", "masters tournament", "wimbledon", "us open", "french open", "australian open", "euros ", "copa america", "ucl", "europa league", "conference league", "ovc", "big 12", "big ten", "sec ", "acc ", "pac-", "march madness", "ncaa", "stanley cup", "home run", "touchdown", "strikeout", "assists", "rebound", "yards"].some((k) => t.includes(k)))
    return "sports";
  if (["bitcoin", "btc", "eth", "crypto", "solana", "ethereum", "dogecoin", "xrp", "cardano", "polkadot", "avalanche", "chainlink", "litecoin", "bnb", "shiba"].some((k) => t.includes(k)))
    return "crypto";
  if (["oscar", "grammy", "emmy", "golden globe", "academy award", "box office", "film", "movie", "album", "song", "spotify", "billboard", "rotten tomato"].some((k) => t.includes(k)))
    return "entertainment";
  if (["subscriber", "youtube", "twitch", "tiktok", "instagram", "twitter", "follower", "views"].some((k) => t.includes(k)))
    return "social_media";
  if (["weather", "hurricane", "tornado", "earthquake", "temperature", "rainfall", "snow", "wildfire"].some((k) => t.includes(k)))
    return "weather";
  if (["eurovision", "nobel", "pulitzer"].some((k) => t.includes(k)))
    return "awards";
  return "other";
}

// ---- Fee calculations (using depth-walking engine) ----

function calcKalshiFee(price: number): number {
  return computeKalshiFee(1, price, 0.07, "ceil_cent");
}

function calcPolymarketFee(price: number): number {
  return computePolymarketFee(1, price, 0.0175, 1, 0);
}

/** Build a working Kalshi web URL from available ticker data.
 *  Kalshi URL format: /markets/{series_ticker}/{slug}/{event_ticker}
 *  We don't have the slug, so we link to the series page: /markets/{series_ticker}
 *  which shows all events in the series. */
function buildKalshiUrl(
  seriesTicker: string | undefined,
  eventTicker: string | undefined,
  ticker: string
): string {
  const series = (seriesTicker || "").toLowerCase();
  if (series) {
    return `https://kalshi.com/markets/${series}`;
  }
  // Fallback: derive series from event_ticker by stripping date suffix
  // e.g., KXFED-26DEC → kxfed
  const et = (eventTicker || ticker).toLowerCase();
  const dashIdx = et.indexOf("-");
  if (dashIdx > 0) {
    // Check if suffix after dash starts with a year digit (2x) — that's a date
    const suffix = et.slice(dashIdx + 1);
    if (/^2[0-9]/.test(suffix)) {
      return `https://kalshi.com/markets/${et.slice(0, dashIdx)}`;
    }
  }
  return `https://kalshi.com/markets/${et}`;
}

// ---- Screener ----

const PRIMARY_THRESHOLD = 0.50;
const FALLBACK_THRESHOLD = 0.25;

// AI re-ranker thresholds — read from config at call time
// RERANK_LOW/HIGH are fallback defaults; runtime uses settings.aiMatching.textScoreAiZone
const RERANK_LOW = 0.50;
const RERANK_HIGH = 0.90;
const KIMI_TEXT_WEIGHT = 0.40;      // Weight for text score in Kimi combined scoring
const KIMI_AI_WEIGHT = 0.60;        // Weight for Kimi confidence in combined scoring
// Embedding fallback weights (used when Kimi unavailable)
const TEXT_WEIGHT = 0.55;
const EMBEDDING_WEIGHT = 0.45;
const COMBINED_THRESHOLD = 0.45;

// ---- Scan Log Ring Buffer ----

export interface ScanLogEntry {
  ts: string;
  level: "info" | "warn" | "error" | "step" | "detail";
  msg: string;
}

const SCAN_LOG_MAX = 500;

export class CrossPlatformScreener {
  private polyScreener: ArbitrageScreener;
  private kalshiScreener: KalshiScreener;
  private embeddingService: EmbeddingService | null = null;
  private kimiService: KimiMatchingService | null = null;
  private stateStore: StateStore | null = null;
  private cachedResults: CrossPlatformResults | null = null;
  private cacheExpiry = 0;
  private fetchInFlight: Promise<CrossPlatformResults> | null = null;
  private readonly CACHE_TTL = 300_000; // 5 min – Kalshi fetch is slow, cache aggressively

  // Status tracking for UI
  private _lastScanAt: string | null = null;
  private _scanning = false;
  private _lastScanDurationMs = 0;

  // Live scan log
  private _scanLog: ScanLogEntry[] = [];
  private _logListeners: Set<(entry: ScanLogEntry) => void> = new Set();

  private _log(level: ScanLogEntry["level"], msg: string): void {
    const entry: ScanLogEntry = { ts: new Date().toISOString(), level, msg };
    this._scanLog.push(entry);
    if (this._scanLog.length > SCAN_LOG_MAX) this._scanLog.splice(0, this._scanLog.length - SCAN_LOG_MAX);
    for (const fn of this._logListeners) fn(entry);
  }

  /** Subscribe to real-time log entries. Returns unsubscribe function. */
  onLog(fn: (entry: ScanLogEntry) => void): () => void {
    this._logListeners.add(fn);
    return () => { this._logListeners.delete(fn); };
  }

  /** Get recent log entries (last N). */
  getRecentLogs(count = 100): ScanLogEntry[] {
    return this._scanLog.slice(-count);
  }

  constructor(polyScreener?: ArbitrageScreener, kalshiScreener?: KalshiScreener) {
    this.polyScreener = polyScreener || new ArbitrageScreener();
    this.kalshiScreener = kalshiScreener || new KalshiScreener();

    // Initialize AI pair verifier — prefer Kimi, fall back to embeddings
    const settings = getSettings();
    const kimiKey = settings.apiKeys.kimi.apiKey;
    if (kimiKey) {
      this.kimiService = new KimiMatchingService(kimiKey, {
        baseUrl: settings.apiKeys.kimi.baseUrl,
        model: settings.apiKeys.kimi.model,
      });
      console.log(`  AI pair verifier: ENABLED (KimiK2.5 — ${settings.apiKeys.kimi.model})`);
    } else {
      // Fallback to OpenAI embeddings
      const openaiKey = process.env.OPENAI_API_KEY;
      if (openaiKey) {
        this.embeddingService = new EmbeddingService(openaiKey);
        console.log("  AI pair verifier: ENABLED (OpenAI embeddings fallback)");
      } else {
        console.log("  AI pair verifier: DISABLED (no KIMI_API_KEY or OPENAI_API_KEY)");
      }
    }
  }

  setStateStore(store: StateStore): void {
    this.stateStore = store;
  }

  /** Re-initialize the Kimi service with current settings (call after API key changes) */
  reloadKimiService(): { enabled: boolean; model?: string } {
    const settings = getSettings();
    const kimiKey = settings.apiKeys.kimi.apiKey;
    if (kimiKey) {
      this.kimiService = new KimiMatchingService(kimiKey, {
        baseUrl: settings.apiKeys.kimi.baseUrl,
        model: settings.apiKeys.kimi.model,
      });
      this.embeddingService = null;
      console.log(`  AI pair verifier: RELOADED (KimiK2.5 — ${settings.apiKeys.kimi.model})`);
      return { enabled: true, model: settings.apiKeys.kimi.model };
    }
    this.kimiService = null;
    console.log("  AI pair verifier: DISABLED (no KIMI_API_KEY)");
    return { enabled: false };
  }

  invalidateCache(): void {
    this.cachedResults = null;
    this.cacheExpiry = 0;
  }

  /** Invalidate everything INCLUDING the Kimi file cache — forces full AI re-evaluation */
  invalidateAll(): void {
    this.cachedResults = null;
    this.cacheExpiry = 0;
    if (this.kimiService) {
      this.kimiService.clearCache();
      console.log("[Screener] Kimi file cache cleared — all pairs will be re-evaluated by AI");
    }
  }

  /** Status info for the UI status endpoint */
  getStatus(): {
    lastScanAt: string | null;
    scanning: boolean;
    lastScanDurationMs: number;
    cacheTtlMs: number;
    cacheExpiresAt: number;
    embeddingEnabled: boolean;
    aiVerifier: "kimi-k2.5" | "openai-embeddings" | "none";
    kimiStats: Record<string, unknown> | null;
    matchedPairs: number;
    arbCount: number;
  } {
    return {
      lastScanAt: this._lastScanAt,
      scanning: this._scanning,
      lastScanDurationMs: this._lastScanDurationMs,
      cacheTtlMs: this.CACHE_TTL,
      cacheExpiresAt: this.cacheExpiry,
      embeddingEnabled: this.embeddingService !== null || this.kimiService !== null,
      aiVerifier: this.kimiService ? "kimi-k2.5" : this.embeddingService ? "openai-embeddings" : "none",
      kimiStats: this.kimiService ? (this.kimiService.getCacheStats() as unknown as Record<string, unknown>) : null,
      matchedPairs: this.cachedResults?.matchedPairs ?? 0,
      arbCount: this.cachedResults?.arbs.length ?? 0,
    };
  }

  /**
   * Fetch real orderbook depth for a matched pair.
   * Returns PairDepth with actual ask levels (or empty arrays on failure).
   */
  private async fetchDepthForPair(
    pm: NormalizedMarket,
    km: NormalizedMarket,
    timeoutMs = 5000,
  ): Promise<PairDepth> {
    const empty: PairDepth = {
      kalshi: { buyYes: [], buyNo: [] },
      polymarket: { yesAsks: [], noAsks: [] },
    };
    const settings = getSettings();
    const kalshiBase = settings.externalApis?.kalshiApiUrl || "https://api.elections.kalshi.com/trade-api/v2";
    const clobBase = settings.externalApis?.clobHttpUrl || "https://clob.polymarket.com";

    try {
      // Fetch all books in parallel with timeout
      const [kalshiBook, polyYesBook, polyNoBook] = await Promise.all([
        axios.get(`${kalshiBase}/markets/${km.slug}/orderbook`, {
          params: { depth: 10 },
          timeout: timeoutMs,
        }).then(r => r.data?.orderbook_fp || r.data?.orderbook || null).catch(() => null),

        pm.clobTokenIds?.[0]
          ? axios.get(`${clobBase}/book`, {
              params: { token_id: pm.clobTokenIds[0] },
              timeout: timeoutMs,
            }).then(r => r.data).catch(() => null)
          : Promise.resolve(null),

        pm.clobTokenIds?.[1]
          ? axios.get(`${clobBase}/book`, {
              params: { token_id: pm.clobTokenIds[1] },
              timeout: timeoutMs,
            }).then(r => r.data).catch(() => null)
          : Promise.resolve(null),
      ]);

      // Parse Kalshi orderbook (fp format: prices in cents)
      if (kalshiBook) {
        const parseKalshi = (levels: any[]): DepthLevel[] =>
          (levels || []).map((l: any) => ({
            price: (l.price || 0) / 100,
            size: l.contracts || l.quantity || 0,
          })).filter((l: DepthLevel) => l.size > 0);

        empty.kalshi.buyYes = parseKalshi(kalshiBook.yes || kalshiBook.asks);
        empty.kalshi.buyNo = parseKalshi(kalshiBook.no || []);
      }

      // Parse Polymarket CLOB book
      const parsePoly = (book: any, side: "asks" | "bids"): DepthLevel[] => {
        if (!book) return [];
        const levels = book[side] || [];
        return levels.map((l: any) => ({
          price: parseFloat(l.price || "0"),
          size: parseFloat(l.size || "0"),
        })).filter((l: DepthLevel) => l.size > 0);
      };

      if (polyYesBook) {
        empty.polymarket.yesAsks = parsePoly(polyYesBook, "asks");
      }
      if (polyNoBook) {
        empty.polymarket.noAsks = parsePoly(polyNoBook, "asks");
      }
    } catch {
      // Return empty depth on any error
    }

    return empty;
  }

  async getResults(): Promise<CrossPlatformResults> {
    if (this.cachedResults && Date.now() < this.cacheExpiry) {
      return this.cachedResults;
    }
    if (this.fetchInFlight) return this.fetchInFlight;

    this.fetchInFlight = this.computeResults().catch((err) => {
      this._scanning = false;
      throw err;
    });
    try {
      return await this.fetchInFlight;
    } finally {
      this.fetchInFlight = null;
    }
  }

  private async computeResults(): Promise<CrossPlatformResults> {
    this._scanning = true;
    const scanStart = Date.now();
    this._log("step", "Scan started — fetching markets from both venues...");

    // Fetch markets from both platforms in parallel
    const [polyMarkets, kalshiMarkets] = await Promise.all([
      this.polyScreener.fetchAllActiveMarkets().then((r) => {
        this._log("info", `Polymarket: fetched ${r.length} active markets`);
        return r;
      }),
      this.kalshiScreener.fetchAllActiveMarkets().then((r) => {
        this._log("info", `Kalshi: fetched ${r.length} active markets`);
        return r;
      }),
    ]);

    // Pre-filter: only keep Kalshi markets with actual price data
    const kalshiWithPrices = kalshiMarkets.filter(
      (m) => (m.yes_bid_dollars || 0) > 0 || (m.yes_ask_dollars || 0) > 0
    );
    this._log("info", `Kalshi pre-filter: ${kalshiWithPrices.length}/${kalshiMarkets.length} have price data`);

    // Normalize all markets into a common format
    this._log("step", "Normalizing markets for text similarity...");
    const normalizedPoly = this.normalizePolymarkets(polyMarkets);
    const normalizedKalshi = this.normalizeKalshiMarkets(kalshiWithPrices);
    this._log("info", `Normalized: ${normalizedPoly.length} Polymarket, ${normalizedKalshi.length} Kalshi`);

    // Match events across platforms (async to yield event loop)
    this._log("step", "Running text similarity matching...");
    const pairs = await this.matchEvents(normalizedPoly, normalizedKalshi);
    this._log("info", `Text matching complete: ${pairs.length} pairs found`);

    // Find arbitrage opportunities (async: fetches depth for top candidates)
    this._log("step", "Evaluating arbitrage opportunities...");
    const arbs = await this.findArbitrage(pairs);
    this._log("info", `Arb evaluation complete: ${arbs.length} opportunities`);

    // Find price differences
    const diffs = this.findPriceDiffs(pairs);

    // Build volume comparisons
    const volumes = this.buildVolumePairs(pairs);

    // Build serializable matched pair info for UI verification
    // Filter out pairs where Kalshi has no order book (0¢ prices = no liquidity)
    const arbSlugs = new Set(arbs.map(a => `${a.polymarketSlug}|${a.kalshiTicker}`));
    const pairInfos: MatchedPairInfo[] = pairs
      .filter(p => p.kalshi.yesBid > 0 || p.kalshi.yesAsk > 0)
      .map(p => ({
        polymarketTitle: p.polymarket.title,
        kalshiTitle: p.kalshi.title,
        polymarketUrl: p.polymarket.url,
        kalshiUrl: p.kalshi.url,
        polymarketSlug: p.polymarket.slug,
        kalshiTicker: p.kalshi.id,
        similarityScore: p.similarityScore,
        category: p.polymarket.category || p.kalshi.category || "other",
        polyYesBid: p.polymarket.yesBid,
        polyYesAsk: p.polymarket.yesAsk,
        kalshiYesBid: p.kalshi.yesBid,
        kalshiYesAsk: p.kalshi.yesAsk,
        hasArb: arbSlugs.has(`${p.polymarket.slug}|${p.kalshi.id}`),
        endDate: p.kalshi.endDate || p.polymarket.endDate || undefined,
        polyYesTokenId: p.polymarket.clobTokenIds?.[0] || undefined,
        polyNoTokenId: p.polymarket.clobTokenIds?.[1] || undefined,
        polyConditionId: p.polymarket.conditionId || undefined,
        polyNegRisk: p.polymarket.negRisk || undefined,
      }));

    const results: CrossPlatformResults = {
      arbs: arbs.sort((a, b) => b.roi - a.roi),
      diffs: diffs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)),
      volumes: volumes.sort((a, b) => Math.abs(b.volumeDiff) - Math.abs(a.volumeDiff)),
      pairs: pairInfos.sort((a, b) => b.similarityScore - a.similarityScore),
      matchedPairs: pairs.length,
      polymarketsScanned: polyMarkets.length,
      kalshiMarketsScanned: kalshiMarkets.length,
      timestamp: new Date().toISOString(),
    };

    this.cachedResults = results;
    this.cacheExpiry = Date.now() + this.CACHE_TTL;
    this._lastScanAt = results.timestamp;
    this._lastScanDurationMs = Date.now() - scanStart;
    this._scanning = false;

    this._log("step", `Scan complete in ${(this._lastScanDurationMs / 1000).toFixed(1)}s — ${pairs.length} pairs, ${arbs.length} arbs, ${diffs.length} diffs`);
    console.log(
      `  Cross-platform: ${pairs.length} matched pairs, ${arbs.length} arbs, ${diffs.length} diffs (${this._lastScanDurationMs}ms)`
    );

    return results;
  }

  // ---- Normalize ----

  private normalizePolymarkets(markets: any[]): NormalizedMarket[] {
    const results: NormalizedMarket[] = [];
    for (const m of markets) {
      const yesBid = m.bestBid || 0;
      const yesAsk = m.bestAsk || 0;
      const title = m.question || "";
      const { unigrams, bigrams } = extractTokens(title);

      // Extract entities and add compressed name abbreviations for ticker matching
      const entities = extractEntities(title);
      for (const e of [...entities]) {
        const abbrev = compressNameToAbbrev(e);
        if (abbrev) entities.add(`ticker:${abbrev}`);
      }

      results.push({
        id: m.conditionId || "",
        title,
        titleClean: cleanTitle(title),
        tokens: unigrams,
        bigrams,
        entities,
        conditions: extractResolutionConditions(title),
        yesBid,
        yesAsk,
        noBid: yesAsk > 0 ? 1 - yesAsk : 0,
        noAsk: yesBid > 0 ? 1 - yesBid : 0,
        volume24h: m.volume24hr || 0,
        liquidity: parseFloat(m.liquidity || "0"),
        url: m.slug ? `https://polymarket.com/event/${m.slug}` : "",
        slug: m.slug || "",
        venue: "POLYMARKET",
        category: categoryTag(title),
        endDate: m.endDate || "",
        clobTokenIds: m.clobTokenIds || [],
        conditionId: m.conditionId || "",
        negRisk: m.negRisk || false,
      });
    }
    return results;
  }

  private normalizeKalshiMarkets(markets: KalshiMarket[]): NormalizedMarket[] {
    const results: NormalizedMarket[] = [];
    for (const m of markets) {
      const title = m.title || m.subtitle || m.ticker;
      const yesBid = (m.yes_bid_dollars || 0) / 100;
      const yesAsk = (m.yes_ask_dollars || 0) / 100;
      // Kalshi API sometimes omits NO prices — derive from YES (YES + NO = $1)
      const noBid = m.no_bid_dollars ? m.no_bid_dollars / 100 : (yesAsk > 0 ? 1 - yesAsk : 0);
      const noAsk = m.no_ask_dollars ? m.no_ask_dollars / 100 : (yesBid > 0 ? 1 - yesBid : 0);
      const { unigrams, bigrams } = extractTokens(title);

      // Extract ticker suffix as pseudo-entity for matching
      // e.g. KXNHLRICHARD-26-SREI → "srei" (Sam Reinhart)
      const entities = extractEntities(title);
      const tickerSuffix = extractTickerSuffix(m.ticker);
      if (tickerSuffix) {
        entities.add(`ticker:${tickerSuffix}`);
      }

      // Extract resolution conditions from title AND ticker
      // Kalshi tickers encode thresholds: KXBTCD-26MAR0617-T57249.99 → threshold at $57,249.99
      const conditions = extractResolutionConditions(title);
      const tickerConditions = extractKalshiTickerConditions(m.ticker);
      for (const c of tickerConditions) {
        conditions.add(c);
      }

      results.push({
        id: m.ticker,
        title,
        titleClean: cleanTitle(title),
        tokens: unigrams,
        bigrams,
        entities,
        conditions,
        yesBid,
        yesAsk,
        noBid,
        noAsk,
        volume24h: (m.volume_24h_fp || 0) / 100,
        liquidity: Number(m.liquidity_dollars) || 0,
        url: buildKalshiUrl(m.series_ticker, m.event_ticker, m.ticker),
        slug: m.ticker,
        venue: "KALSHI",
        category: categoryTag(title),
        endDate: m.close_time || "",
      });
    }
    return results;
  }

  // ---- Event Matching (inverted-index + TF-IDF + bigrams + entity matching) ----

  private async matchEvents(
    polyMarkets: NormalizedMarket[],
    kalshiMarkets: NormalizedMarket[]
  ): Promise<MatchedPair[]> {
    // Read AI zone thresholds from config
    const aiZone = getSettings().aiMatching.textScoreAiZone;
    const rerankLow = aiZone[0] ?? RERANK_LOW;
    const rerankHigh = aiZone[1] ?? RERANK_HIGH;

    // Build IDF map from both corpora for TF-IDF weighting
    buildIdfMap([...polyMarkets, ...kalshiMarkets]);

    // Build inverted index: token -> kalshi markets containing that token
    const kalshiIndex = new Map<string, NormalizedMarket[]>();
    for (const km of kalshiMarkets) {
      for (const token of km.tokens) {
        let list = kalshiIndex.get(token);
        if (!list) {
          list = [];
          kalshiIndex.set(token, list);
        }
        list.push(km);
      }
    }

    const pairs: MatchedPair[] = [];
    const usedKalshi = new Set<string>();
    const matchedPoly = new Set<string>();
    const ambiguousCandidates: Array<{
      polymarket: NormalizedMarket;
      kalshi: NormalizedMarket;
      textScore: number;
    }> = [];
    let processed = 0;

    // Primary pass: enhanced similarity with threshold 0.15
    for (const pm of polyMarkets) {
      if (pm.tokens.size === 0) continue;

      // Yield to event loop every 500 markets so Express can serve requests
      if (++processed % 500 === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }

      // Gather candidate kalshi markets that share at least one token
      const candidateMap = new Map<string, NormalizedMarket>();
      for (const token of pm.tokens) {
        const matches = kalshiIndex.get(token);
        if (matches) {
          for (const km of matches) {
            if (!usedKalshi.has(km.id)) candidateMap.set(km.id, km);
          }
        }
      }

      let bestMatch: NormalizedMarket | null = null;
      let bestScore = 0;

      for (const km of candidateMap.values()) {
        // Category mismatch penalty: different categories get a 0.5x multiplier
        // Only skip penalty when BOTH are "other" (unknown)
        const catMatch = pm.category === km.category || (pm.category === "other" && km.category === "other");
        const catMultiplier = catMatch ? 1.0 : 0.5;

        const score = enhancedSimilarity(
          pm.tokens, km.tokens,
          pm.bigrams, km.bigrams,
          pm.entities, km.entities,
          pm.titleClean, km.titleClean,
          pm.conditions, km.conditions
        ) * catMultiplier;

        if (score > bestScore) {
          bestScore = score;
          bestMatch = km;
        }
      }

      if (bestMatch && bestScore >= rerankLow) {
        if (bestScore >= rerankHigh) {
          // High-confidence text match — accept directly
          usedKalshi.add(bestMatch.id);
          matchedPoly.add(pm.id);
          pairs.push({
            polymarket: pm,
            kalshi: bestMatch,
            similarityScore: bestScore,
          });
        } else {
          // Ambiguous zone — collect for embedding re-ranking
          ambiguousCandidates.push({
            polymarket: pm,
            kalshi: bestMatch,
            textScore: bestScore,
          });
        }
      }
    }

    this._log("info", `Text pass: ${pairs.length} high-confidence, ${ambiguousCandidates.length} ambiguous (need AI)`);

    // ---- AI re-rank for ambiguous candidates ----
    // Sort by text score descending so the best text matches get AI verification first
    ambiguousCandidates.sort((a, b) => b.textScore - a.textScore);

    // Cap at maxAiCandidates to limit API calls; overflow falls back to text-only
    const maxAi = getSettings().aiMatching.maxAiCandidates;
    const aiCandidates = ambiguousCandidates.slice(0, maxAi);
    const overflowCandidates = ambiguousCandidates.slice(maxAi);

    // Accept overflow candidates using text-only threshold
    for (const c of overflowCandidates) {
      if (c.textScore >= PRIMARY_THRESHOLD && !usedKalshi.has(c.kalshi.id)) {
        usedKalshi.add(c.kalshi.id);
        matchedPoly.add(c.polymarket.id);
        pairs.push({
          polymarket: c.polymarket,
          kalshi: c.kalshi,
          similarityScore: c.textScore,
        });
      }
    }

    if (this.kimiService && aiCandidates.length > 0) {
      this._log("step", `Kimi AI verification: sending ${aiCandidates.length} candidates (max ${maxAi})...`);
      if (overflowCandidates.length > 0) {
        this._log("detail", `${overflowCandidates.length} overflow candidates using text-only threshold`);
      }
      // Kimi chat-based verification
      const kimiCandidates: KimiCandidate[] = aiCandidates.map((c) => ({
        polyTitle: c.polymarket.title,
        kalshiTitle: c.kalshi.title,
        polySlug: c.polymarket.slug,
        kalshiTicker: c.kalshi.slug || c.kalshi.id,
        textScore: c.textScore,
      }));

      try {
        const kimiResults = await this.kimiService.judgePairs(kimiCandidates);
        const stats = this.kimiService.getCacheStats();
        this._log("info", `Kimi done: ${stats.cacheMisses} API calls, ${stats.cacheSize} cached, ${(stats.hitRate * 100).toFixed(0)}% hit rate`);

        let aiAccepted = 0;
        let aiRejected = 0;
        for (const c of aiCandidates) {
          const key = `${c.polymarket.slug}::${c.kalshi.slug || c.kalshi.id}`;
          const result = kimiResults.get(key);

          if (result) {
            const verdict = result.match && result.confidence >= getSettings().aiMatching.confidenceThreshold;
            const tag = verdict ? "MATCH" : "NO";
            this._log("detail", `[${tag} ${(result.confidence * 100).toFixed(0)}%] "${c.polymarket.title}" ↔ "${c.kalshi.title}"${result.fromCache ? " (cached)" : ""}`);
            if (verdict) aiAccepted++; else aiRejected++;
            // Persist to SQLite
            if (this.stateStore) {
              try {
                this.stateStore.upsertAiMatch({
                  polySlug: c.polymarket.slug,
                  kalshiTicker: c.kalshi.slug || c.kalshi.id,
                  polyTitle: c.polymarket.title,
                  kalshiTitle: c.kalshi.title,
                  textScore: c.textScore,
                  aiMatch: result.match,
                  aiConfidence: result.confidence,
                  aiReasoning: result.reasoning,
                  aiModel: getSettings().apiKeys.kimi.model,
                  aiLatencyMs: result.latencyMs,
                  fromCache: result.fromCache,
                  finalVerdict: result.match && result.confidence >= getSettings().aiMatching.confidenceThreshold ? "verified" : "pending",
                  polyUrl: c.polymarket.url,
                  kalshiUrl: c.kalshi.url,
                });
              } catch { /* non-critical */ }
            }

            if (result.match && result.confidence >= getSettings().aiMatching.confidenceThreshold) {
              const combined = KIMI_TEXT_WEIGHT * c.textScore + KIMI_AI_WEIGHT * result.confidence;
              if (!usedKalshi.has(c.kalshi.id)) {
                usedKalshi.add(c.kalshi.id);
                matchedPoly.add(c.polymarket.id);
                pairs.push({
                  polymarket: c.polymarket,
                  kalshi: c.kalshi,
                  similarityScore: combined,
                });
              }
            }
          } else {
            // No result — fall back to text-only threshold
            if (c.textScore >= PRIMARY_THRESHOLD && !usedKalshi.has(c.kalshi.id)) {
              usedKalshi.add(c.kalshi.id);
              matchedPoly.add(c.polymarket.id);
              pairs.push({
                polymarket: c.polymarket,
                kalshi: c.kalshi,
                similarityScore: c.textScore,
              });
            }
          }
        }
        this._log("info", `Kimi summary: ${aiAccepted} accepted, ${aiRejected} rejected out of ${aiCandidates.length}`);
      } catch (err) {
        this._log("error", `Kimi AI re-rank failed: ${(err as Error).message}`);
        console.warn("  Kimi AI re-rank failed, falling back to text-only:", (err as Error).message);
        for (const c of aiCandidates) {
          if (c.textScore >= PRIMARY_THRESHOLD && !usedKalshi.has(c.kalshi.id)) {
            usedKalshi.add(c.kalshi.id);
            matchedPoly.add(c.polymarket.id);
            pairs.push({
              polymarket: c.polymarket,
              kalshi: c.kalshi,
              similarityScore: c.textScore,
            });
          }
        }
      }
    } else if (this.embeddingService && aiCandidates.length > 0) {
      // Fallback: OpenAI embedding re-ranking
      const titlesToEmbed = new Set<string>();
      for (const c of aiCandidates) {
        titlesToEmbed.add(c.polymarket.title);
        titlesToEmbed.add(c.kalshi.title);
      }

      try {
        const vectors = await this.embeddingService.batchEmbed([...titlesToEmbed]);
        const stats = this.embeddingService.getCacheStats();
        console.log(
          `  Embedding re-rank (fallback): ${aiCandidates.length} candidates, ` +
            `${titlesToEmbed.size} titles embedded (cache: ${stats.size} vectors, ${(stats.hitRate * 100).toFixed(0)}% hit)`
        );

        for (const c of aiCandidates) {
          const vecA = vectors.get(c.polymarket.title);
          const vecB = vectors.get(c.kalshi.title);

          if (vecA && vecB) {
            const embSim = EmbeddingService.cosineSimilarity(vecA, vecB);
            const combined = TEXT_WEIGHT * c.textScore + EMBEDDING_WEIGHT * embSim;

            if (combined >= COMBINED_THRESHOLD) {
              if (!usedKalshi.has(c.kalshi.id)) {
                usedKalshi.add(c.kalshi.id);
                matchedPoly.add(c.polymarket.id);
                pairs.push({
                  polymarket: c.polymarket,
                  kalshi: c.kalshi,
                  similarityScore: combined,
                });
              }
            }
          } else {
            if (c.textScore >= PRIMARY_THRESHOLD && !usedKalshi.has(c.kalshi.id)) {
              usedKalshi.add(c.kalshi.id);
              matchedPoly.add(c.polymarket.id);
              pairs.push({
                polymarket: c.polymarket,
                kalshi: c.kalshi,
                similarityScore: c.textScore,
              });
            }
          }
        }
      } catch (err) {
        console.warn("  Embedding re-rank failed, falling back to text-only:", (err as Error).message);
        for (const c of aiCandidates) {
          if (c.textScore >= PRIMARY_THRESHOLD && !usedKalshi.has(c.kalshi.id)) {
            usedKalshi.add(c.kalshi.id);
            matchedPoly.add(c.polymarket.id);
            pairs.push({
              polymarket: c.polymarket,
              kalshi: c.kalshi,
              similarityScore: c.textScore,
            });
          }
        }
      }
    } else if (aiCandidates.length > 0) {
      // No AI service — fall back to text-only threshold
      for (const c of aiCandidates) {
        if (c.textScore >= PRIMARY_THRESHOLD && !usedKalshi.has(c.kalshi.id)) {
          usedKalshi.add(c.kalshi.id);
          matchedPoly.add(c.polymarket.id);
          pairs.push({
            polymarket: c.polymarket,
            kalshi: c.kalshi,
            similarityScore: c.textScore,
          });
        }
      }
    }

    // Fallback pass: looser threshold (only if few matches found)
    if (pairs.length < 20) {
      for (const pm of polyMarkets) {
        if (pm.tokens.size === 0 || matchedPoly.has(pm.id)) continue;

        const candidateMap = new Map<string, NormalizedMarket>();
        for (const token of pm.tokens) {
          const matches = kalshiIndex.get(token);
          if (matches) {
            for (const km of matches) {
              if (!usedKalshi.has(km.id)) candidateMap.set(km.id, km);
            }
          }
        }

        let bestMatch: NormalizedMarket | null = null;
        let bestScore = 0;

        for (const km of candidateMap.values()) {
          const catMatch = km.category === pm.category || (pm.category === "other" && km.category === "other");
          const catMultiplier = catMatch ? 1.0 : 0.5;
          const score = enhancedSimilarity(
            pm.tokens, km.tokens,
            pm.bigrams, km.bigrams,
            pm.entities, km.entities,
            pm.titleClean, km.titleClean,
            pm.conditions, km.conditions
          ) * catMultiplier;

          if (score > bestScore) {
            bestScore = score;
            bestMatch = km;
          }
        }

        if (bestMatch && bestScore >= FALLBACK_THRESHOLD) {
          usedKalshi.add(bestMatch.id);
          pairs.push({
            polymarket: pm,
            kalshi: bestMatch,
            similarityScore: bestScore,
          });
        }
      }
    }

    return pairs;
  }

  // ---- Arbitrage Detection ----

  private async findArbitrage(pairs: MatchedPair[]): Promise<CrossPlatformArb[]> {
    const arbs: CrossPlatformArb[] = [];
    const MIN_LIQUIDITY = 500; // Skip markets with <$500 liquidity (likely stale/illiquid)
    const minAnnualizedReturn = getSettings().execution.minAnnualizedReturn;

    for (const { polymarket: pm, kalshi: km, similarityScore } of pairs) {
      // Skip if no price data on either side
      if (pm.yesBid <= 0 && pm.yesAsk <= 0) continue;
      if (km.yesBid <= 0 && km.yesAsk <= 0) continue;

      // Skip illiquid markets — these produce phantom arbs that can't be executed
      if (pm.liquidity < MIN_LIQUIDITY && km.liquidity < MIN_LIQUIDITY) continue;

      // Strategy 1: Buy YES on cheaper venue, Buy NO on the other
      // If Polymarket YES is cheaper, buy YES there, buy NO (= sell YES) on Kalshi
      // If Kalshi YES is cheaper, buy YES there, buy NO on Polymarket

      const strategies = this.evaluateCrossVenueArb(pm, km);

      for (const strat of strategies) {
        if (strat.netProfit <= 0) continue;

        // Compute days to resolution for depth-walking
        const endDateStr = km.endDate || pm.endDate || "";
        const daysToRes = endDateStr
          ? Math.max((Date.parse(endDateStr) - Date.now()) / 86400000, 0.001)
          : 30; // fallback 30 days

        // Build a lightweight PairSnapshot for depth-walking evaluation
        // (depth data is empty — will be rejected by no-depth guard unless enriched later)
        const snapshot: PairSnapshot = {
          pairId: `${pm.slug}|${km.slug}`,
          kalshiTicker: km.slug,
          polymarketSlug: pm.slug,
          polyYesTokenId: pm.clobTokenIds?.[0] || "",
          polyNoTokenId: pm.clobTokenIds?.[1] || "",
          resolutionTimeUtc: endDateStr,
          snapshotTimeUtc: new Date().toISOString(),
          category: pm.category,
          kalshi: { yesBid: km.yesBid, yesAsk: km.yesAsk, noBid: km.noBid, noAsk: km.noAsk },
          polymarket: { yesBid: pm.yesBid, yesAsk: pm.yesAsk, noBid: pm.noBid, noAsk: pm.noAsk },
          daysToResolution: daysToRes,
          depth: {
            kalshi: { buyYes: [], buyNo: [] },
            polymarket: { yesAsks: [], noAsks: [] },
          },
        };

        // Run depth-walking evaluation (falls back to single-level at ask prices)
        const dwDecisions = evaluatePairSnapshot(snapshot, DEFAULT_STRATEGY_PARAMS);
        // Find the matching strategy decision
        const matchStrategy: "BUY_KY_BUY_PN" | "BUY_KN_BUY_PY" =
          strat.buyYesVenue === "KALSHI" ? "BUY_KY_BUY_PN" : "BUY_KN_BUY_PY";
        const dwMatch = dwDecisions.find((d) => d.strategy === matchStrategy);

        // Skip if annualized return is below user-configured minimum
        if (minAnnualizedReturn > 0 && dwMatch?.annualizedEdge !== undefined) {
          if (dwMatch.annualizedEdge < minAnnualizedReturn) continue;
        }

        arbs.push({
          event: pm.title,
          outcome: "YES",
          polymarketSlug: pm.slug,
          kalshiTicker: km.slug,
          polyYesBid: pm.yesBid,
          polyYesAsk: pm.yesAsk,
          kalshiYesBid: km.yesBid,
          kalshiYesAsk: km.yesAsk,
          buyYesVenue: strat.buyYesVenue,
          buyYesPrice: strat.buyYesPrice,
          buyNoVenue: strat.buyNoVenue,
          buyNoPrice: strat.buyNoPrice,
          grossProfit: strat.grossProfit,
          netProfit: strat.netProfit,
          roi: strat.roi,
          priceDiff: Math.abs(pm.yesAsk - km.yesAsk),
          polymarketUrl: pm.url,
          kalshiUrl: km.url,
          similarityScore,
          category: pm.category,
          polymarketLiquidity: pm.liquidity,
          kalshiLiquidity: km.liquidity,
          polymarketVolume24h: pm.volume24h,
          kalshiVolume24h: km.volume24h,
          endDate: endDateStr,
          polyConditionId: pm.conditionId || "",
          polyYesTokenId: pm.clobTokenIds?.[0] || "",
          polyNoTokenId: pm.clobTokenIds?.[1] || "",
          polyNegRisk: pm.negRisk || false,
          // Depth-walking results
          contracts: dwMatch?.contracts,
          kpTotalCost: dwMatch?.kpTotalCost,
          edgeDollar: dwMatch?.edgeDollar,
          edgePct: dwMatch?.edgePct,
          annualizedEdge: dwMatch?.annualizedEdge,
          kalshiLimitPrice: dwMatch?.kalshiPrice,
          polymarketLimitPrice: dwMatch?.polymarketPrice,
          kalshiFee: dwMatch?.metadata?.kalshiFee as number | undefined,
          polymarketFee: dwMatch?.metadata?.polymarketFee as number | undefined,
          daysToResolution: daysToRes,
          strategy: matchStrategy,
          stopReason: dwMatch?.metadata?.arbStopReason as string | undefined,
        });
      }
    }

    // ── Enrich top arbs with real orderbook depth ──
    // Sort by ROI and fetch depth for top 15 candidates for more accurate evaluation
    const TOP_N_DEPTH = 15;
    if (arbs.length > 0) {
      const topCandidates = [...arbs]
        .sort((a, b) => b.roi - a.roi)
        .slice(0, TOP_N_DEPTH);

      // Build a lookup from the original pairs for depth fetching
      const pairLookup = new Map<string, MatchedPair>();
      for (const p of pairs) {
        pairLookup.set(`${p.polymarket.slug}|${p.kalshi.id}`, p);
      }

      const depthPromises = topCandidates.map(async (arb) => {
        const pair = pairLookup.get(`${arb.polymarketSlug}|${arb.kalshiTicker}`);
        if (!pair) return;

        try {
          const depth = await this.fetchDepthForPair(pair.polymarket, pair.kalshi, 5000);
          // Only re-evaluate if we got meaningful depth data
          const hasDepth =
            depth.kalshi.buyYes.length > 0 ||
            depth.kalshi.buyNo.length > 0 ||
            depth.polymarket.yesAsks.length > 0 ||
            depth.polymarket.noAsks.length > 0;
          if (!hasDepth) return;

          const endDateStr = pair.kalshi.endDate || pair.polymarket.endDate || "";
          const daysToRes = endDateStr
            ? Math.max((Date.parse(endDateStr) - Date.now()) / 86400000, 0.001)
            : 30;

          const snapshot: PairSnapshot = {
            pairId: `${pair.polymarket.slug}|${pair.kalshi.slug}`,
            kalshiTicker: pair.kalshi.slug,
            polymarketSlug: pair.polymarket.slug,
            polyYesTokenId: pair.polymarket.clobTokenIds?.[0] || "",
            polyNoTokenId: pair.polymarket.clobTokenIds?.[1] || "",
            resolutionTimeUtc: endDateStr,
            snapshotTimeUtc: new Date().toISOString(),
            category: pair.polymarket.category,
            kalshi: { yesBid: pair.kalshi.yesBid, yesAsk: pair.kalshi.yesAsk, noBid: pair.kalshi.noBid, noAsk: pair.kalshi.noAsk },
            polymarket: { yesBid: pair.polymarket.yesBid, yesAsk: pair.polymarket.yesAsk, noBid: pair.polymarket.noBid, noAsk: pair.polymarket.noAsk },
            daysToResolution: daysToRes,
            depth,
          };

          const dwDecisions = evaluatePairSnapshot(snapshot, DEFAULT_STRATEGY_PARAMS);
          const matchStrategy = arb.strategy || (arb.buyYesVenue === "KALSHI" ? "BUY_KY_BUY_PN" : "BUY_KN_BUY_PY");
          const dwMatch = dwDecisions.find((d) => d.strategy === matchStrategy);

          if (dwMatch) {
            arb.contracts = dwMatch.contracts;
            arb.kpTotalCost = dwMatch.kpTotalCost;
            arb.edgeDollar = dwMatch.edgeDollar;
            arb.edgePct = dwMatch.edgePct;
            arb.annualizedEdge = dwMatch.annualizedEdge;
            arb.kalshiLimitPrice = dwMatch.kalshiPrice;
            arb.polymarketLimitPrice = dwMatch.polymarketPrice;
            arb.kalshiFee = dwMatch.metadata?.kalshiFee as number | undefined;
            arb.polymarketFee = dwMatch.metadata?.polymarketFee as number | undefined;
            arb.stopReason = dwMatch.metadata?.arbStopReason as string | undefined;
          }
        } catch {
          // Depth fetch failed — keep original fallback values
        }
      });

      await Promise.allSettled(depthPromises);
    }

    return arbs;
  }

  private evaluateCrossVenueArb(
    pm: NormalizedMarket,
    km: NormalizedMarket
  ): Array<{
    buyYesVenue: "POLYMARKET" | "KALSHI";
    buyYesPrice: number;
    buyNoVenue: "POLYMARKET" | "KALSHI";
    buyNoPrice: number;
    grossProfit: number;
    netProfit: number;
    roi: number;
  }> {
    const results: Array<{
      buyYesVenue: "POLYMARKET" | "KALSHI";
      buyYesPrice: number;
      buyNoVenue: "POLYMARKET" | "KALSHI";
      buyNoPrice: number;
      grossProfit: number;
      netProfit: number;
      roi: number;
    }> = [];

    // Minimum price to consider — anything below 5¢ is likely illiquid/stale
    const MIN_PRICE = 0.05;

    // Strategy A: Buy YES on Polymarket (at ask), Buy NO on Kalshi (at ask)
    if (pm.yesAsk >= MIN_PRICE && km.noAsk >= MIN_PRICE) {
      const yesCost = pm.yesAsk;
      const noCost = km.noAsk;
      const totalCost = yesCost + noCost;
      const grossProfit = 1.0 - totalCost;

      if (grossProfit > 0) {
        const polyFee = calcPolymarketFee(yesCost);
        const kalshiFee = calcKalshiFee(noCost);
        const netProfit = grossProfit - polyFee - kalshiFee;
        const roi = totalCost > 0 ? netProfit / totalCost : 0;

        results.push({
          buyYesVenue: "POLYMARKET",
          buyYesPrice: yesCost,
          buyNoVenue: "KALSHI",
          buyNoPrice: noCost,
          grossProfit,
          netProfit,
          roi,
        });
      }
    }

    // Strategy B: Buy YES on Kalshi (at ask), Buy NO on Polymarket (at noAsk)
    if (km.yesAsk >= MIN_PRICE && pm.noAsk >= MIN_PRICE) {
      const yesCost = km.yesAsk;
      const noCost = pm.noAsk;
      const totalCost = yesCost + noCost;
      const grossProfit = 1.0 - totalCost;

      if (grossProfit > 0) {
        const kalshiFee = calcKalshiFee(yesCost);
        const polyFee = calcPolymarketFee(noCost);
        const netProfit = grossProfit - polyFee - kalshiFee;
        const roi = totalCost > 0 ? netProfit / totalCost : 0;

        results.push({
          buyYesVenue: "KALSHI",
          buyYesPrice: yesCost,
          buyNoVenue: "POLYMARKET",
          buyNoPrice: noCost,
          grossProfit,
          netProfit,
          roi,
        });
      }
    }

    return results;
  }

  // ---- Price Differences ----

  private findPriceDiffs(pairs: MatchedPair[]): PriceDiff[] {
    const diffs: PriceDiff[] = [];

    for (const { polymarket: pm, kalshi: km } of pairs) {
      // Use midpoints for comparison (more stable than bid/ask)
      const polyMid =
        pm.yesBid > 0 && pm.yesAsk > 0
          ? (pm.yesBid + pm.yesAsk) / 2
          : pm.yesAsk || pm.yesBid;
      const kalshiMid =
        km.yesBid > 0 && km.yesAsk > 0
          ? (km.yesBid + km.yesAsk) / 2
          : km.yesAsk || km.yesBid;

      if (polyMid <= 0 && kalshiMid <= 0) continue;

      const diff = kalshiMid - polyMid;
      const avgPrice = (kalshiMid + polyMid) / 2;
      const diffPct = avgPrice > 0 ? (diff / avgPrice) * 100 : 0;

      // Only include meaningful differences (> 1 cent)
      if (Math.abs(diff) < 0.01) continue;

      diffs.push({
        event: pm.title,
        outcome: "YES",
        kalshiPrice: kalshiMid,
        polymarketPrice: polyMid,
        diff,
        diffPct,
        polymarketUrl: pm.url,
        kalshiUrl: km.url,
        category: pm.category,
      });
    }

    return diffs;
  }

  // ---- Volume Comparison ----

  private buildVolumePairs(pairs: MatchedPair[]): VolumePair[] {
    const volumes: VolumePair[] = [];

    for (const { polymarket: pm, kalshi: km, similarityScore } of pairs) {
      // Only include pairs with volume on at least one side
      if (pm.volume24h <= 0 && km.volume24h <= 0) continue;

      const totalVol = pm.volume24h + km.volume24h;
      const volumeDiff = totalVol > 0
        ? (pm.volume24h - km.volume24h) / totalVol
        : 0;

      volumes.push({
        event: pm.title,
        kalshiTicker: km.slug,
        polymarketSlug: pm.slug,
        kalshiVolume24h: km.volume24h,
        polymarketVolume24h: pm.volume24h,
        kalshiLiquidity: km.liquidity,
        polymarketLiquidity: pm.liquidity,
        volumeDiff,
        polymarketUrl: pm.url,
        kalshiUrl: km.url,
        category: pm.category,
        similarityScore,
      });
    }

    return volumes;
  }
}
