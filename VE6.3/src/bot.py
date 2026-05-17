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
from functools import lru_cache
from pathlib import Path
from typing import Any

import requests
from colorama import Fore, Style

from src.fees import apply_fee, parse_formula
from src.connectors import load_pairs, get_latest_pairs_file


# Fee-rate failures must be treated as permanent so the pair is logged/skipped.
class FeeRateError(RuntimeError):
    pass


# ── Sound notifications ────────────────────────────────────────────────────────

_SRC_DIR = Path(__file__).parent
_sounds_enabled: bool = True


def _play_sound(filename: str) -> None:
    """Play a .wav from the src/ directory non-blocking. Silently no-ops if missing or disabled."""
    if not _sounds_enabled:
        return
    import threading
    path = _SRC_DIR / filename
    if not path.exists():
        return
    try:
        import winsound
        threading.Thread(
            target=winsound.PlaySound,
            args=(str(path), winsound.SND_FILENAME | winsound.SND_ASYNC),
            daemon=True,
        ).start()
    except Exception:
        pass


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

    if isinstance(exc, FeeRateError):
        return False

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
        # Handle datetime/date objects directly
        if hasattr(resolution_date, "year") and hasattr(resolution_date, "month") and hasattr(resolution_date, "day"):
            dt = resolution_date
            # Ensure it's a datetime with timezone
            if not isinstance(dt, datetime):
                dt = datetime(dt.year, dt.month, dt.day, tzinfo=timezone.utc)
            elif dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
        else:
            # Handle strings
            s = str(resolution_date).strip()
            if not s:
                return 365.0
            # Some APIs return '2025-12-31' or ISO8601
            try:
                dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
            except ValueError:
                # Try simple date parse YYYY-MM-DD
                parts = s.split("T")[0].split("-")
                if len(parts) == 3:
                    dt = datetime(int(parts[0]), int(parts[1]), int(parts[2]), tzinfo=timezone.utc) + timedelta(days=1)
                else:
                    return 365.0

        if dt.hour == 0 and dt.minute == 0 and dt.second == 0:
            dt = dt + timedelta(days=1)

        now = datetime.now(timezone.utc)
        diff = (dt - now).total_seconds() / 86400.0
        return max(0.01, diff)

    except (ValueError, TypeError, AttributeError, IndexError):
        return 365.0


def _resolution_has_passed(resolution_date: Any) -> bool:
    """Return True if resolution_date is set and is now in the past."""
    if not resolution_date:
        return False
    s = str(resolution_date).strip()
    if not s:
        return False
    try:
        try:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
        except ValueError:
            parts = s.split("T")[0].split("-")
            if len(parts) == 3:
                dt = datetime(int(parts[0]), int(parts[1]), int(parts[2]), tzinfo=timezone.utc) + timedelta(days=1)
            else:
                return False
        if dt.hour == 0 and dt.minute == 0 and dt.second == 0:
            dt = dt + timedelta(days=1)
        return datetime.now(timezone.utc) >= dt
    except Exception:
        return False


def _kalshi_fee_rate_for_ticker(ticker: str) -> float:
    """Return the Kalshi taker fee rate for a given ticker.

    Per fee schedule: general markets use 0.07; S&P500 (INX*) and Nasdaq-100
    (NASDAQ100*) markets use 0.035.
    """
    t = str(ticker or "").strip().upper()
    if t.startswith("INX") or t.startswith("NASDAQ100"):
        return 0.035
    return 0.07


@lru_cache(maxsize=8)
def _kalshi_fee_fn_for_rate(rate: float):
    return parse_formula(f"p * (1 - p) * {rate} * c")


@lru_cache(maxsize=16)
def _poly_fee_fn_for_rate(rate: float):
    return parse_formula(f"p * (1 - p) * {rate} * c")


_fee_rate_cache: dict[str, float] = {}


def _resolve_poly_fee_rate(poly, token_ids: list[str], market: dict | None = None) -> float:
    """Resolve a Polymarket taker fee rate via the fee-rate endpoint.

    Raises if the fee rate cannot be determined, or if token-level rates disagree.
    Fee rates are stable for the life of a market and cached in memory after first fetch.
    """
    if market is not None and market.get("feesEnabled") is False:
        return 0.0
    token_ids = [str(t).strip() for t in token_ids if str(t).strip()]
    if not token_ids:
        raise FeeRateError("Polymarket fee-rate lookup failed: missing token IDs")
    uncached = [tid for tid in token_ids if tid not in _fee_rate_cache]
    if uncached:
        try:
            with ThreadPoolExecutor(max_workers=len(uncached)) as pool:
                fetched = list(pool.map(poly.get_fee_rate, uncached))
            for tid, rate in zip(uncached, fetched):
                _fee_rate_cache[tid] = float(rate)
        except Exception as exc:
            if _is_transient_error(exc):
                raise
            raise FeeRateError(f"fee-rate lookup failed: {exc}") from exc
    rates = [_fee_rate_cache[tid] for tid in token_ids]
    base = rates[0]
    for r in rates[1:]:
        if abs(r - base) > 1e-9:
            raise FeeRateError(f"Polymarket fee-rate mismatch across tokens: {rates}")
    return base


def _require_poly_fee_rate(rate: Any, label: str) -> float:
    if rate is None:
        raise FeeRateError(f"{label}: missing Polymarket fee rate (cannot calculate fees)")
    return float(rate)


def _normalize_levels(raw: list[Any], descending: bool = False) -> list[dict[str, Any]]:
    """Merge duplicate price levels and sort by price."""
    by_price: dict[float, int] = {}
    for level in raw:
        if not isinstance(level, dict):
            continue
        try:
            p = round(float(level["price"]), 6)
            s = int(float(level["size"]))
        except (KeyError, TypeError, ValueError):
            continue
        if s > 0 and 0.0 < p <= 1.0:
            by_price[p] = by_price.get(p, 0) + s
    return [{"price": p, "size": by_price[p]} for p in sorted(by_price, reverse=descending)]


def _combine_leg_levels(leg_levels: list[list[dict[str, Any]]]) -> list[dict[str, Any]]:
    """Combine multiple per-leg price levels into a synthetic composite level list.

    Each composite level price is the sum of the current leg prices, and the size
    is the minimum remaining size across legs. Assumes each leg list is already
    sorted (asks: ascending; bids: descending).
    """
    if not leg_levels or any(not leg for leg in leg_levels):
        return []

    indices = [0 for _ in leg_levels]
    remaining = []
    for leg in leg_levels:
        remaining.append(int(leg[0].get("size", 0)))

    combined: list[dict[str, Any]] = []
    while True:
        if any(idx >= len(leg) for idx, leg in zip(indices, leg_levels)):
            break
        prices = [float(leg_levels[i][indices[i]]["price"]) for i in range(len(leg_levels))]
        size = min(remaining)
        if size <= 0:
            # Advance any exhausted leg(s)
            for i in range(len(leg_levels)):
                while indices[i] < len(leg_levels[i]) and remaining[i] <= 0:
                    indices[i] += 1
                    if indices[i] < len(leg_levels[i]):
                        remaining[i] = int(leg_levels[i][indices[i]].get("size", 0))
            continue
        combined.append({
            "price": round(sum(prices), 6),
            "size": size,
            "leg_prices": [round(p, 6) for p in prices],
        })
        for i in range(len(leg_levels)):
            remaining[i] -= size
            while indices[i] < len(leg_levels[i]) and remaining[i] <= 0:
                indices[i] += 1
                if indices[i] < len(leg_levels[i]):
                    remaining[i] = int(leg_levels[i][indices[i]].get("size", 0))

    return combined


def _normalize_outcome_label(value: Any) -> str:
    """Normalize outcome labels for matching (case + alnum-only)."""
    text = str(value or "").strip().lower()
    cleaned = []
    for ch in text:
        cleaned.append(ch if ch.isalnum() else " ")
    return " ".join("".join(cleaned).split())


def _find_outcome_index(outcomes: list[str], target: str) -> int | None:
    norm_target = _normalize_outcome_label(target)
    if not norm_target:
        return None
    for idx, outcome in enumerate(outcomes):
        if _normalize_outcome_label(outcome) == norm_target:
            return idx
    return None


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

def _get_json_path(data: Any, path: str) -> Any:
    """Resolve a dotted JSON path like 'balances.available' or 'items[0].cash'."""
    cur: Any = data
    for part in str(path or "").split("."):
        if part == "":
            continue
        key = part
        idx = None
        if "[" in part and part.endswith("]"):
            key, idx_raw = part[:-1].split("[", 1)
            idx = int(idx_raw) if idx_raw.isdigit() else None
        if key:
            if not isinstance(cur, dict) or key not in cur:
                return None
            cur = cur[key]
        if idx is not None:
            if not isinstance(cur, list) or idx >= len(cur):
                return None
            cur = cur[idx]
    return cur


def _fetch_holdings_balance(source_cfg: dict[str, Any]) -> float | None:
    url = str(source_cfg.get("url", "")).strip()
    if not url:
        return None
    method = str(source_cfg.get("method", "GET")).upper()
    headers = source_cfg.get("headers", {}) or {}
    params = source_cfg.get("params", {}) or {}
    body = source_cfg.get("body", {}) or {}
    timeout = float(source_cfg.get("timeout_seconds", 10))
    try:
        res = requests.request(
            method,
            url,
            headers=headers,
            params=params if method == "GET" else None,
            json=body if method != "GET" else None,
            timeout=timeout,
        )
        res.raise_for_status()
        payload = res.json()
        value = _get_json_path(payload, source_cfg.get("json_path", "available_cash"))
        if value is None:
            raise RuntimeError(f"holdings json_path not found: {source_cfg.get('json_path')}")
        return float(value)
    except Exception as exc:
        raise RuntimeError(f"holdings fetch failed: {exc}") from exc


