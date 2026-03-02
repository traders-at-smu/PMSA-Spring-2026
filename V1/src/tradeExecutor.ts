import { config } from "./config";
import { logger } from "./logger";
import { PolymarketClient } from "./polymarketClient";
import { RpcRotator } from "./rpcRotator";
import { PositionDiff, TradeAction } from "./types";
import { recordTrade } from "./database";

export class TradeExecutor {
  private client: PolymarketClient;
  private rpcRotator: RpcRotator;

  constructor(client: PolymarketClient, rpcRotator: RpcRotator) {
    this.client = client;
    this.rpcRotator = rpcRotator;
  }

  async executeDiffs(diffs: PositionDiff[]): Promise<void> {
    if (diffs.length === 0) {
      logger.debug("No position differences to act on");
      return;
    }

    // Check gas price before executing
    const gasOk = await this.rpcRotator.isGasPriceAcceptable();
    if (!gasOk) {
      logger.warn("Gas price too high, deferring trades");
      return;
    }

    // Sort: sells first (to free up capital), then buys
    const sells = diffs.filter((d) => d.diff < 0);
    const buys = diffs.filter((d) => d.diff > 0);

    // Execute sells first
    for (const diff of sells) {
      await this.executeSell(diff);
    }

    // Then execute buys
    for (const diff of buys) {
      await this.executeBuy(diff);
    }
  }

  private async executeBuy(diff: PositionDiff): Promise<void> {
    const marketInfo = await this.client.getMarketInfo(diff.conditionId);
    if (!marketInfo) {
      logger.error(`Cannot find market info for ${diff.conditionId}`);
      return;
    }

    if (!marketInfo.acceptingOrders) {
      logger.warn(`Market not accepting orders: ${diff.title}`);
      return;
    }

    // Find the correct token ID for the outcome
    const tokenId = marketInfo.clobTokenIds[diff.outcomeIndex];
    if (!tokenId) {
      logger.error(
        `No token ID found for outcome ${diff.outcomeIndex} in ${diff.title}`
      );
      return;
    }

    const tickSize = marketInfo.orderPriceMinTickSize.toString();
    const size = this.roundToTickSize(Math.abs(diff.diff), tickSize);

    if (size <= 0) {
      logger.debug(`Buy size too small after rounding for ${diff.title}`);
      return;
    }

    // Check available USDC
    const usdcBalance = await this.client.getUsdcBalance();
    const cost = size * diff.curPrice;

    if (cost > usdcBalance) {
      logger.warn(
        `Insufficient USDC: need $${cost.toFixed(2)}, have $${usdcBalance.toFixed(2)} for ${diff.title}`
      );
      // Reduce size to what we can afford, leave a small buffer
      const affordableSize = (usdcBalance * 0.95) / diff.curPrice;
      if (affordableSize < 1) {
        logger.warn("Cannot afford even a minimum buy, skipping");
        return;
      }
      return this.executeLimitBuy(
        tokenId,
        diff,
        this.roundToTickSize(affordableSize, tickSize),
        marketInfo.negRisk,
        tickSize
      );
    }

    await this.executeLimitBuy(
      tokenId,
      diff,
      size,
      marketInfo.negRisk,
      tickSize
    );
  }

  private async executeLimitBuy(
    tokenId: string,
    diff: PositionDiff,
    size: number,
    negRisk: boolean,
    tickSize: string
  ): Promise<void> {
    // Use current price as limit price (slightly above to increase fill chance)
    const price = this.roundPrice(
      Math.min(diff.curPrice * 1.01, 0.99),
      tickSize
    );

    logger.trade(
      `BUY ${size.toFixed(2)} "${diff.title}" (${diff.outcome}) @ $${price}`
    );

    const orderId = await this.client.placeBuyOrder(
      tokenId,
      price,
      size,
      negRisk,
      tickSize
    );

    await recordTrade({
      type: "BUY",
      conditionId: diff.conditionId,
      asset: diff.asset,
      title: diff.title,
      outcome: diff.outcome,
      size,
      price,
      orderId: orderId || undefined,
      status: orderId ? "SUCCESS" : "FAILED",
    });
  }

  private async executeSell(diff: PositionDiff): Promise<void> {
    const marketInfo = await this.client.getMarketInfo(diff.conditionId);
    if (!marketInfo) {
      logger.error(`Cannot find market info for ${diff.conditionId}`);
      return;
    }

    if (!marketInfo.acceptingOrders) {
      logger.warn(`Market not accepting orders: ${diff.title}`);
      return;
    }

    const tokenId = marketInfo.clobTokenIds[diff.outcomeIndex];
    if (!tokenId) {
      logger.error(
        `No token ID found for outcome ${diff.outcomeIndex} in ${diff.title}`
      );
      return;
    }

    const tickSize = marketInfo.orderPriceMinTickSize.toString();
    const size = this.roundToTickSize(Math.abs(diff.diff), tickSize);

    if (size <= 0) {
      logger.debug(`Sell size too small after rounding for ${diff.title}`);
      return;
    }

    // Slightly below current price for faster fill
    const price = this.roundPrice(
      Math.max(diff.curPrice * 0.99, 0.01),
      tickSize
    );

    logger.trade(
      `SELL ${size.toFixed(2)} "${diff.title}" (${diff.outcome}) @ $${price}`
    );

    const orderId = await this.client.placeSellOrder(
      tokenId,
      price,
      size,
      marketInfo.negRisk,
      tickSize
    );

    await recordTrade({
      type: "SELL",
      conditionId: diff.conditionId,
      asset: diff.asset,
      title: diff.title,
      outcome: diff.outcome,
      size,
      price,
      orderId: orderId || undefined,
      status: orderId ? "SUCCESS" : "FAILED",
    });
  }

  private roundToTickSize(value: number, tickSize: string): number {
    const tick = parseFloat(tickSize);
    if (tick === 0) return Math.floor(value);
    return Math.floor(value / tick) * tick;
  }

  private roundPrice(price: number, tickSize: string): number {
    const tick = parseFloat(tickSize);
    if (tick === 0) return parseFloat(price.toFixed(2));
    return Math.round(price / tick) * tick;
  }
}
