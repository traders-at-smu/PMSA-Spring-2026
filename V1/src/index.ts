import { config } from "./config";
import { logger } from "./logger";
import { connectDatabase } from "./database";
import { RpcRotator } from "./rpcRotator";
import { PolymarketClient } from "./polymarketClient";
import { PositionMonitor } from "./positionMonitor";
import { TradeExecutor } from "./tradeExecutor";
import { AutoRedeemer } from "./autoRedeemer";

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  logger.info("=== Polymarket Copy Trading Bot ===");
  logger.info(`Target: ${config.targetUserAddress}`);
  logger.info(`My Wallet: ${config.myProxyWalletAddress}`);
  logger.info(`Scan Interval: ${config.waitingTime}s`);
  logger.info(`Max Position: ${(config.maxPositionLimit * 100).toFixed(0)}%`);
  if (config.blacklistedMarkets.length > 0) {
    logger.info(`Blacklisted Markets: ${config.blacklistedMarkets.length}`);
  }

  // Connect to database
  await connectDatabase();

  // Initialize RPC rotator
  const rpcRotator = new RpcRotator();

  // Initialize Polymarket client
  const client = new PolymarketClient(rpcRotator);
  await client.initialize();

  // Ensure on-chain approvals
  logger.info("Checking on-chain approvals...");
  await client.ensureApprovals();

  // Initialize components
  const monitor = new PositionMonitor(client);
  const executor = new TradeExecutor(client, rpcRotator);
  const redeemer = new AutoRedeemer(client);

  // Log initial state
  await monitor.logPositionSummary();
  const usdcBalance = await client.getUsdcBalance();
  logger.info(`USDC Balance: $${usdcBalance.toFixed(2)}`);

  // Schedule auto-redemption
  let lastRedemption = 0;

  logger.success("Bot started! Monitoring target positions...");

  // Main loop
  let cycleCount = 0;
  while (true) {
    cycleCount++;

    try {
      // Compare positions and execute trades
      const diffs = await monitor.comparePositions();

      if (diffs.length > 0) {
        logger.info(
          `Cycle ${cycleCount}: Found ${diffs.length} position difference(s)`
        );
        for (const d of diffs) {
          const action = d.diff > 0 ? "BUY" : "SELL";
          logger.info(
            `  ${action} ${Math.abs(d.diff).toFixed(2)} "${d.title}" (${d.outcome}) @ $${d.curPrice.toFixed(3)}`
          );
        }
        await executor.executeDiffs(diffs);
      } else {
        logger.debug(`Cycle ${cycleCount}: Positions in sync`);
      }

      // Auto-redemption check (every redemptionInterval)
      const now = Date.now();
      if (now - lastRedemption > config.redemptionInterval) {
        await redeemer.redeemResolvedPositions();
        lastRedemption = now;
      }

      // Log summary every 100 cycles
      if (cycleCount % 100 === 0) {
        await monitor.logPositionSummary();
        const balance = await client.getUsdcBalance();
        logger.info(`USDC Balance: $${balance.toFixed(2)}`);
      }
    } catch (err) {
      logger.error(`Cycle ${cycleCount} error:`, err);

      // On RPC errors, try rotating
      if (
        err instanceof Error &&
        (err.message.includes("ETIMEDOUT") ||
          err.message.includes("ECONNREFUSED") ||
          err.message.includes("rate limit") ||
          err.message.includes("429"))
      ) {
        rpcRotator.rotate();
        logger.info("Rotated RPC endpoint after connection error");
      }
    }

    await sleep(config.waitingTime * 1000);
  }
}

// Graceful shutdown
process.on("SIGINT", () => {
  logger.info("Shutting down...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  logger.info("Shutting down...");
  process.exit(0);
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection:", reason);
});

main().catch((err) => {
  logger.error("Fatal error:", err);
  process.exit(1);
});
