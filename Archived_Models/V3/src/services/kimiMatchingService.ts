/**
 * KimiK2.5 chat-based pair verification service — V3 enhanced with few-shot prompt engineering.
 * Loads labeled training examples from training-set.json and injects them
 * into the system prompt to improve Kimi's matching accuracy.
 *
 * OpenAI-compatible API (Moonshot AI).
 */

import axios from "axios";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { AiMatchingConfig } from "../config";

// ---- Types ----

export interface KimiMatchResult {
  match: boolean;
  confidence: number;
  reasoning: string;
  fromCache: boolean;
  latencyMs: number;
}

interface CacheEntry {
  result: Omit<KimiMatchResult, "fromCache">;
  timestamp: number;
}

export interface KimiServiceStats {
  totalCalls: number;
  cacheHits: number;
  cacheMisses: number;
  hitRate: number;
  avgLatencyMs: number;
  totalTokensUsed: number;
  estimatedCostUsd: number;
  cacheSize: number;
  fewShotExampleCount: number;
}

export interface KimiCandidate {
  polyTitle: string;
  kalshiTitle: string;
  polySlug: string;
  kalshiTicker: string;
  textScore: number;
}

export interface TrainingExample {
  polymarketTitle: string;
  kalshiTitle: string;
  polymarketSlug: string;
  kalshiTicker: string;
  label: "correct" | "incorrect";
  category: string;
  notes?: string;
}

// ---- Constants ----

const DEFAULT_BASE_URL = "https://api.moonshot.ai/v1";
const DEFAULT_MODEL = "kimi-k2.5";
const DEFAULT_CACHE_PATH = "data/kimi-match-cache.json";
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_CONCURRENCY = 2;
const FLUSH_DEBOUNCE_MS = 30_000;

const BASE_SYSTEM_PROMPT = `You are a prediction market matching expert. Given two market titles from different platforms (Polymarket and Kalshi), determine if they refer to the same real-world event with the same resolution criteria.

Respond with ONLY valid JSON (no markdown, no code blocks):
{"match": boolean, "confidence": number, "reasoning": "string"}

Rules:
- match: true ONLY if both markets will resolve based on the same real-world outcome
- confidence: 0.0 to 1.0 (your certainty)
- reasoning: one-sentence explanation

Be precise about resolution criteria:
- Different thresholds (e.g., "above $100k" vs "above $90k") = NOT a match
- Different time frames = NOT a match
- Different people/entities = NOT a match
- Same event but different specific outcomes = NOT a match
- Different geographic locations (e.g., "Wyoming" vs "Iran", "Alaska" vs "Canada") = NOT a match
- Compare EXACT resolution dates — "before Jan 1, 2027" vs "in 2026" = different conditions, NOT a match
- One market specifying a condition (date, location, threshold) that the other omits → lean NOT a match
- Generic structural similarity (e.g., "Will X visit Y?" templates) is NOT enough — the specifics must match

Sports-specific rules (CRITICAL — many prediction markets are sports bets):
- Club prefixes are abbreviations of the same team: "VfB Stuttgart" = "Stuttgart", "RB Leipzig" = "Leipzig", "FC Barcelona" = "Barcelona", "Manchester United FC" = "Manchester United", etc.
- "Team A vs Team B" and "Team B at Team A" refer to the SAME match (home/away order differs between platforms)
- "Team A vs. Team B" and "Team A v Team B" are the same format
- Common bet types that are equivalent: "Both Teams to Score" = "BTTS", "Over 2.5 Goals" = "Over 2.5", "Moneyline" = "To Win"
- If both markets reference the same two teams, same date, and same bet type → MATCH even if team name formatting differs
- Kalshi tickers often encode the match info: e.g., KXBUNDESLIGABTTS-26MAR15VFBRBL = Bundesliga BTTS, March 15, VFB vs RBL`;

// ---- Service ----

