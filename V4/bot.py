"""Core arbitrage engine: depth-walking, opportunity evaluation, execution, logging.

Trading rules (from Trade Rules.md):
  1. KP(c) < c              — total cost must be less than the number of contracts
  2. c <= max_contracts      — position size must not exceed the contract cap
  3. ARR >= min_arr          — annualised return must meet the minimum threshold

ARR = (edge_pct * 365) / days_to_resolution
edge_pct = (c - KP(c)) / KP(c)
"""

from __future__ import annotations

import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from colorama import Fore, Style

from fees import apply_fee


# ── Error classification ───────────────────────────────────────────────────────

def _is_transient_error(exc: Exception) -> bool:
    """Return True if the error is likely temporary (rate limit, timeout, etc.).

    Transient errors should NOT permanently blacklist a pair — the pair will
    simply be skipped for this scan cycle and retried next time.

    Permanent errors (404, bad ticker, parse failures) DO warrant blacklisting.
    """
    import requests
    msg = str(exc).lower()

    # HTTP status-based: 429 Too Many Requests, 503 Service Unavailable
    if isinstance(exc, requests.HTTPError):
        code = getattr(exc.response, "status_code", None)
        if code in (429, 503, 502, 504):
            return True

    # Connection / timeout errors
    if isinstance(exc, (requests.ConnectionError, requests.Timeout)):
        return True

    # Check message text as a fallback (covers wrapped exceptions)
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


# ── Depth walking ─────────────────────────────────────────────────────────────