def _live_creds_present(cfg: dict[str, Any]) -> bool:
    kalshi = cfg.get("kalshi", {}) or {}
    poly = cfg.get("polymarket", {}) or {}
    return bool(kalshi.get("api_key") and kalshi.get("private_key_base64") and poly.get("private_key"))


def _holdings_configured(cfg: dict[str, Any]) -> bool:
    holdings = cfg.get("holdings", {}) or {}
    kalshi = holdings.get("kalshi", {}) or {}
    poly = holdings.get("polymarket", {}) or {}
    return bool(kalshi.get("url") and poly.get("url"))


def _resolve_execution_mode(cfg: dict[str, Any]) -> str:
    mode = str(cfg.get("mode", "paper")).lower()
    if mode != "live":
        return mode

    holdings = cfg.get("holdings", {}) or {}
    fallback = bool(cfg.get("fallback_to_paper", holdings.get("fallback_to_paper", True)))
    holdings_mode = str(holdings.get("mode", "auto")).lower()

    if not _live_creds_present(cfg):
        if not fallback:
            import os, signal as _signal
            print(
                f"\n  {Fore.RED}FATAL: mode=live, credentials missing, fallback_to_paper=false{Style.RESET_ALL}",
                file=sys.stderr,
            )
            os.kill(os.getpid(), _signal.SIGTERM)
        print(f"  {Fore.YELLOW}! Live credentials missing - falling back to paper mode{Style.RESET_ALL}")
        return "paper"

    if holdings_mode != "off" and not _holdings_configured(cfg):
        if fallback:
            print(f"  {Fore.YELLOW}! Holdings endpoints missing - falling back to paper mode{Style.RESET_ALL}")
            return "paper"
    return "live"


def _estimate_required_cash(opp: dict[str, Any], cfg: dict[str, Any]) -> tuple[float, float]:
    """Return (kalshi_cash_needed, polymarket_cash_needed)."""
    contracts = opp["contracts"]
    k_spend = float(opp.get("k_spend", opp["k_price"] * contracts))
    p_spend = float(opp.get("p_spend", opp["p_price"] * contracts))

    fee_cfg = cfg["fees"]
    k_rup = bool(fee_cfg["kalshi"].get("round_up_to_cent", True))
    k_rate = _kalshi_fee_rate_for_ticker(opp.get("kalshi_ticker", ""))
    k_fee_fn = _kalshi_fee_fn_for_rate(k_rate)
    p_rate = _require_poly_fee_rate(opp.get("poly_fee_rate"), opp.get("pair_id", "pair"))
    p_fee_fn = _poly_fee_fn_for_rate(p_rate)

    k_avg = k_spend / contracts if contracts else 0.0
    p_avg = p_spend / contracts if contracts else 0.0
    k_fee = apply_fee(k_fee_fn, k_avg, contracts, k_rup)
    p_fee = apply_fee(p_fee_fn, p_avg, contracts, False, round_decimals=5)
    return k_spend + k_fee, p_spend + p_fee


