/**
 * Build / extend the training set from signal-history.jsonl.
 *
 * Usage:
 *   npx tsx src/scripts/buildTrainingSet.ts
 *
 * Reads logs/signal-history.jsonl, auto-labels obvious correct/incorrect
 * pairs, and merges with the existing data/training-set.json.
 */

import fs from "fs";
import path from "path";

interface Signal {
  key: string;
  event: string;
  polymarketSlug: string;
  kalshiTicker: string;
  similarityScore: number;
  category: string;
}

interface TrainingExample {
  polymarketTitle: string;
  kalshiTitle: string;
  polymarketSlug: string;
  kalshiTicker: string;
  label: "correct" | "incorrect" | "unknown";
  category: string;
  notes: string;
}

const SIGNAL_PATH = path.resolve(process.cwd(), "logs", "signal-history.jsonl");
const TRAINING_PATH = path.resolve(process.cwd(), "data", "training-set.json");

function loadSignals(): Signal[] {
  if (!fs.existsSync(SIGNAL_PATH)) {
    console.log("No signal-history.jsonl found");
    return [];
  }
  const lines = fs.readFileSync(SIGNAL_PATH, "utf8").trim().split("\n");
  return lines.filter(Boolean).map((l) => JSON.parse(l));
}

function loadExisting(): TrainingExample[] {
  if (!fs.existsSync(TRAINING_PATH)) return [];
  return JSON.parse(fs.readFileSync(TRAINING_PATH, "utf8"));
}

/** Extract team codes from Polymarket slug */
function extractSlugTeams(slug: string): string[] {
  // e.g., "nba-okc-nyk-2026-03-04-rebounds-..." → ["okc", "nyk"]
  // e.g., "epl-wes-mac-2026-03-14-spread-..." → ["wes", "mac"]
  const parts = slug.split("-");
  const teams: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    if (/^\d{4}$/.test(parts[i])) break; // hit the year
    if (parts[i].length >= 2 && parts[i].length <= 5) {
      teams.push(parts[i].toLowerCase());
    }
  }
  return teams;
}

/** Extract team/entity code from Kalshi ticker suffix */
function extractTickerTeams(ticker: string): string[] {
  // e.g., "KXNBAREB-26MAR04OKCNYK-..." → extract "OKCNYK" → ["okc", "nyk"]
  // e.g., "KXEPLBTTS-26MAR04FULWHU" → extract "FULWHU" → ["ful", "whu"]
  const teams: string[] = [];
  // Look for team codes in the date-team segment
  const match = ticker.match(/\d{2}[A-Z]{3}\d{2}([A-Z]+)/);
  if (match) {
    // Split concatenated team codes (usually 3 chars each)
    const combined = match[1].toLowerCase();
    if (combined.length >= 6) {
      teams.push(combined.slice(0, 3));
      teams.push(combined.slice(3, 6));
    } else if (combined.length >= 3) {
      teams.push(combined.slice(0, 3));
    }
  }
  return teams;
}

function autoLabel(signal: Signal): "correct" | "incorrect" | "unknown" {
  // High-confidence correct
  if (signal.similarityScore >= 0.90) return "correct";

  // For sports: check if team codes match
  const slugTeams = extractSlugTeams(signal.polymarketSlug);
  const tickerTeams = extractTickerTeams(signal.kalshiTicker);

  if (slugTeams.length >= 2 && tickerTeams.length >= 2) {
    // Check if there's overlap
    const slugSet = new Set(slugTeams);
    const overlap = tickerTeams.filter((t) => slugSet.has(t));
    if (overlap.length === 0) return "incorrect"; // No team overlap at all
    if (overlap.length < 2 && signal.similarityScore < 0.55) return "incorrect";
  }

  // Low score with category hints
  if (signal.similarityScore < 0.42) {
    // Check for obvious mismatches like rain vs sports
    if (signal.kalshiTicker.includes("RAIN") && !signal.polymarketSlug.includes("rain")) {
      return "incorrect";
    }
  }

  return "unknown";
}

function main() {
  const signals = loadSignals();
  const existing = loadExisting();
  const existingKeys = new Set(existing.map((e) => `${e.polymarketSlug}|${e.kalshiTicker}`));

  console.log(`Loaded ${signals.length} signals, ${existing.length} existing training examples`);

  let added = 0;
  const newExamples: TrainingExample[] = [];

  // Deduplicate signals by key
  const seen = new Set<string>();
  for (const signal of signals) {
    const key = `${signal.polymarketSlug}|${signal.kalshiTicker}`;
    if (seen.has(key) || existingKeys.has(key)) continue;
    seen.add(key);

    const label = autoLabel(signal);
    newExamples.push({
      polymarketTitle: signal.event,
      kalshiTitle: `(Kalshi: ${signal.kalshiTicker})`,
      polymarketSlug: signal.polymarketSlug,
      kalshiTicker: signal.kalshiTicker,
      label: label as "correct" | "incorrect",
      category: signal.category,
      notes: `Auto-labeled from signal history (textScore=${signal.similarityScore.toFixed(3)})`,
    });
    added++;
  }

  console.log(`\nAuto-labeling results:`);
  console.log(`  correct:   ${newExamples.filter((e) => e.label === "correct").length}`);
  console.log(`  incorrect: ${newExamples.filter((e) => e.label === "incorrect").length}`);
  console.log(`  unknown:   ${newExamples.filter((e) => e.label === "unknown").length}`);

  // Only add non-unknown examples to training set
  const labeled = newExamples.filter((e) => e.label !== "unknown");
  const merged = [...existing, ...labeled];

  if (labeled.length > 0) {
    fs.writeFileSync(TRAINING_PATH, JSON.stringify(merged, null, 2) + "\n", "utf8");
    console.log(`\nWrote ${merged.length} total examples to ${TRAINING_PATH}`);
    console.log(`  (${labeled.length} new, ${existing.length} existing)`);
  } else {
    console.log(`\nNo new labeled examples to add.`);
  }

  // Report unknowns for manual review
  const unknowns = newExamples.filter((e) => e.label === "unknown");
  if (unknowns.length > 0) {
    console.log(`\n--- NEEDS MANUAL REVIEW (${unknowns.length}) ---`);
    for (const u of unknowns) {
      console.log(`  [?] "${u.polymarketTitle}"`);
      console.log(`      → ${u.kalshiTicker} (score: ${u.notes})`);
    }
  }
}

main();
