"""Core arbitrage engine: depth-walking, opportunity evaluation, execution, logging.

Trading rules (from Trade Rules.md):
  1. KP(c) < c              — total cost must be less than the number of contracts
  2. c <= max_contracts      — position size must not exceed the contract cap

edge_pct = (c - KP(c)) / KP(c)
"""

from __future__ import annotations

import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

from colorama import Fore, Style

from fees import apply_fee


# ── Error classification ───────────────────────────────────────────────────────

def _is_404_error(exc: Exception) -> bool:
    """Return True if the error is a 404 Not Found (market closed/resolved on exchange)."""
    import requests
    return isinstance(exc, requests.HTTPError) and getattr(exc.response, "status_code", None) == 404


def _is_transient_error(exc: Exception) -> bool:
    """Return True if the error is likely temporary (rate limit, timeout, etc.).

    Transient errors should NOT permanently blacklist a pair — the pair will
    simply be skipped for this scan cycle and retried next time.

    Permanent errors (404, bad ticker, parse failures) DO warrant blacklisting.
    """
    import requests
    msg = str(exc).lower()

    # HTTP status-based: 429 Too Many Requests, 503 Service Unavailable
    # For HTTPError, only check the status code — never the message string,
    # since the URL may contain token IDs with substrings like "503" or "504".
    if isinstance(exc, requests.HTTPError):
        code = getattr(exc.response, "status_code", None)
        return code in (429, 503, 502, 504)

    # Connection / timeout errors
    if isinstance(exc, (requests.ConnectionError, requests.Timeout)):
        return True

    # Check message text as a fallback (covers wrapped/non-HTTP exceptions only)
    transient_phrases = ("429", "too many requests", "503", "502", "504",
                         "timeout", "timed out", "connection", "rate limit")
    return any(phrase in msg for phrase in transient_phrases)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _days_to_resolution(resolution_date: Any) -> float:
    """Convert a resolution date (string, date, or datetime) to days remaining.

    Falls back to 365 days if the date cannot be parsed, so the bot stays
    conservative rather than crashing on a bad value.
    """
    if not resolution_date:
        return 365.0
    try:
        from datetime import date
        if isinstance(resolution_date, datetime):
            delta = resolution_date.replace(tzinfo=timezone.utc) - datetime.now(timezone.utc)
            return max(1.0, delta.total_seconds() / 86400)
        if isinstance(resolution_date, date):
            from datetime import date as date_type
            delta = resolution_date - date_type.today()
            return max(1.0, float(delta.days))
        s = str(resolution_date).strip()
        if "T" in s or " " in s:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
            delta = dt - datetime.now(timezone.utc)
        else:
            from datetime import date as date_type
            d = date_type.fromisoformat(s[:10])
            from datetime import date as date_type2
            delta_days = (d - date_type2.today()).days
            return max(1.0, float(delta_days))
        return max(1.0, delta.total_seconds() / 86400)
    except Exception:
        return 365.0


def _normalize_levels(raw: list[Any]) -> list[dict[str, Any]]:
    """Merge duplicate price levels and sort ascending by price."""
    by_price: dict[float, int] = {}
    for level in raw:
        if not isinstance(level, dict):
            continue
        try:
            p = round(float(level["price"]), 6)
            s = int(float(level["size"]))
        except (KeyError, TypeError, ValueError):
            continue
        if s > 0 and 0.0 <= p <= 1.0:
            by_price[p] = by_price.get(p, 0) + s
    return [{"price": p, "size": by_price[p]} for p in sorted(by_price)]


def _load_open_positions(path: str) -> dict[str, Any]:
    p = Path(path)
    if not p.exists():
        return {}
    try:
        with p.open(encoding="utf-8") as f:
            data = json.load(f)
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return {}


def _save_open_positions(path: str, positions: dict[str, Any]) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with Path(path).open("w", encoding="utf-8") as f:
        json.dump(positions, f, indent=2)


def _load_cooldowns(path: str) -> dict[str, str]:
    p = Path(path)
    if not p.exists():
        return {}
    try:
        with p.open(encoding="utf-8") as f:
            data = json.load(f)
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return {}


def _save_cooldowns(path: str, cooldowns: dict[str, str]) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with Path(path).open("w", encoding="utf-8") as f:
        json.dump(cooldowns, f, indent=2)


def _position_age_seconds(position: dict[str, Any]) -> float:
    try:
        ts = datetime.fromisoformat(position.get("entry_timestamp"))
        return (datetime.now(timezone.utc) - ts).total_seconds()
    except Exception:
        return float("inf")


# ── Depth walking ─────────────────────────────────────────────────────────────

