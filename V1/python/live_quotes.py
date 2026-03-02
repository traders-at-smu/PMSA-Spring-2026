#!/usr/bin/env python3
"""
live_quotes.py
Polls paired markets and writes quote snapshots every N seconds.
"""

import argparse
import csv
import datetime as dt
import json
import os
import time
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DEFAULT_PAIRS = os.path.join(ROOT, "pairs.csv")
DEFAULT_OUT = os.path.join(ROOT, "python", "data", "live_quotes.csv")


def get_json(url: str, params: Optional[Dict[str, Any]] = None) -> Any:
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": "live-quotes/1.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def parse_outcome_prices(raw: Any) -> List[float]:
    if raw is None:
        return []
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            return []
    if not isinstance(raw, list):
        return []
    out: List[float] = []
    for v in raw:
        try:
            out.append(float(v))
        except Exception:
            out.append(0.0)
    return out


def load_pairs(path: str, limit: int) -> List[Dict[str, str]]:
    with open(path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    return rows[:limit]


def poly_quote(market_id: str) -> Dict[str, float]:
    # Prefer direct market lookup, fallback to list lookup.
    try:
        m = get_json(f"https://gamma-api.polymarket.com/markets/{market_id}")
    except Exception:
        arr = get_json("https://gamma-api.polymarket.com/markets", {"id": market_id, "limit": 1})
        m = arr[0] if arr else {}

    outcome_prices = parse_outcome_prices(m.get("outcomePrices"))
    yes_ask = float(m.get("bestAsk") or 0)
    yes_bid = float(m.get("bestBid") or 0)

    # Ask-only policy:
    # Do not synthesize NO ask from YES bid. Use explicit NO ask fields if present,
    # then fall back to outcomePrices[1] as a weak ask proxy.
    no_ask = float(m.get("noAsk") or m.get("bestNoAsk") or 0)
    if no_ask <= 0 and len(outcome_prices) > 1:
        no_ask = float(outcome_prices[1] or 0)

    no_bid = float(m.get("noBid") or m.get("bestNoBid") or 0)
    return {
        "poly_yes_ask": max(0.0, min(1.0, yes_ask)),
        "poly_no_ask": max(0.0, min(1.0, no_ask)),
        "poly_yes_bid": max(0.0, min(1.0, yes_bid)),
        "poly_no_bid": max(0.0, min(1.0, no_bid)),
    }


def kalshi_quote(ticker: str) -> Dict[str, float]:
    m = get_json(f"https://api.elections.kalshi.com/trade-api/v2/markets/{ticker}")
    yes_ask = float(m.get("market", {}).get("yes_ask_dollars") or 0) / 100
    no_ask = float(m.get("market", {}).get("no_ask_dollars") or 0) / 100
    yes_bid = float(m.get("market", {}).get("yes_bid_dollars") or 0) / 100
    no_bid = float(m.get("market", {}).get("no_bid_dollars") or 0) / 100
    return {
        "kal_yes_ask": max(0.0, min(1.0, yes_ask)),
        "kal_no_ask": max(0.0, min(1.0, no_ask)),
        "kal_yes_bid": max(0.0, min(1.0, yes_bid)),
        "kal_no_bid": max(0.0, min(1.0, no_bid)),
    }


def write_rows(path: str, rows: List[Dict[str, Any]]) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    exists = os.path.exists(path)
    fields = [
        "timestamp",
        "pair_id",
        "poly_market_id",
        "kalshi_market_id",
        "poly_yes_ask",
        "poly_no_ask",
        "kal_yes_ask",
        "kal_no_ask",
        "poly_yes_bid",
        "poly_no_bid",
        "kal_yes_bid",
        "kal_no_bid",
    ]
    with open(path, "a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        if not exists:
            writer.writeheader()
        writer.writerows(rows)


def run_once(pairs: List[Dict[str, str]], out_path: str) -> int:
    timestamp = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    rows: List[Dict[str, Any]] = []

    for p in pairs:
        try:
            pq = poly_quote(p["poly_market_id"])
            kq = kalshi_quote(p["kalshi_market_id"])
            rows.append({
                "timestamp": timestamp,
                "pair_id": p["pair_id"],
                "poly_market_id": p["poly_market_id"],
                "kalshi_market_id": p["kalshi_market_id"],
                **pq,
                **kq,
            })
        except Exception as err:  # pylint: disable=broad-except
            print(f"WARN pair {p.get('pair_id', '?')} failed: {err}")
            continue

    if rows:
        write_rows(out_path, rows)
    print(f"Saved {len(rows)} quote rows at {timestamp}")
    return len(rows)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pairs", default=DEFAULT_PAIRS)
    parser.add_argument("--out", default=DEFAULT_OUT)
    parser.add_argument("--interval", type=int, default=30)
    parser.add_argument("--max-pairs", type=int, default=80)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()

    pairs = load_pairs(args.pairs, args.max_pairs)
    if not pairs:
        raise RuntimeError(f"No pairs found in {args.pairs}")

    if args.once:
        run_once(pairs, args.out)
        return 0

    while True:
        run_once(pairs, args.out)
        time.sleep(max(1, args.interval))


if __name__ == "__main__":
    raise SystemExit(main())
