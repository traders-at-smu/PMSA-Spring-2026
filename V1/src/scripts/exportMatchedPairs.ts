/**
 * exportMatchedPairs.ts
 *
 * Standalone script: scrape Polymarket + Kalshi, match contracts,
 * output a clean CSV of matched pairs with URLs, prices, and arb data.
 *
 * Usage:
 *   npx ts-node src/scripts/exportMatchedPairs.ts
 *   npx ts-node src/scripts/exportMatchedPairs.ts --min-similarity 0.20
 *   npx ts-node src/scripts/exportMatchedPairs.ts --arbs-only
 *   npx ts-node src/scripts/exportMatchedPairs.ts --format json
 */

import { ArbitrageScreener } from "../screener";
import { KalshiScreener } from "../kalshiScreener";
import { CrossPlatformScreener } from "../crossPlatformScreener";
import * as fs from "fs";
import * as path from "path";

// ---- CLI args ----
const args = process.argv.slice(2);
const minSimilarity = parseFloat(
  args.find((a) => a.startsWith("--min-similarity="))?.split("=")[1] ?? "0.10"
);
const arbsOnly = args.includes("--arbs-only");
const format = args.find((a) => a.startsWith("--format="))?.split("=")[1] ?? "csv";
const outDir = path.resolve(
  args.find((a) => a.startsWith("--out="))?.split("=")[1] ?? "."
);

async function main() {
  console.log("=== Matched Pairs Export ===");
  console.log(`  Min similarity: ${minSimilarity}`);
  console.log(`  Arbs only: ${arbsOnly}`);
  console.log(`  Format: ${format}`);
  console.log();

  const polyScreener = new ArbitrageScreener();
  const kalshiScreener = new KalshiScreener();
  const crossScreener = new CrossPlatformScreener(polyScreener, kalshiScreener);

  console.log("Fetching and matching...");
  const results = await crossScreener.getResults();

  console.log(`  Polymarket markets scanned: ${results.polymarketsScanned}`);
  console.log(`  Kalshi markets scanned:     ${results.kalshiMarketsScanned}`);
  console.log(`  Matched pairs:              ${results.matchedPairs}`);
  console.log(`  Arb opportunities:          ${results.arbs.length}`);
  console.log(`  Price diffs:                ${results.diffs.length}`);
  console.log();

  // ---- Build rows ----
  if (arbsOnly) {
    // Only profitable arbs
    const rows = results.arbs
      .filter((a) => a.similarityScore >= minSimilarity && a.netProfit > 0)
      .map((a) => ({
        event: a.event,
        similarity: a.similarityScore.toFixed(3),
        category: a.category,
        buy_yes_venue: a.buyYesVenue,
        buy_yes_price: a.buyYesPrice.toFixed(2),
        buy_no_venue: a.buyNoVenue,
        buy_no_price: a.buyNoPrice.toFixed(2),
        total_cost: (a.buyYesPrice + a.buyNoPrice).toFixed(2),
        gross_profit: a.grossProfit.toFixed(4),
        net_profit: a.netProfit.toFixed(4),
        roi_pct: (a.roi * 100).toFixed(2),
        polymarket_slug: a.polymarketSlug,
        kalshi_ticker: a.kalshiTicker,
        polymarket_url: a.polymarketUrl,
        kalshi_url: a.kalshiUrl,
        poly_condition_id: a.polyConditionId,
        poly_yes_token_id: a.polyYesTokenId,
        poly_no_token_id: a.polyNoTokenId,
      }));

    writeOutput("matched_arbs", rows, format, outDir);
    console.log(`Exported ${rows.length} arb opportunities.`);
  } else {
    // All matched pairs (including non-arb)
    const pairRows = results.diffs
      .filter((d) => true) // include all
      .map((d) => ({
        event: d.event,
        category: d.category,
        polymarket_price: d.polymarketPrice.toFixed(3),
        kalshi_price: d.kalshiPrice.toFixed(3),
        price_diff: d.diff.toFixed(3),
        diff_pct: d.diffPct.toFixed(2),
        polymarket_url: d.polymarketUrl,
        kalshi_url: d.kalshiUrl,
      }));

    const arbRows = results.arbs
      .filter((a) => a.similarityScore >= minSimilarity && a.netProfit > 0)
      .map((a) => ({
        event: a.event,
        similarity: a.similarityScore.toFixed(3),
        category: a.category,
        buy_yes_venue: a.buyYesVenue,
        buy_yes_price: a.buyYesPrice.toFixed(2),
        buy_no_venue: a.buyNoVenue,
        buy_no_price: a.buyNoPrice.toFixed(2),
        total_cost: (a.buyYesPrice + a.buyNoPrice).toFixed(2),
        net_profit: a.netProfit.toFixed(4),
        roi_pct: (a.roi * 100).toFixed(2),
        polymarket_url: a.polymarketUrl,
        kalshi_url: a.kalshiUrl,
      }));

    writeOutput("matched_pairs", pairRows, format, outDir);
    writeOutput("matched_arbs", arbRows, format, outDir);
    console.log(`Exported ${pairRows.length} pairs + ${arbRows.length} arbs.`);
  }
}

function writeOutput(name: string, rows: Record<string, string>[], fmt: string, dir: string) {
  if (rows.length === 0) {
    console.log(`  ${name}: no rows to write.`);
    return;
  }

  if (fmt === "json") {
    const outPath = path.join(dir, `${name}.json`);
    fs.writeFileSync(outPath, JSON.stringify(rows, null, 2));
    console.log(`  -> ${outPath}`);
  } else {
    // CSV
    const headers = Object.keys(rows[0]);
    const csvLines = [
      headers.join(","),
      ...rows.map((r) =>
        headers.map((h) => {
          const val = r[h] ?? "";
          // Quote fields containing commas or quotes
          return val.includes(",") || val.includes('"')
            ? `"${val.replace(/"/g, '""')}"`
            : val;
        }).join(",")
      ),
    ];
    const outPath = path.join(dir, `${name}.csv`);
    fs.writeFileSync(outPath, csvLines.join("\n"));
    console.log(`  -> ${outPath}`);
  }
}

main().catch((err) => {
  console.error("Export failed:", err);
  process.exit(1);
});
