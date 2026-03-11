#!/usr/bin/env tsx
/**
 * Add a labeled training example from an AI match result in the SQLite database.
 *
 * Usage:
 *   npx tsx src/scripts/addTrainingExample.ts <polySlug> <kalshiTicker> <correct|incorrect> [notes]
 *
 * This reads the AI match result from state.db and appends it to training-set.json
 * with the user's label. The next time the Kimi service reloads its few-shot prompt,
 * this example will be included.
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { getSettings } from "../config";
import { StateStore } from "../services/stateStore";
import type { TrainingExample } from "../services/kimiMatchingService";

const args = process.argv.slice(2);
if (args.length < 3) {
  console.error("Usage: addTrainingExample <polySlug> <kalshiTicker> <correct|incorrect> [notes]");
  process.exit(1);
}

const [polySlug, kalshiTicker, label, ...noteParts] = args;
const notes = noteParts.join(" ") || undefined;

if (label !== "correct" && label !== "incorrect") {
  console.error("Label must be 'correct' or 'incorrect'");
  process.exit(1);
}

const settings = getSettings();
const store = new StateStore(path.resolve(process.cwd(), settings.paths.stateDb));

// Look up the AI match result in SQLite
const matches = store.listAiMatches({ limit: 1000 });
const match = matches.find(
  (m) => m.poly_slug === polySlug && m.kalshi_ticker === kalshiTicker
);

if (!match) {
  console.error(`No AI match found for ${polySlug} :: ${kalshiTicker}`);
  console.error("Available matches:");
  for (const m of matches.slice(0, 10)) {
    console.error(`  ${m.poly_slug} :: ${m.kalshi_ticker}`);
  }
  process.exit(1);
}

// Build training example
const example: TrainingExample = {
  polymarketTitle: match.poly_title,
  kalshiTitle: match.kalshi_title,
  polymarketSlug: match.poly_slug,
  kalshiTicker: match.kalshi_ticker,
  label: label as "correct" | "incorrect",
  category: "other", // Could be inferred from the market data
  notes,
};

// Append to training-set.json
const trainingPath = path.resolve(process.cwd(), settings.paths.trainingSet);
let existing: TrainingExample[] = [];
try {
  if (fs.existsSync(trainingPath)) {
    existing = JSON.parse(fs.readFileSync(trainingPath, "utf8"));
  }
} catch {
  existing = [];
}

// Check for duplicates
const isDuplicate = existing.some(
  (e) => e.polymarketSlug === example.polymarketSlug && e.kalshiTicker === example.kalshiTicker
);
if (isDuplicate) {
  console.log(`Example already exists for ${polySlug} :: ${kalshiTicker}`);
  process.exit(0);
}

existing.push(example);
fs.mkdirSync(path.dirname(trainingPath), { recursive: true });
fs.writeFileSync(trainingPath, JSON.stringify(existing, null, 2) + "\n", "utf8");

console.log(`Added ${label} example: "${match.poly_title}" ↔ "${match.kalshi_title}"`);
console.log(`Training set now has ${existing.length} examples`);
