"""raw_boxed_filter.py — Compute raw boxed-arb edge for every pair, output ranked CSV.

For each pair:
  cost1 = poly_yes_ask + kal_no_ask   (BUY_KY_BUY_PN)
  cost2 = poly_no_ask + kal_yes_ask   (BUY_KN_BUY_PY)
  edge_raw = 1.0 - min(cost1, cost2)

Outputs data/opportunities_raw.csv sorted by edge_raw descending.

Usage:
    python raw_boxed_filter.py --config config.json
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent
_SRC_DIR = _SCRIPT_DIR / "src"
sys.path.insert(0, str(_SRC_DIR))

from connectors import KalshiConnector, PolymarketConnector, load_pairs  # noqa: E402

try:
    from colorama import Fore, Style, init as colorama_init
    colorama_init()
except ImportError:
    class _Dummy:
        def __getattr__(self, _): return ""
    Fore = Style = _Dummy()  # type: ignore[assignment]


# ── Config helpers (same as main.py) ─────────────────────────────────────────

def _strip_comments(text: str) -> str:
    return "\n".join(
        line for line in text.splitlines()
        if not line.strip().startswith("//")
    )

def _strip_doc_keys(obj) -> None:
    if isinstance(obj, dict):
        for key in [k for k in obj if k.startswith("_")]:
            del obj[key]
        for v in obj.values():
            _strip_doc_keys(v)

def load_config(path: str) -> dict:
    p = Path(path)
    if not p.exists():
        example = _SCRIPT_DIR / "config.example.json"
        if example.exists():
            p = example
        else:
            print(f"Config not found: {path}", file=sys.stderr)
            sys.exit(1)
    text = p.read_text(encoding="utf-8")
    cfg = json.loads(_strip_comments(text))
    _strip_doc_keys(cfg)
    return cfg

def _build_connectors(cfg: dict) -> tuple[KalshiConnector, PolymarketConnector]:
    k = cfg.get("kalshi", {})
    p = cfg.get("polymarket", {})
    api = cfg.get("api", {})
    kalshi = KalshiConnector(
        api_key=k.get("api_key", ""),
        private_key_base64=k.get("private_key_base64", ""),
        base_url=api.get("kalshi_base_url", ""),
    )
    poly = PolymarketConnector(
        private_key=p.get("private_key", ""),
        clob_url=api.get("polymarket_clob_url", ""),
        gamma_url=api.get("polymarket_gamma_url", ""),
        api_key=p.get("api_key", ""),
        api_secret=p.get("api_secret", ""),
        api_passphrase=p.get("api_passphrase", ""),
    )
    return kalshi, poly


# ── Token resolution ─────────────────────────────────────────────────────────

def _resolve_all_tokens(
    pairs: list[dict], poly: PolymarketConnector
) -> list[dict]:
    resolved = []
    for pair in pairs:
        yid = (pair.get("polymarket_yes_token_id") or "").strip()
        nid = (pair.get("polymarket_no_token_id") or "").strip()
        slug = pair.get("polymarket_market_slug", "")
        if (not yid or not nid) and slug:
            try:
                yid, nid = poly._resolve_tokens(slug)
                pair["polymarket_yes_token_id"] = yid
                pair["polymarket_no_token_id"] = nid
            except Exception as exc:
                print(f"  [WARN] {pair['pair_id']}: token resolve failed: {exc}", file=sys.stderr)
                continue
        if yid and nid:
            resolved.append(pair)
        else:
            print(f"  [WARN] {pair['pair_id']}: no token IDs, skipping", file=sys.stderr)
    return resolved


# ── Days to expiry helper ────────────────────────────────────────────────────

def _days_to_expiry(pair: dict) -> float:
    from datetime import datetime, timezone
    raw = pair.get("resolution_date") or pair.get("expiry_kalshi_utc") or ""
    if not raw:
        return 365.0
    try:
        for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d", "%m/%d/%Y", "%Y-%m-%dT%H:%M:%S"):
            try:
                dt = datetime.strptime(str(raw).strip(), fmt).replace(tzinfo=timezone.utc)
                delta = (dt - datetime.now(timezone.utc)).total_seconds() / 86400
                return max(delta, 0.01)
            except ValueError:
                continue
    except Exception:
        pass
    return 365.0


# ── Fetch + compute edge for one pair ────────────────────────────────────────

def _evaluate_pair_raw(
    pair: dict, kalshi: KalshiConnector, poly: PolymarketConnector
) -> dict | None:
    pid = pair["pair_id"]

    try:
        kq = kalshi.get_quotes(pair["kalshi_ticker"])
    except Exception as exc:
        print(f"  [WARN] {pid} Kalshi: {exc}", file=sys.stderr)
        return None

    try:
        pq = poly.get_quotes(
            pair["polymarket_yes_token_id"],
            pair["polymarket_no_token_id"],
            pair.get("polymarket_market_slug", ""),
        )
    except Exception as exc:
        print(f"  [WARN] {pid} Poly: {exc}", file=sys.stderr)
        return None

    p_yes_ask = pq.get("yes_ask", 1.0)
    p_no_ask = pq.get("no_ask", 1.0)
    k_yes_ask = kq.get("yes_ask", 1.0)
    k_no_ask = kq.get("no_ask", 1.0)

    # Two boxed-arb strategies
    cost1 = p_no_ask + k_yes_ask    # BUY_KY_BUY_PN
    cost2 = p_yes_ask + k_no_ask    # BUY_KN_BUY_PY

    best_cost = min(cost1, cost2)
    strategy = "BUY_KY_BUY_PN" if cost1 < cost2 else "BUY_KN_BUY_PY"
    edge_raw = 1.0 - best_cost

    return {
        "pair_id": pid,
        "title": pair.get("title", pid),
        "kalshi_ticker": pair.get("kalshi_ticker", ""),
        "polymarket_slug": pair.get("polymarket_market_slug", ""),
        "strategy": strategy,
        "best_cost": round(best_cost, 6),
        "edge_raw": round(edge_raw, 6),
        "poly_yes_ask": round(p_yes_ask, 6),
        "poly_no_ask": round(p_no_ask, 6),
        "kal_yes_ask": round(k_yes_ask, 6),
        "kal_no_ask": round(k_no_ask, 6),
        "days_to_expiry": round(_days_to_expiry(pair), 1),
    }


# ── Main ─────────────────────────────────────────────────────────────────────

CSV_FIELDS = [
    "timestamp", "pair_id", "title", "kalshi_ticker", "polymarket_slug",
    "strategy", "best_cost", "edge_raw",
    "poly_yes_ask", "poly_no_ask", "kal_yes_ask", "kal_no_ask",
    "days_to_expiry",
]


def main() -> None:
    parser = argparse.ArgumentParser(description="Compute raw boxed-arb edge for all pairs.")
    parser.add_argument("--config", default="config.json", help="Path to config file")
    args = parser.parse_args()

    cfg = load_config(args.config)
    kalshi, poly = _build_connectors(cfg)

    pairs_path = cfg.get("pairs_file", "")
    if not pairs_path:
        print("No pairs_file in config.", file=sys.stderr)
        sys.exit(1)

    pairs = load_pairs(str(Path(_SCRIPT_DIR, pairs_path)))
    print(f"  Loaded {len(pairs)} pairs from {pairs_path}")

    pairs = _resolve_all_tokens(pairs, poly)
    print(f"  {len(pairs)} pairs with valid token IDs\n")

    if not pairs:
        print("No valid pairs.", file=sys.stderr)
        sys.exit(1)

    # Fetch all quotes in parallel
    max_workers = int(cfg.get("max_workers", 6))
    print(f"  Fetching quotes for {len(pairs)} pairs ({max_workers} workers)...")
    start = time.time()
    results: list[dict] = []

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {
            pool.submit(_evaluate_pair_raw, p, kalshi, poly): p
            for p in pairs
        }
        for fut in as_completed(futures):
            result = fut.result()
            if result:
                results.append(result)

    elapsed = time.time() - start
    print(f"  Done in {elapsed:.1f}s — {len(results)}/{len(pairs)} pairs quoted\n")

    # Sort by edge_raw descending
    results.sort(key=lambda r: r["edge_raw"], reverse=True)

    # Write CSV
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    out_path = _SCRIPT_DIR / "data" / "opportunities_raw.csv"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    with out_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS, extrasaction="ignore")
        writer.writeheader()
        for row in results:
            row["timestamp"] = ts
            writer.writerow(row)

    print(f"  Wrote {len(results)} rows to {out_path}\n")

    # Print top results to console
    arb_count = sum(1 for r in results if r["edge_raw"] > 0)
    print(f"  {'─' * 75}")
    print(f"  RANKED OPPORTUNITIES — {arb_count} with positive raw edge")
    print(f"  {'─' * 75}")
    print(f"  {'#':<4} {'Edge':>7} {'Cost':>7} {'Strategy':<16} {'Days':>5}  Pair")
    print(f"  {'─' * 75}")

    for i, r in enumerate(results[:30], 1):
        edge = r["edge_raw"]
        if edge > 0:
            color = Fore.GREEN
            sign = "+"
        elif edge > -0.02:
            color = Fore.YELLOW
            sign = ""
        else:
            color = Fore.RED
            sign = ""

        title = r["title"][:40] if r["title"] else r["pair_id"]
        print(
            f"  {i:<4} {color}{sign}{edge * 100:>6.2f}%{Style.RESET_ALL} "
            f"${r['best_cost']:>5.3f} {r['strategy']:<16} {r['days_to_expiry']:>5.0f}d  {title}"
        )

    if len(results) > 30:
        print(f"  ... and {len(results) - 30} more (see {out_path})")
    print()


if __name__ == "__main__":
    main()
