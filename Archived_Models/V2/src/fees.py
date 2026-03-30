"""Shared fee calculation functions for Kalshi and Polymarket."""

from __future__ import annotations

import math


def compute_kalshi_fee(c: int, p: float, rate: float = 0.07, round_mode: str = "ceil_cent") -> float:
    """Kalshi taker fee: rate * contracts * p * (1 - p), rounded per mode."""
    fee = rate * c * p * (1.0 - p)
    if round_mode == "ceil_cent":
        return math.ceil(fee * 100.0) / 100.0
    if round_mode == "round_cent":
        return round(fee, 2)
    return fee


def compute_polymarket_fee(
    c: int, p: float, fee_rate: float, exponent: float, maker_rebate: float = 0.0
) -> float:
    """Polymarket fee: c * fee_rate * (p*(1-p))^exponent, minus maker rebate."""
    fee = c * fee_rate * ((p * (1.0 - p)) ** exponent)
    if maker_rebate > 0.0:
        fee *= 1.0 - maker_rebate
    return max(0.0, fee)
