"""Portfolio position tracking and P&L reporting."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any


@dataclass
class Position:
    pair_id: str
    venue: str  # "kalshi" or "polymarket"
    side: str  # "yes" or "no"
    contracts: int
    avg_entry_price: float
    current_price: float = 0.0
    unrealized_pnl: float = 0.0
    realized_pnl: float = 0.0
    source: str = "arb"  # "arb" or "copy"
    status: str = "open"  # "open", "closed", "resolved"
    opened_at: str = ""
    closed_at: str | None = None


class PortfolioTracker:
    def __init__(self, state_store):
        self.store = state_store

    def sync_positions_from_orders(self) -> list[Position]:
        """Build/update positions from the orders table.

        Groups filled orders by (pair_id, venue, side) and computes
        average entry price and total contracts.
        """
        orders = self.store.list_orders(limit=10000)
        filled = [o for o in orders if o.get("status") == "filled"]

        # Group by position key
        groups: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
        for o in filled:
            key = (o["pair_id"], o["venue"], o["side"])
            groups.setdefault(key, []).append(o)

        positions: list[Position] = []
        now = datetime.now(timezone.utc).isoformat()

        for (pair_id, venue, side), order_list in groups.items():
            total_contracts = sum(o["contracts"] for o in order_list)
            total_cost = sum(o["contracts"] * o["price"] for o in order_list)
            avg_price = total_cost / total_contracts if total_contracts > 0 else 0.0
            earliest = min(o["created_at"] for o in order_list)

            pos = Position(
                pair_id=pair_id,
                venue=venue,
                side=side,
                contracts=total_contracts,
                avg_entry_price=round(avg_price, 6),
                opened_at=earliest,
            )
            positions.append(pos)

        # Persist to DB
        for pos in positions:
            self.store.upsert_position(pos)

        return positions

    def update_mark_prices(self, snapshots: list[dict[str, Any]]) -> None:
        """Update current prices for open positions from latest snapshots."""
        price_map: dict[str, dict[str, dict[str, float]]] = {}
        for s in snapshots:
            pid = s["pair_id"]
            price_map[pid] = {
                "kalshi": {
                    "yes": s["kalshi"].get("yes_bid", 0.0),
                    "no": s["kalshi"].get("no_bid", 0.0),
                },
                "polymarket": {
                    "yes": s["polymarket"].get("yes_bid", 0.0),
                    "no": s["polymarket"].get("no_bid", 0.0),
                },
            }

        positions = self.get_open_positions()
        now = datetime.now(timezone.utc).isoformat()

        for pos in positions:
            venue_prices = price_map.get(pos.pair_id, {}).get(pos.venue)
            if not venue_prices:
                continue
            pos.current_price = venue_prices.get(pos.side, 0.0)
            # Unrealized P&L: (current_price - avg_entry) * contracts
            pos.unrealized_pnl = round(
                (pos.current_price - pos.avg_entry_price) * pos.contracts, 6
            )
            self.store.upsert_position(pos)

        # Save a P&L snapshot
        summary = self.get_portfolio_summary()
        self.store.save_pnl_snapshot(now, summary)

    def get_open_positions(self) -> list[Position]:
        """Return all positions with status='open'."""
        rows = self.store.list_positions(status="open")
        return [
            Position(
                pair_id=r["pair_id"],
                venue=r["venue"],
                side=r["side"],
                contracts=r["contracts"],
                avg_entry_price=r["avg_entry_price"],
                current_price=r.get("current_price", 0.0),
                unrealized_pnl=r.get("unrealized_pnl", 0.0),
                realized_pnl=r.get("realized_pnl", 0.0),
                source=r.get("source", "arb"),
                status=r.get("status", "open"),
                opened_at=r.get("opened_at", ""),
                closed_at=r.get("closed_at"),
            )
            for r in rows
        ]

    def get_portfolio_summary(self) -> dict[str, Any]:
        """Aggregate P&L across all open positions."""
        positions = self.get_open_positions()
        total_value = sum(p.current_price * p.contracts for p in positions)
        total_cost = sum(p.avg_entry_price * p.contracts for p in positions)
        total_unrealized = sum(p.unrealized_pnl for p in positions)
        total_realized = sum(p.realized_pnl for p in positions)

        return {
            "open_position_count": len(positions),
            "total_value": round(total_value, 2),
            "total_cost": round(total_cost, 2),
            "total_unrealized_pnl": round(total_unrealized, 2),
            "total_realized_pnl": round(total_realized, 2),
            "total_pnl": round(total_unrealized + total_realized, 2),
        }

    def get_pnl_history(self, limit: int = 30) -> list[dict[str, Any]]:
        """Return recent P&L snapshots."""
        return self.store.list_pnl_snapshots(limit=limit)

    def close_position(self, pair_id: str, venue: str, side: str, realized_pnl: float = 0.0) -> None:
        """Mark a position as closed."""
        self.store.close_position(pair_id, venue, side, realized_pnl)
