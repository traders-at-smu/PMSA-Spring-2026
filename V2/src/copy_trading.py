"""Copy trading service: monitor top Polymarket traders and mirror positions."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import requests

logger = logging.getLogger(__name__)

DATA_API = "https://data-api.polymarket.com"
GAMMA_API = "https://gamma-api.polymarket.com"


@dataclass
class CopyTarget:
    address: str
    name: str
    set_at: str = ""


@dataclass
class TraderPosition:
    title: str
    outcome: str
    size: float
    cur_price: float
    cash_pnl: float
    percent_pnl: float
    condition_id: str


@dataclass
class TradeSignal:
    trader_address: str
    trader_name: str
    side: str  # "BUY" or "SELL"
    size: float
    price: float
    cash_value: float
    market_title: str
    outcome: str
    condition_id: str
    timestamp: str
    suspicion_score: int = 0
    suspicion_signals: list[str] = field(default_factory=list)


def _fmt_cash(n: float) -> str:
    if n >= 1_000_000:
        return f"${n / 1_000_000:.2f}M"
    if n >= 1_000:
        return f"${n / 1_000:.1f}K"
    return f"${n:.0f}"


def compute_suspicion_score(
    cash_value: float,
    account_age_days: int = -1,
    is_first_large_bet: bool = False,
    hours_to_expiry: float = -1.0,
    is_aggregated: bool = False,
    trade_count: int = 1,
) -> tuple[int, list[str]]:
    """Port of V1 suspicion scoring. Returns (score, signals)."""
    score = 0
    signals: list[str] = []

    # Signal 1: Fresh account
    if 0 < account_age_days < 7:
        score += 30
        signals.append(f"Account only {account_age_days}d old")
    elif 0 < account_age_days < 30:
        score += 15
        signals.append(f"New account ({account_age_days}d)")

    # Signal 2: First large bet
    if is_first_large_bet:
        score += 20
        signals.append("First large bet on this market")

    # Signal 3: Timing near expiry
    if 0 < hours_to_expiry < 12 and cash_value >= 5000:
        score += 20
        signals.append(f"{hours_to_expiry:.1f}h to expiry with {_fmt_cash(cash_value)} bet")
    elif 0 < hours_to_expiry < 24 and cash_value >= 5000:
        score += 10
        signals.append(f"{hours_to_expiry:.1f}h to expiry")

    # Signal 4: Outsized position
    if cash_value >= 50000:
        score += 25
        signals.append(f"Massive position: {_fmt_cash(cash_value)}")
    elif cash_value >= 20000:
        score += 15
        signals.append(f"Large position: {_fmt_cash(cash_value)}")
    elif cash_value >= 10000:
        score += 10
        signals.append(f"Sizable position: {_fmt_cash(cash_value)}")

    # Signal 5: Accumulation pattern
    if is_aggregated and trade_count > 5:
        score += 15
        signals.append(f"Accumulated via {trade_count} trades")
    elif is_aggregated and trade_count > 2:
        score += 8
        signals.append(f"Built position over {trade_count} trades")

    return min(score, 100), signals


class CopyTradingService:
    def __init__(self, config: dict[str, Any], state_store):
        self.store = state_store
        ct_cfg = config.get("copy_trading", {})
        self.enabled = ct_cfg.get("enabled", False)
        self.poll_interval = ct_cfg.get("poll_interval_seconds", 30)
        self.min_trade_size = ct_cfg.get("min_trade_size_usd", 5000)
        self.max_copy_size = ct_cfg.get("max_copy_size_usd", 500)
        self.suspicion_threshold = ct_cfg.get("suspicion_score_threshold", 40)
        self.copy_fraction = ct_cfg.get("copy_fraction", 0.1)
        self._last_poll: dict[str, str] = {}  # address -> last seen timestamp

    def get_leaderboard(
        self, order_by: str = "pnl", time_period: str = "all", limit: int = 50
    ) -> list[dict[str, Any]]:
        """Fetch Polymarket leaderboard."""
        try:
            resp = requests.get(
                f"{DATA_API}/leaderboard",
                params={"order": order_by, "timePeriod": time_period, "limit": limit},
                timeout=15,
            )
            resp.raise_for_status()
            return resp.json() if isinstance(resp.json(), list) else resp.json().get("leaders", [])
        except Exception:
            logger.warning("Failed to fetch leaderboard", exc_info=True)
            return []

    def get_trader_positions(self, address: str) -> list[TraderPosition]:
        """Fetch a trader's current positions."""
        try:
            resp = requests.get(f"{DATA_API}/positions", params={"user": address}, timeout=15)
            resp.raise_for_status()
            positions = resp.json() if isinstance(resp.json(), list) else []
            return [
                TraderPosition(
                    title=p.get("title", ""),
                    outcome=p.get("outcome", ""),
                    size=float(p.get("size", 0)),
                    cur_price=float(p.get("curPrice", 0)),
                    cash_pnl=float(p.get("cashPnl", 0)),
                    percent_pnl=float(p.get("percentPnl", 0)),
                    condition_id=p.get("conditionId", ""),
                )
                for p in positions
            ]
        except Exception:
            logger.warning(f"Failed to fetch positions for {address}", exc_info=True)
            return []

    def poll_trader_activity(self, address: str) -> list[dict[str, Any]]:
        """Fetch recent trading activity for a trader."""
        try:
            resp = requests.get(
                f"{DATA_API}/activity",
                params={"user": address, "limit": 50},
                timeout=15,
            )
            resp.raise_for_status()
            data = resp.json()
            return data if isinstance(data, list) else data.get("history", [])
        except Exception:
            logger.warning(f"Failed to poll activity for {address}", exc_info=True)
            return []

    def detect_copy_opportunities(self) -> list[TradeSignal]:
        """Poll all active copy targets for new large trades."""
        if not self.enabled:
            return []

        targets = self.store.list_copy_targets(active_only=True)
        signals: list[TradeSignal] = []

        for target in targets:
            address = target["address"]
            name = target["name"]
            last_seen = self._last_poll.get(address, "")

            activities = self.poll_trader_activity(address)
            for act in activities:
                ts = act.get("timestamp", act.get("createdAt", ""))
                if last_seen and ts <= last_seen:
                    continue

                cash_value = float(act.get("cashValue", act.get("value", 0)))
                if cash_value < self.min_trade_size:
                    continue

                score, score_signals = compute_suspicion_score(cash_value=cash_value)

                signal = TradeSignal(
                    trader_address=address,
                    trader_name=name,
                    side=act.get("side", act.get("type", "BUY")).upper(),
                    size=float(act.get("size", 0)),
                    price=float(act.get("price", 0)),
                    cash_value=cash_value,
                    market_title=act.get("title", act.get("marketTitle", "")),
                    outcome=act.get("outcome", ""),
                    condition_id=act.get("conditionId", ""),
                    timestamp=ts,
                    suspicion_score=score,
                    suspicion_signals=score_signals,
                )
                signals.append(signal)

                # Persist signal
                self.store.save_copy_signal({
                    "trader_address": address,
                    "condition_id": signal.condition_id,
                    "side": signal.side,
                    "size": signal.size,
                    "price": signal.price,
                    "cash_value": signal.cash_value,
                    "market_title": signal.market_title,
                    "suspicion_score": score,
                })

            # Update last seen
            if activities:
                timestamps = [a.get("timestamp", a.get("createdAt", "")) for a in activities]
                valid = [t for t in timestamps if t]
                if valid:
                    self._last_poll[address] = max(valid)

        return signals

    def add_target(self, address: str, name: str) -> None:
        """Add a copy trading target."""
        self.store.save_copy_target(address, name)

    def remove_target(self, address: str) -> None:
        """Deactivate a copy trading target."""
        self.store.remove_copy_target(address)

    def list_targets(self) -> list[dict[str, Any]]:
        """List all active copy targets."""
        return self.store.list_copy_targets(active_only=True)
