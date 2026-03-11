/**
 * Unified 5-minute loop orchestrator for V3.
 * Each cycle: fetch markets → AI match pairs → evaluate arb → paper trade → track P&L.
 */

import crypto from "crypto";
import { getSettings } from "./config";
import type { CrossPlatformScreener, CrossPlatformArb } from "./crossPlatformScreener";
import type { ExecutionEngine, ExecutionResult } from "./services/executionEngine";
import type { PaperAccountService } from "./services/paperAccountService";
import type { NotificationService } from "./services/notificationService";
import type { StateStore } from "./services/stateStore";
import type { OpportunityDecision, ArbStrategy } from "./types";

// ---- Types ----

export interface LoopServices {
  screener: CrossPlatformScreener;
  execution: ExecutionEngine;
  paper: PaperAccountService;
  notifications: NotificationService;
  store: StateStore;
}

export interface CycleResult {
  cycleId: string;
  timestamp: string;
  matchedPairs: number;
  arbsFound: number;
  tradesExecuted: number;
  durationMs: number;
  errors: string[];
}

// ---- Loop state ----

let _running = false;
let _cycleCount = 0;
let _lastCycleAt: string | null = null;
let _nextCycleAt: string | null = null;
let _stopRequested = false;

export function getLoopStatus() {
  const settings = getSettings();
  return {
    running: _running,
    cycleCount: _cycleCount,
    lastCycleAt: _lastCycleAt,
    nextCycleAt: _nextCycleAt,
    intervalMs: settings.loop.intervalMs,
  };
}

// ---- Core cycle ----

export async function runOneCycle(services: LoopServices): Promise<CycleResult> {
  const cycleId = crypto.randomBytes(8).toString("hex");
  const start = Date.now();
  const errors: string[] = [];
  const settings = getSettings();
  let tradesExecuted = 0;

  console.log(`\n[Loop] Cycle ${cycleId} starting...`);

  // 1. Fetch + match + evaluate via screener (handles steps 1-6 internally)
  services.screener.invalidateCache(); // force fresh data
  const results = await services.screener.getResults();

  console.log(
    `  Matched: ${results.matchedPairs} pairs | Arbs: ${results.arbs.length} | Poly: ${results.polymarketsScanned} | Kalshi: ${results.kalshiMarketsScanned}`
  );

  // 2. Build OpportunityDecision[] from profitable arbs
  const decisions: OpportunityDecision[] = results.arbs
    .filter((a) => a.netProfit > 0 && (a.edgePct ?? a.roi) >= settings.execution.minNetEdge)
    .map((a) => arbToDecision(a));

  // 3. Execute trades (paper mode)
  if (decisions.length > 0 && settings.loop.executeOnArb) {
    try {
      const execResults: ExecutionResult[] = await services.execution.execute(
        cycleId,
        decisions,
        settings.execution.mode.toLowerCase() as "paper" | "live"
      );

      tradesExecuted = execResults.filter((r) => r.status === "executed").length;

      // Notify on executed trades
      for (const r of execResults) {
        if (r.status === "executed") {
          services.notifications.notifyTradeExecuted(r.decision, settings.execution.mode);
        }
      }

      console.log(`  Executed: ${tradesExecuted}/${decisions.length} trades`);
    } catch (err: any) {
      const msg = `Execution error: ${err?.message || err}`;
      errors.push(msg);
      console.warn(`  ${msg}`);
    }
  }

  // 4. Notify on arb found (even if not executed)
  for (const arb of results.arbs.slice(0, 3)) {
    services.notifications.notifyArbFound(
      `${arb.polymarketSlug}|${arb.kalshiTicker}`,
      arb.edgePct ?? arb.roi,
      arb.annualizedEdge ?? 0
    );
  }

  // 5. Persist cycle to SQLite
  try {
    services.store.saveCycle(cycleId, [], decisions, errors);
  } catch (err: any) {
    console.warn(`  Failed to save cycle: ${err?.message}`);
  }

  const durationMs = Date.now() - start;
  _lastCycleAt = new Date().toISOString();
  _cycleCount++;

  const result: CycleResult = {
    cycleId,
    timestamp: _lastCycleAt,
    matchedPairs: results.matchedPairs,
    arbsFound: results.arbs.length,
    tradesExecuted,
    durationMs,
    errors,
  };

  console.log(`[Loop] Cycle ${cycleId} done in ${durationMs}ms`);
  return result;
}

// ---- Automated loop ----

export async function startLoop(services: LoopServices): Promise<void> {
  if (_running) {
    console.log("[Loop] Already running");
    return;
  }

  _running = true;
  _stopRequested = false;
  const intervalMs = getSettings().loop.intervalMs;
  console.log(`[Loop] Starting automated loop (interval: ${intervalMs / 1000}s)`);

  while (!_stopRequested) {
    try {
      await runOneCycle(services);
    } catch (err: any) {
      console.error(`[Loop] Cycle failed: ${err?.message}`);
      services.notifications.notifyRiskAlert("Loop cycle failed", err?.message);
    }

    if (_stopRequested) break;

    const nextAt = Date.now() + intervalMs;
    _nextCycleAt = new Date(nextAt).toISOString();
    await sleep(intervalMs);
  }

  _running = false;
  _nextCycleAt = null;
  console.log("[Loop] Stopped");
}

export function stopLoop(): void {
  _stopRequested = true;
}

// ---- Helpers ----

function arbToDecision(arb: CrossPlatformArb): OpportunityDecision {
  const strategy: ArbStrategy =
    arb.strategy || (arb.buyYesVenue === "KALSHI" ? "BUY_KY_BUY_PN" : "BUY_KN_BUY_PY");

  return {
    pairId: `${arb.polymarketSlug}|${arb.kalshiTicker}`,
    strategy,
    contracts: arb.contracts ?? 1,
    kpTotalCost: arb.kpTotalCost ?? arb.buyYesPrice + arb.buyNoPrice,
    edgeDollar: arb.edgeDollar ?? arb.netProfit,
    edgePct: arb.edgePct ?? arb.roi,
    annualizedEdge: arb.annualizedEdge ?? 0,
    kalshiSide: arb.buyYesVenue === "KALSHI" ? "yes" : "no",
    polymarketSide: arb.buyYesVenue === "POLYMARKET" ? "yes" : "no",
    kalshiPrice: arb.buyYesVenue === "KALSHI" ? arb.buyYesPrice : arb.buyNoPrice,
    polymarketPrice: arb.buyYesVenue === "POLYMARKET" ? arb.buyYesPrice : arb.buyNoPrice,
    trade: true,
    reasons: [],
    metadata: {
      similarityScore: arb.similarityScore,
      category: arb.category,
      daysToResolution: arb.daysToResolution,
      kalshiFee: arb.kalshiFee,
      polymarketFee: arb.polymarketFee,
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