def _check_holdings(opp: dict[str, Any], cfg: dict[str, Any]) -> bool:
    holdings = cfg.get("holdings", {}) or {}
    if str(holdings.get("mode", "auto")).lower() == "off":
        return True

    try:
        k_needed, p_needed = _estimate_required_cash(opp, cfg)
    except FeeRateError as exc:
        failed_log = cfg.get("failed_log", "failed_pairs.json")
        _log_failed_pair(
            {
                "pair_id": opp.get("pair_id", ""),
                "kalshi_ticker": opp.get("kalshi_ticker", ""),
                "title": opp.get("title", ""),
            },
            f"holdings fee error: {exc}",
            failed_log,
        )
        print(
            f"  {Fore.YELLOW}! {opp.get('pair_id', '')}: {exc}  "
            f"â†’ logged to failed pairs{Style.RESET_ALL}",
            file=sys.stderr,
        )
        return False

    kalshi_cfg = holdings.get("kalshi", {}) or {}
    poly_cfg = holdings.get("polymarket", {}) or {}

    try:
        k_balance = _fetch_holdings_balance(kalshi_cfg)
        p_balance = _fetch_holdings_balance(poly_cfg)
    except Exception as exc:
        print(f"  {Fore.YELLOW}! Holdings check failed - {exc}{Style.RESET_ALL}")
        return False

    if k_balance is None or p_balance is None:
        print(f"  {Fore.YELLOW}! Holdings unavailable - skipping live trade{Style.RESET_ALL}")
        return False

    if k_balance < k_needed:
        print(
            f"  {Fore.YELLOW}! Insufficient Kalshi cash: need ${k_needed:.2f}, have ${k_balance:.2f}{Style.RESET_ALL}"
        )
        return False
    if p_balance < p_needed:
        print(
            f"  {Fore.YELLOW}! Insufficient Polymarket cash: need ${p_needed:.2f}, have ${p_balance:.2f}{Style.RESET_ALL}"
        )
        return False
    return True


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
    p_leg_spend: list[float] | None = None
    p_leg_last: list[float] | None = None

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
        p_level = p_levels[p_idx]
        np_ = float(p_level["price"])
        leg_prices = p_level.get("leg_prices")
        nc = contracts + 1
        avg_k = (k_spend + nk) / nc
        avg_p = (p_spend + np_) / nc

        # Recompute fees for the candidate position
        next_kf = apply_fee(kalshi_fee_fn, avg_k, nc, kalshi_round_up)
        next_pf = apply_fee(poly_fee_fn, avg_p, nc, False, round_decimals=5)
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

        if isinstance(leg_prices, list) and leg_prices:
            if p_leg_spend is None:
                p_leg_spend = [0.0 for _ in leg_prices]
            for i, lp in enumerate(leg_prices):
                p_leg_spend[i] += float(lp)
            p_leg_last = [float(lp) for lp in leg_prices]

        # Record slippage: one entry per distinct price-level combination.
        # If prices unchanged from the last entry, update it in-place so each
        # entry reflects the cumulative state at the END of that price level.
        edge_d = contracts * exit_target - cur_kp
        arr_now = (edge_d / cur_kp * 365.0 / days) if cur_kp > 0 and days > 0 else 0.0
        if slippage and slippage[-1]["k_price"] == nk and slippage[-1]["p_price"] == np_:
            slippage[-1]["contracts"] = contracts
            slippage[-1]["total_profit"] = round(edge_d, 4)
            slippage[-1]["arr"] = round(arr_now, 4)
            if p_leg_last is not None:
                slippage[-1]["p_leg_prices"] = [round(v, 6) for v in p_leg_last]
        else:
            entry = {
                "k_price": round(nk, 6),
                "p_price": round(np_, 6),
                "contracts": contracts,
                "total_profit": round(edge_d, 4),
                "arr": round(arr_now, 4),
            }
            if p_leg_last is not None:
                entry["p_leg_prices"] = [round(v, 6) for v in p_leg_last]
            slippage.append(entry)

    final_kp = cur_kp

    # V6: no exit fees — positions are held to expiry, settlement pays $1/contract automatically.
    final_edge_pct = (contracts * exit_target - final_kp) / final_kp if final_kp > 0 else 0.0
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

    p_leg_prices = []
    if p_leg_spend is not None and contracts > 0:
        p_leg_prices = [round(v / contracts, 6) for v in p_leg_spend]

    return {
        "contracts": contracts,
        "k_spend": k_spend,
        "p_spend": p_spend,
        "k_price": k_price,
        "p_price": p_price,
        "p_leg_spend": p_leg_spend or [],
        "p_leg_prices": p_leg_prices,
        "kp_cost": final_kp,
        "arr": final_arr,
        "edge_pct": final_edge_pct,
        "total_fee": cur_kf + cur_pf,
        "exit_fee_estimate": 0.0,
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
    p_leg_spend: list[float] | None = None
    p_leg_last: list[float] | None = None

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
        p_level = p_levels[p_idx]
        np_ = float(p_level["price"])
        leg_prices = p_level.get("leg_prices")

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

        if isinstance(leg_prices, list) and leg_prices:
            if p_leg_spend is None:
                p_leg_spend = [0.0 for _ in leg_prices]
            for i, lp in enumerate(leg_prices):
                p_leg_spend[i] += float(lp)
            p_leg_last = [float(lp) for lp in leg_prices]

        if slippage and slippage[-1]["k_price"] == nk and slippage[-1]["p_price"] == np_:
            slippage[-1]["contracts"] = contracts
        else:
            entry = {
                "k_price": round(nk, 6),
                "p_price": round(np_, 6),
                "contracts": contracts,
            }
            if p_leg_last is not None:
                entry["p_leg_prices"] = [round(v, 6) for v in p_leg_last]
            slippage.append(entry)

        if contracts >= target_contracts:
            stop_reason = "target_reached"
            break

    p_leg_prices = []
    if p_leg_spend is not None and contracts > 0:
        p_leg_prices = [round(v / contracts, 6) for v in p_leg_spend]

    return {
        "contracts": contracts,
        "k_price": k_price,
        "p_price": p_price,
        "k_spend": k_spend,
        "p_spend": p_spend,
        "p_leg_spend": p_leg_spend or [],
        "p_leg_prices": p_leg_prices,
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
    """Evaluate all arbitrage strategies for one pair and return the best by $ edge.

    Up to 4 strategies when kalshi_quotes_b is present (dual-ticker pairs):
        BUY_KY_BUY_PN  (T1) - Buy Kalshi T1 YES + Buy Polymarket T2 YES
        BUY_KN_BUY_PY  (T1) - Buy Kalshi T1 NO  + Buy Polymarket T1 YES
        BUY_KY_BUY_PN  (T2) - Buy Kalshi T2 YES + Buy Polymarket T1 YES
        BUY_KN_BUY_PY  (T2) - Buy Kalshi T2 NO  + Buy Polymarket T2 YES

    Returns a list with at most one opportunity dict (the highest $ edge), or
    empty if no arb found.
    """
    max_contracts = int(cfg["max_contracts"])
    days = _days_to_resolution(pair.get("resolution_date", ""))
    exit_target = 1.0  # V6 holds to expiry — settlement always pays $1/contract
    min_edge_pct = float(cfg.get("min_edge_pct", 0.001))

    fee_cfg = cfg["fees"]
    k_round_up = bool(fee_cfg["kalshi"].get("round_up_to_cent", True))
    k_rate = _kalshi_fee_rate_for_ticker(pair.get("kalshi_ticker", ""))
    k_fee_fn = _kalshi_fee_fn_for_rate(k_rate)
    pair_poly_rate = _require_poly_fee_rate(pair.get("poly_fee_rate"), pair.get("pair_id", "pair"))
    p_fee_fn = _poly_fee_fn_for_rate(pair_poly_rate)

    k_depth = kalshi_quotes["depth"]
    poly_type = poly_quotes.get("type", "binary")
    kalshi_url = pair.get("kalshi_url") or ""
    kalshi_event_url = kalshi_quotes.get("event_url") or ""

    # Second Kalshi ticker quotes (present when CSV has kalshi_market_id_b)
    kalshi_quotes_b = kalshi_quotes.get("kalshi_quotes_b", {})
    k_rate_b = _kalshi_fee_rate_for_ticker(pair.get("kalshi_ticker_b", ""))
    k_fee_fn_b = _kalshi_fee_fn_for_rate(k_rate_b)

    strategies: list[dict[str, Any]] = []
    yes_token_id = ""
    no_token_id = ""

    if poly_type == "multi":
        outcomes = [str(o) for o in poly_quotes.get("outcomes", [])]
        primary_outcome = poly_quotes.get("primary_outcome", "")
        primary_token_id = poly_quotes.get("primary_token_id", "")
        tokens = poly_quotes.get("tokens", {})
        complement_token_ids = poly_quotes.get("complement_token_ids", [])
        if not primary_token_id or primary_token_id not in tokens:
            raise RuntimeError("Polymarket primary token not resolved for multi-outcome market")
        if not complement_token_ids:
            raise RuntimeError("Polymarket complement token list is empty for multi-outcome market")

        yes_token_id = primary_token_id
        no_token_id = ""

        primary_levels = _normalize_levels(tokens[primary_token_id].get("asks", []))
        complement_levels = [
            _normalize_levels(tokens[token_id].get("asks", []))
            for token_id in complement_token_ids
            if token_id in tokens
        ]
        combined_complement_levels = _combine_leg_levels(complement_levels)
        complement_leg_price_hints = [tokens[token_id]["best_ask"] for token_id in complement_token_ids]

        strategies = [
            {
                "strategy": "BUY_KY_BUY_PN",
                "k_side": "yes",
                "p_side": "no",
                "p_token_ids": complement_token_ids,
                "p_token_id": complement_token_ids[0],
                "k_levels": _normalize_levels(k_depth.get("buy_yes", [])),
                "p_levels": combined_complement_levels,
                "k_price_hint": float(kalshi_quotes["yes_ask"]),
                "p_price_hint": float(poly_quotes.get("complement_best_ask", 1.0)),
                "p_leg_prices_hint": complement_leg_price_hints,
                "_kq": kalshi_quotes,
                "_k_fee_fn": k_fee_fn,
                "_kalshi_ticker": pair.get("kalshi_ticker", ""),
            },
            {
                "strategy": "BUY_KN_BUY_PY",
                "k_side": "no",
                "p_side": "yes",
                "p_token_ids": [primary_token_id],
                "p_token_id": primary_token_id,
                "k_levels": _normalize_levels(k_depth.get("buy_no", [])),
                "p_levels": primary_levels,
                "k_price_hint": float(kalshi_quotes["no_ask"]),
                "p_price_hint": float(poly_quotes.get("primary_best_ask", 1.0)),
                "p_leg_prices_hint": [float(poly_quotes.get("primary_best_ask", 1.0))],
                "_kq": kalshi_quotes,
                "_k_fee_fn": k_fee_fn,
                "_kalshi_ticker": pair.get("kalshi_ticker", ""),
            },
        ]
    else:
        p_depth = poly_quotes["depth"]
        yes_token_id = poly_quotes["yes_token_id"]
        no_token_id = poly_quotes["no_token_id"]
        strategies = [
            {
                "strategy": "BUY_KY_BUY_PN",
                "k_side": "yes",
                "p_side": "no",
                "p_token_ids": [no_token_id],
                "p_token_id": no_token_id,
                "k_levels": _normalize_levels(k_depth.get("buy_yes", [])),
                "p_levels": _normalize_levels(p_depth.get("no_asks", [])),
                "k_price_hint": float(kalshi_quotes["yes_ask"]),
                "p_price_hint": float(poly_quotes["no_ask"]),
                "_kq": kalshi_quotes,
                "_k_fee_fn": k_fee_fn,
                "_kalshi_ticker": pair.get("kalshi_ticker", ""),
            },
            {
                "strategy": "BUY_KN_BUY_PY",
                "k_side": "no",
                "p_side": "yes",
                "p_token_ids": [yes_token_id],
                "p_token_id": yes_token_id,
                "k_levels": _normalize_levels(k_depth.get("buy_no", [])),
                "p_levels": _normalize_levels(p_depth.get("yes_asks", [])),
                "k_price_hint": float(kalshi_quotes["no_ask"]),
                "p_price_hint": float(poly_quotes["yes_ask"]),
                "_kq": kalshi_quotes,
                "_k_fee_fn": k_fee_fn,
                "_kalshi_ticker": pair.get("kalshi_ticker", ""),
            },
        ]

        # Strategies 3 & 4: use second Kalshi ticker if available.
        # For ticker B (opponent ticker), Poly sides are SWAPPED vs ticker A:
        #   K_B YES (opponent wins) hedges with Poly YES (primary/complement token pays if primary loses)
        #   K_B NO  (primary wins)  hedges with Poly NO  (opponent token pays if opponent loses)
        if kalshi_quotes_b and kalshi_quotes_b.get("depth"):
            k_depth_b = kalshi_quotes_b["depth"]
            strategies += [
                {
                    "strategy": "BUY_KBY_BUY_PY",
                    "k_side": "yes",
                    "p_side": "yes",
                    "p_token_ids": [yes_token_id],
                    "p_token_id": yes_token_id,
                    "k_levels": _normalize_levels(k_depth_b.get("buy_yes", [])),
                    "p_levels": _normalize_levels(p_depth.get("yes_asks", [])),
                    "k_price_hint": float(kalshi_quotes_b["yes_ask"]),
                    "p_price_hint": float(poly_quotes["yes_ask"]),
                    "_kq": kalshi_quotes_b,
                    "_k_fee_fn": k_fee_fn_b,
                    "_kalshi_ticker": pair.get("kalshi_ticker_b", ""),
                },
                {
                    "strategy": "BUY_KBN_BUY_PN",
                    "k_side": "no",
                    "p_side": "no",
                    "p_token_ids": [no_token_id],
                    "p_token_id": no_token_id,
                    "k_levels": _normalize_levels(k_depth_b.get("buy_no", [])),
                    "p_levels": _normalize_levels(p_depth.get("no_asks", [])),
                    "k_price_hint": float(kalshi_quotes_b["no_ask"]),
                    "p_price_hint": float(poly_quotes["no_ask"]),
                    "_kq": kalshi_quotes_b,
                    "_k_fee_fn": k_fee_fn_b,
                    "_kalshi_ticker": pair.get("kalshi_ticker_b", ""),
                },
            ]

    results: list[dict[str, Any]] = []
    same_side_warned = False
    for strat in strategies:
        k_levels = strat["k_levels"]
        p_levels = strat["p_levels"]
        strat_kq = strat["_kq"]
        strat_k_fee_fn = strat["_k_fee_fn"]
        strat_kalshi_ticker = strat["_kalshi_ticker"]

        # Skip if either side has no liquidity
        if not k_levels or not p_levels:
            continue

        walk = _walk_depth(
            k_levels, p_levels, days, max_contracts,
            strat_k_fee_fn, p_fee_fn, k_round_up, exit_target,
        )

        c = walk["contracts"]

        if c == 0:
            continue

        edge_dollar = c * exit_target - walk["kp_cost"]
        if edge_dollar <= 0 or walk["edge_pct"] < min_edge_pct:
            continue

        top_of_book_sum = walk["k_price"] + walk["p_price"]
        if top_of_book_sum < 0.80:
            print(
                f"  [WARN] {pair['pair_id']} {strat['strategy']} ({strat_kalshi_ticker}): "
                f"top_of_book={top_of_book_sum:.3f} < 0.80 — "
                f"likely mismatched (same-side) pair, skipping",
                file=sys.stderr,
            )
            same_side_warned = True
            continue
        _max_arb_gap = max(
            (1.0 - (s["k_price"] + s["p_price"]) for s in walk.get("slippage", [])),
            default=0.0,
        )
        if _max_arb_gap > 0.15:
            print(
                f"  [WARN] {pair['pair_id']} {strat['strategy']} ({strat_kalshi_ticker}): "
                f"max arb gap={_max_arb_gap:.3f} > 0.15 — "
                f"prices too good to be true, flagging as bad",
                file=sys.stderr,
            )
            continue
        k_price_out = walk["k_price"]
        p_price_out = walk["p_price"]
        kp_cost_out = walk["kp_cost"]
        edge_pct_out = walk["edge_pct"]
        arr_out      = walk["arr"]
        total_fee_out = walk["total_fee"]

        results.append({
                "pair_id": pair["pair_id"],
                "title": pair.get("title", pair["pair_id"]),
                "poly_market_title": pair.get("poly_market_question", ""),
                "kalshi_market_title": strat_kq.get("kalshi_title", ""),
                "kalshi_ticker": strat_kalshi_ticker,
                "polymarket_slug": pair.get("polymarket_market_slug", ""),
                "kalshi_url": strat_kq.get("kalshi_url") or kalshi_url,
                "kalshi_event_url": strat_kq.get("event_url") or kalshi_event_url,
                "polymarket_url": pair.get("polymarket_url", ""),
                "poly_event_url": pair.get("poly_event_url", ""),
                "strategy": strat["strategy"],
                "k_side": strat["k_side"],
                "p_side": strat["p_side"],
                "p_token_ids": strat.get("p_token_ids", []),
                "p_token_id": strat.get("p_token_id", ""),
                "yes_token_id": yes_token_id,
                "no_token_id": no_token_id,
                "contracts": c,
                "k_price": k_price_out,
                "p_price": p_price_out,
                "k_spend": walk.get("k_spend", 0.0),
                "p_spend": walk.get("p_spend", 0.0),
                "p_leg_prices": walk.get("p_leg_prices", []),
                "p_leg_spend": walk.get("p_leg_spend", []),
                "kp_cost": kp_cost_out,
                "edge_dollar": round(edge_dollar, 4),
                "edge_pct": edge_pct_out,
                "arr": arr_out,
                "total_fee": total_fee_out,
                "days": days,
                "slippage": walk.get("slippage", []),
                "remaining": walk.get("remaining", {}),
                "poly_fee_rate": pair.get("poly_fee_rate"),
                "resolution_date": str(pair.get("resolution_date", "")),
            })

    if not results:
        if same_side_warned:
            return [{"_bad_pair": True, "strategy": "SAME_SIDE"}]
        return results
    best = max(results, key=lambda r: r["edge_dollar"])
    return [best]


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


def _resolve_kalshi_url(opp: dict[str, Any]) -> str:
    ticker = str(opp.get("kalshi_ticker") or "").strip()
    url = str(opp.get("kalshi_url") or "").strip()
    event_url = str(opp.get("kalshi_event_url") or "").strip()
    base_url = f"{_KALSHI_BASE_URL}/{ticker}" if ticker else ""
    # Prefer the live event_url from the API — it is the most specific (3-segment)
    # and always more accurate than the Excel-stored kalshi_url.
    if event_url:
        return event_url
    if url and base_url and url.lower() == base_url.lower():
        url = ""
    if url:
        return url
    return base_url


def _resolve_polymarket_url(opp: dict[str, Any]) -> str:
    for key in ("poly_event_url", "polymarket_url", "poly_url"):
        url = str(opp.get(key) or "").strip()
        if url:
            return url
    slug = str(opp.get("polymarket_slug") or "").strip()
    return f"{_POLY_BASE_URL}/{slug}" if slug else ""


def _write_opportunity_log(opp: dict[str, Any], log_path: str) -> None:
    """Append one opportunity (with market links) to the opportunity log."""
    k_url = _resolve_kalshi_url(opp)
    p_url = _resolve_polymarket_url(opp)
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
        "kalshi_url":      k_url,
        "polymarket_url":  p_url,
        "p_token_ids":     opp.get("p_token_ids", []),
        "p_leg_prices":    opp.get("p_leg_prices", []),
        "p_leg_spend":     opp.get("p_leg_spend", []),
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
        if "p_leg_prices" in s:
            fills[-1]["p_leg_prices"] = s.get("p_leg_prices", [])
    return fills


def _build_log_entry(opp: dict[str, Any], mode: str, **overrides) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    entry: dict[str, Any] = {
        "title": opp["title"],
        "poly_market_title": opp.get("poly_market_title", ""),
        "kalshi_market_title": opp.get("kalshi_market_title", ""),
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
        "resolution_date": str(opp.get("resolution_date", "")),
        "kalshi_token": opp["kalshi_ticker"],
        "polymarket_token": opp["p_token_id"],
        "p_token_ids": opp.get("p_token_ids", []),
        "p_leg_prices": opp.get("p_leg_prices", []),
        "p_leg_spend": opp.get("p_leg_spend", []),
    }
    entry.update(overrides)
    return entry


def execute_paper(opp: dict[str, Any], log_path: str) -> dict[str, Any]:
    """Simulate a trade (no real orders) and append to the trade log."""
    _play_sound("enter.wav")
    trade_num = _next_trade_number(log_path)
    entry = _build_log_entry(opp, "paper", trade_number=trade_num)
    _write_trade_log(entry, log_path)
    return entry


def execute_live(opp: dict[str, Any], kalshi, poly, log_path: str) -> dict[str, Any]:
    """Place orders sequentially: Kalshi IOC first, then Polymarket FOK for exactly what Kalshi filled.

    Kalshi uses IOC — fills up to max contracts at best available price, exchange cancels remainder.
    Polymarket uses FOK — must fill all of the Kalshi fill count or the order cancels entirely.

    Outcomes:
      - Both filled    → fully hedged entry
      - Kalshi only    → legs_filled="kalshi_only" (Polymarket FOK failed); held to expiry
      - Kalshi failed  → legs_filled="none"; nothing recorded
    """
    trade_num = _next_trade_number(log_path)
    # Millisecond timestamp makes client_order_id unique across retry cycles.
    # Without it, trade_num resets to T00001 on each cycle when prior attempts
    # failed (trade counter only advances on completed trades), so Kalshi sees
    # the same idempotency key and returns 409 Conflict on every retry.
    client_id = f"{trade_num}:{opp['pair_id']}:{opp['strategy']}:{int(time.time() * 1000)}"
    requested = opp["contracts"]

    p_token_ids = opp.get("p_token_ids") or [opp.get("p_token_id", "")]
    p_leg_prices = opp.get("p_leg_prices") or []
    if not p_leg_prices:
        p_leg_prices = [opp["p_price"] for _ in p_token_ids]
    if len(p_leg_prices) < len(p_token_ids):
        p_leg_prices += [opp["p_price"] for _ in range(len(p_token_ids) - len(p_leg_prices))]

    # Pre-check: abort before Kalshi fires if Polymarket notional would be below $1 minimum.
    # Polymarket rejects orders where price × contracts < $1 regardless of order type.
    for _pp in p_leg_prices:
        if _pp * requested < 1.0:
            print(
                f"\n  {'='*55}\n"
                f"  {Fore.YELLOW}!! SKIPPED — Polymarket notional ${_pp * requested:.2f} "
                f"below $1 minimum (price={_pp:.4f} × {requested}c){Style.RESET_ALL}\n"
                f"  {'='*55}\n",
                file=sys.stderr,
            )
            return {"legs_filled": "none", "partial_fill": False, "trade_number": trade_num}

    # ── Step 1: Kalshi IOC market order ───────────────────────────────────────
    k_filled = 0
    k_actual_price = 0.0
    k_actual_cost = 0.0
    try:
        k_resp = kalshi.place_order(
            ticker=opp["kalshi_ticker"],
            side=opp["k_side"],
            contracts=requested,
            price=opp["k_price"],
            client_order_id=f"{client_id}:k",
        )
        k_order = k_resp.get("order", {})
        fill_fp = k_order.get("fill_count_fp", "0") or "0"
        k_filled = int(float(fill_fp))

        # Actual cost and average fill price from exchange response
        k_actual_cost = float(k_order.get("taker_fill_cost_dollars", 0.0) or 0.0)
        k_actual_price = round(k_actual_cost / k_filled, 6) if k_filled > 0 else 0.0

        if k_filled <= 0:
            raise RuntimeError(
                f"Kalshi IOC order filled 0 contracts (status={k_order.get('status','?')})"
            )
    except Exception as exc:
        print(
            f"\n  {'='*55}\n"
            f"  {Fore.RED}!! KALSHI LEG FAILED — no position opened{Style.RESET_ALL}\n"
            f"  Error: {exc}\n"
            f"  {'='*55}\n",
            file=sys.stderr,
        )
        # Nothing filled — return immediately. Step 2 (Polymarket) and
        # Step 3 (_write_trade_log / open_positions) are never reached.
        # Any "Traded Xc" output visible in the same session came from a prior
        # cycle's genuine fill, not from this failure path.
        return {"legs_filled": "none", "partial_fill": True, "trade_number": trade_num}

    # ── Step 2: Polymarket FAK market order — up to k_filled contracts ───────
    p_filled = 0
    p_actual_price = 0.0
    p_actual_cost = 0.0
    poly_exc: Exception | None = None
    try:
        for token_id, price in zip(p_token_ids, p_leg_prices):
            if not token_id:
                raise RuntimeError("Missing Polymarket token_id for multi-leg order")
            p_resp = poly.place_order(
                token_id=token_id,
                side="buy",
                size=k_filled,
            )
            # py_clob_client_v2 returns takingAmount/makingAmount as decimal dollar
            # strings (e.g. "4.885"), NOT as 6-decimal micro-USDC integers.
            # takingAmount for BUY = shares received (count). makingAmount = USDC spent.
            taking = p_resp.get("takingAmount", "0") or "0"
            making = p_resp.get("makingAmount", "0") or "0"
            leg_filled = float(taking)
            leg_cost = float(making)
            p_filled += leg_filled
            p_actual_cost += leg_cost
        p_actual_price = round(p_actual_cost / p_filled, 6) if p_filled > 0 else 0.0
    except Exception as exc:
        import traceback
        print("=" * 70, file=sys.stderr)
        print("FULL POLYMARKET ORDER TRACEBACK:", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        print(f"order_args: token_id={token_id}, price={price}, size={k_filled}", file=sys.stderr)
        print("=" * 70, file=sys.stderr)
        poly_exc = exc

    if poly_exc:
        print(
            f"\n  {'='*55}\n"
            f"  {Fore.RED}!! PARTIAL FILL — Kalshi open ({k_filled}c), Polymarket failed{Style.RESET_ALL}\n"
            f"  Ticker: {opp.get('kalshi_ticker','')} | Error: {poly_exc}\n"
            f"  Position held to expiry as single-leg trade.\n"
            f"  {'='*55}\n",
            file=sys.stderr,
        )
        legs_filled = "kalshi_only"
        p_filled = 0
        p_actual_cost = 0.0
    else:
        if p_filled < k_filled:
            legs_filled = "mismatch"
            print(
                f"  {Fore.YELLOW}! MISMATCH — Kalshi {k_filled}c / Polymarket {p_filled}c "
                f"({k_filled - p_filled}c unhedged on Kalshi){Style.RESET_ALL}",
                file=sys.stderr,
            )
        else:
            legs_filled = "both"
        _play_sound("enter.wav")

    # ── Step 3: Build entry from actual fills only — no scan data ────────────
    now = datetime.now(timezone.utc)
    actual_total_cost = round(k_actual_cost + p_actual_cost, 4)
    partial = legs_filled != "both"

    # Profit from actual fills
    if not partial and k_filled == p_filled:
        total_profit = round(k_filled * 1.0 - actual_total_cost, 4)
        edge_pct = round((total_profit / actual_total_cost) * 100, 2) if actual_total_cost > 0 else 0.0
        profit_if_kalshi_wins = None
        profit_if_poly_wins = None
    else:
        total_profit = 0.0
        edge_pct = 0.0
        profit_if_kalshi_wins = round(k_filled * 1.0 - actual_total_cost, 4)
        profit_if_poly_wins = round(p_filled * 1.0 - actual_total_cost, 4)

    # Annualised return from actual edge and days to resolution
    try:
        res_dt = datetime.fromisoformat(str(opp.get("resolution_date", ""))).replace(tzinfo=timezone.utc)
        days_to_expiry = max((res_dt - now).days, 1)
        arr = round(edge_pct * 365 / days_to_expiry, 2)
    except Exception:
        arr = 0.0

    # Fills: actual contracts and weighted average price per leg
    actual_fills = []
    if k_filled > 0:
        actual_fills.append({"leg": "kalshi", "contracts": k_filled, "avg_price": k_actual_price})
    if p_filled > 0:
        actual_fills.append({"leg": "polymarket", "contracts": p_filled, "avg_price": p_actual_price})

    entry: dict[str, Any] = {
        "trade_number":       trade_num,
        "trade_phase":        "entry",
        "mode":               "live",
        "execution_date":     now.date().isoformat(),
        "timestamp":          now.isoformat(),
        # Market metadata (identifiers, not prices)
        "title":              opp.get("title", ""),
        "pair_id":            opp["pair_id"],
        "strategy":           opp["strategy"],
        "kalshi_token":       opp["kalshi_ticker"],
        "polymarket_token":   opp.get("p_token_id", ""),
        "p_token_ids":        opp.get("p_token_ids", []),
        "resolution_date":    str(opp.get("resolution_date", "")),
        # Actual fill data
        "fills":              actual_fills,
        "legs_filled":        legs_filled,
        "partial_fill":       partial,
        "k_contracts_filled": k_filled,
        "p_contracts_filled": p_filled,
        "k_actual_price":     k_actual_price,
        "p_actual_price":     p_actual_price,
        "k_actual_cost":      round(k_actual_cost, 4),
        "p_actual_cost":      round(p_actual_cost, 4),
        "total_cost":         actual_total_cost,
        "total_profit":       total_profit,
        "edge_pct":           edge_pct,
        "arr":                arr,
    }
    if profit_if_kalshi_wins is not None:
        entry["profit_if_kalshi_wins"] = profit_if_kalshi_wins
        entry["profit_if_poly_wins"] = profit_if_poly_wins

    _write_trade_log(entry, log_path)
    return entry


def _record_open_position(
    positions: dict[str, Any],
    opp: dict[str, Any],
    trade: dict[str, Any],
    position_file: str,
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
        "p_token_ids": opp.get("p_token_ids", []),
        "p_leg_prices": opp.get("p_leg_prices", []),
        "p_leg_spend": opp.get("p_leg_spend", []),
        "yes_token_id": opp.get("yes_token_id", ""),
        "no_token_id": opp.get("no_token_id", ""),
        "title": opp.get("title", opp["pair_id"]),
        "contracts": trade.get("total_contracts", opp["contracts"]),
        "k_contracts_filled": trade.get("k_contracts_filled", opp["contracts"]),
        "p_contracts_filled": trade.get("p_contracts_filled", opp["contracts"]),
        "k_actual_price": trade.get("k_actual_price", opp.get("k_price", 0.0)),
        "p_actual_price": trade.get("p_actual_price", opp.get("p_price", 0.0)),
        "k_actual_cost": trade.get("k_actual_cost", 0.0),
        "p_actual_cost": trade.get("p_actual_cost", 0.0),
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
        "poly_fee_rate": opp.get("poly_fee_rate"),
        "resolution_date": opp.get("resolution_date", ""),
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
        "p_token_ids": position.get("p_token_ids", []),
        "p_leg_prices": exit_walk.get("p_leg_prices", []),
        "p_leg_spend": exit_walk.get("p_leg_spend", []),
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
    shutdown: bool = False,
) -> dict[str, Any]:
    """Evaluate and close open positions using bid rules."""
    target_sum = float(cfg.get("exit_target_total_price", 0.99))
    exit_candidates = []
    resolved_404: list[str] = []

    for pair_id, position in list(positions.items()):
        # --- Expiry check (before any API calls) ---
        if _resolution_has_passed(position.get("resolution_date", "")):
            contracts = position["contracts"]
            entry_kp_cost = position.get("entry_kp_cost", 0.0)
            realized_pnl = contracts * 1.0 - entry_kp_cost
            edge_pct = (realized_pnl / entry_kp_cost) if entry_kp_cost > 0 else 0.0
            age_seconds = _position_age_seconds(position)
            age_days = max(age_seconds / 86400.0, 1.0 / 86400.0)
            arr = edge_pct * 365.0 / age_days
            trade_number = _next_trade_number(log_path)
            exit_log = {
                "title": position.get("title", pair_id),
                "pair_id": pair_id,
                "trade_phase": "exit",
                "corresponding_entry_trade_number": position.get("entry_trade_number", ""),
                "entry_k_price": position.get("entry_k_price", 0.0),
                "entry_p_price": position.get("entry_p_price", 0.0),
                "entry_fills": position.get("entry_fills", []),
                "entry_fee": position.get("entry_fee", 0.0),
                "entry_kp_cost": round(entry_kp_cost, 4),
                "exit_fills": [],
                "total_contracts": contracts,
                "edge_pct": round(edge_pct * 100, 2),
                "total_profit": round(realized_pnl, 4),
                "arr": round(arr * 100, 2),
                "fee": 0.0,
                "hold_duration_seconds": round(age_seconds, 2),
                "close_reason": "expired",
                "kalshi_token": position.get("kalshi_ticker", ""),
                "polymarket_token": position.get("p_token_id", ""),
                "p_token_ids": position.get("p_token_ids", []),
                "p_leg_prices": position.get("p_leg_prices", []),
                "p_leg_spend": position.get("p_leg_spend", []),
                "strategy": position.get("strategy", ""),
                "execution_date": datetime.now(timezone.utc).date().isoformat(),
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "mode": mode,
                "trade_number": trade_number,
            }
            _write_trade_log(exit_log, log_path)
            print(
                f"  {Fore.CYAN}EXPIRED {pair_id} — {contracts}c settled at $1/contract, "
                f"profit ${realized_pnl:.4f}{Style.RESET_ALL}"
            )
            resolved_404.append(pair_id)
            continue

        fetch_delay = 2
        kq = pq = None
        while True:
            try:
                kq = kalshi.get_quotes(position["kalshi_ticker"])
                break
            except Exception as exc:
                if "429" in str(exc):
                    print(f"  {Fore.YELLOW}Rate limited fetching {pair_id} — retrying in {fetch_delay}s...{Style.RESET_ALL}")
                    time.sleep(fetch_delay)
                    fetch_delay = min(fetch_delay * 2, 60)
                elif "404" in str(exc):
                    # Market delisted/resolved — auto-close the position
                    print(f"  {Fore.CYAN}Market gone (404) for {pair_id} — auto-closing as resolved{Style.RESET_ALL}")
                    _404_contracts = position.get("contracts", 0)
                    _404_kp_cost = position.get("entry_kp_cost", 0.0)
                    _404_pnl = _404_contracts * 1.0 - _404_kp_cost
                    _404_edge_pct = (_404_pnl / _404_kp_cost) if _404_kp_cost > 0 else 0.0
                    _404_age_s = _position_age_seconds(position)
                    _404_age_d = max(_404_age_s / 86400.0, 1.0 / 86400.0)
                    _404_arr = _404_edge_pct * 365.0 / _404_age_d
                    trade_number = _next_trade_number(log_path)
                    exit_log = {
                        "title": position.get("title", pair_id),
                        "pair_id": pair_id,
                        "trade_phase": "exit",
                        "corresponding_entry_trade_number": position.get("entry_trade_number", ""),
                        "entry_k_price": position.get("entry_k_price", 0.0),
                        "entry_p_price": position.get("entry_p_price", 0.0),
                        "entry_fills": position.get("entry_fills", []),
                        "entry_fee": position.get("entry_fee", 0.0),
                        "entry_kp_cost": round(_404_kp_cost, 4),
                        "exit_fills": [],
                        "total_contracts": _404_contracts,
                        "edge_pct": round(_404_edge_pct * 100, 2),
                        "total_profit": round(_404_pnl, 4),
                        "arr": round(_404_arr * 100, 2),
                        "fee": 0.0,
                        "hold_duration_seconds": round(_404_age_s, 2),
                        "close_reason": "market_resolved_404",
                        "kalshi_token": position.get("kalshi_ticker", ""),
                        "polymarket_token": position.get("p_token_id", ""),
                        "strategy": position.get("strategy", ""),
                        "execution_date": datetime.now(timezone.utc).date().isoformat(),
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "mode": mode,
                        "trade_number": trade_number,
                    }
                    _write_trade_log(exit_log, log_path)
                    resolved_404.append(pair_id)
                    break
                elif shutdown:
                    print(f"  {Fore.YELLOW}Exit fetch failed for {pair_id}: {exc} — retrying in {fetch_delay}s...{Style.RESET_ALL}")
                    time.sleep(fetch_delay)
                    fetch_delay = min(fetch_delay * 2, 60)
                else:
                    print(f"  {Fore.YELLOW}Exit fetch failed for {pair_id}: {exc}{Style.RESET_ALL}")
                    break
        if kq is None:
            continue

        p_token_ids = [t for t in (position.get("p_token_ids") or []) if str(t).strip()]
        p_levels = []
        p_bid = 0.0
        try:
            if p_token_ids:
                books = poly.get_books(p_token_ids)
                leg_bid_levels = []
                leg_best_bids = []
                for tid in p_token_ids:
                    book = books.get(tid)
                    if not book:
                        # If a multi-outcome leg is 404, we can't reliably exit. 
                        # But if ALL books are missing or it's a 404 error, it's resolved.
                        raise RuntimeError(f"Missing orderbook for Polymarket token {tid}")
                    leg_bid_levels.append(_normalize_levels(poly._parse_bid_levels(book), descending=True))
                    leg_best_bids.append(poly._best_bid(book))
                p_bid = sum(leg_best_bids)
                p_levels = leg_bid_levels[0] if len(leg_bid_levels) == 1 else _combine_leg_levels(leg_bid_levels)
            else:
                pq = poly.get_quotes(position.get("yes_token_id", ""), position.get("no_token_id", ""), "")
                p_bid = pq["no_bid"] if position["strategy"] == "BUY_KY_BUY_PN" else pq["yes_bid"]
                p_levels = pq.get("depth", {}).get("no_bids" if position["strategy"] == "BUY_KY_BUY_PN" else "yes_bids", [])
        except Exception as exc:
            if _is_404_error(exc):
                print(f"  {Fore.CYAN}Polymarket market gone (404) for {pair_id} — auto-closing as resolved{Style.RESET_ALL}")
                _p404_contracts = position.get("contracts", 0)
                _p404_kp_cost = position.get("entry_kp_cost", 0.0)
                _p404_pnl = _p404_contracts * 1.0 - _p404_kp_cost
                _p404_edge_pct = (_p404_pnl / _p404_kp_cost) if _p404_kp_cost > 0 else 0.0
                _p404_age_s = _position_age_seconds(position)
                _p404_age_d = max(_p404_age_s / 86400.0, 1.0 / 86400.0)
                _p404_arr = _p404_edge_pct * 365.0 / _p404_age_d
                trade_number = _next_trade_number(log_path)
                exit_log = {
                    "title": position.get("title", pair_id),
                    "pair_id": pair_id,
                    "trade_phase": "exit",
                    "corresponding_entry_trade_number": position.get("entry_trade_number", ""),
                    "entry_k_price": position.get("entry_k_price", 0.0),
                    "entry_p_price": position.get("entry_p_price", 0.0),
                    "entry_fills": position.get("entry_fills", []),
                    "entry_fee": position.get("entry_fee", 0.0),
                    "entry_kp_cost": round(_p404_kp_cost, 4),
                    "exit_fills": [],
                    "total_contracts": _p404_contracts,
                    "edge_pct": round(_p404_edge_pct * 100, 2),
                    "total_profit": round(_p404_pnl, 4),
                    "arr": round(_p404_arr * 100, 2),
                    "fee": 0.0,
                    "hold_duration_seconds": round(_p404_age_s, 2),
                    "close_reason": "poly_market_resolved_404",
                    "kalshi_token": position.get("kalshi_ticker", ""),
                    "polymarket_token": position.get("p_token_id", ""),
                    "strategy": position.get("strategy", ""),
                    "execution_date": datetime.now(timezone.utc).date().isoformat(),
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "mode": mode,
                    "trade_number": trade_number,
                }
                _write_trade_log(exit_log, log_path)
                resolved_404.append(pair_id)
                continue

            print(f"  {Fore.YELLOW}Exit Poly fetch failed for {pair_id}: {exc}{Style.RESET_ALL}")
            continue

        # V6: no convergence exit — positions are held to expiry for $1/contract payout.

    for pair_id in exit_candidates:
        positions.pop(pair_id, None)

    # Remove positions whose markets returned 404 (resolved/delisted)
    for pair_id in resolved_404:
        positions.pop(pair_id, None)

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


def _log_bad_pair(pair: dict[str, Any], reason: str, log_path: str) -> None:
    """Append one entry to the bad-pairs log file."""
    Path(log_path).parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "pair_id": pair["pair_id"],
        "kalshi_ticker": pair.get("kalshi_ticker", ""),
        "title": pair.get("title", ""),
        "reason": reason,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    with Path(log_path).open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


def load_bad_ids(log_path: str) -> set[str]:
    """Read the bad-pairs log and return the set of pair_ids to skip."""
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

def _build_polymarket_quotes(pair: dict[str, Any], poly) -> dict[str, Any]:
    slug = pair.get("polymarket_market_slug", "")
    outcomes = [str(o) for o in pair.get("poly_outcomes", [])]
    token_ids = [str(t) for t in pair.get("poly_token_ids", [])]
    primary = str(pair.get("poly_primary_outcome", "")).strip()
    market: dict | None = None

    if (not outcomes or not token_ids) and slug:
        info = poly.resolve_market_outcomes(slug)
        outcomes = [str(o) for o in info.get("outcomes", [])]
        token_ids = [str(t) for t in info.get("token_ids", [])]
        pair["poly_outcomes"] = outcomes
        pair["poly_token_ids"] = token_ids
        market = info.get("market", {})
        event_slug = str(market.get("eventSlug") or market.get("event_slug") or "").strip()
        if event_slug and not pair.get("poly_event_url"):
            pair["poly_event_url"] = f"https://polymarket.com/event/{event_slug}"
        if not primary:
            outcomes_lc = [o.strip().lower() for o in outcomes]
            if len(outcomes_lc) == 2 and "yes" in outcomes_lc and "no" in outcomes_lc:
                primary = "yes"
                pair["poly_primary_outcome"] = primary
        # Cache the poly question from the already-fetched market data
        if market and not pair.get("poly_market_question"):
            pair["poly_market_question"] = str(market.get("question") or "").strip()

    outcomes_lc = [o.strip().lower() for o in outcomes]
    binary_yes_no = len(outcomes_lc) == 2 and "yes" in outcomes_lc and "no" in outcomes_lc

    # 3+ outcome markets require explicit primary mapping and multi-outcome logic
    if outcomes and not binary_yes_no and len(outcomes) > 2:
        if not primary:
            raise RuntimeError("Missing poly_primary_outcome for non-binary Polymarket market")
        primary_idx = _find_outcome_index(outcomes, primary)
        if primary_idx is None:
            raise RuntimeError(
                f"poly_primary_outcome '{primary}' not found in outcomes {outcomes}"
            )
        if len(token_ids) < len(outcomes):
            raise RuntimeError(
                f"Polymarket outcomes/token_ids length mismatch (outcomes={len(outcomes)}, tokens={len(token_ids)})"
            )
        token_ids = token_ids[:len(outcomes)]
        books = poly.get_books(token_ids)
        tokens: dict[str, Any] = {}
        for outcome, tid in zip(outcomes, token_ids):
            book = books.get(tid)
            if not book:
                # Raise so Phase 2 catch logic handles this as a failure/expired
                raise RuntimeError(f"Missing orderbook for Polymarket token {tid}")
            tokens[tid] = {
                "outcome": outcome,
                "best_bid": poly._best_bid(book),
                "best_ask": poly._best_ask(book),
                "asks": poly._parse_ask_levels(book),
                "bids": poly._parse_bid_levels(book),
            }
        primary_token_id = token_ids[primary_idx]
        complement_token_ids = [tid for i, tid in enumerate(token_ids) if i != primary_idx]
        primary_best_ask = tokens[primary_token_id]["best_ask"]
        primary_best_bid = tokens[primary_token_id]["best_bid"]
        complement_best_ask = sum(tokens[tid]["best_ask"] for tid in complement_token_ids)
        complement_best_bid = sum(tokens[tid]["best_bid"] for tid in complement_token_ids)
        fee_rate = _resolve_poly_fee_rate(poly, [primary_token_id] + complement_token_ids, market)
        pair["poly_fee_rate"] = fee_rate
        return {
            "type": "multi",
            "outcomes": outcomes,
            "token_ids": token_ids,
            "primary_outcome": primary,
            "primary_token_id": primary_token_id,
            "complement_token_ids": complement_token_ids,
            "primary_best_ask": primary_best_ask,
            "primary_best_bid": primary_best_bid,
            "complement_best_ask": complement_best_ask,
            "complement_best_bid": complement_best_bid,
            "tokens": tokens,
            "poly_fee_rate": fee_rate,
        }
    elif outcomes and not binary_yes_no and len(outcomes) == 2:
        # 2-outcome team-name market (e.g. ["Stars", "Wild"]) — treat as binary.
        # Map primary outcome → YES token, complement → NO token.
        # Use get_books batch call (avoids slug resolution + get_question_by_token overhead).
        if not primary:
            raise RuntimeError("Missing poly_primary_outcome for 2-outcome market")
        primary_idx = _find_outcome_index(outcomes, primary)
        if primary_idx is None:
            raise RuntimeError(f"poly_primary_outcome '{primary}' not found in outcomes {outcomes}")
        complement_idx = 1 - primary_idx
        yes_id = token_ids[primary_idx]
        no_id = token_ids[complement_idx]
        pair["polymarket_yes_token_id"] = yes_id
        pair["polymarket_no_token_id"] = no_id
        books = poly.get_books([yes_id, no_id])
        yes_book = books.get(yes_id)
        no_book = books.get(no_id)
        if not yes_book or not no_book:
            raise RuntimeError(f"Missing orderbook for 2-outcome Polymarket tokens {yes_id}, {no_id}")
        fee_rate = _resolve_poly_fee_rate(poly, [yes_id, no_id], market)
        pair["poly_fee_rate"] = fee_rate
        if not pair.get("poly_market_question"):
            pair["poly_market_question"] = pair.get("title", "")
        return {
            "type": "binary",
            "yes_bid": poly._best_bid(yes_book),
            "yes_ask": poly._best_ask(yes_book),
            "no_bid": poly._best_bid(no_book),
            "no_ask": poly._best_ask(no_book),
            "depth": {
                "yes_asks": poly._parse_ask_levels(yes_book),
                "no_asks": poly._parse_ask_levels(no_book),
                "yes_bids": poly._parse_bid_levels(yes_book),
                "no_bids": poly._parse_bid_levels(no_book),
            },
            "yes_token_id": yes_id,
            "no_token_id": no_id,
            "poly_fee_rate": fee_rate,
        }

    # Binary yes/no path
    try:
        pq = poly.get_quotes(
            pair.get("polymarket_yes_token_id", ""),
            pair.get("polymarket_no_token_id", ""),
            slug,
        )
    except requests.HTTPError as exc:
        # Re-raise so run_scan can catch 404s and log accordingly
        raise
    except Exception as exc:
        raise RuntimeError(f"Polymarket quote fetch failed: {exc}") from exc
    fee_rate = _resolve_poly_fee_rate(poly, [pq["yes_token_id"], pq["no_token_id"]], market)
    pair["poly_fee_rate"] = fee_rate
    pq["type"] = "binary"
    pq["poly_fee_rate"] = fee_rate

    # Fetch and cache poly market question for binary pre-populated token pairs
    if not pair.get("poly_market_question"):
        yid = pq.get("yes_token_id", "")
        pair["poly_market_question"] = poly.get_question_by_token(yid) if yid else ""

    return pq


def _fetch_pair(pair: dict[str, Any], kalshi, poly) -> tuple[dict, dict, dict]:
    """Fetch orderbook quotes for one pair (runs in a worker thread).

    Rate limits (429) are raised immediately — skipped for the cycle by run_scan.
    Other transient errors (503, timeouts) retry up to 3 times with exponential backoff.
    Permanent errors (404, bad ticker) are raised immediately.

    All fetches (Kalshi A, Kalshi B if present, Polymarket) fire in parallel.
    """
    max_retries = 3
    delay = 1.0
    last_exc: Exception | None = None
    ticker_b = pair.get("kalshi_ticker_b", "")

    for attempt in range(max_retries + 1):
        try:
            tasks: dict[str, Any] = {
                "kq": lambda: kalshi.get_quotes(pair["kalshi_ticker"]),
                "pq": lambda: _build_polymarket_quotes(pair, poly),
            }
            if ticker_b:
                tasks["kq_b"] = lambda: kalshi.get_quotes(ticker_b)

            results: dict[str, Any] = {}
            with ThreadPoolExecutor(max_workers=len(tasks)) as ex:
                futures = {ex.submit(fn): key for key, fn in tasks.items()}
                for fut in as_completed(futures):
                    results[futures[fut]] = fut.result()

            kq = results["kq"]
            pq = results["pq"]
            if ticker_b:
                kq["kalshi_quotes_b"] = results["kq_b"]
            return pair, kq, pq
        except Exception as exc:
            if _is_transient_error(exc) and "429" not in str(exc) and attempt < max_retries:
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
    bad_ids: set[str] | None = None,
    skip_pair_ids: set[str] | None = None,
    execute_approved_ids: set[str] | None = None,
    on_new_position: Any | None = None,
    batch_start: int | None = None,
    total_pairs: int | None = None,
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

    if bad_ids is None:
        bad_ids = set()

    mode = _resolve_execution_mode(cfg)
    log_path = cfg.get("entry_log", "entry_trades.json")
    opp_log_path = cfg.get("opportunities_log", "opportunities.json")
    failed_log = cfg.get("failed_log", "failed_pairs.json")
    expired_log = cfg.get("expired_log", "expired_pairs.json")
    bad_log = cfg.get("bad_log", "bad_pairs.json")
    max_workers = int(cfg.get("max_workers", 25))
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
        and p["pair_id"] not in bad_ids
        and p["pair_id"] not in skip_pair_ids
    ]
    skipped = len(pairs) - len(active_pairs)

    skip_note = f"  {Style.DIM}({skipped} skipped — failed/expired/bad){Style.RESET_ALL}" if skipped else ""
    if batch_start is not None and total_pairs is not None:
        batch_end = batch_start + len(active_pairs) - 1
        batch_label = f"Fetching pairs {batch_start}–{batch_end} of {total_pairs}"
    else:
        batch_label = f"Fetching quotes for {len(active_pairs)} pair(s)"
    print(
        f"\n{Style.DIM}[{ts}]{Style.RESET_ALL} "
        f"{batch_label}  "
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
            if cfg.get("skip_multi_outcome", False) and pq.get("type") == "multi":
                continue
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

        if opps and opps[0].get("_bad_pair"):
            bad_opp = opps[0]
            if bad_opp.get("price_gap"):
                reason = (
                    f"{bad_opp.get('strategy')} price gap={bad_opp.get('price_gap', 0):.3f} > 0.15"
                )
                msg = f"  {Fore.YELLOW}! {label}: fill price gap too large  → logged to bad pairs{Style.RESET_ALL}"
            else:
                reason = (
                    f"{bad_opp.get('strategy')} cost/contract={bad_opp.get('cost_per_contract', 0):.3f} < 0.85"
                )
                msg = f"  {Fore.YELLOW}! {label}: same-side/mismatched pair  → logged to bad pairs{Style.RESET_ALL}"
            bad_ids.add(pair["pair_id"])
            _log_bad_pair(pair, reason, bad_log)
            print(msg, file=sys.stderr)
            continue

        # Optional per-pair market status line (enabled via print_market_status in config).
        if cfg.get("print_market_status", True):
            k_yes_ask = float(kq["yes_ask"])
            k_no_ask  = float(kq["no_ask"])
            if pq.get("type") == "multi":
                p_yes_ask = float(pq.get("primary_best_ask", 0.0))
                p_no_ask = float(pq.get("complement_best_ask", 0.0))
            else:
                p_yes_ask = float(pq["yes_ask"])
                p_no_ask = float(pq["no_ask"])
            days_left = _days_to_resolution(pair.get("resolution_date", ""))
            # Net-of-fees marginal edge for 1 contract in each direction
            fee_cfg   = cfg["fees"]
            k_rup     = bool(fee_cfg["kalshi"].get("round_up_to_cent", True))
            k_rate    = _kalshi_fee_rate_for_ticker(pair.get("kalshi_ticker", ""))
            k_fee_fn  = _kalshi_fee_fn_for_rate(k_rate)
            p_rate    = _require_poly_fee_rate(pair.get("poly_fee_rate"), pair.get("pair_id", "pair"))
            p_fee_fn  = _poly_fee_fn_for_rate(p_rate)
            def _net_edge(ka: float, pa: float) -> float:
                return 1.0 - (ka + pa
                               + apply_fee(k_fee_fn, ka, 1, k_rup)
                               + apply_fee(p_fee_fn, pa, 1, False, round_decimals=5))
            net_edge_dollar = max(
                _net_edge(kq["yes_ask"], p_no_ask),
                _net_edge(kq["no_ask"],  p_yes_ask),
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
                f"  K YES/NO: {k_yes_ask:.3f}/{k_no_ask:.3f}"
                f"  P YES/NO: {p_yes_ask:.3f}/{p_no_ask:.3f}"
                f"  exp={days_left:.1f}d"
                f"  edge={edge_color}{edge_pct * 100:+.1f}%"
                f"  ARR={net_arr * 100:+.1f}%{Style.RESET_ALL}"
            )

        if opps:
            for opp in opps:
                exec_key = (opp.get("kalshi_ticker", ""), opp["strategy"])
                k_url = _resolve_kalshi_url(opp)
                p_url = _resolve_polymarket_url(opp)
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
                    elif execute_approved_ids is not None and opp["pair_id"] not in execute_approved_ids:
                        print(f"    {Style.DIM}→ arb seen — awaiting 2nd confirmation{Style.RESET_ALL}")
                    else:
                        executed_keys.add(exec_key)
                        trade = None
                        if mode == "paper":
                            trade = execute_paper(opp, log_path)
                            print(f"    {Style.DIM}→ logged {trade['trade_number']} (paper){Style.RESET_ALL}")
                        elif mode == "live":
                            if not _check_holdings(opp, cfg):
                                print(f"    {Fore.YELLOW}! skipped - insufficient holdings{Style.RESET_ALL}")
                                continue
                            trade = execute_live(opp, kalshi, poly, log_path)
                            if trade.get("legs_filled") != "none":
                                status = "PARTIAL FILL" if trade.get("partial_fill") else "filled"
                                color = Fore.RED if trade.get("partial_fill") else Fore.GREEN
                                print(f"    → {trade['trade_number']} {color}{status}{Style.RESET_ALL}")
                                _print_fill_breakdown(opp)
                            if on_new_position and trade is not None and trade.get("legs_filled") != "none":
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
    import signal as _signal
    def _sigterm_handler(signum, frame):
        raise KeyboardInterrupt
    _signal.signal(_signal.SIGTERM, _sigterm_handler)

    interval = max(1, int(cfg.get("scan_interval_seconds", 2)))
    pairs_per_cycle = int(cfg.get("pairs_per_cycle", 25))
    pair_offset = 0
    failed_log = cfg.get("failed_log", "failed_pairs.json")
    expired_log = cfg.get("expired_log", "expired_pairs.json")
    bad_log = cfg.get("bad_log", "bad_pairs.json")
    position_file = cfg.get("position_file", "open_positions.json")
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

    # Load any previously flagged bad (same-side/inverted) pairs
    bad_ids = load_bad_ids(bad_log)
    if bad_ids:
        print(
            f"  {Style.DIM}Loaded {len(bad_ids)} bad pair(s) from "
            f"{bad_log} — these will be skipped.{Style.RESET_ALL}"
        )

    positions = _load_open_positions(position_file)
    if positions:
        print(
            f"  {Style.DIM}Loaded {len(positions)} open position(s) from "
            f"{position_file}{Style.RESET_ALL}"
        )

    cooldown_log = cfg.get("cooldown_log", "data/cooldowns.json")
    cooldowns: dict[str, str] = _load_cooldowns(cooldown_log)
    opportunity_streak: dict[str, int] = {}

    def _cooldown_expiry(iso: str) -> float:
        try:
            dt = datetime.fromisoformat(iso)
            return dt.timestamp() if dt.tzinfo else dt.replace(tzinfo=timezone.utc).timestamp()
        except Exception:
            return 0.0

    def _on_new_position(opp: dict[str, Any], trade: dict[str, Any]) -> None:
        _record_open_position(positions, opp, trade, position_file)
        # Cooldown until next 3am CDT (08:00 UTC) — aligns with daily bot restart
        now_utc = datetime.now(timezone.utc)
        reset = now_utc.replace(hour=8, minute=0, second=0, microsecond=0)
        if now_utc >= reset:
            reset += timedelta(days=1)
        cooldowns[opp["pair_id"]] = reset.isoformat()
        _save_cooldowns(cooldown_log, cooldowns)
        opportunity_streak.pop(opp["pair_id"], None)

    EXIT_INTERVAL = 5    # seconds between exit checks
    SCAN_INTERVAL = 2    # seconds between new-pair scans

    last_exit_check = 0.0  # epoch seconds; 0 forces immediate check on first cycle
    next_cycle_ids: set[str] = set()
    scan_offset = 0  # rolling 0-based counter for batch progress display

    print(f"\n{Fore.CYAN}Bot running — press Ctrl+C to stop.{Style.RESET_ALL}")
    while True:
        try:
            # --- Auto-reload pairs if a newer file is found in input_files_dir (csv mode only) ---
            if str(cfg.get("pairs_input_mode", "excel")).lower() == "csv":
                input_dir = cfg.get("input_files_dir", "input_files")
                latest_file = get_latest_pairs_file(input_dir)
                if latest_file and latest_file != cfg.get("pairs_file"):
                    print(f"\n  {Fore.CYAN}[reload]{Style.RESET_ALL} Found new pairs file: {latest_file}")
                    try:
                        new_pairs = load_pairs(latest_file)
                        if new_pairs:
                            pairs = new_pairs
                            cfg["pairs_file"] = latest_file
                            pair_offset = 0  # Reset rotation for the new set
                            print(f"  {Fore.CYAN}[reload]{Style.RESET_ALL} Loaded {len(pairs)} active pair(s)")
                            # Clear stale state so new pairs are not pre-skipped
                            failed_ids.clear()
                            expired_ids.clear()
                            bad_ids.clear()
                            positions.clear()
                            for _path in (failed_log, expired_log, bad_log, position_file):
                                try:
                                    Path(_path).write_text("", encoding="utf-8")
                                except Exception:
                                    pass
                            print(
                                f"  {Fore.CYAN}[reload]{Style.RESET_ALL} Cleared failed/expired/bad/positions state for new pairs file"
                            )
                    except Exception as exc:
                        print(f"  {Fore.RED}[reload] Failed to load {latest_file}: {exc}{Style.RESET_ALL}")

            # --- Exit check (every EXIT_INTERVAL seconds) ---
            if cfg.get("exit_enabled", True) and (time.time() - last_exit_check >= EXIT_INTERVAL):
                positions = _process_exit_positions(
                    positions=positions,
                    kalshi=kalshi,
                    poly=poly,
                    cfg=cfg,
                    mode=_resolve_execution_mode(cfg),
                    log_path=cfg.get("exit_log", "exit_trades.json"),
                    position_file=position_file,
                    shutdown=False,
                )
                last_exit_check = time.time()

            # Prune expired cooldowns and build active set
            now_ts = time.time()
            for pid in list(cooldowns):
                if _cooldown_expiry(cooldowns[pid]) <= now_ts:
                    del cooldowns[pid]
            active_cooldowns = set(cooldowns.keys())

            # Pairs approved for execution — seen as arb for 5 consecutive cycles
            execute_approved_ids = {
                pid for pid, count in opportunity_streak.items() if count >= 4
            }

            # Pre-filter permanently excluded and cooled-down pairs
            scannable = [
                p for p in pairs
                if p["pair_id"] not in failed_ids
                and p["pair_id"] not in expired_ids
                and p["pair_id"] not in bad_ids
                and p["pair_id"] not in active_cooldowns
            ]
            # Priority pairs from last cycle's entries, then round-robin fill
            priority_pairs = [p for p in scannable if p["pair_id"] in next_cycle_ids]
            remaining_pairs = [p for p in scannable if p["pair_id"] not in next_cycle_ids]
            rotated = remaining_pairs[pair_offset:] + remaining_pairs[:pair_offset]
            fill_slots = max(pairs_per_cycle - len(priority_pairs), 0)
            scan_pairs = priority_pairs + rotated[:fill_slots]
            pair_offset = (pair_offset + fill_slots) % max(len(remaining_pairs), 1)

            total = len(scannable)
            batch_start = scan_offset + 1
            opps = run_scan(
                scan_pairs,
                kalshi,
                poly,
                cfg,
                execute=True,
                failed_ids=failed_ids,
                expired_ids=expired_ids,
                bad_ids=bad_ids,
                execute_approved_ids=execute_approved_ids,
                on_new_position=_on_new_position,
                batch_start=batch_start,
                total_pairs=total,
            )
            scan_offset = (scan_offset + len(scan_pairs)) % max(total, 1)

            # Update opportunity streaks
            found_ids = {opp["pair_id"] for opp in opps}
            attempted_ids = execute_approved_ids & found_ids
            for pid in found_ids - attempted_ids:
                opportunity_streak[pid] = opportunity_streak.get(pid, 0) + 1
            for pid in attempted_ids:
                opportunity_streak.pop(pid, None)
            for p in scan_pairs:
                if p["pair_id"] not in found_ids:
                    opportunity_streak.pop(p["pair_id"], None)

            next_cycle_ids = found_ids
            traded = len(opps)
            print(
                f"  {Style.DIM}{traded} new entry trade(s) this cycle  "
                f"| next scan in {interval}s...{Style.RESET_ALL}"
            )
            time.sleep(interval)
        except KeyboardInterrupt:
            print(f"\n{Fore.YELLOW}Shutdown requested — leaving positions open to settle at expiry.{Style.RESET_ALL}")
            _save_open_positions(position_file, positions)
            print(f"{Fore.YELLOW}Stopped.{Style.RESET_ALL}")
            break
        except Exception as exc:
            ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
            print(
                f"\n  {Fore.RED}[{ts}] Unexpected error — resuming in 10s: {exc}{Style.RESET_ALL}",
                file=sys.stderr,
            )
            time.sleep(10)
