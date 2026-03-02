"""Standalone strategy math engine for cross-exchange arbitrage checks."""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import asdict
from pathlib import Path
from typing import Any

try:
    from src.models import OpportunityDecision
except ModuleNotFoundError:  # Allows direct execution: python src/strategy_model.py
    from models import OpportunityDecision


def compute_kalshi_fee(c: int, p: float, rate: float = 0.07, round_mode: str = "ceil_cent") -> float:
    fee = rate * c * p * (1.0 - p)
    if round_mode == "ceil_cent":
        return math.ceil(fee * 100.0) / 100.0
    if round_mode == "round_cent":
        return round(fee, 2)
    return fee


def compute_polymarket_fee(c: int, p: float, fee_rate: float, exponent: float) -> float:
    fee = c * fee_rate * ((p * (1.0 - p)) ** exponent)
    return max(0.0, fee)


def _safe_div(a: float, b: float) -> float:
    return 0.0 if b == 0 else a / b


def _normalize_depth_levels(levels: Any) -> list[dict[str, Any]]:
    normalized: dict[float, int] = {}
    if not isinstance(levels, list):
        return []
    for level in levels:
        if not isinstance(level, dict):
            continue
        try:
            price = round(float(level.get("price", 0.0)), 6)
            size = int(float(level.get("size", 0)))
        except (TypeError, ValueError):
            continue
        if size <= 0 or price < 0.0 or price > 1.0:
            continue
        normalized[price] = normalized.get(price, 0) + size
    return [{"price": p, "size": normalized[p]} for p in sorted(normalized)]


def _fallback_levels(price: float, minimum_contracts: int) -> list[dict[str, Any]]:
    p = max(0.0, min(1.0, float(price)))
    return [{"price": round(p, 6), "size": max(1, minimum_contracts)}]