def _walk_depth(
    k_levels: list[dict[str, Any]],
    p_levels: list[dict[str, Any]],
    days: float,
    max_contracts: int,
    kalshi_fee_fn,
    poly_fee_fn,
    kalshi_round_up: bool,
    exit_target: float = 1.0,
) -> dict[str, Any]:
    """Walk the combined orderbook depth, accumulating contracts while profitable.

    At each step we add one contract and check all three trading rules.
    The walk stops as soon as any rule is violated, and we return the last
    valid position (which may be zero contracts if no arb exists at all).

    Stop reasons:
        no_positive_edge         — marginal cost of next contract >= $1.00
        max_contracts_hit        — position would exceed the contract cap
        kalshi_depth_exhausted
        polymarket_depth_exhausted
    """
    if not k_levels or not p_levels:
        return {
            "contracts": 0, "k_spend": 0.0, "p_spend": 0.0,
            "k_price": 0.0, "p_price": 0.0, "kp_cost": 0.0,
            "arr": 0.0, "edge_pct": 0.0, "total_fee": 0.0,
            "stop_reason": "no_levels", "slippage": [], "remaining": [],
        }

    k_idx = p_idx = 0
    k_rem = int(k_levels[0]["size"])
    p_rem = int(p_levels[0]["size"])

    contracts = 0
    k_spend = 0.0
    p_spend = 0.0
    k_price = float(k_levels[0]["price"])
    p_price = float(p_levels[0]["price"])

    cur_kf = 0.0
    cur_pf = 0.0
    cur_kp = 0.0
    stop_reason = "depth_exhausted"

    # Slippage tracking: one entry per distinct (k_price, p_price) level pair,
    # updated in-place as contracts accumulate at the same prices.
    slippage: list[dict[str, Any]] = []

    while k_idx < len(k_levels) and p_idx < len(p_levels):
        # Advance Kalshi level pointer if exhausted
        if k_rem <= 0:
            k_idx += 1
            if k_idx >= len(k_levels):
                stop_reason = "kalshi_depth_exhausted"
                break
            k_rem = int(k_levels[k_idx]["size"])
            continue

        # Advance Polymarket level pointer if exhausted
        if p_rem <= 0:
            p_idx += 1
            if p_idx >= len(p_levels):
                stop_reason = "polymarket_depth_exhausted"
                break
            p_rem = int(p_levels[p_idx]["size"])
            continue

        nk = float(k_levels[k_idx]["price"])
        np_ = float(p_levels[p_idx]["price"])
        nc = contracts + 1
        avg_k = (k_spend + nk) / nc
        avg_p = (p_spend + np_) / nc

        # Recompute fees for the candidate position
        next_kf = apply_fee(kalshi_fee_fn, avg_k, nc, kalshi_round_up)
        next_pf = apply_fee(poly_fee_fn, avg_p, nc, False)
        delta_fee = (next_kf - cur_kf) + (next_pf - cur_pf)

        # Rule 1: marginal cost of one more contract must be < exit_target (positive edge)
        if nk + np_ + delta_fee >= exit_target:
            stop_reason = "no_positive_edge"
            break

        next_kp = k_spend + nk + p_spend + np_ + next_kf + next_pf

        # Rule 2: position size must not exceed the contract cap
        if nc > max_contracts:
            stop_reason = "max_contracts_hit"
            break

        # Accept this contract
        contracts = nc
        k_spend += nk
        p_spend += np_
        k_price = nk
        p_price = np_
        cur_kf = next_kf
        cur_pf = next_pf
        cur_kp = next_kp
        k_rem -= 1
        p_rem -= 1

        # Record slippage: one entry per distinct price-level combination.
        # If prices unchanged from the last entry, update it in-place so each
        # entry reflects the cumulative state at the END of that price level.
        # Estimate exit fees at current position for slippage tracking
        _avg_k = k_spend / contracts if contracts > 0 else 0.0
        _avg_p = p_spend / contracts if contracts > 0 else 0.0
        _exit_kf = apply_fee(kalshi_fee_fn, _avg_k, contracts, kalshi_round_up)
        _exit_pf = apply_fee(poly_fee_fn, _avg_p, contracts, False)
        edge_d = contracts * exit_target - cur_kp - _exit_kf - _exit_pf
        arr_now = (edge_d / cur_kp * 365.0 / days) if cur_kp > 0 and days > 0 else 0.0
        if slippage and slippage[-1]["k_price"] == nk and slippage[-1]["p_price"] == np_:
            slippage[-1]["contracts"] = contracts
            slippage[-1]["total_profit"] = round(edge_d, 4)
            slippage[-1]["arr"] = round(arr_now, 4)
        else:
            slippage.append({
                "k_price": round(nk, 6),
                "p_price": round(np_, 6),
                "contracts": contracts,
                "total_profit": round(edge_d, 4),
                "arr": round(arr_now, 4),
            })

    final_kp = cur_kp

    # Estimate exit fees: when selling back, fees are charged on the sell price.
    # Use the average entry prices as a conservative proxy for exit sell prices.
    est_exit_kf = 0.0
    est_exit_pf = 0.0
    if contracts > 0:
        avg_k_sell = k_spend / contracts
        avg_p_sell = p_spend / contracts
        est_exit_kf = apply_fee(kalshi_fee_fn, avg_k_sell, contracts, kalshi_round_up)
        est_exit_pf = apply_fee(poly_fee_fn, avg_p_sell, contracts, False)
    total_exit_fees = est_exit_kf + est_exit_pf

    final_edge_pct = (contracts * exit_target - final_kp - total_exit_fees) / final_kp if final_kp > 0 else 0.0
    final_arr = (final_edge_pct * 365.0) / days if days > 0 else 0.0

    # After hitting max_contracts, count profitable contracts still available in the book.
    # Walk level-by-level in bulk (not one contract at a time — only counting, not scoring).
    remaining: list[dict[str, Any]] = []
    if stop_reason == "max_contracts_hit":
        r_ki, r_pi = k_idx, p_idx
        r_kr, r_pr = k_rem, p_rem
        while r_ki < len(k_levels) and r_pi < len(p_levels):
            if r_kr <= 0:
                r_ki += 1
                if r_ki >= len(k_levels):
                    break
                r_kr = int(k_levels[r_ki]["size"])
                continue
            if r_pr <= 0:
                r_pi += 1
                if r_pi >= len(p_levels):
                    break
                r_pr = int(p_levels[r_pi]["size"])
                continue
            nk = float(k_levels[r_ki]["price"])
            np_ = float(p_levels[r_pi]["price"])
            if nk + np_ >= exit_target:
                break
            count = min(r_kr, r_pr)
            r_nk = round(nk, 6)
            r_np = round(np_, 6)
            if remaining and remaining[-1]["k_price"] == r_nk and remaining[-1]["p_price"] == r_np:
                remaining[-1]["contracts"] += count
            else:
                remaining.append({"k_price": r_nk, "p_price": r_np, "contracts": count})
            r_kr -= count
            r_pr -= count

    return {
        "contracts": contracts,
        "k_spend": k_spend,
        "p_spend": p_spend,
        "k_price": k_price,
        "p_price": p_price,
        "kp_cost": final_kp,
        "arr": final_arr,
        "edge_pct": final_edge_pct,
        "total_fee": cur_kf + cur_pf,
        "exit_fee_estimate": total_exit_fees,
        "stop_reason": stop_reason,
        "slippage": slippage,
        "remaining": remaining,
    }


def _walk_depth_bids(
    k_levels: list[dict[str, Any]],
    p_levels: list[dict[str, Any]],
    target_contracts: int,
    target_sum: float = 0.99,
) -> dict[str, Any]:
    """Walk bid depth for exit; stop if cumulative best price falls below target_sum.

    Bid levels must be sorted descending (highest bid first) so we sell at the
    best available prices first.
    """
    # Sort descending — best (highest) bids first
    k_levels = sorted(k_levels, key=lambda x: float(x["price"]), reverse=True)
    p_levels = sorted(p_levels, key=lambda x: float(x["price"]), reverse=True)

    if not k_levels or not p_levels or target_contracts <= 0:
        return {
            "contracts": 0,
            "k_price": 0.0,
            "p_price": 0.0,
            "slippage": [],
            "stop_reason": "no_levels",
        }

    k_idx = p_idx = 0
    k_rem = int(k_levels[0]["size"])
    p_rem = int(p_levels[0]["size"])
    contracts = 0
    k_spend = 0.0
    p_spend = 0.0
    k_price = float(k_levels[0]["price"])
    p_price = float(p_levels[0]["price"])
    slippage: list[dict[str, Any]] = []
    stop_reason = "depth_exhausted"

    while contracts < target_contracts and k_idx < len(k_levels) and p_idx < len(p_levels):
        if k_rem <= 0:
            k_idx += 1
            if k_idx >= len(k_levels):
                stop_reason = "kalshi_depth_exhausted"
                break
            k_rem = int(k_levels[k_idx]["size"])
            continue
        if p_rem <= 0:
            p_idx += 1
            if p_idx >= len(p_levels):
                stop_reason = "polymarket_depth_exhausted"
                break
            p_rem = int(p_levels[p_idx]["size"])
            continue

        nk = float(k_levels[k_idx]["price"])
        np_ = float(p_levels[p_idx]["price"])

        if nk + np_ < target_sum:
            stop_reason = "target_not_met"
            break

        contracts += 1
        k_price = nk
        p_price = np_
        k_spend += nk
        p_spend += np_

        k_rem -= 1
        p_rem -= 1

        if slippage and slippage[-1]["k_price"] == nk and slippage[-1]["p_price"] == np_:
            slippage[-1]["contracts"] = contracts
        else:
            slippage.append({
                "k_price": round(nk, 6),
                "p_price": round(np_, 6),
                "contracts": contracts,
            })

        if contracts >= target_contracts:
            stop_reason = "target_reached"
            break

    return {
        "contracts": contracts,
        "k_price": k_price,
        "p_price": p_price,
        "k_spend": k_spend,
        "p_spend": p_spend,
        "slippage": slippage,
        "stop_reason": stop_reason,
    }