export class KimiMatchingService {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private cachePath: string;
  private trainingSetPath: string;
  private cache = new Map<string, CacheEntry>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  // Few-shot
  private aiMatchingConfig: AiMatchingConfig;
  private fewShotSystemPrompt: string;
  private fewShotCount = 0;

  // Stats
  private _totalCalls = 0;
  private _cacheHits = 0;
  private _cacheMisses = 0;
  private _totalLatencyMs = 0;
  private _totalTokensUsed = 0;

  constructor(
    apiKey: string,
    options?: {
      baseUrl?: string;
      model?: string;
      cachePath?: string;
      trainingSetPath?: string;
      aiMatchingConfig?: AiMatchingConfig;
    }
  ) {
    this.apiKey = apiKey;
    this.baseUrl = options?.baseUrl || DEFAULT_BASE_URL;
    this.model = options?.model || DEFAULT_MODEL;
    this.cachePath = path.resolve(process.cwd(), options?.cachePath || DEFAULT_CACHE_PATH);
    this.trainingSetPath = path.resolve(
      process.cwd(),
      options?.trainingSetPath || "data/training-set.json"
    );
    this.aiMatchingConfig = options?.aiMatchingConfig || {
      confidenceThreshold: 0.90,
      textScoreAutoAcceptMin: 0.99,
      textScoreAiZone: [0.50, 0.99],
      maxAiCandidates: 500,
      maxMatchesPerPoly: 3,
      fewShotExampleCount: 15,
      fewShotSelectionStrategy: "diverse",
    };

    this.loadCache();
    this.fewShotSystemPrompt = this.buildFewShotSystemPrompt();
  }

  // ---- Public API ----

  async judgePair(
    polyTitle: string,
    kalshiTitle: string,
    _polySlug: string,
    _kalshiTicker: string
  ): Promise<KimiMatchResult> {
    const key = this.cacheKey(polyTitle, kalshiTitle);

    // Check cache
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_MAX_AGE_MS) {
      this._cacheHits++;
      return { ...cached.result, fromCache: true };
    }

    // API call
    this._cacheMisses++;
    this._totalCalls++;

    const MAX_RETRIES = 3;
    let lastErr = "";

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const start = Date.now();
      try {
        const resp = await axios.post(
          `${this.baseUrl}/chat/completions`,
          {
            model: this.model,
            messages: [
              { role: "system", content: this.fewShotSystemPrompt },
              { role: "user", content: `Polymarket: "${polyTitle}"\nKalshi: "${kalshiTitle}"` },
            ],
            temperature: 1,
            max_tokens: 4096,
          },
          {
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              "Content-Type": "application/json",
            },
            timeout: 120_000,
          }
        );

        const latencyMs = Date.now() - start;
        this._totalLatencyMs += latencyMs;

