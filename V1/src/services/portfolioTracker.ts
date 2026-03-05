/**
 * Portfolio position tracking and P&L reporting.
 * Port of V2/src/portfolio.py.
 */

import type { PairSnapshot, Position, PortfolioSummary } from "../types";
import type { StateStore, PnlSnapshotRow } from "./stateStore";

export class PortfolioTracker {
  constructor(private store: StateStore) {}

  /**
   * Build/update positions from the orders table.
   * Groups filled orders by (pair_id, venue, side) and computes avg entry price.
   */
  syncPositionsFromOrders(): Position[] {
    const orders = this.store.listOrders(10000);
    const filled = orders.filter((o) => o.status === "filled");

    // Group by position key
    const groups = new Map<string, typeof filled>();
    for (const o of filled) {
      const key = `${o.pair_id}|${o.venue}|${o.side}`;
      const list = groups.get(key) ?? [];
      list.push(o);
      groups.set(key, list);
    }

    const positions: Position[] = [];

    for (const [, orderList] of groups) {
      const totalContracts = orderList.reduce((s, o) => s + o.contracts, 0);
      const totalCost = orderList.reduce((s, o) => s + o.contracts * o.price, 0);
      const avgPrice = totalContracts > 0 ? totalCost / totalContracts : 0;
      const earliest = orderList.reduce(
        (min, o) => (o.created_at < min ? o.created_at : min),
        orderList[0].created_at
      );

      const pos: Position = {
        pairId: orderList[0].pair_id,
        venue: orderList[0].venue as Position["venue"],
        side: orderList[0].side as Position["side"],
        contracts: totalContracts,
        avgEntryPrice: Math.round(avgPrice * 1e6) / 1e6,
        currentPrice: 0,
        unrealizedPnl: 0,
        realizedPnl: 0,
        source: "arb",
        status: "open",
        openedAt: earliest,
        closedAt: null,
      };
      positions.push(pos);
    }

    // Persist to DB
    for (const pos of positions) {
      this.store.upsertPosition(pos);
    }

    return positions;
  }

  /**
   * Update current prices for open positions from latest snapshots.
   */
  updateMarkPrices(snapshots: PairSnapshot[]): void {
    const priceMap = new Map<string, Record<string, Record<string, number>>>();
    for (const s of snapshots) {
      priceMap.set(s.pairId, {
        kalshi: { yes: s.kalshi.yesBid, no: s.kalshi.noBid },
        polymarket: { yes: s.polymarket.yesBid, no: s.polymarket.noBid },
      });
    }

    const positions = this.getOpenPositions();
    const now = new Date().toISOString();

    for (const pos of positions) {
      const venuePrices = priceMap.get(pos.pairId)?.[pos.venue];
      if (!venuePrices) continue;
      pos.currentPrice = venuePrices[pos.side] ?? 0;
      pos.unrealizedPnl = Math.round((pos.currentPrice - pos.avgEntryPrice) * pos.contracts * 1e6) / 1e6;
      this.store.upsertPosition(pos);
    }

    // Save a P&L snapshot
    const summary = this.getPortfolioSummary();
    this.store.savePnlSnapshot(now, summary as unknown as Record<string, unknown>);
  }

  getOpenPositions(): Position[] {
    const rows = this.store.listPositions("open");
    return rows.map((r) => ({
      id: r.id as number,
      pairId: r.pair_id as string,
      venue: r.venue as Position["venue"],
      side: r.side as Position["side"],
      contracts: r.contracts as number,
      avgEntryPrice: r.avg_entry_price as number,
      currentPrice: (r.current_price as number) || 0,
      unrealizedPnl: (r.unrealized_pnl as number) || 0,
      realizedPnl: (r.realized_pnl as number) || 0,
      source: (r.source as Position["source"]) || "arb",
      status: (r.status as Position["status"]) || "open",
      openedAt: (r.opened_at as string) || "",
      closedAt: (r.closed_at as string) || null,
    }));
  }

  getPortfolioSummary(): PortfolioSummary {
    const positions = this.getOpenPositions();
    const totalValue = positions.reduce((s, p) => s + p.currentPrice * p.contracts, 0);
    const totalCost = positions.reduce((s, p) => s + p.avgEntryPrice * p.contracts, 0);
    const totalUnrealized = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
    const totalRealized = positions.reduce((s, p) => s + p.realizedPnl, 0);

    return {
      openPositionCount: positions.length,
      totalValue: Math.round(totalValue * 100) / 100,
      totalCost: Math.round(totalCost * 100) / 100,
      totalUnrealizedPnl: Math.round(totalUnrealized * 100) / 100,
      totalRealizedPnl: Math.round(totalRealized * 100) / 100,
      totalPnl: Math.round((totalUnrealized + totalRealized) * 100) / 100,
    };
  }

  getPnlHistory(limit = 30): PnlSnapshotRow[] {
    return this.store.listPnlSnapshots(limit);
  }

  closePosition(pairId: string, venue: string, side: string, realizedPnl = 0): void {
    this.store.closePosition(pairId, venue, side, realizedPnl);
  }
}
