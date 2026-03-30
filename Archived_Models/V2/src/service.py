"""Service orchestration for one-cycle data pull, strategy evaluation, and optional execution."""

from __future__ import annotations

from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from typing import Any

from src.copy_trading import CopyTradingService
from src.mapping_loader import load_mapping
from src.notifications import NotificationService
from src.portfolio import PortfolioTracker
from src.risk import RiskManager
from src.strategy_model import find_mispricing


def _days_to_resolution(resolution_time_utc: str) -> float:
    dt = datetime.fromisoformat(resolution_time_utc.replace("Z", "+00:00"))
    now = datetime.now(timezone.utc)
    delta = dt - now
    return max(delta.total_seconds() / 86400.0, 1 / 86400.0)


class BotService:
    def __init__(self, config: dict[str, Any], state_store, kalshi_client, polymarket_client, execution_engine):
        self.config = config
        self.store = state_store
        self.kalshi = kalshi_client
        self.poly = polymarket_client
        self.execution = execution_engine
        self.portfolio = PortfolioTracker(state_store)
        self.notifier = NotificationService(config)
        self.risk_manager = RiskManager(config, state_store, self.portfolio)

        self.copy_trading = CopyTradingService(config, state_store)

        # Wire risk manager and notifier into execution engine
        self.execution.risk_manager = self.risk_manager
        self.execution.notifier = self.notifier

    def collect_snapshots(self) -> tuple[list[dict[str, Any]], dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
        mappings = load_mapping(self.config["paths"]["mapping_file"])
        snapshots: list[dict[str, Any]] = []
        raw_k: dict[str, Any] = {}
        raw_p: dict[str, Any] = {}
        errors: list[dict[str, Any]] = []

        for m in mappings:
            pair_id = m["pair_id"]
            try:
                configured_kalshi_ticker = str(m.get("kalshi_ticker", "")).strip()
                resolved_kalshi_ticker = self.kalshi.resolve_market_ticker(m)
                if not resolved_kalshi_ticker:
                    raise RuntimeError("Unable to resolve a Kalshi market ticker from mapping row")

                if (
                    configured_kalshi_ticker
                    and resolved_kalshi_ticker != configured_kalshi_ticker
                    and hasattr(self.store, "save_alert")
                ):
                    self.store.save_alert(
                        "medium",
                        "Kalshi ticker was auto-resolved from API",
                        pair_id=pair_id,
                        details={
                            "configured_kalshi_ticker": configured_kalshi_ticker,
                            "resolved_kalshi_ticker": resolved_kalshi_ticker,
                            "kalshi_url": m.get("kalshi_url", ""),
                            "kalshi_title_hint": m.get("kalshi_title_hint", ""),
                        },
                    )

                kq = self.kalshi.get_quotes(resolved_kalshi_ticker)
                pq = self.poly.get_quotes(
                    m.get("polymarket_yes_token_id", ""),
                    m.get("polymarket_no_token_id", ""),
                    market_slug=m.get("polymarket_market_slug", ""),
                )

                raw_k[pair_id] = kq["raw"]
                raw_p[pair_id] = pq["raw"]

                resolution_time_utc = (
                    m.get("resolution_time_utc", "")
                    or pq.get("resolved", {}).get("resolution_time_utc", "")
                    or (
                        (datetime.now(timezone.utc) + timedelta(days=30)).replace(microsecond=0)
                        .replace(tzinfo=timezone.utc)
                        .isoformat()
                        .replace("+00:00", "Z")
                    )
                )
                yes_token_id = m.get("polymarket_yes_token_id", "") or pq.get("yes_token_id", "")
                no_token_id = m.get("polymarket_no_token_id", "") or pq.get("no_token_id", "")

                snapshots.append(
                    {
                        "pair_id": pair_id,
                        "kalshi_ticker": resolved_kalshi_ticker,
                        "polymarket_market_slug": m["polymarket_market_slug"],
                        "polymarket_yes_token_id": yes_token_id,
                        "polymarket_no_token_id": no_token_id,
                        "resolution_time_utc": resolution_time_utc,
                        "category": m.get("category", "default"),
                        "days_to_resolution": _days_to_resolution(resolution_time_utc),
                        "kalshi": {
                            "yes_bid": kq["yes_bid"],
                            "yes_ask": kq["yes_ask"],
                            "no_bid": kq["no_bid"],
                            "no_ask": kq["no_ask"],
                        },
                        "polymarket": {
                            "yes_bid": pq["yes_bid"],
                            "yes_ask": pq["yes_ask"],
                            "no_bid": pq["no_bid"],
                            "no_ask": pq["no_ask"],
                        },
                        "depth": {
                            "kalshi": kq.get("depth", {}),
                            "polymarket": pq.get("depth", {}),
                        },
                    }
                )
            except Exception as exc:
                err = {
                    "pair_id": pair_id,
                    "kalshi_ticker": m.get("kalshi_ticker", ""),
                    "polymarket_market_slug": m.get("polymarket_market_slug", ""),
                    "error": str(exc),
                }
                errors.append(err)
                raw_k[pair_id] = raw_k.get(pair_id, {"error": str(exc)})
                raw_p[pair_id] = raw_p.get(pair_id, {"error": str(exc)})
                if hasattr(self.store, "save_alert"):
                    self.store.save_alert(
                        "medium",
                        "Pair snapshot failed; skipped pair for this cycle",
                        pair_id=pair_id,
                        details=err,
                    )

        return snapshots, raw_k, raw_p, errors

    def run_cycle(self, execute_trades: bool = False, mode_override: str | None = None, typed_confirm: str | None = None) -> dict[str, Any]:
        cycle_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        snapshots, raw_k, raw_p, errors = self.collect_snapshots()
        decisions = find_mispricing(snapshots, self.config)

        for d in decisions:
            s = next(s for s in snapshots if s["pair_id"] == d.pair_id)
            d.metadata.update(
                {
                    "kalshi_ticker": s["kalshi_ticker"],
                    "polymarket_yes_token_id": s["polymarket_yes_token_id"],
                    "polymarket_no_token_id": s["polymarket_no_token_id"],
                }
            )

        self.store.save_cycle(
            cycle_id=cycle_id,
            raw_kalshi=raw_k,
            raw_poly=raw_p,
            snapshots=snapshots,
            opportunities=[asdict(d) for d in decisions],
            errors=errors,
        )

        mode = mode_override or self.config["mode"]
        execution_results = []
        if execute_trades:
            execution_results = self.execution.execute(cycle_id=cycle_id, decisions=decisions, mode=mode, typed_confirm=typed_confirm)
            # Sync positions from orders after execution
            self.portfolio.sync_positions_from_orders()

        # Update mark-to-market prices for open positions
        if snapshots:
            self.portfolio.update_mark_prices(snapshots)

        return {
            "cycle_id": cycle_id,
            "snapshots": snapshots,
            "decisions": [asdict(d) for d in decisions],
            "execution": execution_results,
            "mode": mode,
            "errors": errors,
            "portfolio": self.portfolio.get_portfolio_summary(),
        }

    def run_copy_cycle(self) -> dict[str, Any]:
        """Run one copy trading poll cycle. Independent from arb cycle."""
        signals = self.copy_trading.detect_copy_opportunities()

        # Notify on high-suspicion signals
        for sig in signals:
            if sig.suspicion_score >= self.copy_trading.suspicion_threshold and self.notifier:
                self.notifier.notify_copy_signal({
                    "trader_name": sig.trader_name,
                    "trader_address": sig.trader_address,
                    "market_title": sig.market_title,
                    "side": sig.side,
                    "cash_value": sig.cash_value,
                    "suspicion_score": sig.suspicion_score,
                })

        return {
            "signals_found": len(signals),
            "signals": [
                {
                    "trader": s.trader_name,
                    "market": s.market_title,
                    "side": s.side,
                    "cash_value": s.cash_value,
                    "suspicion_score": s.suspicion_score,
                    "suspicion_signals": s.suspicion_signals,
                }
                for s in signals
            ],
        }