        const usage = resp.data?.usage;
        if (usage) {
          this._totalTokensUsed += (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
        }

        const content = resp.data?.choices?.[0]?.message?.content || "";

        if (!content) {
          // Empty content — model ran out of tokens for the answer, retry
          if (attempt < MAX_RETRIES) {
            console.warn(`[KimiMatch] Empty response (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${2 ** attempt}s...`);
            await new Promise(r => setTimeout(r, 2000 * (2 ** attempt)));
            continue;
          }
          console.warn(`[KimiMatch] Failed to parse response (0 chars): `);
          return { match: false, confidence: 0, reasoning: "Empty response after retries", fromCache: false, latencyMs };
        }

        // Debug: log first few raw responses
        if (this._totalCalls <= 3) {
          console.log(`[KimiMatch DEBUG] Raw response #${this._totalCalls} (${content.length} chars):\n${content.substring(0, 500)}`);
        }

        const parsed = this.parseResponse(content);
        const result: KimiMatchResult = {
          match: parsed.match,
          confidence: parsed.confidence,
          reasoning: parsed.reasoning,
          fromCache: false,
          latencyMs,
        };

        // Cache the result
        this.cache.set(key, {
          result: { match: parsed.match, confidence: parsed.confidence, reasoning: parsed.reasoning, latencyMs },
          timestamp: Date.now(),
        });
        this.scheduleDiskFlush();
        return result;

      } catch (err: any) {
        const latencyMs = Date.now() - start;
        const msg = err?.response?.data?.error?.message || err?.message || "Unknown error";
        lastErr = msg;
        const isRetryable = msg.includes("overloaded") || msg.includes("timeout") || msg.includes("429") || msg.includes("503") || msg.includes("ECONNRESET");

        if (isRetryable && attempt < MAX_RETRIES) {
          const delay = 3000 * (2 ** attempt); // 3s, 6s, 12s
          console.warn(`[KimiMatch] Retryable error (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${msg} — retrying in ${delay / 1000}s`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        console.warn(`[KimiMatch] API error (${latencyMs}ms): ${msg}`);
        return { match: false, confidence: 0, reasoning: `API error: ${msg}`, fromCache: false, latencyMs };
      }
    }

    return { match: false, confidence: 0, reasoning: `Failed after ${MAX_RETRIES + 1} attempts: ${lastErr}`, fromCache: false, latencyMs: 0 };
  }

  /** Send multiple pairs in one API call and parse array response */
  async judgeBatch(batch: KimiCandidate[]): Promise<KimiMatchResult[]> {
    if (batch.length === 1) {
      // Single pair — use the standard method (has retry logic)
      const c = batch[0];
      return [await this.judgePair(c.polyTitle, c.kalshiTitle, c.polySlug, c.kalshiTicker)];
    }

    this._cacheMisses += batch.length;
    this._totalCalls++;
    const start = Date.now();

    // Build multi-pair prompt
    const pairsText = batch.map((c, i) =>
      `Pair ${i + 1}:\n  Polymarket: "${c.polyTitle}"\n  Kalshi: "${c.kalshiTitle}"`
    ).join("\n\n");

    const batchPrompt = `Evaluate each pair below. Respond with a JSON ARRAY of objects, one per pair in order:\n[{"match": boolean, "confidence": number, "reasoning": "string"}, ...]\n\n${pairsText}`;

    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const resp = await axios.post(
          `${this.baseUrl}/chat/completions`,
          {
            model: this.model,
            messages: [
              { role: "system", content: this.fewShotSystemPrompt },
              { role: "user", content: batchPrompt },
            ],
            temperature: 1,
            max_tokens: 8192,
          },
          {
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              "Content-Type": "application/json",
            },
            timeout: 120_000,
          }
        );

        const latencyMs = Date.now() - start;
        this._totalLatencyMs += latencyMs;
        const perPairLatency = Math.round(latencyMs / batch.length);

