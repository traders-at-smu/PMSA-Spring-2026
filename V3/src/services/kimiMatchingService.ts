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
const MAX_CONCURRENCY = 8;
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
- Generic structural similarity (e.g., "Will X visit Y?" templates) is NOT enough — the specifics must match`;

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
      textScoreAutoAcceptMin: 0.90,
      textScoreAiZone: [0.50, 0.90],
      maxAiCandidates: 250,
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
          max_tokens: 200,
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          timeout: 15_000,
        }
      );

      const latencyMs = Date.now() - start;
      this._totalLatencyMs += latencyMs;

      const usage = resp.data?.usage;
      if (usage) {
        this._totalTokensUsed += (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
      }

      const content = resp.data?.choices?.[0]?.message?.content || "";
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
      console.warn(`[KimiMatch] API error (${latencyMs}ms): ${msg}`);
      return {
        match: false,
        confidence: 0,
        reasoning: `API error: ${msg}`,
        fromCache: false,
        latencyMs,
      };
    }
  }

  async judgePairs(candidates: KimiCandidate[]): Promise<Map<string, KimiMatchResult>> {
    const results = new Map<string, KimiMatchResult>();

    // Split into cached and uncached
    const uncached: KimiCandidate[] = [];
    for (const c of candidates) {
      const key = this.cacheKey(c.polyTitle, c.kalshiTitle);
      const cached = this.cache.get(key);
      if (cached && Date.now() - cached.timestamp < CACHE_MAX_AGE_MS) {
        this._cacheHits++;
        results.set(`${c.polySlug}::${c.kalshiTicker}`, { ...cached.result, fromCache: true });
      } else {
        uncached.push(c);
      }
    }

    // Process uncached with concurrency limiter
    if (uncached.length > 0) {
      const semaphore = { active: 0, queue: [] as (() => void)[] };

      const acquire = (): Promise<void> => {
        if (semaphore.active < MAX_CONCURRENCY) {
          semaphore.active++;
          return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
          semaphore.queue.push(() => { semaphore.active++; resolve(); });
        });
      };

      const release = () => {
        semaphore.active--;
        const next = semaphore.queue.shift();
        if (next) next();
      };

      const tasks = uncached.map(async (c) => {
        await acquire();
        try {
          const result = await this.judgePair(c.polyTitle, c.kalshiTitle, c.polySlug, c.kalshiTicker);
          results.set(`${c.polySlug}::${c.kalshiTicker}`, result);
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

  private parseResponse(content: string): { match: boolean; confidence: number; reasoning: string } {
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