# ── Opportunity evaluation ────────────────────────────────────────────────────

def evaluate_pair(
    pair: dict[str, Any],
    kalshi_quotes: dict[str, Any],
    poly_quotes: dict[str, Any],
    cfg: dict[str, Any],
) -> list[dict[str, Any]]:
    """Evaluate both arbitrage strategies for one pair.

    Two strategies:
        BUY_KY_BUY_PN  — Buy Kalshi YES + Buy Polymarket NO
        BUY_KN_BUY_PY  — Buy Kalshi NO  + Buy Polymarket YES

    Returns a list of tradeable opportunity dicts (empty if no arb found).
    """
    max_contracts = int(cfg["max_contracts"])
    days = _days_to_resolution(pair.get("resolution_date", ""))
    exit_target = float(cfg.get("exit_target_total_price", 0.99))

    fee_cfg = cfg["fees"]
    k_fee_fn = fee_cfg["kalshi"]["_fn"]
    p_fee_fn = fee_cfg["polymarket"]["_fn"]
    k_round_up = bool(fee_cfg["kalshi"].get("round_up_to_cent", True))

    k_depth = kalshi_quotes["depth"]
    p_depth = poly_quotes["depth"]

    # Resolved token IDs from the connector (may differ from Excel if auto-resolved)
    yes_token_id = poly_quotes["yes_token_id"]
    no_token_id = poly_quotes["no_token_id"]

    strategies = [
        {
            "strategy": "BUY_KY_BUY_PN",
            "k_side": "yes",
            "p_side": "no",
            "p_token_id": no_token_id,      # buying NO on Polymarket
            "k_levels": _normalize_levels(k_depth.get("buy_yes", [])),
            "p_levels": _normalize_levels(p_depth.get("no_asks", [])),
            "k_price_hint": float(kalshi_quotes["yes_ask"]),
            "p_price_hint": float(poly_quotes["no_ask"]),
        },
        {
            "strategy": "BUY_KN_BUY_PY",
            "k_side": "no",
            "p_side": "yes",
            "p_token_id": yes_token_id,     # buying YES on Polymarket
            "k_levels": _normalize_levels(k_depth.get("buy_no", [])),
            "p_levels": _normalize_levels(p_depth.get("yes_asks", [])),
            "k_price_hint": float(kalshi_quotes["no_ask"]),
            "p_price_hint": float(poly_quotes["yes_ask"]),
        },
    ]

    results: list[dict[str, Any]] = []
    for strat in strategies:
        k_levels = strat["k_levels"]
        p_levels = strat["p_levels"]

        # Fallback if depth is empty: use best ask as a single synthetic level
        if not k_levels:
            k_levels = [{"price": strat["k_price_hint"], "size": 200}]
        if not p_levels:
            p_levels = [{"price": strat["p_price_hint"], "size": 200}]

        walk = _walk_depth(
            k_levels, p_levels, days, max_contracts,
            k_fee_fn, p_fee_fn, k_round_up, exit_target,
        )

        if walk["contracts"] > 0:
            # Estimate exit fees for edge calculation (using avg entry prices as proxy)
            c = walk["contracts"]
            avg_k_exit = walk["k_spend"] / c if c > 0 else 0.0
            avg_p_exit = walk["p_spend"] / c if c > 0 else 0.0
            est_exit_fee = apply_fee(k_fee_fn, avg_k_exit, c, k_round_up) + apply_fee(p_fee_fn, avg_p_exit, c, False)
            edge_dollar = c * exit_target - walk["kp_cost"] - est_exit_fee
            results.append({
                "pair_id": pair["pair_id"],
                "title": pair.get("title", pair["pair_id"]),
                "kalshi_ticker": pair["kalshi_ticker"],
                "polymarket_slug": pair.get("polymarket_market_slug", ""),
                "strategy": strat["strategy"],
                "k_side": strat["k_side"],
                "p_side": strat["p_side"],
                "p_token_id": strat["p_token_id"],
                "yes_token_id": yes_token_id,
                "no_token_id": no_token_id,
                "contracts": walk["contracts"],
                "k_price": walk["k_price"],
                "p_price": walk["p_price"],
                "kp_cost": walk["kp_cost"],
                "edge_dollar": round(edge_dollar, 4),
                "edge_pct": walk["edge_pct"],
                "arr": walk["arr"],
                "total_fee": walk["total_fee"],
                "days": days,
                "slippage": walk["slippage"],
                "remaining": walk["remaining"],
            })

    return results


# ── Trade log ─────────────────────────────────────────────────────────────────