        const usage = resp.data?.usage;
        if (usage) {
          this._totalTokensUsed += (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
        }

        let content = resp.data?.choices?.[0]?.message?.content || "";
        // Strip thinking tags
        content = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

        // Try to parse as JSON array
        let parsed: any[] | null = null;
        try {
          // Extract array from content
          const arrMatch = content.match(/\[[\s\S]*\]/);
          if (arrMatch) parsed = JSON.parse(arrMatch[0]);
        } catch { /* fall through */ }

        if (!parsed || !Array.isArray(parsed) || parsed.length < batch.length) {
          // Batch parse failed — fall back to individual calls
          console.warn(`[KimiMatch] Batch parse failed (got ${parsed?.length ?? 0}/${batch.length}), falling back to individual calls`);
          const fallbackResults: KimiMatchResult[] = [];
          for (const c of batch) {
            fallbackResults.push(await this.judgePair(c.polyTitle, c.kalshiTitle, c.polySlug, c.kalshiTicker));
          }
          return fallbackResults;
        }

        // Map parsed results
        const batchResults: KimiMatchResult[] = parsed.map((item) => {
          const result: KimiMatchResult = {
            match: typeof item.match === "boolean" ? item.match : false,
            confidence: typeof item.confidence === "number" ? Math.max(0, Math.min(1, item.confidence)) : 0,
            reasoning: String(item.reasoning || ""),
            fromCache: false,
            latencyMs: perPairLatency,
          };
          return result;
        });

        // Cache each result
        for (let i = 0; i < batch.length; i++) {
          const c = batch[i];
          const result = batchResults[i];
          const key = this.cacheKey(c.polyTitle, c.kalshiTitle);
          this.cache.set(key, {
            result: { match: result.match, confidence: result.confidence, reasoning: result.reasoning, latencyMs: result.latencyMs },
            timestamp: Date.now(),
          });
        }
        this.scheduleDiskFlush();
        return batchResults;

      } catch (err: any) {
        const msg = err?.response?.data?.error?.message || err?.message || "Unknown error";
        const isRetryable = msg.includes("overloaded") || msg.includes("timeout") || msg.includes("429");
        if (isRetryable && attempt < MAX_RETRIES) {
          const delay = 3000 * (2 ** attempt);
          console.warn(`[KimiMatch] Batch retry (attempt ${attempt + 1}): ${msg} — waiting ${delay / 1000}s`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        // Fall back to individual calls on permanent error
        console.warn(`[KimiMatch] Batch failed: ${msg}, falling back to individual calls`);
        const fallbackResults: KimiMatchResult[] = [];
        for (const c of batch) {
          fallbackResults.push(await this.judgePair(c.polyTitle, c.kalshiTitle, c.polySlug, c.kalshiTicker));
        }
        return fallbackResults;
      }
    }

    // Should never reach here, but just in case
    return batch.map(() => ({ match: false, confidence: 0, reasoning: "Batch exhausted retries", fromCache: false, latencyMs: 0 }));
  }

  async judgePairs(
    candidates: KimiCandidate[],
    isAborted?: () => boolean,
    onProgress?: (done: number, total: number, result: { key: string; result: KimiMatchResult; polyTitle: string; kalshiTitle: string }) => void,
  ): Promise<Map<string, KimiMatchResult>> {
    const results = new Map<string, KimiMatchResult>();
    let completed = 0;
    const total = candidates.length;

    // Split into cached and uncached
    const uncached: KimiCandidate[] = [];
    for (const c of candidates) {
      const key = this.cacheKey(c.polyTitle, c.kalshiTitle);
      const cached = this.cache.get(key);
      if (cached && Date.now() - cached.timestamp < CACHE_MAX_AGE_MS) {
        this._cacheHits++;
        const resultKey = `${c.polySlug}::${c.kalshiTicker}`;
        const cachedResult = { ...cached.result, fromCache: true };
        results.set(resultKey, cachedResult);
        completed++;
        onProgress?.(completed, total, { key: resultKey, result: cachedResult, polyTitle: c.polyTitle, kalshiTitle: c.kalshiTitle });
      } else {
        uncached.push(c);
      }
    }

    // Process uncached in batches of BATCH_SIZE with concurrency limiter
    const BATCH_SIZE = 10;
    if (uncached.length > 0) {
      // Chunk uncached into batches
      const batches: KimiCandidate[][] = [];
      for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
        batches.push(uncached.slice(i, i + BATCH_SIZE));
      }

      const semaphore = { active: 0, queue: [] as (() => void)[] };

      const acquire = (): Promise<void> => {
        if (semaphore.active < MAX_CONCURRENCY) {
          semaphore.active++;
          return Promise.resolve();
        }
        // If we wait more than 10 minutes to acquire a slot, a previous task is
        // permanently hung (e.g. OS-level TCP hang that bypassed the 120s axios timeout).
        // Throw so Promise.allSettled surfaces the error and the scan doesn't hang forever.
        return new Promise<void>((resolve, reject) => {
          let resolved = false;
          const acquireTimeout = setTimeout(() => {
            if (resolved) return;
            resolved = true;
            const idx = semaphore.queue.indexOf(resume);
            if (idx !== -1) semaphore.queue.splice(idx, 1);
            reject(new Error("[KimiMatch] Semaphore acquire timeout (10 min) — previous batch appears hung"));
          }, 10 * 60 * 1000);
          const resume = () => {
            if (resolved) return;
            resolved = true;
            clearTimeout(acquireTimeout);
            semaphore.active++;
            resolve();
          };
          semaphore.queue.push(resume);
        });
      };

      const release = () => {
        semaphore.active--;
        const next = semaphore.queue.shift();
        if (next) next();
      };

      const tasks = batches.map(async (batch) => {
        if (isAborted?.()) return;
        await acquire();
        try {
          if (isAborted?.()) return;
          const batchResults = await this.judgeBatch(batch);
          for (let i = 0; i < batch.length; i++) {
            const c = batch[i];
            const result = batchResults[i] || { match: false, confidence: 0, reasoning: "Batch parse failed", fromCache: false, latencyMs: 0 };
            const resultKey = `${c.polySlug}::${c.kalshiTicker}`;
            results.set(resultKey, result);
            completed++;
            onProgress?.(completed, total, { key: resultKey, result, polyTitle: c.polyTitle, kalshiTitle: c.kalshiTitle });
          }
        } finally {
          release();
        }
      });

      await Promise.allSettled(tasks);
    }

