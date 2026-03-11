#!/usr/bin/env node
/**
 * V3 Unified Arb Bot — CLI Entrypoint
 *
 *   npm run serve      → dashboard only
 *   npm run loop       → dashboard + automated 5-min loop
 *   npm run scan-once  → one cycle, print JSON, exit
 */

import "dotenv/config";
import path from "path";
import { getSettings } from "./config";
import { ArbitrageScreener } from "./screener";
import { KalshiScreener } from "./kalshiScreener";
import { CrossPlatformScreener } from "./crossPlatformScreener";
import { StateStore } from "./services/stateStore";
import { PaperAccountService } from "./services/paperAccountService";
import { TelegramService } from "./services/telegramService";
import { PortfolioTracker } from "./services/portfolioTracker";
import { RiskManager, DEFAULT_RISK_CONFIG } from "./services/riskManager";
import { ExecutionEngine, DEFAULT_LIVE_SAFETY } from "./services/executionEngine";
import { NotificationService } from "./services/notificationService";
import { runOneCycle, startLoop } from "./loop";
import type { LoopServices } from "./loop";

// ---- Resolve command ----

const command = process.argv[2] || "serve";
if (!["serve", "loop", "scan-once"].includes(command)) {
  console.error(`Unknown command: ${command}`);
  console.error("Usage: tsx src/index.ts [serve|loop|scan-once]");
  process.exit(1);
}

// ---- Initialize services ----

console.log("V3 Unified Arb Bot starting...");
const settings = getSettings();

const stateStore = new StateStore(path.resolve(process.cwd(), settings.paths.stateDb));
const polyScreener = new ArbitrageScreener();
const kalshiScreener = new KalshiScreener();
const crossPlatformScreener = new CrossPlatformScreener(polyScreener, kalshiScreener);
crossPlatformScreener.setStateStore(stateStore);

const paperAccount = new PaperAccountService();
const telegramService = new TelegramService();
const portfolioTracker = new PortfolioTracker(stateStore);
const riskManager = new RiskManager(
  {
    maxOpenPositionsPerPair: settings.risk.maxOpenPositionsPerPair,
    maxNotionalPerPair: settings.risk.maxNotionalPerPair,
    maxTotalExposure: settings.risk.maxTotalExposure,
    maxDrawdownPct: settings.risk.maxDrawdownPct,
    circuitBreakerCooldownMin: settings.risk.circuitBreakerCooldownMin,
  },
  portfolioTracker
);

const executionEngine = new ExecutionEngine(
  stateStore,
  riskManager,
  portfolioTracker,
  telegramService,
  {
    requireArm: settings.liveSafety.requireArm,
    requireTypedConfirm: settings.liveSafety.requireTypedConfirm,
    confirmTokenTtlSec: settings.liveSafety.confirmTokenTtlSec,
  }
);

const notificationService = new NotificationService(settings.notifications);

const loopServices: LoopServices = {
  screener: crossPlatformScreener,
  execution: executionEngine,
  paper: paperAccount,
  notifications: notificationService,
  store: stateStore,
};

console.log(`  Mode: ${settings.execution.mode} | Bankroll: $${settings.execution.bankrollUsd}`);
console.log(`  AI confidence threshold: ${settings.aiMatching.confidenceThreshold}`);

// ---- Run ----

async function main() {
  if (command === "scan-once") {
    const result = await runOneCycle(loopServices);
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  // Start dashboard server
  const { startServer } = await import("./dashboard/server");
  startServer({
    crossPlatformScreener,
    stateStore,
    paperAccount,
    executionEngine,
    portfolioTracker,
    riskManager,
    notificationService,
    loopServices,
  });

  if (command === "loop") {
    // Start automated loop after server is up
    console.log(`[Loop] Will start in 3s (interval: ${settings.loop.intervalMs / 1000}s)...`);
    setTimeout(() => {
      startLoop(loopServices).catch((err) => {
        console.error("[Loop] Fatal error:", err);
        process.exit(1);
      });
    }, 3000);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
