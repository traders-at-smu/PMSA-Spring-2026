import { logger } from "./logger";
import { PolymarketClient } from "./polymarketClient";
import { recordRedemption } from "./database";

export class AutoRedeemer {
  private client: PolymarketClient;

  constructor(client: PolymarketClient) {
    this.client = client;
  }

  async redeemResolvedPositions(): Promise<void> {
    logger.info("Checking for redeemable positions...");

    try {
      const positions = await this.client.getMyPositions();

      for (const position of positions) {
        if (position.size <= 0) continue;

        const isResolved = await this.client.isMarketResolved(
          position.conditionId
        );

        if (!isResolved) continue;

        logger.info(
          `Redeeming resolved position: ${position.title} (${position.outcome})`
        );

        const txHash = await this.client.redeemPosition(position.conditionId);

        if (txHash) {
          const usdcReceived = position.size * position.curPrice;
          logger.success(
            `Redeemed ${position.size.toFixed(2)} tokens from "${position.title}" | TX: ${txHash}`
          );

          await recordRedemption({
            conditionId: position.conditionId,
            title: position.title,
            outcome: position.outcome,
            tokensRedeemed: position.size,
            usdcReceived,
            txHash,
            status: "SUCCESS",
          });
        } else {
          logger.error(
            `Failed to redeem "${position.title}" (${position.outcome})`
          );

          await recordRedemption({
            conditionId: position.conditionId,
            title: position.title,
            outcome: position.outcome,
            tokensRedeemed: position.size,
            usdcReceived: 0,
            status: "FAILED",
          });
        }
      }
    } catch (err) {
      logger.error("Auto-redemption error:", err);
    }
  }
}
