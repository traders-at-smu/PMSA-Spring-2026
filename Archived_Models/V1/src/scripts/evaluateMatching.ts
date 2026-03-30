/**
 * Evaluate matching quality against the training set.
 *
 * Usage:
 *   npx tsx src/scripts/evaluateMatching.ts                    # text-only baseline
 *   npx tsx src/scripts/evaluateMatching.ts --mode embedding   # embedding-only
 *   npx tsx src/scripts/evaluateMatching.ts --mode combined    # combined scoring
 *   npx tsx src/scripts/evaluateMatching.ts --sweep            # sweep thresholds for best F1
 */

import fs from "fs";
import path from "path";
import { EmbeddingService } from "../services/embeddingService";

interface TrainingExample {
  polymarketTitle: string;
  kalshiTitle: string;
  label: "correct" | "incorrect";
  category?: string;
  notes?: string;
}

interface EvalResult {
  mode: string;
  threshold: number;
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
}

const TRAINING_PATH = path.resolve(process.cwd(), "data", "training-set.json");

function loadTrainingSet(): TrainingExample[] {
  if (!fs.existsSync(TRAINING_PATH)) {
    throw new Error(`Training set not found at ${TRAINING_PATH}. Run buildTrainingSet.ts first.`);
  }
  const data: TrainingExample[] = JSON.parse(fs.readFileSync(TRAINING_PATH, "utf8"));
  // Filter out any "unknown" labels
  return data.filter((e) => e.label === "correct" || e.label === "incorrect");
}

function evaluate(
  examples: TrainingExample[],
  scores: number[],
  threshold: number,
  mode: string
): EvalResult {
  let tp = 0, fp = 0, tn = 0, fn = 0;

  for (let i = 0; i < examples.length; i++) {
    const predicted = scores[i] >= threshold;
    const actual = examples[i].label === "correct";

    if (predicted && actual) tp++;
    else if (predicted && !actual) fp++;
    else if (!predicted && !actual) tn++;
    else fn++;
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return { mode, threshold, truePositives: tp, falsePositives: fp, trueNegatives: tn, falseNegatives: fn, precision, recall, f1 };
}

function printResult(r: EvalResult, examples?: TrainingExample[], scores?: number[]): void {
  console.log(`\n  Mode: ${r.mode} | Threshold: ${r.threshold.toFixed(2)}`);
  console.log(`  TP=${r.truePositives} FP=${r.falsePositives} TN=${r.trueNegatives} FN=${r.falseNegatives}`);
  console.log(`  Precision: ${(r.precision * 100).toFixed(1)}%`);
  console.log(`  Recall:    ${(r.recall * 100).toFixed(1)}%`);
  console.log(`  F1:        ${(r.f1 * 100).toFixed(1)}%`);

  if (examples && scores && r.falsePositives > 0) {
    console.log(`\n  False Positives (labeled incorrect but scored above threshold):`);
    for (let i = 0; i < examples.length; i++) {
      if (scores[i] >= r.threshold && examples[i].label === "incorrect") {
        console.log(`    [${scores[i].toFixed(3)}] "${examples[i].polymarketTitle}" → "${examples[i].kalshiTitle}"`);
      }
    }
  }
}

function sweepThresholds(
  examples: TrainingExample[],
  scores: number[],
  mode: string
): EvalResult {
  let best: EvalResult | null = null;
  for (let t = 0.20; t <= 0.80; t += 0.01) {
    const r = evaluate(examples, scores, t, mode);
    if (!best || r.f1 > best.f1) best = r;
  }
  return best!;
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes("--mode") ? args[args.indexOf("--mode") + 1] : "text-only";
  const doSweep = args.includes("--sweep");

  const examples = loadTrainingSet();
  console.log(`Loaded ${examples.length} training examples`);
  console.log(`  correct: ${examples.filter((e) => e.label === "correct").length}`);
  console.log(`  incorrect: ${examples.filter((e) => e.label === "incorrect").length}`);

  // For text-only: use a simple token overlap as a proxy
  // (The real enhancedSimilarity is in crossPlatformScreener but we can approximate)
  const textScores = examples.map((e) => {
    const aTok = new Set(e.polymarketTitle.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter((w) => w.length > 2));
    const bTok = new Set(e.kalshiTitle.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter((w) => w.length > 2));
    const shared = [...aTok].filter((t) => bTok.has(t)).length;
    const total = new Set([...aTok, ...bTok]).size;
    return total > 0 ? shared / total : 0;
  });

  if (mode === "text-only" || mode === "all") {
    console.log("\n=== TEXT-ONLY EVALUATION ===");
    if (doSweep) {
      const best = sweepThresholds(examples, textScores, "text-only");
      printResult(best, examples, textScores);
    } else {
      const result = evaluate(examples, textScores, 0.40, "text-only");
      printResult(result, examples, textScores);
    }
  }

  if (mode === "embedding" || mode === "combined" || mode === "all") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error("\nOPENAI_API_KEY not set — cannot run embedding evaluation");
      process.exit(1);
    }

    const embedder = new EmbeddingService(apiKey);
    const allTitles = [...new Set(examples.flatMap((e) => [e.polymarketTitle, e.kalshiTitle]))];
    console.log(`\nEmbedding ${allTitles.length} unique titles...`);
    const vectors = await embedder.batchEmbed(allTitles);
    embedder.flushSync();

    const embeddingScores = examples.map((e) => {
      const va = vectors.get(e.polymarketTitle);
      const vb = vectors.get(e.kalshiTitle);
      if (!va || !vb) return 0;
      return EmbeddingService.cosineSimilarity(va, vb);
    });

    if (mode === "embedding" || mode === "all") {
      console.log("\n=== EMBEDDING-ONLY EVALUATION ===");
      if (doSweep) {
        const best = sweepThresholds(examples, embeddingScores, "embedding");
        printResult(best, examples, embeddingScores);
      } else {
        const result = evaluate(examples, embeddingScores, 0.75, "embedding");
        printResult(result, examples, embeddingScores);
      }
    }

    if (mode === "combined" || mode === "all") {
      console.log("\n=== COMBINED EVALUATION ===");
      const TEXT_WEIGHT = 0.55;
      const EMBED_WEIGHT = 0.45;
      const combinedScores = examples.map((_, i) => TEXT_WEIGHT * textScores[i] + EMBED_WEIGHT * embeddingScores[i]);

      if (doSweep) {
        const best = sweepThresholds(examples, combinedScores, "combined");
        printResult(best, examples, combinedScores);
      } else {
        const result = evaluate(examples, combinedScores, 0.45, "combined");
        printResult(result, examples, combinedScores);
      }

      // Show individual scores for inspection
      console.log("\n  --- Individual Scores ---");
      for (let i = 0; i < examples.length; i++) {
        const label = examples[i].label === "correct" ? "+" : "-";
        console.log(
          `  [${label}] text=${textScores[i].toFixed(3)} emb=${embeddingScores[i].toFixed(3)} ` +
            `combined=${(TEXT_WEIGHT * textScores[i] + EMBED_WEIGHT * embeddingScores[i]).toFixed(3)} ` +
            `"${examples[i].polymarketTitle.slice(0, 50)}"`
        );
      }
    }
  }
}

main().catch(console.error);