def _walk_depth(
    k_levels: list[dict[str, Any]],
    p_levels: list[dict[str, Any]],
    days: float,
    max_contracts: int,
    min_arr: float,
    kalshi_fee_fn,
    poly_fee_fn,
    kalshi_round_up: bool,
) -> dict[str, Any]:
    """Walk the combined orderbook depth, accumulating contracts while profitable.

    At each step we add one contract and check all three trading rules.
    The walk stops as soon as any rule is violated, and we return the last
    valid position (which may be zero contracts if no arb exists at all).

    Stop reasons:
        no_positive_edge         — marginal cost of next contract >= $1.00
        max_contracts_hit        — position would exceed the contract cap
        arr_below_min            — annualised return fell below threshold
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

        # Rule 1: marginal cost of one more contract must be < $1 (positive edge)
        if nk + np_ + delta_fee >= 1.0:
            stop_reason = "no_positive_edge"
            break

        next_kp = k_spend + nk + p_spend + np_ + next_kf + next_pf

        # Rule 2: position size must not exceed the contract cap
        if nc > max_contracts:
            stop_reason = "max_contracts_hit"
            break

        # Rule 3: annualised return must meet minimum threshold
        edge_pct = (nc - next_kp) / next_kp if next_kp > 0 else 0.0
        arr = (edge_pct * 365.0) / days if days > 0 else 0.0
        if arr < min_arr:
            stop_reason = "arr_below_min"
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
        edge_d = contracts - cur_kp
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
    final_edge_pct = (contracts - final_kp) / final_kp if final_kp > 0 else 0.0
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
            if nk + np_ >= 1.0:
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
        "stop_reason": stop_reason,
        "slippage": slippage,
        "remaining": remaining,
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
    min_arr = float(cfg["min_arr"])
    days = _days_to_resolution(pair.get("resolution_date", ""))

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
            k_levels, p_levels, days, max_contracts, min_arr,
            k_fee_fn, p_fee_fn, k_round_up,
        )

        if walk["contracts"] > 0:
            edge_dollar = walk["contracts"] - walk["kp_cost"]
            results.append({
                "pair_id": pair["pair_id"],
                "title": pair.get("title", pair["pair_id"]),
                "kalshi_ticker": pair["kalshi_ticker"],
                "polymarket_slug": pair.get("polymarket_market_slug", ""),
                "strategy": strat["strategy"],
                "k_side": strat["k_side"],
                "p_side": strat["p_side"],
                "p_token_id": strat["p_token_id"],
                "contracts": walk["contracts"],
                "k_price": walk["k_price"],
                "p_price": walk["p_price"],
                "kp_cost": walk["kp_cost"],
                "edge_dollar": round(edge_dollar, 4),
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

def _build_log_entry(opp: dict[str, Any], mode: str, **overrides) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    entry: dict[str, Any] = {
        "trade_number": overrides.pop("trade_number", "T?????"),
        "title": opp["title"],
        "kalshi_token": opp["kalshi_ticker"],
        "polymarket_token": opp["p_token_id"],
        "kalshi_price": round(opp["k_price"], 4),
        "polymarket_price": round(opp["p_price"], 4),
        "fee": round(opp["total_fee"], 4),
        "kalshi_contracts_purchased": opp["contracts"],
        "polymarket_contracts_purchased": opp["contracts"],
        "total_profit": round(opp["edge_dollar"], 4),
        "execution_date": now.date().isoformat(),             # YYYY-MM-DD
        "arr": round(opp["arr"] * 100, 2),                   # annualised return as % (e.g. 18.4)
        "timestamp": now.isoformat(),
        "mode": mode,
        "strategy": opp["strategy"],
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
    p_contracts = opp["contracts"]
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
        p_contracts = 0
        print(
            f"  {Fore.RED}! PARTIAL FILL{Style.RESET_ALL} — Polymarket leg failed "
            f"after Kalshi filled: {exc}",
            file=sys.stderr,
        )

    entry = _build_log_entry(
        opp, "live",
        trade_number=trade_num,
        polymarket_contracts_purchased=p_contracts,
        total_profit=round(opp["edge_dollar"], 4) if not partial else 0.0,
        partial_fill=partial,
    )
    _write_trade_log(entry, log_path)
    return entry


# ── Failed-pairs tracking ─────────────────────────────────────────────────────

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
    """Fetch orderbook quotes for one pair (runs in a worker thread)."""
    kq = kalshi.get_quotes(pair["kalshi_ticker"])
    pq = poly.get_quotes(
        pair["polymarket_yes_token_id"],
        pair["polymarket_no_token_id"],
        pair.get("polymarket_market_slug", ""),
    )
    return pair, kq, pq


def run_scan(
    pairs: list[dict[str, Any]],
    kalshi,
    poly,
    cfg: dict[str, Any],
    execute: bool = False,
    failed_ids: set[str] | None = None,
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

    mode = cfg["mode"]
    log_path = cfg.get("trade_log", "trades.json")
    opp_log_path = cfg.get("opportunities_log", "opportunities.json")
    failed_log = cfg.get("failed_log", "failed_pairs.json")
    max_workers = int(cfg.get("max_workers", 30))
    ts = datetime.now().strftime("%H:%M:%S")
    t0 = time.monotonic()

    # Filter out pairs that have previously failed
    active_pairs = [p for p in pairs if p["pair_id"] not in failed_ids]
    skipped = len(pairs) - len(active_pairs)

    skip_note = f"  {Style.DIM}({skipped} skipped — in failed log){Style.RESET_ALL}" if skipped else ""
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
    # Deduplicate executions: if the same (ticker, strategy) appears more than once
    # (e.g. duplicate rows in the pairs file) only execute it the first time.
    executed_keys: set[tuple[str, str]] = set()

    for pair in active_pairs:
        label = f"{pair['kalshi_ticker']}/{pair['pair_id']}"
        result = results.get(pair["pair_id"])

        if isinstance(result, Exception):
            if _is_transient_error(result):
                # Rate limit / timeout — skip this cycle, do NOT blacklist
                print(
                    f"  {Fore.YELLOW}~ {label}: {result}  (transient — will retry){Style.RESET_ALL}",
                    file=sys.stderr,
                )
            else:
                # Permanent error (bad ticker, parse failure, 404, etc.)
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
                    f"edge=${opp['edge_dollar']:.2f}"
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
                        if mode == "paper":
                            trade = execute_paper(opp, log_path)
                            print(f"    {Style.DIM}→ logged {trade['trade_number']} (paper){Style.RESET_ALL}")
                        elif mode == "live":
                            trade = execute_live(opp, kalshi, poly, log_path)
                            status = "PARTIAL FILL" if trade.get("partial_fill") else "filled"
                            color = Fore.RED if trade.get("partial_fill") else Fore.GREEN
                            print(f"    → {trade['trade_number']} {color}{status}{Style.RESET_ALL}")
                        _print_fill_breakdown(opp)
                else:
                    print(f"    {Style.DIM}(scan-only — use 'run' to execute){Style.RESET_ALL}")
                    _print_fill_breakdown(opp)
            all_opps.extend(opps)

    parts = [f"{len(all_opps)} opportunity(ies) found"]
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
    failed_log = cfg.get("failed_log", "failed_pairs.json")

    # Load any previously failed pairs so they are skipped from the first cycle
    failed_ids = load_failed_ids(failed_log)
    if failed_ids:
        print(
            f"  {Style.DIM}Loaded {len(failed_ids)} previously failed pair(s) from "
            f"{failed_log} — these will be skipped.{Style.RESET_ALL}"
        )

    print(f"\n{Fore.CYAN}Bot running — press Ctrl+C to stop.{Style.RESET_ALL}")
    while True:
        try:
            opps = run_scan(pairs, kalshi, poly, cfg, execute=True, failed_ids=failed_ids)
            traded = len(opps)
            print(
                f"  {Style.DIM}{traded} trade(s) this cycle  "
                f"| next scan in {interval}s...{Style.RESET_ALL}"
            )
            time.sleep(interval)
        except KeyboardInterrupt:
            print(f"\n{Fore.YELLOW}Stopped.{Style.RESET_ALL}")
            break
