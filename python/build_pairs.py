#!/usr/bin/env python3
"""
build_pairs.py
Builds pairs.csv for Polymarket/Kalshi market matching.
"""

import argparse
import csv
import datetime as dt
import json
import os
import re
import time
import urllib.parse
import urllib.request
import urllib.error
from typing import Any, Dict, List, Optional, Tuple

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DEFAULT_OUTPUT = os.path.join(ROOT, "pairs.csv")
MIN_SIMILARITY_SCORE = 0.32
MAX_EXPIRY_GAP_HOURS = 96.0


def get_json(url: str, params: Optional[Dict[str, Any]] = None) -> Any:
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": "pair-builder/1.0"})
    delay = 1.0
    last_err: Optional[Exception] = None
    for _ in range(6):
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            last_err = err
            if err.code not in (429, 503, 504):
                raise
            time.sleep(delay)
            delay = min(delay * 2, 8)
        except Exception as err:
            last_err = err
            time.sleep(delay)
            delay = min(delay * 2, 8)
    if last_err:
        raise last_err
    raise RuntimeError("Failed to fetch JSON")


def clean_title(title: str) -> str:
    t = (title or "").lower()
    t = re.sub(r"[^a-z0-9\s]", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def parse_time(raw: str) -> str:
    if not raw:
        return ""
    try:
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        d = dt.datetime.fromisoformat(raw)
        if d.tzinfo is None:
            d = d.replace(tzinfo=dt.timezone.utc)
        return d.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    except Exception:
        return ""


def category_tag(title: str) -> str:
    t = title.lower()
    if any(k in t for k in ["president", "election", "senate", "house", "governor", "trump", "biden"]):
        return "politics"
    if any(k in t for k in ["fed", "inflation", "gdp", "unemployment", "cpi", "rates"]):
        return "macro"
    if any(k in t for k in ["nba", "nfl", "mlb", "nhl", "soccer", "mvp", "world cup", "game"]):
        return "sports"
    if any(k in t for k in ["bitcoin", "btc", "eth", "crypto", "solana"]):
        return "crypto"
    return "other"


def token_set(title: str) -> set:
    return {w for w in clean_title(title).split(" ") if len(w) >= 3}


def similarity(a: str, b: str) -> float:
    sa = token_set(a)
    sb = token_set(b)
    if not sa or not sb:
        return 0.0
    inter = len(sa.intersection(sb))
    union = len(sa.union(sb))
    return inter / union if union else 0.0


def expiry_gap_hours(a: str, b: str) -> float:
    pa = parse_time(a)
    pb = parse_time(b)
    if not pa or not pb:
        # If one side is missing expiry, allow but do not award confidence.
        return MAX_EXPIRY_GAP_HOURS
    try:
        da = dt.datetime.fromisoformat(pa.replace("Z", "+00:00"))
        db = dt.datetime.fromisoformat(pb.replace("Z", "+00:00"))
        return abs((da - db).total_seconds()) / 3600.0
    except Exception:
        return MAX_EXPIRY_GAP_HOURS


def fetch_polymarket() -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    base = "https://gamma-api.polymarket.com/markets"
    offset = 0
    pages = 0
    while True:
        rows = get_json(base, {"active": "true", "closed": "false", "limit": 500, "offset": offset})
        if not rows:
            break
        for m in rows:
            out.append({
                "id": str(m.get("id") or m.get("conditionId") or ""),
                "title": m.get("question") or "",
                "expiry": parse_time(m.get("endDate") or ""),
            })
        if len(rows) < 500:
            break
        offset += 500
        pages += 1
        if pages >= 8:
            break
        time.sleep(0.25)
    return [m for m in out if m["id"] and m["title"]]


def fetch_kalshi() -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    base = "https://api.elections.kalshi.com/trade-api/v2/markets"
    cursor = None
    pages = 0
    while True:
        params: Dict[str, Any] = {"limit": 200, "status": "open"}
        if cursor:
            params["cursor"] = cursor
        data = get_json(base, params)
        markets = data.get("markets", [])
        if not markets:
            break
        for m in markets:
            out.append({
                "id": str(m.get("ticker") or ""),
                "title": m.get("title") or m.get("subtitle") or "",
                "expiry": parse_time(m.get("close_time") or m.get("latest_expiration_time") or ""),
            })
        next_cursor = data.get("cursor")
        if not next_cursor or next_cursor == cursor:
            break
        cursor = next_cursor
        pages += 1
        if pages >= 10:
            break
        time.sleep(0.35)
    return [m for m in out if m["id"] and m["title"]]


def best_match(poly: Dict[str, Any], kalshi: List[Dict[str, Any]]) -> Optional[Tuple[Dict[str, Any], float]]:
    best = None
    best_score = 0.0
    poly_cat = category_tag(poly["title"])
    for km in kalshi:
        if category_tag(km["title"]) != poly_cat:
            continue
        gap_h = expiry_gap_hours(poly.get("expiry", ""), km.get("expiry", ""))
        if gap_h > MAX_EXPIRY_GAP_HOURS:
            continue
        s = similarity(poly["title"], km["title"])
        if gap_h <= 24:
            s += 0.05
        elif gap_h <= 48:
            s += 0.02
        if s > best_score:
            best_score = s
            best = km
    if best and best_score >= MIN_SIMILARITY_SCORE:
        return best, best_score
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default=DEFAULT_OUTPUT)
    parser.add_argument("--min-pairs", type=int, default=50)
    args = parser.parse_args()

    polymarket = fetch_polymarket()
    kalshi = fetch_kalshi()

    rows: List[Dict[str, Any]] = []
    used_kalshi = set()

    for pm in polymarket:
        match = best_match(pm, kalshi)
        if not match:
            continue
        km, score = match
        if km["id"] in used_kalshi:
            continue
        used_kalshi.add(km["id"])
        cleaned = clean_title(pm["title"])[:120]
        rows.append({
            "pair_id": f"pair-{len(rows) + 1:04d}",
            "poly_market_id": pm["id"],
            "kalshi_market_id": km["id"],
            "title_clean": cleaned,
            "expiry_poly_utc": pm["expiry"],
            "expiry_kalshi_utc": km["expiry"],
            "similarity_score": f"{score:.4f}",
            "category_tag": category_tag(pm["title"]),
        })
        if len(rows) >= args.min_pairs:
            break

    # Intentionally avoid low-confidence fallback matching.
    # For deployment safety, prefer fewer high-quality pairs over many weak pairs.

    os.makedirs(os.path.dirname(os.path.abspath(args.output)) or ".", exist_ok=True)
    fields = [
        "pair_id",
        "poly_market_id",
        "kalshi_market_id",
        "title_clean",
        "expiry_poly_utc",
        "expiry_kalshi_utc",
        "similarity_score",
        "category_tag",
    ]
    with open(args.output, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)

    print(f"Wrote {len(rows)} pairs to {args.output}")
    if len(rows) < args.min_pairs:
        print(
            f"WARNING: Only {len(rows)} high-confidence pairs found (< min-pairs {args.min_pairs}). "
            "Proceeding without low-confidence fallback matches."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