def _levels_for_candidate(snapshot: dict[str, Any], candidate: dict[str, Any], minimum_contracts: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    depth = snapshot.get("depth", {})
    kalshi_depth = depth.get("kalshi", {}) if isinstance(depth, dict) else {}
    poly_depth = depth.get("polymarket", {}) if isinstance(depth, dict) else {}

    if candidate["kalshi_side"] == "yes":
        k_levels = _normalize_depth_levels(kalshi_depth.get("buy_yes", []))
    else:
        k_levels = _normalize_depth_levels(kalshi_depth.get("buy_no", []))

    if candidate["polymarket_side"] == "yes":
        p_levels = _normalize_depth_levels(poly_depth.get("yes_asks", []))
    else:
        p_levels = _normalize_depth_levels(poly_depth.get("no_asks", []))

    if not k_levels:
        k_levels = _fallback_levels(candidate["kalshi_price"], minimum_contracts)
    if not p_levels:
        p_levels = _fallback_levels(candidate["polymarket_price"], minimum_contracts)

    return k_levels, p_levels


def _position_metrics(
    contracts: int,
    kalshi_spend: float,
    polymarket_spend: float,
    days: float,
    kalshi_fee_cfg: dict[str, Any],
    poly_fee_cfg: dict[str, Any],
    category_fee: dict[str, Any],
) -> dict[str, float]:
    if contracts <= 0:
        return {
            "kalshi_fee": 0.0,
            "polymarket_fee": 0.0,
            "kp_cost": 0.0,
            "edge_dollar": 0.0,
            "edge_pct": 0.0,
            "annualized_edge": 0.0,
            "avg_kalshi_price": 0.0,
            "avg_polymarket_price": 0.0,
        }

    avg_k_price = kalshi_spend / contracts
    avg_p_price = polymarket_spend / contracts

    kalshi_fee = 0.0
    if kalshi_fee_cfg.get("enabled", True):
        kalshi_fee = compute_kalshi_fee(
            contracts,
            avg_k_price,
            rate=float(kalshi_fee_cfg.get("rate", 0.07)),
            round_mode=str(kalshi_fee_cfg.get("round_mode", "ceil_cent")),
        )

    polymarket_fee = 0.0
    if poly_fee_cfg.get("enabled", True):
        polymarket_fee = compute_polymarket_fee(
            contracts,
            avg_p_price,
            fee_rate=float(category_fee.get("fee_rate", 0.0)),
            exponent=float(category_fee.get("exponent", 1.0)),
        )

    kp_cost = kalshi_spend + polymarket_spend + kalshi_fee + polymarket_fee
    edge_dollar = contracts - kp_cost
    edge_pct = _safe_div(edge_dollar, kp_cost)
    annualized_edge = _safe_div(edge_pct * 365.0, days)

    return {
        "kalshi_fee": kalshi_fee,
        "polymarket_fee": polymarket_fee,
        "kp_cost": kp_cost,
        "edge_dollar": edge_dollar,
        "edge_pct": edge_pct,
        "annualized_edge": annualized_edge,
        "avg_kalshi_price": avg_k_price,
        "avg_polymarket_price": avg_p_price,
    }


def _walk_depth_until_arb_ends(
    kalshi_levels: list[dict[str, Any]],
    polymarket_levels: list[dict[str, Any]],
    days: float,
    kp_max: float,
    annualized_edge_min: float,
    kalshi_fee_cfg: dict[str, Any],
    poly_fee_cfg: dict[str, Any],
    category_fee: dict[str, Any],
) -> dict[str, Any]:
    total_k_depth = sum(int(level["size"]) for level in kalshi_levels)
    total_p_depth = sum(int(level["size"]) for level in polymarket_levels)

    k_idx = 0
    p_idx = 0
    k_remaining = int(kalshi_levels[0]["size"]) if kalshi_levels else 0
    p_remaining = int(polymarket_levels[0]["size"]) if polymarket_levels else 0

    contracts = 0
    kalshi_spend = 0.0
    polymarket_spend = 0.0
    k_limit = float(kalshi_levels[0]["price"]) if kalshi_levels else 0.0
    p_limit = float(polymarket_levels[0]["price"]) if polymarket_levels else 0.0
    metrics = _position_metrics(
        contracts,
        kalshi_spend,
        polymarket_spend,
        days,
        kalshi_fee_cfg,
        poly_fee_cfg,
        category_fee,
    )
    stop_reason = "depth_exhausted"

    while k_idx < len(kalshi_levels) and p_idx < len(polymarket_levels):
        if k_remaining <= 0:
            k_idx += 1
            if k_idx >= len(kalshi_levels):
                stop_reason = "kalshi_depth_exhausted"
                break
            k_remaining = int(kalshi_levels[k_idx]["size"])
            continue

        if p_remaining <= 0:
            p_idx += 1
            if p_idx >= len(polymarket_levels):
                stop_reason = "polymarket_depth_exhausted"
                break
            p_remaining = int(polymarket_levels[p_idx]["size"])
            continue

        next_k_price = float(kalshi_levels[k_idx]["price"])
        next_p_price = float(polymarket_levels[p_idx]["price"])
        next_contracts = contracts + 1
        next_metrics = _position_metrics(
            next_contracts,
            kalshi_spend + next_k_price,
            polymarket_spend + next_p_price,
            days,
            kalshi_fee_cfg,
            poly_fee_cfg,
            category_fee,
        )

        marginal_fee = (next_metrics["kalshi_fee"] - metrics["kalshi_fee"]) + (
            next_metrics["polymarket_fee"] - metrics["polymarket_fee"]
        )
        marginal_cost = next_k_price + next_p_price + marginal_fee

        if marginal_cost >= 1.0:
            stop_reason = "no_positive_edge"
            break
        if next_metrics["kp_cost"] >= kp_max:
            stop_reason = "kp_max_hit"
            break
        if next_metrics["annualized_edge"] < annualized_edge_min:
            stop_reason = "annualized_edge_below_min"
            break

        contracts = next_contracts
        kalshi_spend += next_k_price
        polymarket_spend += next_p_price
        metrics = next_metrics
        k_limit = next_k_price
        p_limit = next_p_price
        k_remaining -= 1
        p_remaining -= 1

    return {
        "contracts": contracts,
        "kalshi_spend": kalshi_spend,
        "polymarket_spend": polymarket_spend,
        "kalshi_limit_price": k_limit,
        "polymarket_limit_price": p_limit,
        "metrics": metrics,
        "stop_reason": stop_reason,
        "contracts_available_kalshi_side": total_k_depth,
        "contracts_available_polymarket_side": total_p_depth,
    }


def _stop_reason_text(code: str) -> str:
    if code == "no_positive_edge":
        return "Arbitrage ended: KP(c) >= c"
    if code == "kp_max_hit":
        return "Arbitrage ended: KP(c) >= KP_max"
    if code == "annualized_edge_below_min":
        return "Arbitrage ended: annualized edge below A_min"
    if code == "kalshi_depth_exhausted":
        return "Arbitrage ended: Kalshi depth exhausted"
    if code == "polymarket_depth_exhausted":
        return "Arbitrage ended: Polymarket depth exhausted"
    return "Arbitrage ended"


def evaluate_pair_snapshot(snapshot: dict[str, Any], params: dict[str, Any]) -> list[OpportunityDecision]:
    min_contract_size = int(params["fixed_contract_size"])
    kp_max = float(params["kp_max_per_trade"])
    a_min = float(params["annualized_edge_min"])
    days = max(float(snapshot["days_to_resolution"]), 1e-9)

    kalshi_fee_cfg = params["fees"]["kalshi"]
    poly_fee_cfg = params["fees"]["polymarket"]

    category = snapshot.get("category", "default")
    category_fee = poly_fee_cfg.get("categories", {}).get(category, poly_fee_cfg["default"])

    ask_ky = float(snapshot["kalshi"]["yes_ask"])
    ask_kn = float(snapshot["kalshi"]["no_ask"])
    ask_py = float(snapshot["polymarket"]["yes_ask"])
    ask_pn = float(snapshot["polymarket"]["no_ask"])

    candidates = [
        {
            "strategy": "BUY_KY_BUY_PN",
            "kalshi_side": "yes",
            "polymarket_side": "no",
            "kalshi_price": ask_ky,
            "polymarket_price": ask_pn,
        },
        {
            "strategy": "BUY_KN_BUY_PY",
            "kalshi_side": "no",
            "polymarket_side": "yes",
            "kalshi_price": ask_kn,
            "polymarket_price": ask_py,
        },
    ]

    decisions: list[OpportunityDecision] = []
    for candidate in candidates:
        k_levels, p_levels = _levels_for_candidate(snapshot, candidate, min_contract_size)
        walk = _walk_depth_until_arb_ends(
            kalshi_levels=k_levels,
            polymarket_levels=p_levels,
            days=days,
            kp_max=kp_max,
            annualized_edge_min=a_min,
            kalshi_fee_cfg=kalshi_fee_cfg,
            poly_fee_cfg=poly_fee_cfg,
            category_fee=category_fee,
        )

        contracts = int(walk["contracts"])
        metrics = walk["metrics"]
        reasons: list[str] = []
        if contracts < min_contract_size:
            reasons.append(
                f"Contracts before arb end ({contracts}) < fixed_contract_size ({min_contract_size})"
            )
        if contracts == 0:
            reasons.append(_stop_reason_text(str(walk["stop_reason"])))

        decisions.append(
            OpportunityDecision(
                pair_id=snapshot["pair_id"],
                strategy=candidate["strategy"],
                contracts=contracts,
                kp_total_cost=round(metrics["kp_cost"], 6),
                edge_dollar=round(metrics["edge_dollar"], 6),
                edge_pct=round(metrics["edge_pct"], 6),
                annualized_edge=round(metrics["annualized_edge"], 6),
                kalshi_side=candidate["kalshi_side"],
                polymarket_side=candidate["polymarket_side"],
                kalshi_price=round(
                    float(walk["kalshi_limit_price"]) if contracts > 0 else candidate["kalshi_price"], 6
                ),
                polymarket_price=round(
                    float(walk["polymarket_limit_price"]) if contracts > 0 else candidate["polymarket_price"], 6
                ),
                trade=len(reasons) == 0,
                reasons=reasons,
                metadata={
                    "days_to_resolution": days,
                    "kalshi_fee": round(metrics["kalshi_fee"], 6),
                    "polymarket_fee": round(metrics["polymarket_fee"], 6),
                    "avg_kalshi_price": round(metrics["avg_kalshi_price"], 6),
                    "avg_polymarket_price": round(metrics["avg_polymarket_price"], 6),
                    "category": category,
                    "contracts_available_kalshi_side": int(walk["contracts_available_kalshi_side"]),
                    "contracts_available_polymarket_side": int(walk["contracts_available_polymarket_side"]),
                    "contracts_before_arb_ends": contracts,
                    "fixed_contract_size_minimum": min_contract_size,
                    "arb_stop_reason": str(walk["stop_reason"]),
                },
            )
        )

    return decisions


def find_mispricing(snapshots: list[dict[str, Any]], params: dict[str, Any]) -> list[OpportunityDecision]:
    decisions: list[OpportunityDecision] = []
    for snapshot in snapshots:
        per_pair = evaluate_pair_snapshot(snapshot, params)
        decisions.extend(per_pair)
    return decisions


def _load_json(path: str) -> dict[str, Any]:
    with Path(path).open("r", encoding="utf-8") as f:
        return json.load(f)


def _cli() -> int:
    parser = argparse.ArgumentParser(description="Standalone strategy model runner")
    parser.add_argument("--input", required=True, help="Path to JSON snapshot or list of snapshots")
    parser.add_argument("--config", required=True, help="Path to JSON config")
    args = parser.parse_args()

    payload = _load_json(args.input)
    config = _load_json(args.config)

    snapshots = payload if isinstance(payload, list) else [payload]
    decisions = find_mispricing(snapshots, config)

    print("pair_id,strategy,trade,kp_total_cost,edge_dollar,edge_pct,annualized_edge")
    for d in decisions:
        print(
            f"{d.pair_id},{d.strategy},{d.trade},{d.kp_total_cost:.6f},"
            f"{d.edge_dollar:.6f},{d.edge_pct:.6f},{d.annualized_edge:.6f}"
        )

    print("\nJSON:")
    print(json.dumps([asdict(d) for d in decisions], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
