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


def compute_recent_edges(history: List[Dict[str, str]]) -> List[Dict[str, Any]]:
    snaps = []
    for row in history[-3:]:
        cost1 = as_float(row.get("poly_yes_ask")) + as_float(row.get("kal_no_ask"))
        cost2 = as_float(row.get("poly_no_ask")) + as_float(row.get("kal_yes_ask"))
        best_cost = min(cost1, cost2) if cost1 > 0 and cost2 > 0 else max(cost1, cost2)
        edge = 1 - best_cost
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

    for pair_id, history in by_pair.items():
        latest = history[-1]
        pair = pairs.get(pair_id, {})

        poly_yes_ask = as_float(latest.get("poly_yes_ask"))
        poly_no_ask = as_float(latest.get("poly_no_ask"))
        kal_yes_ask = as_float(latest.get("kal_yes_ask"))
        kal_no_ask = as_float(latest.get("kal_no_ask"))

        cost1 = poly_yes_ask + kal_no_ask
        cost2 = poly_no_ask + kal_yes_ask
        if cost1 <= 0 and cost2 <= 0:
            continue

        best_cost = min(c for c in [cost1, cost2] if c > 0)
        best_dir = "POLY_YES_KAL_NO" if best_cost == cost1 else "POLY_NO_KAL_YES"
        edge_raw = 1 - best_cost

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
            "profitPerDollar": edge_raw,
            "numOutcomes": 2,
            "sumAsks": best_cost,
            "pair_id": pair_id,
            "poly_market_id": pair.get("poly_market_id", latest.get("poly_market_id", "")),
            "kalshi_market_id": pair.get("kalshi_market_id", latest.get("kalshi_market_id", "")),
            "timestamp": now,
            "cost1": cost1,
            "cost2": cost2,
            "best_cost": best_cost,
            "best_direction": best_dir,
            "edge_raw": edge_raw,
            "topBookDepthUsd": top_book_depth,
            "depthWithinProfitableBandUsd": profitable_depth,
            "edgePersistence": edge_persistence,
            "recentSnapshotsJson": json.dumps(recent),
        })

    rows.sort(key=lambda r: as_float(r.get("edge_raw")), reverse=True)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    fields = [
        "id", "venue", "strategy", "market", "yesAsk", "noAsk", "bidDepth", "askDepth", "liquidity",
        "profitPerDollar", "numOutcomes", "sumAsks", "pair_id", "poly_market_id", "kalshi_market_id", "timestamp",
        "cost1", "cost2", "best_cost", "best_direction", "edge_raw", "topBookDepthUsd",
        "depthWithinProfitableBandUsd", "edgePersistence", "recentSnapshotsJson",
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