    return results;
  }

  getCacheStats(): KimiServiceStats {
    const totalLookups = this._cacheHits + this._cacheMisses;
    const inputCost = this._totalTokensUsed * 0.6 / 1_000_000;
    const outputCost = this._totalTokensUsed * 0.25 / 1_000_000;
    return {
      totalCalls: this._totalCalls,
      cacheHits: this._cacheHits,
      cacheMisses: this._cacheMisses,
      hitRate: totalLookups > 0 ? this._cacheHits / totalLookups : 0,
      avgLatencyMs: this._totalCalls > 0 ? Math.round(this._totalLatencyMs / this._totalCalls) : 0,
      totalTokensUsed: this._totalTokensUsed,
      estimatedCostUsd: Math.round((inputCost + outputCost) * 10000) / 10000,
      cacheSize: this.cache.size,
      fewShotExampleCount: this.fewShotCount,
    };
  }

  /** Rebuild the few-shot system prompt from current training data. Call after adding new examples. */
  reloadFewShotPrompt(): void {
    this.fewShotSystemPrompt = this.buildFewShotSystemPrompt();
    console.log(`[KimiMatch] Few-shot prompt reloaded (${this.fewShotCount} examples)`);
  }

  flushSync(): void {
    if (!this.dirty) return;
    try {
      const dir = path.dirname(this.cachePath);
      fs.mkdirSync(dir, { recursive: true });
      const obj: Record<string, CacheEntry> = {};
      for (const [k, v] of this.cache.entries()) {
        if (Date.now() - v.timestamp < CACHE_MAX_AGE_MS) {
          obj[k] = v;
        }
      }
      fs.writeFileSync(this.cachePath, JSON.stringify(obj), "utf8");
      this.dirty = false;
    } catch (err: any) {
      console.warn("[KimiMatch] Cache flush failed:", err?.message);
    }
  }

  clearCache(): void {
    this.cache.clear();
    this.dirty = true;
    this.flushSync();
  }

  // ---- Few-shot prompt engineering ----

  private buildFewShotSystemPrompt(): string {
    const examples = this.loadTrainingExamples();
    if (examples.length === 0) {
      this.fewShotCount = 0;
      return BASE_SYSTEM_PROMPT;
    }

    const selected = this.selectFewShotExamples(
      examples,
      this.aiMatchingConfig.fewShotExampleCount
    );
    this.fewShotCount = selected.length;

    if (selected.length === 0) {
      return BASE_SYSTEM_PROMPT;
    }

    const exampleBlock = selected
      .map((ex) => {
        const isMatch = ex.label === "correct";
        const conf = isMatch ? "0.98" : "0.95";
        const reasoning = ex.notes || (isMatch ? "Same event, same resolution criteria" : "Different resolution criteria");
        return `Example:
  Polymarket: "${ex.polymarketTitle}"
  Kalshi: "${ex.kalshiTitle}"
  Answer: {"match": ${isMatch}, "confidence": ${conf}, "reasoning": "${reasoning}"}`;
      })
      .join("\n\n");

    return `${BASE_SYSTEM_PROMPT}

Here are labeled examples for calibration:

${exampleBlock}`;
  }

  private loadTrainingExamples(): TrainingExample[] {
    try {
      if (!fs.existsSync(this.trainingSetPath)) return [];
      const raw = fs.readFileSync(this.trainingSetPath, "utf8");
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return [];
      return data.filter(
        (e: any) =>
          e.polymarketTitle &&
          e.kalshiTitle &&
          (e.label === "correct" || e.label === "incorrect")
      );
    } catch (err: any) {
      console.warn("[KimiMatch] Failed to load training set:", err?.message);
      return [];
    }
  }

  /**
   * Select a diverse subset of training examples for the few-shot prompt.
   * Strategy "diverse": 60% correct / 40% incorrect, distributed across categories.
   * Strategy "recent": most recently added examples.
   * Strategy "hard": prioritize edge cases (where notes mention ambiguity).
   */
  private selectFewShotExamples(
    all: TrainingExample[],
    count: number
  ): TrainingExample[] {
    if (all.length <= count) return all;

    const strategy = this.aiMatchingConfig.fewShotSelectionStrategy;

    if (strategy === "recent") {
      return all.slice(-count);
    }

    if (strategy === "hard") {
      // Prioritize examples with detailed notes (edge cases)
      const withNotes = all.filter((e) => e.notes && e.notes.length > 20);
      const withoutNotes = all.filter((e) => !e.notes || e.notes.length <= 20);
      const result: TrainingExample[] = [];
      for (const ex of withNotes) {
        if (result.length >= count) break;
        result.push(ex);
      }
      for (const ex of withoutNotes) {
        if (result.length >= count) break;
        result.push(ex);
      }
      return result;
    }

    // "diverse" strategy (default)
    const correct = all.filter((e) => e.label === "correct");
    const incorrect = all.filter((e) => e.label === "incorrect");

    const targetCorrect = Math.ceil(count * 0.6);
    const targetIncorrect = count - targetCorrect;

    const pickDiverse = (pool: TrainingExample[], n: number): TrainingExample[] => {
      if (pool.length <= n) return [...pool];
      const byCategory = new Map<string, TrainingExample[]>();
      for (const ex of pool) {
        const cat = ex.category || "other";
        const list = byCategory.get(cat) || [];
        list.push(ex);
        byCategory.set(cat, list);
      }

      const result: TrainingExample[] = [];
      const categories = [...byCategory.keys()];
      let idx = 0;
      while (result.length < n) {
        const cat = categories[idx % categories.length];
        const catList = byCategory.get(cat)!;
        if (catList.length > 0) {
          result.push(catList.shift()!);
        }
        idx++;
        if ([...byCategory.values()].every((l) => l.length === 0)) break;
      }
      return result;
    };

    return [
      ...pickDiverse(correct, targetCorrect),
      ...pickDiverse(incorrect, targetIncorrect),
    ];
  }

  // ---- Private ----

  private cacheKey(polyTitle: string, kalshiTitle: string): string {
    const a = this.cleanTitle(polyTitle);
    const b = this.cleanTitle(kalshiTitle);
    return crypto.createHash("md5").update(`${a}|${b}`).digest("hex");
  }

  private cleanTitle(title: string): string {
    return title.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
  }

  private parseResponse(rawContent: string): { match: boolean; confidence: number; reasoning: string } {
    // Strip thinking/reasoning blocks from reasoning models (kimi-k2.5, etc.)
    // These wrap chain-of-thought in <think>...</think> or similar tags
    let content = rawContent
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .replace(/<reasoning>[\s\S]*?<\/reasoning>/g, "")
      .trim();

    // If content doesn't start with '{', try to extract JSON object from mixed text
    if (!content.startsWith("{")) {
      const jsonExtract = content.match(/\{[^{}]*"match"\s*:[^{}]*"confidence"\s*:[^{}]*\}/);
      if (jsonExtract) content = jsonExtract[0];
    }

    // Attempt 1: direct JSON.parse
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed.match === "boolean" && typeof parsed.confidence === "number") {
        return {
          match: parsed.match,
          confidence: Math.max(0, Math.min(1, parsed.confidence)),
          reasoning: String(parsed.reasoning || ""),
        };
      }
    } catch { /* fall through */ }

    // Attempt 2: extract from code blocks
    const codeBlockMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (codeBlockMatch) {
      try {
        const parsed = JSON.parse(codeBlockMatch[1]);
        if (typeof parsed.match === "boolean" && typeof parsed.confidence === "number") {
          return {
            match: parsed.match,
            confidence: Math.max(0, Math.min(1, parsed.confidence)),
            reasoning: String(parsed.reasoning || ""),
          };
        }
      } catch { /* fall through */ }
    }

    // Attempt 3: regex extraction from the CLEANED content (thinking tags already stripped)
    const matchVal = /"match"\s*:\s*(true|false)/.exec(content);
    const confVal = /"confidence"\s*:\s*([\d.]+)/.exec(content);
    const reasonVal = /"reasoning"\s*:\s*"([^"]*)"/.exec(content);

    if (matchVal && confVal) {
      return {
        match: matchVal[1] === "true",
        confidence: Math.max(0, Math.min(1, parseFloat(confVal[1]))),
        reasoning: reasonVal?.[1] || "Parsed via regex fallback",
      };
    }

    // Attempt 4: search the ORIGINAL content (in case stripping was too aggressive)
    const origMatchVal = /"match"\s*:\s*(true|false)/.exec(rawContent);
    const origConfVal = /"confidence"\s*:\s*([\d.]+)/.exec(rawContent);
    const origReasonVal = /"reasoning"\s*:\s*"([^"]*)"/.exec(rawContent);

    if (origMatchVal && origConfVal) {
      return {
        match: origMatchVal[1] === "true",
        confidence: Math.max(0, Math.min(1, parseFloat(origConfVal[1]))),
        reasoning: origReasonVal?.[1] || "Parsed via regex fallback (raw)",
      };
    }

    console.warn(`[KimiMatch] Failed to parse response (${rawContent.length} chars): ${rawContent.substring(0, 200)}`);
    return { match: false, confidence: 0, reasoning: "Failed to parse model response" };
  }

  private scheduleDiskFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushSync();
    }, FLUSH_DEBOUNCE_MS);
  }

  private loadCache(): void {
    try {
      if (!fs.existsSync(this.cachePath)) return;
      const raw = fs.readFileSync(this.cachePath, "utf8");
      const obj = JSON.parse(raw) as Record<string, CacheEntry>;
      let loaded = 0;
      let expired = 0;
      for (const [k, v] of Object.entries(obj)) {
        if (Date.now() - v.timestamp < CACHE_MAX_AGE_MS) {
          this.cache.set(k, v);
          loaded++;
        } else {
          expired++;
        }
      }
      if (loaded > 0 || expired > 0) {
        console.log(`  KimiK2.5 cache: ${loaded} entries loaded, ${expired} expired`);
      }
    } catch (err: any) {
      console.warn("[KimiMatch] Cache load failed:", err?.message);
    }
  }
}
