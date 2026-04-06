"""live_quotes.py — Pull and display live quotes for all pairs every 30 seconds.

Outputs to both console and data/live_quotes.csv.

Usage:
    python live_quotes.py --config config.json
    python live_quotes.py --config config.json --interval 10   # 10s instead of 30s
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent
_SRC_DIR = _SCRIPT_DIR / "src"
sys.path.insert(0, str(_SRC_DIR))

from connectors import KalshiConnector, PolymarketConnector, load_pairs  # noqa: E402

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


# ── Resolve token IDs once at startup ────────────────────────────────────────

def _resolve_all_tokens(
    pairs: list[dict], poly: PolymarketConnector
) -> list[dict]:
    """Ensure every pair has yes/no token IDs. Resolve from slug if missing."""
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


# ── Fetch one pair's quotes ──────────────────────────────────────────────────

def _fetch_pair_quotes(
    pair: dict, kalshi: KalshiConnector, poly: PolymarketConnector
) -> dict | None:
    """Fetch Kalshi + Poly quotes for a single pair. Returns None on error."""
    pid = pair["pair_id"]
    try:
        kq = kalshi.get_quotes(pair["kalshi_ticker"])
    except Exception as exc:
        print(f"  [WARN] {pid} Kalshi fetch failed: {exc}", file=sys.stderr)
        return None

    try:
        pq = poly.get_quotes(
            pair["polymarket_yes_token_id"],
            pair["polymarket_no_token_id"],
            pair.get("polymarket_market_slug", ""),
        )
    except Exception as exc:
        print(f"  [WARN] {pid} Poly fetch failed: {exc}", file=sys.stderr)
        return None

    return {
        "pair_id": pid,
        "poly_yes_ask": pq.get("yes_ask", 1.0),
        "poly_no_ask": pq.get("no_ask", 1.0),
        "kal_yes_ask": kq.get("yes_ask", 1.0),
        "kal_no_ask": kq.get("no_ask", 1.0),
    }


# ── Main loop ────────────────────────────────────────────────────────────────

CSV_HEADER = ["timestamp", "pair_id", "poly_yes_ask", "poly_no_ask", "kal_yes_ask", "kal_no_ask"]

def run_loop(pairs: list[dict], kalshi: KalshiConnector, poly: PolymarketConnector,
             interval: int, max_workers: int, out_path: Path) -> None:
    # Write CSV header if file doesn't exist
    write_header = not out_path.exists()
    if write_header:
        out_path.parent.mkdir(parents=True, exist_ok=True)

    print(f"\n  Live Quotes — {len(pairs)} pairs, every {interval}s")
    print(f"  Output: {out_path}")
    print(f"  Press Ctrl+C to stop.\n")
    print(",".join(CSV_HEADER))

    cycle = 0
    try:
        while True:
            cycle += 1
            ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
            rows: list[dict] = []

            with ThreadPoolExecutor(max_workers=max_workers) as pool:
                futures = {
                    pool.submit(_fetch_pair_quotes, p, kalshi, poly): p
                    for p in pairs
                }
                for fut in as_completed(futures):
                    result = fut.result()
                    if result:
                        rows.append(result)

            # Sort by pair_id for consistent output
            rows.sort(key=lambda r: r["pair_id"])

            # Print to console + write to CSV
            with out_path.open("a", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=CSV_HEADER, extrasaction="ignore")
                if write_header:
                    writer.writeheader()
                    write_header = False

                for row in rows:
                    row["timestamp"] = ts
                    line = (
                        f"{ts},{row['pair_id']},"
                        f"{row['poly_yes_ask']:.4f},{row['poly_no_ask']:.4f},"
                        f"{row['kal_yes_ask']:.4f},{row['kal_no_ask']:.4f}"
                    )
                    print(line)
                    writer.writerow(row)

            ok = len(rows)
            fail = len(pairs) - ok
            status = f"  [{ts}] Cycle {cycle}: {ok}/{len(pairs)} OK"
            if fail:
                status += f", {fail} failed"
            print(status, file=sys.stderr)

            time.sleep(interval)

    except KeyboardInterrupt:
        print(f"\n  Stopped after {cycle} cycle(s). Data saved to {out_path}")


# ── CLI ──────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Pull live quotes for all pairs.")
    parser.add_argument("--config", default="config.json", help="Path to config file")
    parser.add_argument("--interval", type=int, default=30, help="Seconds between cycles (default: 30)")
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
    print(f"  {len(pairs)} pairs with valid token IDs")

    if not pairs:
        print("No valid pairs to quote.", file=sys.stderr)
        sys.exit(1)

    max_workers = int(cfg.get("max_workers", 6))
    out_path = _SCRIPT_DIR / "data" / "live_quotes.csv"

    run_loop(pairs, kalshi, poly, args.interval, max_workers, out_path)


if __name__ == "__main__":
    main()
