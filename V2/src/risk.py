"""Pre-trade risk checks and circuit breaker logic."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from src.models import OpportunityDecision
from src.portfolio import PortfolioTracker


class RiskManager:
    def __init__(self, config: dict[str, Any], state_store, portfolio: PortfolioTracker):
        self.store = state_store
        self.portfolio = portfolio

        self.max_positions_per_pair = config.get("max_open_positions_per_pair", 5)
        self.max_notional_per_pair = config.get("max_notional_per_pair", 250.0)

        risk_cfg = config.get("risk", {})
        self.max_total_exposure = risk_cfg.get("max_total_exposure", 5000.0)
        self.max_drawdown_pct = risk_cfg.get("max_drawdown_pct", 0.15)
        self.circuit_breaker_cooldown_min = risk_cfg.get("circuit_breaker_cooldown_minutes", 60)

    def check_pre_trade(self, decision: OpportunityDecision) -> tuple[bool, str]:
        """Check if a trade is allowed. Returns (allowed, reason)."""
        # Circuit breaker
        if self.circuit_breaker_active():
            return False, "Circuit breaker active: drawdown exceeds limit"

        # Per-pair position count
        open_positions = self.portfolio.get_open_positions()
        pair_positions = [p for p in open_positions if p.pair_id == decision.pair_id]
        if len(pair_positions) >= self.max_positions_per_pair:
            return False, f"Max positions per pair ({self.max_positions_per_pair}) reached for {decision.pair_id}"

        # Per-pair notional
        pair_notional = sum(p.contracts * p.avg_entry_price for p in pair_positions)
        trade_notional = decision.contracts * (decision.kalshi_price + decision.polymarket_price)
        if pair_notional + trade_notional > self.max_notional_per_pair:
            return False, f"Max notional per pair (${self.max_notional_per_pair}) would be exceeded for {decision.pair_id}"

        # Total exposure
        summary = self.portfolio.get_portfolio_summary()
        total_exposure = summary["total_cost"] + trade_notional
        if total_exposure > self.max_total_exposure:
            return False, f"Max total exposure (${self.max_total_exposure}) would be exceeded"

        return True, "ok"

    def circuit_breaker_active(self) -> bool:
        """True if portfolio drawdown exceeds the configured max."""
        summary = self.portfolio.get_portfolio_summary()
        total_cost = summary["total_cost"]
        if total_cost <= 0:
            return False

        total_pnl = summary["total_pnl"]
        drawdown = -total_pnl / total_cost if total_pnl < 0 else 0.0
        return drawdown >= self.max_drawdown_pct
