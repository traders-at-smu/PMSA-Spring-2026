"""Core data models used across runtime modules."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class MarketQuote:
    yes_bid: float
    yes_ask: float
    no_bid: float
    no_ask: float
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class PairSnapshot:
    pair_id: str
    kalshi_ticker: str
    polymarket_market_slug: str
    polymarket_yes_token_id: str
    polymarket_no_token_id: str
    resolution_time_utc: str
    category: str
    kalshi: MarketQuote
    polymarket: MarketQuote
    days_to_resolution: float


@dataclass
class OpportunityDecision:
    pair_id: str
    strategy: str
    contracts: int
    kp_total_cost: float
    edge_dollar: float
    edge_pct: float
    annualized_edge: float
    kalshi_side: str
    polymarket_side: str
    kalshi_price: float
    polymarket_price: float
    trade: bool
    reasons: list[str]
    metadata: dict[str, Any] = field(default_factory=dict)