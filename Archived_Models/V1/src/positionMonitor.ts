import { config } from "./config";
import { logger } from "./logger";
import { PolymarketClient } from "./polymarketClient";
import { TargetPosition, MyPosition, PositionDiff } from "./types";

export class PositionMonitor {
  private client: PolymarketClient;

  constructor(client: PolymarketClient) {
    this.client = client;
  }

  async comparePositions(): Promise<PositionDiff[]> {
    const [targetPositions, myPositions] = await Promise.all([
      this.client.getTargetPositions(),
      this.client.getMyPositions(),
    ]);

    logger.debug(
      `Target has ${targetPositions.length} positions, I have ${myPositions.length} positions`
    );

    // Build maps keyed by asset (token ID)
    const targetMap = new Map<string, TargetPosition>();
    for (const p of targetPositions) {
      if (p.size > 0) {
        targetMap.set(p.asset, p);
      }
    }

    const myMap = new Map<string, MyPosition>();
    for (const p of myPositions) {
      if (p.size > 0) {
        myMap.set(p.asset, p);
      }
    }

    const diffs: PositionDiff[] = [];

    // Calculate target's total portfolio value to compute relative weights
    const targetTotalValue = targetPositions.reduce(
      (sum, p) => sum + p.currentValue,
      0
    );
    const myPortfolioValue = await this.client.getMyPortfolioValue();
    const myUsdc = await this.client.getUsdcBalance();
    const myTotalCapital = myPortfolioValue + myUsdc;

    if (targetTotalValue === 0 || myTotalCapital === 0) {
      logger.warn("Target or own portfolio value is 0, skipping comparison");
      return [];
    }

    logger.debug(
      `Target portfolio: $${targetTotalValue.toFixed(2)} | My capital: $${myTotalCapital.toFixed(2)}`
    );

    // For each target position, calculate desired size proportional to my capital
    for (const [asset, target] of targetMap) {
      if (this.isBlacklisted(target.conditionId)) {
        logger.debug(`Skipping blacklisted market: ${target.title}`);
        continue;
      }

      const targetWeight = target.currentValue / targetTotalValue;

      // Cap at max position limit
      const cappedWeight = Math.min(targetWeight, config.maxPositionLimit);
      const desiredValue = myTotalCapital * cappedWeight;
      const desiredSize =
        target.curPrice > 0 ? desiredValue / target.curPrice : 0;

      const myPosition = myMap.get(asset);
      const mySize = myPosition ? myPosition.size : 0;

      const diff = desiredSize - mySize;

      // Only create a diff if the difference is meaningful (> $1 in value)
      if (Math.abs(diff * target.curPrice) > 1) {
        diffs.push({
          conditionId: target.conditionId,
          asset,
          title: target.title,
          outcome: target.outcome,
          outcomeIndex: target.outcomeIndex,
          targetSize: desiredSize,
          mySize,
          diff,
          curPrice: target.curPrice,
        });
      }
    }

    // Check for positions I have that the target doesn't (should sell)
    for (const [asset, myPos] of myMap) {
      if (!targetMap.has(asset) && myPos.size > 0) {
        if (this.isBlacklisted(myPos.conditionId)) continue;

        diffs.push({
          conditionId: myPos.conditionId,
          asset,
          title: myPos.title,
          outcome: myPos.outcome,
          outcomeIndex: myPos.outcomeIndex,
          targetSize: 0,
          mySize: myPos.size,
          diff: -myPos.size,
          curPrice: myPos.curPrice,
        });
      }
    }

    return diffs;
  }

  private isBlacklisted(conditionId: string): boolean {
    return config.blacklistedMarkets.includes(conditionId);
  }

  async logPositionSummary(): Promise<void> {
    const [targetPositions, myPositions] = await Promise.all([
      this.client.getTargetPositions(),
      this.client.getMyPositions(),
    ]);

    const targetTotal = targetPositions.reduce(
      (sum, p) => sum + p.currentValue,
      0
    );
    const myTotal = myPositions.reduce((sum, p) => sum + p.currentValue, 0);

    logger.info("=== Position Summary ===");
    logger.info(`Target: ${targetPositions.length} positions ($${targetTotal.toFixed(2)})`);
    logger.info(`Mine: ${myPositions.length} positions ($${myTotal.toFixed(2)})`);
    logger.info("========================");
  }
}
