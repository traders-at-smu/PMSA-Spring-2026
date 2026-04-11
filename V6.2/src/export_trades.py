"""
export_trades.py — Export V6 EXP trade logs to CSV for analysis.

Usage (from V6 EXP/ directory):
    python src/export_trades.py                    # writes data/trades_export_YYYY-MM-DD.csv
    python src/export_trades.py --out my_file.csv  # custom output path
    python src/export_trades.py --data data/       # custom data directory

Output: one row per trade_number (PK).
  - Entry trades: filled price levels shown as summary + per-level columns
  - Exit trades: linked back to their entry via corresponding_entry_trade_number
  - Open positions: joined from open_positions.json for resolution_date + live cost
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from datetime import date
from pathlib import Path

try:
    import requests as _requests
    _REQUESTS_OK = True
except ImportError:
    _REQUESTS_OK = False

_KALSHI_API   = "https://api.elections.kalshi.com/trade-api/v2"
_POLY_GAMMA   = "https://gamma-api.polymarket.com"
_TIMEOUT      = 8


# ── Helpers ───────────────────────────────────────────────────────────────────

def _fmt_fills(fills: list[dict]) -> str:
    """Format fill levels as a human-readable summary.
    e.g.  10c@(K=0.980 P=0.002) | 4c@(K=0.980 P=0.017)
    """
    if not fills:
        return ""
    parts = []
    for f in fills:
        parts.append(
            f"{f['contracts']}c@(K={f['k_price']:.3f} P={f['p_price']:.3f})"
        )
    return " | ".join(parts)


def _weighted_avg(fills: list[dict], side: str) -> float | None:
    """Weighted-average price across fill levels for 'k_price' or 'p_price'."""
    if not fills:
        return None
    total_contracts = sum(f["contracts"] for f in fills)
    if total_contracts == 0:
        return None
    return sum(f[side] * f["contracts"] for f in fills) / total_contracts


def _fill_columns(fills: list[dict], prefix: str, max_levels: int) -> dict:
    """Expand fill levels into numbered columns: fill_1_contracts, fill_1_k_price, etc."""
    row = {}
    for i in range(1, max_levels + 1):
        if i <= len(fills):
            f = fills[i - 1]
            row[f"{prefix}fill_{i}_contracts"] = f["contracts"]
            row[f"{prefix}fill_{i}_k_price"]   = f["k_price"]
            row[f"{prefix}fill_{i}_p_price"]    = f["p_price"]
        else:
            row[f"{prefix}fill_{i}_contracts"] = ""
            row[f"{prefix}fill_{i}_k_price"]   = ""
            row[f"{prefix}fill_{i}_p_price"]    = ""
    return row


def _load_ndjson(path: Path) -> list[dict]:
    records = []
    if not path.exists():
        return records
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return records


def _load_json(path: Path) -> dict | list:
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


def upload_to_dropbox(local_path: str, cfg: dict) -> bool:
    """Upload a file to Dropbox using credentials from the config.
    Returns True if successful, False otherwise.
    """
    dbx_cfg = cfg.get("dropbox", {})
    if not dbx_cfg.get("enabled"):
        return False

    app_key      = dbx_cfg.get("app_key")
    app_secret   = dbx_cfg.get("app_secret")
    refresh_token = dbx_cfg.get("refresh_token")
    remote_dir   = dbx_cfg.get("remote_path", "/trades").rstrip("/")

    if not all([app_key, app_secret, refresh_token]):
        print("  [dropbox] ERROR: Missing credentials (app_key, app_secret, or refresh_token).")
        return False

    try:
        import dropbox
        from dropbox.files import WriteMode
    except ImportError:
        print("  [dropbox] ERROR: 'dropbox' library not installed. Run 'pip install dropbox'.")
        return False

    local_file = Path(local_path)
    if not local_file.exists():
        print(f"  [dropbox] ERROR: Local file not found: {local_path}")
        return False

    # Ensure remote_path is a clean absolute path for Dropbox (starts with /)
    # If remote_dir is empty or "/", it becomes "/filename"
    # If remote_dir is "/trades", it becomes "/trades/filename"
    remote_path = f"/{remote_dir.strip('/')}/{local_file.name}".replace("//", "/")

    try:
        with dropbox.Dropbox(
            app_key=app_key,
            app_secret=app_secret,
            oauth2_refresh_token=refresh_token
        ) as dbx:
            with local_file.open("rb") as f:
                print(f"  [dropbox] Uploading {local_file.name} to {remote_path}...")
                dbx.files_upload(f.read(), remote_path, mode=WriteMode("overwrite"))
                print("  [dropbox] Upload successful!")
                return True
    except Exception as e:
        print(f"  [dropbox] ERROR during upload: {e}")
        return False


# ── Title lookups (run once per unique token at export time) ─────────────────

def _load_pairs_lookup(input_dir: Path) -> dict[str, dict]:
    """Build a lookup keyed by kalshi_market_id from all daily CSV pairs files.

    Returns {kalshi_market_id: row_dict} so the export can resolve resolution_date
    and other pair metadata without hitting any APIs.
    """
    lookup: dict[str, dict] = {}
    for csv_path in sorted(input_dir.glob("output-*.csv")):
        try:
            with csv_path.open(encoding="utf-8") as fh:
                for row in csv.DictReader(fh):
                    kid = str(row.get("kalshi_market_id") or "").strip()
                    if kid and kid not in lookup:
                        lookup[kid] = row
        except Exception:
            pass
    return lookup


def _fetch_kalshi_title(ticker: str, _cache: dict = {}) -> str:
    """Fetch Kalshi market subtitle/title for a ticker via API. Returns '' on failure.

    Retries once on 429 rate-limit with a short delay before giving up.
    """
    import time
    if not ticker or not _REQUESTS_OK:
        return ""
    if ticker in _cache:
        return _cache[ticker]
    title = ""
    for attempt in range(2):
        try:
            r = _requests.get(f"{_KALSHI_API}/markets/{ticker}", timeout=_TIMEOUT)
            if r.status_code == 429 and attempt == 0:
                time.sleep(1.5)
                continue
            r.raise_for_status()
            mkt = r.json().get("market", {})
            title = str(mkt.get("subtitle") or mkt.get("title") or "").strip()
            break
        except Exception:
            if attempt == 0:
                time.sleep(1.5)
    _cache[ticker] = title
    return title


def _fetch_poly_title(token_id: str, _cache: dict = {}) -> str:
    """Fetch Polymarket market question for a token ID via Gamma API. Returns '' on failure."""
    if not token_id or not _REQUESTS_OK:
        return ""
    if token_id in _cache:
        return _cache[token_id]
    try:
        r = _requests.get(
            f"{_POLY_GAMMA}/markets",
            params={"clob_token_ids": token_id},
            timeout=_TIMEOUT,
        )
        r.raise_for_status()
        payload = r.json()
        market = payload[0] if isinstance(payload, list) and payload else payload
        title = str(market.get("question") or "") if isinstance(market, dict) else ""
    except Exception:
        title = ""
    _cache[token_id] = title
    return title


def _enrich_records(records: list[dict], pairs_lookup: dict[str, dict]) -> None:
    """Fill in missing poly_market_title, kalshi_market_title, and resolution_date.

    Resolution date comes from the local pairs files (no API call needed).
    Market titles are fetched from the APIs and cached per unique token.
    """
    for t in records:
        ticker = str(t.get("kalshi_token", "")).strip()
        pair   = pairs_lookup.get(ticker, {})

        # Resolution date — read from the pairs file first, then the trade record itself
        if not t.get("resolution_date"):
            res = str(pair.get("resolution_time_utc") or "").strip()
            if res:
                t["resolution_date"] = res[:10]  # keep YYYY-MM-DD portion only

        # Poly market title — API fetch, cached per token; slug as fallback
        if not t.get("poly_market_title"):
            token = (t.get("p_token_ids") or [t.get("polymarket_token", "")])[0]
            if token:
                t["poly_market_title"] = _fetch_poly_title(str(token).strip())
        if not t.get("poly_market_title"):
            slug = str(pair.get("poly_slug") or "").strip()
            if slug:
                t["poly_market_title"] = slug.replace("-", " ").title()

        # Kalshi market title — API fetch, cached per ticker
        if not t.get("kalshi_market_title") and ticker:
            t["kalshi_market_title"] = _fetch_kalshi_title(ticker)


# ── Main ──────────────────────────────────────────────────────────────────────

def export(data_dir: str, out_path: str) -> None:
    data = Path(data_dir)

    trades   = _load_ndjson(data / "entry_trades.json")
    positions: dict = _load_json(data / "open_positions.json")  # keyed by pair_id

    # Build lookup: entry_trade_number → position record (for resolution_date etc.)
    pos_by_entry_trade: dict[str, dict] = {}
    for pos in positions.values():
        tn = pos.get("entry_trade_number", "")
        if tn:
            pos_by_entry_trade[tn] = pos

    # Separate entry vs exit records; build exit lookup by entry trade number
    entry_records: list[dict] = []
    exit_by_entry: dict[str, dict] = {}   # entry trade number → exit record
    exit_orphans:  list[dict] = []        # exits with no paired entry in this file

    for t in trades:
        if t.get("trade_phase") == "exit":
            linked = t.get("corresponding_entry_trade_number", "")
            if linked:
                exit_by_entry[linked] = t
            else:
                exit_orphans.append(t)
        else:
            entry_records.append(t)

    # Determine max fill levels across all entry fills so column count is consistent
    max_entry_levels = max(
        (len(t.get("fills", [])) for t in entry_records),
        default=1,
    )
    max_exit_levels = max(
        (len(t.get("exit_fills", [])) for t in exit_by_entry.values()),
        default=1,
    )

    # Build lookup from local pairs files (resolution_date, etc.) — no API needed
    input_dir = Path(data_dir).parent / "input_files"
    pairs_lookup = _load_pairs_lookup(input_dir)
    print(f"Loaded pairs lookup from {input_dir} ({len(pairs_lookup)} entries)")

    # Enrich records: resolution_date from pairs files, titles from APIs
    print("Fetching market titles from APIs (cached per unique token)...")
    _enrich_records(entry_records, pairs_lookup)
    _enrich_records(exit_orphans, pairs_lookup)

    rows = []

    # ── Entry-rooted rows ──────────────────────────────────────────────────────
    for t in entry_records:
        tn     = t["trade_number"]
        fills  = t.get("fills", [])
        pos    = pos_by_entry_trade.get(tn, {})
        ex     = exit_by_entry.get(tn, {})

        avg_k  = _weighted_avg(fills, "k_price")
        avg_p  = _weighted_avg(fills, "p_price")
        avg_combined = round(avg_k + avg_p, 4) if avg_k is not None and avg_p is not None else ""

        # Status
        if ex:
            status = "closed"
        elif pos:
            status = "open"
        else:
            status = "entry_only"  # logged but position not tracked (e.g. paper dupe)

        row: dict = {
            "trade_number":          tn,
            "status":                status,
            "trade_phase":           "entry",
            "pair_id":               t.get("pair_id", ""),
            "title":                 t.get("title", ""),
            "poly_market_title":     t.get("poly_market_title", ""),
            "kalshi_market_title":   t.get("kalshi_market_title", ""),
            "strategy":              t.get("strategy", ""),
            "mode":                  t.get("mode", ""),
            "execution_date":        t.get("execution_date", ""),
            "timestamp":             t.get("timestamp", ""),
            "resolution_date":       pos.get("resolution_date", "") or t.get("resolution_date", ""),
            # Entry fill summary
            "entry_fills_summary":   _fmt_fills(fills),
            "entry_avg_k_price":     round(avg_k, 4) if avg_k is not None else "",
            "entry_avg_p_price":     round(avg_p, 4) if avg_p is not None else "",
            "entry_avg_combined":    avg_combined,
            "entry_total_contracts": t.get("total_contracts", ""),
            "entry_total_cost":      round(t["total_contracts"] * avg_combined, 4) if avg_combined != "" else "",
            "entry_fee":             t.get("fee", ""),
            "entry_edge_pct":        t.get("edge_pct", ""),
            "entry_total_profit":    t.get("total_profit", ""),
            "entry_arr":             t.get("arr", ""),
        }

        # Expand entry fill levels as individual columns
        row.update(_fill_columns(fills, "entry_", max_entry_levels))

        # Exit columns (populated if closed)
        ex_fills = ex.get("exit_fills", []) if ex else []
        row["exit_trade_number"]   = ex.get("trade_number", "")
        row["exit_timestamp"]      = ex.get("timestamp", "")
        row["exit_fills_summary"]  = _fmt_fills(ex_fills)
        row["exit_total_contracts"]= ex.get("total_contracts", "")
        row["exit_edge_pct"]       = ex.get("edge_pct", "")
        row["exit_total_profit"]   = ex.get("total_profit", "")
        row["exit_arr"]            = ex.get("arr", "")
        row["exit_fee"]            = ex.get("fee", "")
        row["close_reason"]        = ex.get("close_reason", "")
        row["hold_duration_sec"]   = ex.get("hold_duration_seconds", "")

        row.update(_fill_columns(ex_fills, "exit_", max_exit_levels))

        rows.append(row)

    # ── Orphan exit rows (exits with no paired entry in the log) ──────────────
    for t in exit_orphans:
        ex_fills = t.get("exit_fills", [])
        row = {
            "trade_number":           t["trade_number"],
            "status":                 "closed",
            "trade_phase":            "exit",
            "pair_id":                t.get("pair_id", ""),
            "title":                  t.get("title", ""),
            "poly_market_title":      t.get("poly_market_title", ""),
            "kalshi_market_title":    t.get("kalshi_market_title", ""),
            "strategy":               t.get("strategy", ""),
            "mode":                   t.get("mode", ""),
            "execution_date":         t.get("execution_date", ""),
            "timestamp":              t.get("timestamp", ""),
            "resolution_date":        "",
            "entry_fills_summary":    _fmt_fills(t.get("entry_fills", [])),
            "entry_avg_k_price":      t.get("entry_k_price", ""),
            "entry_avg_p_price":      t.get("entry_p_price", ""),
            "entry_avg_combined":     round(t.get("entry_k_price", 0) + t.get("entry_p_price", 0), 4) if t.get("entry_k_price") else "",
            "entry_total_contracts":  t.get("total_contracts", ""),
            "entry_total_cost":       t.get("entry_kp_cost", ""),
            "entry_fee":              t.get("entry_fee", ""),
            "entry_edge_pct":         "",
            "entry_total_profit":     "",
            "entry_arr":              "",
            "exit_trade_number":      t["trade_number"],
            "exit_timestamp":         t.get("timestamp", ""),
            "exit_fills_summary":     _fmt_fills(ex_fills),
            "exit_total_contracts":   t.get("total_contracts", ""),
            "exit_edge_pct":          t.get("edge_pct", ""),
            "exit_total_profit":      t.get("total_profit", ""),
            "exit_arr":               t.get("arr", ""),
            "exit_fee":               t.get("fee", ""),
            "close_reason":           t.get("close_reason", ""),
            "hold_duration_sec":      t.get("hold_duration_seconds", ""),
        }
        row.update(_fill_columns(t.get("entry_fills", []), "entry_", max_entry_levels))
        row.update(_fill_columns(ex_fills, "exit_", max_exit_levels))
        rows.append(row)

    if not rows:
        print("No trade records found — nothing to export.")
        return

    # Sort by trade_number
    rows.sort(key=lambda r: r["trade_number"])

    # Collect all column names preserving insertion order
    # Collect all column names preserving insertion order
    all_keys: list[str] = []
    seen: set[str] = set()
    for row in rows:
        for key in row:
            if key not in seen:
                all_keys.append(key)
                seen.add(key)

    # Drop columns where every row is empty — avoids trailing blank columns
    # when e.g. no trades have closed yet and all exit_* fields are empty.
    fieldnames = [
        k for k in all_keys
        if any(str(row.get(k, "")).strip() for row in rows)
    ]

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k, "") for k in fieldnames})

    entry_count  = sum(1 for r in rows if r["trade_phase"] == "entry")
    closed_count = sum(1 for r in rows if r["status"] == "closed")
    open_count   = sum(1 for r in rows if r["status"] == "open")
    print(f"Exported {len(rows)} trade(s) -> {out}")
    print(f"  {entry_count} entries  |  {open_count} open  |  {closed_count} closed")


def dated_export(data_dir: str | None = None, out_dir: str | None = None, cfg: dict | None = None) -> str:
    """Run export with a datestamped filename. Returns the output path written.

    Intended to be called from the scheduler or other modules.
    Paths default to the standard V6 EXP layout (data/ relative to this file's
    parent directory) so it works regardless of the working directory.
    """
    base = Path(__file__).parent.parent  # V6 EXP/
    _data = data_dir or str(base / "data")
    _out_dir = out_dir or str(base / "data")
    today = date.today().isoformat()   # e.g. 2026-04-09
    out_path = str(Path(_out_dir) / f"trades_export_{today}.csv")
    export(_data, out_path)

    # Optional: Upload to Dropbox if enabled
    if cfg and cfg.get("dropbox", {}).get("enabled"):
        upload_to_dropbox(out_path, cfg)

    return out_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Export V6 EXP trades to CSV")
    # Default paths resolve relative to V6 EXP/ regardless of cwd
    _base = Path(__file__).parent.parent
    parser.add_argument("--data", default=str(_base / "data"), help="Data directory")
    parser.add_argument(
        "--out",
        default=None,
        help="Output CSV path (default: data/trades_export_YYYY-MM-DD.csv)",
    )
    args = parser.parse_args()

    if args.out:
        export(args.data, args.out)
    else:
        dated_export(args.data)