def _next_trade_number(log_path: str) -> str:
    """Return the next T-prefixed trade number by scanning the log file."""
    p = Path(log_path)
    last = 0
    if p.exists():
        try:
            with p.open(encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                        num = int(str(entry.get("trade_number", "T0")).lstrip("T"))
                        last = max(last, num)
                    except (json.JSONDecodeError, ValueError):
                        pass
        except OSError:
            pass
    return f"T{(last + 1):05d}"


def _write_trade_log(entry: dict[str, Any], log_path: str) -> None:
    Path(log_path).parent.mkdir(parents=True, exist_ok=True)
    with Path(log_path).open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


_KALSHI_BASE_URL = "https://kalshi.com/markets"
_POLY_BASE_URL   = "https://polymarket.com/event"


def _write_opportunity_log(opp: dict[str, Any], log_path: str) -> None:
    """Append one opportunity (with market links) to the opportunity log."""
    ticker = opp.get("kalshi_ticker", "")
    slug   = opp.get("polymarket_slug", "")
    entry = {
        "timestamp":       datetime.now(timezone.utc).isoformat(),
        "pair_id":         opp["pair_id"],
        "title":           opp.get("title", opp["pair_id"]),
        "strategy":        opp["strategy"],
        "contracts":       opp["contracts"],
        "k_price":         round(opp["k_price"], 4),
        "p_price":         round(opp["p_price"], 4),
        "kp_cost":         round(opp["kp_cost"], 4),
        "edge_dollar":     round(opp["edge_dollar"], 4),
        "arr_pct":         round(opp["arr"] * 100, 2),
        "total_fee":       round(opp["total_fee"], 4),
        "days":            round(opp["days"], 2),
        "kalshi_url":      f"{_KALSHI_BASE_URL}/{ticker}" if ticker else "",
        "polymarket_url":  f"{_POLY_BASE_URL}/{slug}"     if slug   else "",
        "slippage":        opp.get("slippage", []),
    }
    Path(log_path).parent.mkdir(parents=True, exist_ok=True)
    with Path(log_path).open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


# ── Execution ─────────────────────────────────────────────────────────────────

def _slippage_to_fills(slippage: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Convert cumulative slippage entries to per-level fill records."""
    fills = []
    prev_contracts = 0
    for s in slippage:
        level_contracts = s["contracts"] - prev_contracts
        prev_contracts = s["contracts"]
        fills.append({
            "k_price": s["k_price"],
            "p_price": s["p_price"],
            "contracts": level_contracts,
        })
    return fills


def _build_log_entry(opp: dict[str, Any], mode: str, **overrides) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    entry: dict[str, Any] = {
        "title": opp["title"],
        "pair_id": opp["pair_id"],
        "trade_phase": "entry",
        "fills": _slippage_to_fills(opp.get("slippage", [])),
        "total_contracts": opp["contracts"],
        "edge_pct": round(opp["edge_pct"] * 100, 2),
        "total_profit": round(opp["edge_dollar"], 4),
        "arr": round(opp["arr"] * 100, 2),                   # annualised return as % (e.g. 18.4)
        "fee": round(opp["total_fee"], 4),
        "trade_number": overrides.pop("trade_number", "T?????"),
        "strategy": opp["strategy"],
        "execution_date": now.date().isoformat(),
        "timestamp": now.isoformat(),
        "mode": mode,
        "kalshi_token": opp["kalshi_ticker"],
        "polymarket_token": opp["p_token_id"],
    }
    entry.update(overrides)
    return entry


def execute_paper(opp: dict[str, Any], log_path: str) -> dict[str, Any]:
    """Simulate a trade (no real orders) and append to the trade log."""
    trade_num = _next_trade_number(log_path)
    entry = _build_log_entry(opp, "paper", trade_number=trade_num)
    _write_trade_log(entry, log_path)
    return entry


def execute_live(opp: dict[str, Any], kalshi, poly, log_path: str) -> dict[str, Any]:
    """Place real orders on Kalshi then Polymarket; log the result.

    Kalshi leg is placed first. If the Polymarket leg fails afterward,
    a PARTIAL FILL warning is printed — the Kalshi position is already open.
    """
    trade_num = _next_trade_number(log_path)
    client_id = f"{trade_num}:{opp['pair_id']}:{opp['strategy']}"

    # Kalshi leg
    kalshi.place_order(
        ticker=opp["kalshi_ticker"],
        side=opp["k_side"],
        contracts=opp["contracts"],
        price=opp["k_price"],
        client_order_id=f"{client_id}:k",
    )

    # Polymarket leg
    partial = False
    try:
        poly.place_order(
            token_id=opp["p_token_id"],
            side="buy",
            size=opp["contracts"],
            price=opp["p_price"],
        )
    except Exception as exc:
        partial = True
        print(
            f"  {Fore.RED}! PARTIAL FILL{Style.RESET_ALL} — Polymarket leg failed "
            f"after Kalshi filled: {exc}",
            file=sys.stderr,
        )

    entry = _build_log_entry(
        opp, "live",
        trade_number=trade_num,
        total_profit=round(opp["edge_dollar"], 4) if not partial else 0.0,
        partial_fill=partial,
    )
    _write_trade_log(entry, log_path)
    return entry


def _record_open_position(
    positions: dict[str, Any],
    opp: dict[str, Any],
    trade: dict[str, Any],
    position_file: str,
    cooldown_seconds: int = 3600,
) -> None:
    """Add an open position and write state to disk."""
    now = datetime.now(timezone.utc)
    pos = {
        "pair_id": opp["pair_id"],
        "strategy": opp["strategy"],
        "k_side": opp["k_side"],
        "p_side": opp["p_side"],
        "kalshi_ticker": opp["kalshi_ticker"],
        "p_token_id": opp.get("p_token_id", ""),
        "yes_token_id": opp.get("yes_token_id", ""),
        "no_token_id": opp.get("no_token_id", ""),
        "title": opp.get("title", opp["pair_id"]),
        "contracts": opp["contracts"],
        "entry_k_price": opp["k_price"],
        "entry_p_price": opp["p_price"],
        "entry_kp_cost": opp.get("kp_cost", 0.0),
        "entry_fills": _slippage_to_fills(opp.get("slippage", [])),
        "entry_fee": opp.get("total_fee", 0.0),
        "entry_edge_dollar": opp.get("edge_dollar", 0.0),
        "entry_arr": opp.get("arr", 0.0),
        "entry_edge_pct": opp.get("edge_pct", 0.0),
        "entry_timestamp": now.isoformat(),
        "entry_trade_number": trade.get("trade_number", ""),
        "cooldown_until": (now + timedelta(seconds=cooldown_seconds)).isoformat(),
    }
    positions[opp["pair_id"]] = pos
    _save_open_positions(position_file, positions)


def _build_exit_log_entry(
    position: dict[str, Any],
    exit_walk: dict[str, Any],
    exit_contracts: int,
    exit_fee: float,
    timeout: bool,
    shutdown: bool,
    mode: str,
    trade_number: str,
) -> dict[str, Any]:
    full_entry_kp_cost = position.get(
        "entry_kp_cost",
        (position["entry_k_price"] + position["entry_p_price"]) * position["contracts"]
        + position.get("entry_fee", 0.0),
    )
    cost_per_contract = full_entry_kp_cost / position["contracts"] if position["contracts"] else 0.0
    entry_total_cost = cost_per_contract * exit_contracts
    # Use actual blended spend from the bid walk, not a single level price
    exit_k_spend = exit_walk.get("k_spend", exit_walk.get("k_price", 0.0) * exit_contracts)
    exit_p_spend = exit_walk.get("p_spend", exit_walk.get("p_price", 0.0) * exit_contracts)
    exit_total_value = exit_k_spend + exit_p_spend - exit_fee
    realized_pnl = exit_total_value - entry_total_cost
    edge_pct = (realized_pnl / entry_total_cost) if entry_total_cost > 0 else 0.0
    age_seconds = _position_age_seconds(position)
    age_days = max(age_seconds / 86400.0, 1.0 / 86400.0)
    arr = edge_pct * 365.0 / age_days

    entry = {
        "title": position.get("title", position["pair_id"]),
        "pair_id": position["pair_id"],
        "trade_phase": "exit",
        "corresponding_entry_trade_number": position.get("entry_trade_number", ""),
        "entry_k_price": position["entry_k_price"],
        "entry_p_price": position["entry_p_price"],
        "entry_fills": position.get("entry_fills", []),
        "entry_fee": position.get("entry_fee", 0.0),
        "entry_kp_cost": round(entry_total_cost, 4),
        "exit_fills": _slippage_to_fills(exit_walk.get("slippage", [])),
        "total_contracts": exit_contracts,
        "edge_pct": round(edge_pct * 100, 2),
        "total_profit": round(realized_pnl, 4),
        "arr": round(arr * 100, 2),
        "fee": round(exit_fee, 4),
        "hold_duration_seconds": round(age_seconds, 2),
        "close_reason": "shutdown" if shutdown else ("timeout" if timeout else "target"),
        "kalshi_token": position.get("kalshi_ticker", ""),
        "polymarket_token": position.get("p_token_id", ""),
        "strategy": position.get("strategy", ""),
        "execution_date": datetime.now(timezone.utc).date().isoformat(),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "mode": mode,
        "trade_number": trade_number,
    }
    return entry


def _process_exit_positions(
    positions: dict[str, Any],
    kalshi,
    poly,
    cfg: dict[str, Any],
    mode: str,
    log_path: str,
    position_file: str,
    cooldowns: dict[str, str] | None = None,
    shutdown: bool = False,
) -> dict[str, Any]:
    """Evaluate and close open positions using bid rules."""
    target_sum = float(cfg.get("exit_target_total_price", 0.99))
    exit_candidates = []

    for pair_id, position in list(positions.items()):
        age = _position_age_seconds(position)
        fetch_delay = 2
        kq = pq = None
        while True:
            try:
                kq = kalshi.get_quotes(position["kalshi_ticker"])
                pq = poly.get_quotes(position.get("yes_token_id", ""), position.get("no_token_id", ""), "")
                break
            except Exception as exc:
                if "429" in str(exc):
                    print(f"  {Fore.YELLOW}Rate limited fetching {pair_id} — retrying in {fetch_delay}s...{Style.RESET_ALL}")
                    time.sleep(fetch_delay)
                    fetch_delay = min(fetch_delay * 2, 60)
                elif shutdown:
                    print(f"  {Fore.YELLOW}Exit fetch failed for {pair_id}: {exc} — retrying in {fetch_delay}s...{Style.RESET_ALL}")
                    time.sleep(fetch_delay)
                    fetch_delay = min(fetch_delay * 2, 60)
                else:
                    print(f"  {Fore.YELLOW}Exit fetch failed for {pair_id}: {exc}{Style.RESET_ALL}")
                    break
        if kq is None or pq is None:
            continue
        if shutdown:
            time.sleep(1.5)

        if position["strategy"] == "BUY_KY_BUY_PN":
            k_bid = kq["yes_bid"]
            p_bid = pq["no_bid"]
            k_levels = kq.get("depth", {}).get("sell_yes", [])
            p_levels = pq.get("depth", {}).get("no_bids", [])
            k_side = "yes"
            p_side = "no"
        else:
            k_bid = kq["no_bid"]
            p_bid = pq["yes_bid"]
            k_levels = kq.get("depth", {}).get("sell_no", [])
            p_levels = pq.get("depth", {}).get("yes_bids", [])
            k_side = "no"
            p_side = "yes"

        target_hit = (k_bid + p_bid) >= target_sum
        if not (target_hit or shutdown):
            continue

        # For shutdown, accept any bid. For convergence exits, require target_sum.
        forced = shutdown
        walk = _walk_depth_bids(k_levels, p_levels, position["contracts"], 0.0 if forced else target_sum)

        # For convergence exits: if no contracts meet the target in the book, skip.
        # For forced exits: sell the full position at best available bids.
        if not forced and walk["contracts"] == 0:
            continue

        exit_contracts = walk["contracts"] if walk["contracts"] > 0 else position["contracts"]
        exit_k_price = walk.get("k_price", k_bid)
        exit_p_price = walk.get("p_price", p_bid)

        # Execute the exit leg(s)
        order_failed = False
        if mode == "live":
            try:
                kalshi.place_order(
                    ticker=position["kalshi_ticker"],
                    side=k_side,
                    contracts=exit_contracts,
                    price=exit_k_price,
                    client_order_id=f"EXIT:{pair_id}:{position.get('entry_trade_number', '')}:k",
                    action="sell",
                )
            except Exception as exc:
                order_failed = True
                print(f"  {Fore.RED}Kalshi exit failed for {pair_id}: {exc}{Style.RESET_ALL}")
            try:
                poly.place_order(
                    token_id=position.get("p_token_id", ""),
                    side="sell",
                    size=exit_contracts,
                    price=exit_p_price,
                )
            except Exception as exc:
                order_failed = True
                print(f"  {Fore.RED}Polymarket exit failed for {pair_id}: {exc}{Style.RESET_ALL}")

        fee_cfg = cfg["fees"]
        k_fee_fn = fee_cfg["kalshi"]["_fn"]
        p_fee_fn = fee_cfg["polymarket"]["_fn"]
        k_rup = bool(fee_cfg["kalshi"].get("round_up_to_cent", True))
        # Use blended average exit prices for fee calculation, not just the last fill price
        exit_k_spend_val = walk.get("k_spend", exit_k_price * exit_contracts)
        exit_p_spend_val = walk.get("p_spend", exit_p_price * exit_contracts)
        exit_k_avg = exit_k_spend_val / exit_contracts if exit_contracts else exit_k_price
        exit_p_avg = exit_p_spend_val / exit_contracts if exit_contracts else exit_p_price
        exit_fee = apply_fee(k_fee_fn, exit_k_avg, exit_contracts, k_rup) + apply_fee(p_fee_fn, exit_p_avg, exit_contracts, False)

        trade_number = _next_trade_number(log_path)
        exit_log = _build_exit_log_entry(
            position=position,
            exit_walk=walk,
            exit_contracts=exit_contracts,
            exit_fee=exit_fee,
            timeout=False,
            shutdown=shutdown,
            mode=mode,
            trade_number=trade_number,
        )
        _write_trade_log(exit_log, log_path)

        remaining = position["contracts"] - exit_contracts
        if order_failed:
            print(f"  {Fore.YELLOW}PARTIAL exit for {pair_id} ({exit_contracts}/{position['contracts']}c){Style.RESET_ALL}")
        elif remaining > 0:
            print(f"  {Fore.GREEN}EXIT {exit_contracts}c of {position['contracts']}c for {pair_id} — {remaining}c remain (bids below target){Style.RESET_ALL}")
        else:
            print(f"  {Fore.GREEN}EXIT {exit_contracts}c for {pair_id} — fully closed K{exit_k_price:.4f}/P{exit_p_price:.4f}{Style.RESET_ALL}")

        if remaining > 0 and not forced:
            # Partial convergence exit — update position contract count and scale
            # entry_kp_cost proportionally so the next exit log computes correct P&L
            original_contracts = positions[pair_id]["contracts"]
            old_kp_cost = positions[pair_id].get("entry_kp_cost", 0.0)
            positions[pair_id]["contracts"] = remaining
            positions[pair_id]["entry_kp_cost"] = old_kp_cost * remaining / original_contracts if original_contracts else 0.0
        else:
            exit_candidates.append(pair_id)

    for pair_id in exit_candidates:
        pos = positions.pop(pair_id, None)
        if cooldowns is not None and pos is not None:
            cooldowns[pair_id] = pos.get("cooldown_until", "")

    _save_open_positions(position_file, positions)
    return positions


# ── Failed-pairs tracking ─────────────────────────────────────────────────────

def load_expired_ids(log_path: str) -> set[str]:
    """Read the expired-pairs log and return the set of pair_ids to skip."""
    p = Path(log_path)
    ids: set[str] = set()
    if not p.exists():
        return ids
    try:
        with p.open(encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                    pid = entry.get("pair_id", "")
                    if pid:
                        ids.add(pid)
                except json.JSONDecodeError:
                    pass
    except OSError:
        pass
    return ids


def _log_expired_pair(pair: dict[str, Any], log_path: str) -> None:
    """Append one entry to the expired-pairs log file."""
    Path(log_path).parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "pair_id": pair["pair_id"],
        "kalshi_ticker": pair.get("kalshi_ticker", ""),
        "title": pair.get("title", ""),
        "resolution_date": str(pair.get("resolution_date", "")),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    with Path(log_path).open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


def load_failed_ids(log_path: str) -> set[str]:
    """Read the failed-pairs log and return the set of pair_ids to skip."""
    p = Path(log_path)
    ids: set[str] = set()
    if not p.exists():
        return ids
    try:
        with p.open(encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                    pid = entry.get("pair_id", "")
                    if pid:
                        ids.add(pid)
                except json.JSONDecodeError:
                    pass
    except OSError:
        pass
    return ids


def _log_failed_pair(pair: dict[str, Any], error: str, log_path: str) -> None:
    """Append one entry to the failed-pairs log file."""
    Path(log_path).parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "pair_id": pair["pair_id"],
        "kalshi_ticker": pair.get("kalshi_ticker", ""),
        "title": pair.get("title", ""),
        "error": str(error),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    with Path(log_path).open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


# ── Fill breakdown ────────────────────────────────────────────────────────────

def _print_fill_breakdown(opp: dict[str, Any]) -> None:
    """Print traded fill levels and any remaining arb contracts in the book."""
    slippage  = opp.get("slippage", [])
    remaining = opp.get("remaining", [])
    if not slippage:
        return

    # Traded breakdown — convert cumulative slippage entries to per-level counts
    parts: list[str] = []
    prev_c = 0
    for entry in slippage:
        level_c = entry["contracts"] - prev_c
        prev_c = entry["contracts"]
        parts.append(
            f"{level_c}c @ K{entry['k_price']:.4f}/P{entry['p_price']:.4f}"
        )
    traded_str = ", ".join(parts)
    print(f"    {Style.DIM}Traded {opp['contracts']}c: {traded_str}{Style.RESET_ALL}")

    # Remaining arb in the book beyond our cap
    if remaining:
        rem_total = sum(r["contracts"] for r in remaining)
        rem_parts = [
            f"{r['contracts']}c @ K{r['k_price']:.4f}/P{r['p_price']:.4f}"
            for r in remaining
        ]
        print(
            f"    {Style.DIM}{rem_total}c remain of arb: "
            f"{', '.join(rem_parts)}{Style.RESET_ALL}"
        )


# ── Scan cycle ────────────────────────────────────────────────────────────────

def _fetch_pair(pair: dict[str, Any], kalshi, poly) -> tuple[dict, dict, dict]:
    """Fetch orderbook quotes for one pair (runs in a worker thread).

    Retries up to 3 times with exponential backoff on transient errors (429, 503,
    timeouts). Permanent errors (404, bad ticker) are raised immediately.
    """
    max_retries = 3
    delay = 1.0  # seconds before first retry; doubles each attempt
    last_exc: Exception | None = None
    for attempt in range(max_retries + 1):
        try:
            kq = kalshi.get_quotes(pair["kalshi_ticker"])
            pq = poly.get_quotes(
                pair["polymarket_yes_token_id"],
                pair["polymarket_no_token_id"],
                pair.get("polymarket_market_slug", ""),
            )
            return pair, kq, pq
        except Exception as exc:
            if _is_transient_error(exc) and attempt < max_retries:
                last_exc = exc
                time.sleep(delay)
                delay *= 2
            else:
                raise
    raise last_exc  # type: ignore[misc]


def run_scan(
    pairs: list[dict[str, Any]],
    kalshi,
    poly,
    cfg: dict[str, Any],
    execute: bool = False,
    failed_ids: set[str] | None = None,
    expired_ids: set[str] | None = None,
    skip_pair_ids: set[str] | None = None,
    on_new_position: Any | None = None,
) -> list[dict[str, Any]]:
    """Run one full scan across all pairs using concurrent HTTP requests.

    Phase 1 — fetch: active pairs (not in failed_ids) are fetched in parallel.
    Phase 2 — evaluate: results are evaluated and executed in original pair order.

    If a pair errors during fetch it is added to failed_ids and written to the
    failed-pairs log so it is skipped in all future cycles.

    If execute=False (scan command), opportunities are displayed but not traded.
    If execute=True (run command), each opportunity is executed immediately.
    """
    if failed_ids is None:
        failed_ids = set()
    if expired_ids is None:
        expired_ids = set()

    mode = cfg["mode"]
    log_path = cfg.get("entry_log", "entry_trades.json")
    opp_log_path = cfg.get("opportunities_log", "opportunities.json")
    failed_log = cfg.get("failed_log", "failed_pairs.json")
    expired_log = cfg.get("expired_log", "expired_pairs.json")
    max_workers = int(cfg.get("max_workers", 30))
    ts = datetime.now().strftime("%H:%M:%S")
    t0 = time.monotonic()

    # Filter out pairs that have previously failed or whose resolution date has passed
    from datetime import date as _date
    today = _date.today()

    def _is_expired(p: dict) -> bool:
        rd = p.get("resolution_date")
        if not rd:
            return False
        try:
            if hasattr(rd, "date"):
                return rd.date() < today
            if hasattr(rd, "year"):   # date object
                return rd < today
            s = str(rd).strip()[:10]
            return _date.fromisoformat(s) < today
        except Exception:
            return False

    skip_pair_ids = skip_pair_ids or set()

    # Log newly-expired pairs to expired_ids so they are never rechecked
    for p in pairs:
        if p["pair_id"] not in expired_ids and _is_expired(p):
            expired_ids.add(p["pair_id"])
            _log_expired_pair(p, expired_log)

    active_pairs = [
        p for p in pairs
        if p["pair_id"] not in failed_ids
        and p["pair_id"] not in expired_ids
        and p["pair_id"] not in skip_pair_ids
    ]
    skipped = len(pairs) - len(active_pairs)

    skip_note = f"  {Style.DIM}({skipped} skipped — failed/expired){Style.RESET_ALL}" if skipped else ""
    print(
        f"\n{Style.DIM}[{ts}]{Style.RESET_ALL} "
        f"Fetching quotes for {len(active_pairs)} pair(s)  "
        f"{Style.DIM}({max_workers} workers)...{Style.RESET_ALL}"
        f"{skip_note}"
    )

    if not active_pairs:
        print(f"  {Fore.YELLOW}All pairs are in the failed log — nothing to scan.{Style.RESET_ALL}")
        return []

    # Phase 1: fetch all active pairs concurrently
    # results maps pair_id -> (pair, kq, pq) on success, or Exception on failure
    results: dict[str, Any] = {}
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(_fetch_pair, pair, kalshi, poly): pair for pair in active_pairs}
        done = 0
        for fut in as_completed(futures):
            done += 1
            pair = futures[fut]
            try:
                results[pair["pair_id"]] = fut.result()
            except Exception as exc:
                results[pair["pair_id"]] = exc
            if done % 50 == 0 or done == len(active_pairs):
                print(
                    f"  {Style.DIM}{done}/{len(active_pairs)} fetched...{Style.RESET_ALL}",
                    end="\r",
                    flush=True,
                )

    elapsed = time.monotonic() - t0
    print(f"  Fetched {len(active_pairs)} pairs in {elapsed:.1f}s{' ' * 20}")

    # Phase 2: evaluate and execute in original pair order
    all_opps: list[dict[str, Any]] = []
    new_failures = 0
    rate_limited = 0
    # Deduplicate executions: if the same (ticker, strategy) appears more than once
    # (e.g. duplicate rows in the pairs file) only execute it the first time.
    executed_keys: set[tuple[str, str]] = set()

    for pair in active_pairs:
        label = f"{pair['kalshi_ticker']}/{pair['pair_id']}"
        result = results.get(pair["pair_id"])

        if isinstance(result, Exception):
            if _is_transient_error(result):
                # Rate limit / timeout — skip this cycle, do NOT blacklist
                rate_limited += 1
                print(
                    f"  {Fore.YELLOW}~ {label}: {result}  (transient — will retry){Style.RESET_ALL}",
                    file=sys.stderr,
                )
            elif _is_404_error(result):
                # 404 = market closed/resolved on exchange — treat as expired
                expired_ids.add(pair["pair_id"])
                _log_expired_pair(pair, expired_log)
                new_failures += 1
                print(
                    f"  {Fore.YELLOW}! {label}: 404 — market gone, logged to expired pairs{Style.RESET_ALL}",
                    file=sys.stderr,
                )
            else:
                # Permanent error (bad ticker, parse failure, etc.)
                failed_ids.add(pair["pair_id"])
                _log_failed_pair(pair, str(result), failed_log)
                new_failures += 1
                print(
                    f"  {Fore.YELLOW}! {label}: {result}  → logged to failed pairs{Style.RESET_ALL}",
                    file=sys.stderr,
                )
            continue

        try:
            _, kq, pq = result
            opps = evaluate_pair(pair, kq, pq, cfg)
        except Exception as exc:
            failed_ids.add(pair["pair_id"])
            _log_failed_pair(pair, f"eval error: {exc}", failed_log)
            new_failures += 1
            print(
                f"  {Fore.YELLOW}! {label} (eval): {exc}  → logged to failed pairs{Style.RESET_ALL}",
                file=sys.stderr,
            )
            continue

        # Optional per-pair market status line (enabled via print_market_status in config).
        if cfg.get("print_market_status", False):
            k_yes_mp = (kq["yes_bid"] + kq["yes_ask"]) / 2
            k_no_mp  = (kq["no_bid"]  + kq["no_ask"])  / 2
            p_yes_mp = (pq["yes_bid"] + pq["yes_ask"]) / 2
            p_no_mp  = (pq["no_bid"]  + pq["no_ask"])  / 2
            days_left = _days_to_resolution(pair.get("resolution_date", ""))
            # Net-of-fees marginal edge for 1 contract in each direction
            fee_cfg   = cfg["fees"]
            k_fee_fn  = fee_cfg["kalshi"]["_fn"]
            p_fee_fn  = fee_cfg["polymarket"]["_fn"]
            k_rup     = bool(fee_cfg["kalshi"].get("round_up_to_cent", True))
            def _net_edge(ka: float, pa: float) -> float:
                return 1.0 - (ka + pa
                               + apply_fee(k_fee_fn, ka, 1, k_rup)
                               + apply_fee(p_fee_fn, pa, 1, False))
            net_edge_dollar = max(
                _net_edge(kq["yes_ask"], pq["no_ask"]),
                _net_edge(kq["no_ask"],  pq["yes_ask"]),
            )
            # kp_cost = what it costs to buy both legs for 1 contract
            kp_cost_1c = 1.0 - net_edge_dollar
            # edge_pct and ARR consistent with the depth-walk formula:
            #   edge_pct = edge_dollar / kp_cost
            #   ARR      = edge_pct * 365 / days
            edge_pct = (net_edge_dollar / kp_cost_1c) if kp_cost_1c > 0 else 0.0
            net_arr  = (edge_pct * 365.0 / days_left) if days_left > 0 else 0.0
            edge_color = Fore.GREEN if edge_pct > 0 else Fore.RED
            print(
                f"  {Style.DIM}{label:<38}{Style.RESET_ALL}"
                f"  K YES/NO: {k_yes_mp:.3f}/{k_no_mp:.3f}"
                f"  P YES/NO: {p_yes_mp:.3f}/{p_no_mp:.3f}"
                f"  exp={days_left:.1f}d"
                f"  edge={edge_color}{edge_pct * 100:+.1f}%"
                f"  ARR={net_arr * 100:+.1f}%{Style.RESET_ALL}"
            )

        if opps:
            for opp in opps:
                exec_key = (opp.get("kalshi_ticker", ""), opp["strategy"])
                ticker = opp.get("kalshi_ticker", "")
                slug   = opp.get("polymarket_slug", "")
                k_url  = f"{_KALSHI_BASE_URL}/{ticker}" if ticker else ""
                p_url  = f"{_POLY_BASE_URL}/{slug}"     if slug   else ""
                print(
                    f"  {Fore.GREEN}✓{Style.RESET_ALL} {label:<38} "
                    f"{opp['strategy']:<16} "
                    f"{opp['contracts']}c  "
                    f"ARR={opp['arr'] * 100:.1f}%  "
                    f"edge=${opp['edge_dollar']:.2f}  "
                    f"K={opp['k_price']:.4f}  P={opp['p_price']:.4f}"
                )
                if k_url:
                    print(f"    {Style.DIM}Kalshi:      {k_url}{Style.RESET_ALL}")
                if p_url:
                    print(f"    {Style.DIM}Polymarket:  {p_url}{Style.RESET_ALL}")
                _write_opportunity_log(opp, opp_log_path)
                if execute:
                    if exec_key in executed_keys:
                        print(
                            f"    {Fore.YELLOW}⚠ duplicate {exec_key[0]}/{exec_key[1]} "
                            f"— skipping (already executed this cycle){Style.RESET_ALL}"
                        )
                    else:
                        executed_keys.add(exec_key)
                        min_profit = float(cfg.get("min_profit_dollars", 0.25))
                        if opp["edge_dollar"] < min_profit:
                            print(
                                f"    {Fore.YELLOW}⚠ skipping — profit ${opp['edge_dollar']:.2f} "
                                f"below min ${min_profit:.2f}{Style.RESET_ALL}"
                            )
                            continue
                        trade = None
                        if mode == "paper":
                            trade = execute_paper(opp, log_path)
                            print(f"    {Style.DIM}→ logged {trade['trade_number']} (paper){Style.RESET_ALL}")
                        elif mode == "live":
                            trade = execute_live(opp, kalshi, poly, log_path)
                            status = "PARTIAL FILL" if trade.get("partial_fill") else "filled"
                            color = Fore.RED if trade.get("partial_fill") else Fore.GREEN
                            print(f"    → {trade['trade_number']} {color}{status}{Style.RESET_ALL}")
                        _print_fill_breakdown(opp)
                        if on_new_position and trade is not None:
                            on_new_position(opp, trade)
                else:
                    print(f"    {Style.DIM}(scan-only — use 'run' to execute){Style.RESET_ALL}")
                    _print_fill_breakdown(opp)
            all_opps.extend(opps)

    parts = [f"{len(all_opps)} opportunity(ies) found"]
    if rate_limited:
        parts.append(f"{Fore.YELLOW}{rate_limited} rate-limited (retry next cycle){Style.RESET_ALL}")
    if new_failures:
        parts.append(f"{Fore.YELLOW}{new_failures} new failure(s) logged → {failed_log}{Style.RESET_ALL}")
    print(f"  {Style.DIM}{' | '.join(parts)}{Style.RESET_ALL}")

    return all_opps


def run_loop(
    pairs: list[dict[str, Any]],
    kalshi,
    poly,
    cfg: dict[str, Any],
) -> None:
    """Continuously scan and execute trades until Ctrl+C.

    Failed pairs are loaded from the failed-pairs log at startup and accumulated
    in memory across cycles — they are never fetched again within this session.
    """
    interval = max(1, int(cfg.get("scan_interval_seconds", 5)))
    pairs_per_cycle = int(cfg.get("pairs_per_cycle", len(pairs)))
    pair_offset = 0
    failed_log = cfg.get("failed_log", "failed_pairs.json")
    expired_log = cfg.get("expired_log", "expired_pairs.json")
    position_file = cfg.get("position_file", "open_positions.json")
    cooldown_file = cfg.get("cooldown_file", "cooldowns.json")

    # Load any previously failed pairs so they are skipped from the first cycle
    failed_ids = load_failed_ids(failed_log)
    if failed_ids:
        print(
            f"  {Style.DIM}Loaded {len(failed_ids)} previously failed pair(s) from "
            f"{failed_log} — these will be skipped.{Style.RESET_ALL}"
        )

    # Load any previously expired pairs so they are skipped from the first cycle
    expired_ids = load_expired_ids(expired_log)
    if expired_ids:
        print(
            f"  {Style.DIM}Loaded {len(expired_ids)} previously expired pair(s) from "
            f"{expired_log} — these will be skipped.{Style.RESET_ALL}"
        )

    positions = _load_open_positions(position_file)
    if positions:
        print(
            f"  {Style.DIM}Loaded {len(positions)} open position(s) from "
            f"{position_file}{Style.RESET_ALL}"
        )

    # Tracks cooldown_until per pair_id — persists to disk so restarts respect cooldowns
    cooldowns: dict[str, str] = _load_cooldowns(cooldown_file)
    # Prune expired cooldowns on startup
    now_startup = datetime.now(timezone.utc)
    cooldowns = {
        pid: ts for pid, ts in cooldowns.items()
        if datetime.fromisoformat(ts) > now_startup
    }

    def _on_new_position(opp: dict[str, Any], trade: dict[str, Any]) -> None:
        cooldown_seconds = int(cfg.get("entry_cooldown_seconds", 3600))
        _record_open_position(positions, opp, trade, position_file, cooldown_seconds=cooldown_seconds)

    EXIT_INTERVAL = 10   # seconds between exit checks
    SCAN_INTERVAL = 5    # seconds between new-pair scans

    last_exit_check = 0.0  # epoch seconds; 0 forces immediate check on first cycle

    print(f"\n{Fore.CYAN}Bot running — press Ctrl+C to stop.{Style.RESET_ALL}")
    while True:
        try:
            # --- Exit check (every EXIT_INTERVAL seconds) ---
            if cfg.get("exit_enabled", True) and (time.time() - last_exit_check >= EXIT_INTERVAL):
                positions = _process_exit_positions(
                    positions=positions,
                    kalshi=kalshi,
                    poly=poly,
                    cfg=cfg,
                    mode=cfg.get("mode", "paper"),
                    log_path=cfg.get("exit_log", "exit_trades.json"),
                    position_file=position_file,
                    cooldowns=cooldowns,
                    shutdown=False,
                )
                _save_cooldowns(cooldown_file, cooldowns)
                last_exit_check = time.time()

            now = datetime.now(timezone.utc)
            skip_pair_ids = set()

            # Skip pairs with an open position
            for pos in positions.values():
                skip_pair_ids.add(pos["pair_id"])

            # Skip pairs still in cooldown (even if their position has closed)
            for pair_id, cooldown_until_str in cooldowns.items():
                try:
                    cooldown_until = datetime.fromisoformat(cooldown_until_str)
                    if cooldown_until > now:
                        skip_pair_ids.add(pair_id)
                except Exception:
                    pass

            # Rotate through non-position pairs, keeping open-position pairs first
            open_pair_ids = {pos["pair_id"] for pos in positions.values()}
            priority_pairs = [p for p in pairs if p["pair_id"] in open_pair_ids]
            remaining_pairs = [p for p in pairs if p["pair_id"] not in open_pair_ids]
            rotated_remaining = remaining_pairs[pair_offset:] + remaining_pairs[:pair_offset]
            scan_pairs = (priority_pairs + rotated_remaining)[:pairs_per_cycle]
            pair_offset = (pair_offset + max(pairs_per_cycle - len(priority_pairs), 0)) % max(len(remaining_pairs), 1)

            opps = run_scan(
                scan_pairs,
                kalshi,
                poly,
                cfg,
                execute=True,
                failed_ids=failed_ids,
                expired_ids=expired_ids,
                skip_pair_ids=skip_pair_ids,
                on_new_position=_on_new_position,
            )
            traded = len(opps)
            print(
                f"  {Style.DIM}{traded} new entry trade(s) this cycle  "
                f"| next scan in {SCAN_INTERVAL}s...{Style.RESET_ALL}"
            )
            time.sleep(SCAN_INTERVAL)
        except KeyboardInterrupt:
            print(f"\n{Fore.YELLOW}Shutdown requested — closing positions on bids...{Style.RESET_ALL}")
            if cfg.get("exit_enabled", True):
                positions = _process_exit_positions(
                    positions=positions,
                    kalshi=kalshi,
                    poly=poly,
                    cfg=cfg,
                    mode=cfg.get("mode", "paper"),
                    log_path=cfg.get("exit_log", "exit_trades.json"),
                    position_file=position_file,
                    cooldowns=cooldowns,
                    shutdown=True,
                )
                _save_cooldowns(cooldown_file, cooldowns)
            print(f"{Fore.YELLOW}Stopped.{Style.RESET_ALL}")
            break
