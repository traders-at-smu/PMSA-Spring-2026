import axios from "axios";
import fs from "fs";
import path from "path";
import crypto from "crypto";

// ---- Types ----

interface CachedVector {
  v: number[]; // 512-dim float vector
  t: number;   // timestamp (epoch ms)
}

interface EmbeddingCacheFile {
  [hash: string]: CachedVector;
}

// ---- Service ----

export class EmbeddingService {
  private readonly apiKey: string;
  private readonly model = "text-embedding-3-small";
  private readonly dimensions = 512;
  private readonly batchSize = 100;
  private readonly cachePath: string;

  private cache = new Map<string, number[]>();
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  // Stats
  private hits = 0;
  private misses = 0;

  constructor(apiKey: string, cachePath?: string) {
    this.apiKey = apiKey;
    this.cachePath = cachePath ?? path.resolve(process.cwd(), "data", "embedding-cache.json");
    this.loadCache();
  }

  // ---- Public API ----

  /** Get embedding for a single title (cached) */
  async getEmbedding(title: string): Promise<number[] | null> {
    const key = this.cacheKey(title);
    const cached = this.cache.get(key);
    if (cached) {
      this.hits++;
      return cached;
    }
    this.misses++;

    const results = await this.callOpenAI([title]);
    if (!results || results.length === 0) return null;

    const vec = results[0];
    this.cache.set(key, vec);
    this.scheduleDiskFlush();
    return vec;
  }

  /** Batch-embed multiple titles. Returns Map<title, vector>. Skips cached titles. */
  async batchEmbed(titles: string[]): Promise<Map<string, number[]>> {
    const result = new Map<string, number[]>();
    const uncached: { title: string; key: string }[] = [];

    for (const title of titles) {
      const key = this.cacheKey(title);
      const cached = this.cache.get(key);
      if (cached) {
        this.hits++;
        result.set(title, cached);
      } else {
        this.misses++;
        uncached.push({ title, key });
      }
    }

    if (uncached.length === 0) return result;

    // Batch in chunks
    for (let i = 0; i < uncached.length; i += this.batchSize) {
      const batch = uncached.slice(i, i + this.batchSize);
      const vectors = await this.callOpenAI(batch.map((u) => u.title));
      if (!vectors) continue;

      for (let j = 0; j < batch.length && j < vectors.length; j++) {
        const vec = vectors[j];
        this.cache.set(batch[j].key, vec);
        result.set(batch[j].title, vec);
      }
    }

    this.scheduleDiskFlush();
    return result;
  }

  /** Cosine similarity between two vectors. Returns 0–1 (clamped). */
  static cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) return 0;
    return Math.max(0, Math.min(1, dot / denom));
  }

  getCacheStats(): { size: number; hits: number; misses: number; hitRate: number } {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }

  /** Flush cache to disk immediately (call on shutdown) */
  flushSync(): void {
    if (!this.dirty) return;
    this.writeCacheToDisk();
  }

  // ---- Private ----

  private cacheKey(title: string): string {
    const cleaned = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    return crypto.createHash("md5").update(cleaned).digest("hex");
  }

  private loadCache(): void {
    try {
      if (!fs.existsSync(this.cachePath)) return;
      const raw = fs.readFileSync(this.cachePath, "utf8");
      const data: EmbeddingCacheFile = JSON.parse(raw);
      for (const [hash, entry] of Object.entries(data)) {
        if (entry.v && Array.isArray(entry.v)) {
          this.cache.set(hash, entry.v);
        }
      }
      console.log(`  Embedding cache loaded: ${this.cache.size} vectors from ${this.cachePath}`);
    } catch (err) {
      console.warn("  Embedding cache load failed, starting fresh:", (err as Error).message);
    }
  }

  private writeCacheToDisk(): void {
    try {
      const dir = path.dirname(this.cachePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const data: EmbeddingCacheFile = {};
      for (const [hash, vec] of this.cache) {
        data[hash] = { v: vec, t: Date.now() };
      }
      fs.writeFileSync(this.cachePath, JSON.stringify(data), "utf8");
      this.dirty = false;
    } catch (err) {
      console.error("  Embedding cache write failed:", (err as Error).message);
    }
  }

  private scheduleDiskFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.writeCacheToDisk();
    }, 30_000); // 30s debounce
  }

  private async callOpenAI(inputs: string[]): Promise<number[][] | null> {
    try {
      const resp = await axios.post(
        "https://api.openai.com/v1/embeddings",
        {
          model: this.model,
          input: inputs,
          dimensions: this.dimensions,
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          timeout: 30_000,
        }
      );

      const embeddings: { index: number; embedding: number[] }[] = resp.data?.data ?? [];
      // Sort by index to match input order
      embeddings.sort((a, b) => a.index - b.index);
      return embeddings.map((e) => e.embedding);
    } catch (err: any) {
      const status = err?.response?.status;
      const msg = err?.response?.data?.error?.message || err.message;
      console.error(`  Embedding API error (${status || "network"}): ${msg}`);
      return null;
    }
  }
}
