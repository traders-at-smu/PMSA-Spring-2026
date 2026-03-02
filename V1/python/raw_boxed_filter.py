#!/usr/bin/env python3
"""
raw_boxed_filter.py
Builds opportunities_raw.csv from latest quote snapshots.
"""

import argparse
import csv
import datetime as dt
import json
import os
import urllib.parse
import urllib.request
from collections import defaultdict
from typing import Any, Dict, List, Optional

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DEFAULT_PAIRS = os.path.join(ROOT, "pairs.csv")
DEFAULT_QUOTES = os.path.join(ROOT, "python", "data", "live_quotes.csv")
DEFAULT_OUT = os.path.join(ROOT, "opportunities_raw.csv")
DEFAULT_SECTION_D = os.path.join(ROOT, "python", "data", "model_v1_section_d_input.json")
MIN_PAIR_SIMILARITY = 0.32
MIN_DAYS_TO_RESOLUTION = 0.1  # 2.4h
MAX_DAYS_TO_RESOLUTION = 120.0
MIN_ASK = 0.01
MAX_ASK = 0.99
MIN_BOX_COST = 0.50
MAX_BOX_COST = 0.995


def get_json(url: str, params: Optional[Dict[str, Any]] = None) -> Any:
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": "raw-boxed-filter/1.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def load_csv(path: str) -> List[Dict[str, str]]:
    if not os.path.exists(path):
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def as_float(v: Any) -> float:
    try:
        return float(v)
    except Exception:
        return 0.0


def in_range(v: float, lo: float, hi: float) -> bool:
    return lo <= v <= hi


def ceil_to_cent(value: float) -> float:
    return (int((value * 100) + 0.9999999999)) / 100


def calc_kalshi_fee(contracts: float, ask_price: float) -> float:
    # Trade Rules: Fee_K*(C) = roundup(0.007 * C * Ask_K* * (1 - Ask_K*))
    return ceil_to_cent(0.007 * max(0.0, contracts) * max(0.0, ask_price) * (1 - max(0.0, ask_price)))


def calc_strategy_total_cost(
    contracts: float,
    kalshi_ask: float,
    polymarket_ask: float,
) -> float:
    return (contracts * kalshi_ask) + (contracts * polymarket_ask) + calc_kalshi_fee(contracts, kalshi_ask)


def parse_utc_iso(raw: str) -> Optional[dt.datetime]:
    if not raw:
        return None
    try:
        normalized = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
        parsed = dt.datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=dt.timezone.utc)
        return parsed.astimezone(dt.timezone.utc)
    except Exception:
        return None


def days_to_resolution(pair: Dict[str, str], now_utc: dt.datetime) -> float:
    poly_exp = parse_utc_iso(pair.get("expiry_poly_utc", ""))
    kal_exp = parse_utc_iso(pair.get("expiry_kalshi_utc", ""))
    expiries = [d for d in [poly_exp, kal_exp] if d is not None]
    if not expiries:
        return 0.0
    min_days = min((d - now_utc).total_seconds() / 86400 for d in expiries)
    return max(0.0, min_days)


def compute_recent_edges(history: List[Dict[str, str]]) -> List[Dict[str, Any]]:
    snaps = []
    for row in history[-3:]:
        c = 1.0
        kypn = calc_strategy_total_cost(c, as_float(row.get("kal_yes_ask")), as_float(row.get("poly_no_ask")))
        knpy = calc_strategy_total_cost(c, as_float(row.get("kal_no_ask")), as_float(row.get("poly_yes_ask")))
        best_cost = min(kypn, knpy) if kypn > 0 and knpy > 0 else max(kypn, knpy)
        edge = c - best_cost
        snaps.append({"timestamp": row.get("timestamp", ""), "grossEdgePerDollar": edge})
    return snaps


def poly_depth(poly_market_id: str) -> Dict[str, float]:
    try:
        m = get_json(f"https://gamma-api.polymarket.com/markets/{poly_market_id}")
    except Exception:
        arr = get_json("https://gamma-api.polymarket.com/markets", {"id": poly_market_id, "limit": 1})
        m = arr[0] if arr else {}
    bid_depth = as_float(m.get("volume24hr")) * 0.02
    ask_depth = as_float(m.get("liquidity")) * 0.01
    return {
        "bidDepth": max(1.0, bid_depth),
        "askDepth": max(1.0, ask_depth),
    }


def kalshi_depth(kalshi_market_id: str) -> Dict[str, float]:
    try:
        book = get_json(f"https://api.elections.kalshi.com/trade-api/v2/markets/{kalshi_market_id}/orderbook", {"depth": 20})
        ob = book.get("orderbook_fp") or book.get("orderbook") or {}
        yes = ob.get("yes", [])
        no = ob.get("no", [])
        top = 0.0
        for lvl in yes:
            top += (as_float(lvl.get("price")) * as_float(lvl.get("contracts"))) / 100
        for lvl in no:
            top += (as_float(lvl.get("price")) * as_float(lvl.get("contracts"))) / 100
        return {"top": max(1.0, top)}
    except Exception:
        try:
            m = get_json(f"https://api.elections.kalshi.com/trade-api/v2/markets/{kalshi_market_id}")
            liq = as_float(m.get("market", {}).get("liquidity_dollars"))
            return {"top": max(1.0, liq)}
        except Exception:
            return {"top": 1.0}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pairs", default=DEFAULT_PAIRS)
    parser.add_argument("--quotes", default=DEFAULT_QUOTES)
    parser.add_argument("--out", default=DEFAULT_OUT)
    parser.add_argument("--section-d", default=DEFAULT_SECTION_D)
    args = parser.parse_args()

    pairs = {r["pair_id"]: r for r in load_csv(args.pairs) if r.get("pair_id")}
    quotes = load_csv(args.quotes)
    if not quotes:
        print("No quotes available")
        return 2

    by_pair: Dict[str, List[Dict[str, str]]] = defaultdict(list)
    for q in quotes:
        by_pair[q.get("pair_id", "")].append(q)

    rows: List[Dict[str, Any]] = []
    now = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    now_utc = dt.datetime.now(dt.timezone.utc)

    for pair_id, history in by_pair.items():
        latest = history[-1]
        pair = pairs.get(pair_id, {})
        sim_raw = (pair.get("similarity_score") or "").strip()
        if sim_raw and as_float(sim_raw) < MIN_PAIR_SIMILARITY:
            continue

        poly_yes_ask = as_float(latest.get("poly_yes_ask"))
        poly_no_ask = as_float(latest.get("poly_no_ask"))
        kal_yes_ask = as_float(latest.get("kal_yes_ask"))
        kal_no_ask = as_float(latest.get("kal_no_ask"))

        # Ask-only policy: require explicit ask prices for every leg we may trade.
        if (
            not in_range(poly_yes_ask, MIN_ASK, MAX_ASK)
            or not in_range(poly_no_ask, MIN_ASK, MAX_ASK)
            or not in_range(kal_yes_ask, MIN_ASK, MAX_ASK)
            or not in_range(kal_no_ask, MIN_ASK, MAX_ASK)
        ):
            continue

        c = 1.0
        fee_ky = calc_kalshi_fee(c, kal_yes_ask)
        fee_kn = calc_kalshi_fee(c, kal_no_ask)
        # Trade Rules:
        # KYPN = Ask_KY + Ask_PN + Fee_KY(C=1) + Fee_PN(0)
        # KNPY = Ask_KN + Ask_PY + Fee_KN(C=1) + Fee_PY(0)
        kypn_cost_c1 = calc_strategy_total_cost(c, kal_yes_ask, poly_no_ask)
        knpy_cost_c1 = calc_strategy_total_cost(c, kal_no_ask, poly_yes_ask)

        if kypn_cost_c1 <= 0 and knpy_cost_c1 <= 0:
            continue

        strategy_options = []
        if kypn_cost_c1 > 0:
            strategy_options.append(("BUY_KY_PN", kypn_cost_c1, kal_yes_ask, poly_no_ask, fee_ky))
        if knpy_cost_c1 > 0:
            strategy_options.append(("BUY_KN_PY", knpy_cost_c1, kal_no_ask, poly_yes_ask, fee_kn))
        if not strategy_options:
            continue

        best_direction, best_cost_c1, best_kal_ask, best_poly_ask, best_kal_fee_c1 = min(strategy_options, key=lambda x: x[1])
        if best_cost_c1 >= 1.0:
            # No arbitrage per Trade Rules.
            continue
        if best_cost_c1 < MIN_BOX_COST or best_cost_c1 > MAX_BOX_COST:
            continue

        kp_c1 = best_cost_c1
        edge_dollar_c1 = c - kp_c1
        edge_per_contract = edge_dollar_c1 / c
        edge_pct = (edge_dollar_c1 / kp_c1) if kp_c1 > 0 else 0.0
        days_remaining = days_to_resolution(pair, now_utc)
        if days_remaining < MIN_DAYS_TO_RESOLUTION or days_remaining > MAX_DAYS_TO_RESOLUTION:
            continue
        annualized_edge = (edge_pct * 365 / days_remaining) if days_remaining > 0 else 0.0

        pdepth = poly_depth(pair.get("poly_market_id", latest.get("poly_market_id", "")))
        kdepth = kalshi_depth(pair.get("kalshi_market_id", latest.get("kalshi_market_id", "")))

        top_book_depth = pdepth["bidDepth"] + pdepth["askDepth"] + kdepth["top"]
        profitable_depth = min(pdepth["bidDepth"], pdepth["askDepth"]) + (kdepth["top"] * 0.02)

        recent = compute_recent_edges(history)
        pos = len([s for s in recent if as_float(s.get("grossEdgePerDollar")) > 0])
        edge_persistence = (pos / len(recent)) if recent else 0.0

        rows.append({
            "id": f"miguel-{pair_id}",
            "venue": "KALSHI",
            "strategy": "BINARY_BUY_BOTH",
            "market": pair.get("title_clean", pair_id),
            "yesAsk": kal_yes_ask,
            "noAsk": kal_no_ask,
            "bidDepth": pdepth["bidDepth"],
            "askDepth": pdepth["askDepth"],
            "liquidity": kdepth["top"],
            "profitPerDollar": edge_per_contract,
            "numOutcomes": 2,
            "sumAsks": best_cost_c1,
            "pair_id": pair_id,
            "poly_market_id": pair.get("poly_market_id", latest.get("poly_market_id", "")),
            "kalshi_market_id": pair.get("kalshi_market_id", latest.get("kalshi_market_id", "")),
            "timestamp": now,
            # Legacy columns retained for dashboard compatibility.
            "cost1": knpy_cost_c1,
            "cost2": kypn_cost_c1,
            "best_cost": best_cost_c1,
            "best_direction": best_direction,
            "edge_raw": edge_per_contract,
            # Trade Rules columns.
            "ask_py": poly_yes_ask,
            "ask_pn": poly_no_ask,
            "ask_ky": kal_yes_ask,
            "ask_kn": kal_no_ask,
            "fee_ky_c1": fee_ky,
            "fee_kn_c1": fee_kn,
            "kypn_cost_c1": kypn_cost_c1,
            "knpy_cost_c1": knpy_cost_c1,
            "selected_kal_ask": best_kal_ask,
            "selected_poly_ask": best_poly_ask,
            "selected_kal_fee_c1": best_kal_fee_c1,
            "kp_c1": kp_c1,
            "edge_dollar_c1": edge_dollar_c1,
            "edge_per_contract_c1": edge_per_contract,
            "edge_pct_c1": edge_pct,
            "days_to_resolution": days_remaining,
            "annualized_edge_c1": annualized_edge,
            "topBookDepthUsd": top_book_depth,
            "depthWithinProfitableBandUsd": profitable_depth,
            "edgePersistence": edge_persistence,
            "recentSnapshotsJson": json.dumps(recent),
        })

    rows.sort(key=lambda r: as_float(r.get("edge_pct_c1")), reverse=True)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    fields = [
        "id", "venue", "strategy", "market", "yesAsk", "noAsk", "bidDepth", "askDepth", "liquidity",
        "profitPerDollar", "numOutcomes", "sumAsks", "pair_id", "poly_market_id", "kalshi_market_id", "timestamp",
        "cost1", "cost2", "best_cost", "best_direction", "edge_raw", "topBookDepthUsd",
        "depthWithinProfitableBandUsd", "edgePersistence", "recentSnapshotsJson",
        "ask_py", "ask_pn", "ask_ky", "ask_kn",
        "fee_ky_c1", "fee_kn_c1", "kypn_cost_c1", "knpy_cost_c1",
        "selected_kal_ask", "selected_poly_ask", "selected_kal_fee_c1",
        "kp_c1", "edge_dollar_c1", "edge_per_contract_c1", "edge_pct_c1",
        "days_to_resolution", "annualized_edge_c1",
    ]
    with open(args.out, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)

    top3 = rows[:3]
    section_d = {
        "generated_at": now,
        "count": len(rows),
        "top": top3,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.section_d)) or ".", exist_ok=True)
    with open(args.section_d, "w", encoding="utf-8") as f:
        json.dump(section_d, f, indent=2)

    print(f"Wrote {len(rows)} opportunities to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
