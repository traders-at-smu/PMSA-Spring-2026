import argparse
import csv
import sys
from pathlib import Path
from urllib.parse import urlparse

import requests

# API Constants
KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2"
POLY_GAMMA_BASE = "https://gamma-api.polymarket.com"
HTTP_TIMEOUT_SEC = 10
OUTPUT_FIELDS = [
    "pair_id",
    "title_clean",
    "category_tag",
    "similarity_score",
    "poly_market_id",
    "poly_slug",
    "poly_url",
    "kalshi_market_id",
    "kalshi_url",
    "expiry_poly_utc",
    "expiry_kalshi_utc",
    "resolution_time_utc",
]

COUNTER_PATH = Path(__file__).resolve().parent / "counter.txt"
REPO_ROOT = Path(__file__).resolve().parent.parent
XLSX_PATHS = [
    REPO_ROOT / "V2" / "Pairs_for_Kalshi_and_Polymarket.xlsx",
    REPO_ROOT / "V4" / "Pairs_for_Kalshi_and_Polymarket.xlsx",
    REPO_ROOT / "V5" / "Pairs_for_Kalshi_and_Polymarket.xlsx",
]


def _normalize_header(value):
    return "".join(ch for ch in str(value or "").strip().lower() if ch.isalnum())


def load_existing_pair_keys() -> set[tuple[str, str]]:
    """Load all (poly_market_id, kalshi_market_id) tuples from existing Excel files."""
    keys: set[tuple[str, str]] = set()
    try:
        from openpyxl import load_workbook
    except ImportError:
        print("Warning: openpyxl not installed, skipping duplicate check", file=sys.stderr)
        return keys

    for xlsx_path in XLSX_PATHS:
        if not xlsx_path.exists():
            continue
        try:
            wb = load_workbook(xlsx_path, read_only=True, data_only=True)
            ws = wb.active
            headers = [ws.cell(row=1, column=c).value for c in range(1, ws.max_column + 1)]
            header_map = {_normalize_header(h): i for i, h in enumerate(headers)}
            poly_idx = header_map.get("polymarketid") or header_map.get("poly_market_id")
            kalshi_idx = header_map.get("kalshimarketid") or header_map.get("kalshi_market_id")
            if poly_idx is None or kalshi_idx is None:
                # Try normalized versions
                for k, v in header_map.items():
                    if "poly" in k and "id" in k:
                        poly_idx = v
                    if "kalshi" in k and ("id" in k or "ticker" in k):
                        kalshi_idx = v
            if poly_idx is None or kalshi_idx is None:
                wb.close()
                continue
            for row in ws.iter_rows(min_row=2, values_only=True):
                poly_id = str(row[poly_idx] or "").strip() if poly_idx < len(row) else ""
                kalshi_id = str(row[kalshi_idx] or "").strip() if kalshi_idx < len(row) else ""
                if poly_id and kalshi_id:
                    keys.add((poly_id, kalshi_id))
            wb.close()
        except Exception as exc:
            print(f"Warning: could not read {xlsx_path.name}: {exc}", file=sys.stderr)
    return keys


def get_next_pair_id():
    if not COUNTER_PATH.exists():
        COUNTER_PATH.write_text("1", encoding="utf-8")
        return "pair-0001"
    count = int(COUNTER_PATH.read_text(encoding="utf-8").strip())
    count += 1
    COUNTER_PATH.write_text(str(count), encoding="utf-8")
    return f"pair-{count:04d}"

def extract_poly_slug(url):
    """Safely extracts slug from Polymarket URL."""
    path = urlparse(url).path
    parts = [p for p in path.split("/") if p]
    try:
        if "event" in parts:
            return parts[-1]
        return parts[-1]
    except Exception:
        return None


def _poly_display_name(market):
    """Human-readable Polymarket market label."""
    if not isinstance(market, dict):
        return "Unknown market"
    question = str(market.get("question", "")).strip()
    slug = str(market.get("slug", "")).strip()
    if question and slug:
        return f"{question} [{slug}]"
    if question:
        return question
    if slug:
        return slug
    return str(market.get("conditionId", "Unknown market"))


def resolve_polymarket_contracts(poly_slug):
    """
    Resolves Polymarket contracts from either:
    - direct market slug (/market/<slug>)
    - event slug (/event/<slug> or /sports/.../<slug>)
    """
    slug = str(poly_slug or "").strip()
    if not slug:
        raise RuntimeError("Polymarket slug is empty")

    market_resp = requests.get(
        f"{POLY_GAMMA_BASE}/markets",
        params={"slug": slug},
        timeout=HTTP_TIMEOUT_SEC,
    )
    market_resp.raise_for_status()
    market_rows = market_resp.json()
    if isinstance(market_rows, list) and market_rows:
        return [market_rows[0]]
    if isinstance(market_rows, dict) and market_rows.get("conditionId"):
        return [market_rows]

    event_resp = requests.get(
        f"{POLY_GAMMA_BASE}/events",
        params={"slug": slug},
        timeout=HTTP_TIMEOUT_SEC,
    )
    event_resp.raise_for_status()
    event_rows = event_resp.json()
    if not isinstance(event_rows, list) or not event_rows:
        raise RuntimeError(f"No Polymarket market or event found for slug: {slug}")

    event = event_rows[0]
    raw_markets = event.get("markets", [])
    markets = [m for m in raw_markets if isinstance(m, dict)]
    if not markets:
        raise RuntimeError(f"Event has no markets for slug: {slug}")

    active_markets = [m for m in markets if bool(m.get("active")) and not bool(m.get("closed"))]
    candidates = active_markets or markets

    return candidates


def resolve_polymarket_market(poly_slug, context_label=""):
    """Backward-compatible single-market resolver with interactive disambiguation."""
    candidates = resolve_polymarket_contracts(poly_slug)
    if len(candidates) == 1:
        return candidates[0]

    prefix = f"{context_label} " if context_label else ""
    print(f"\n{prefix}Multiple Polymarket markets found for this event. Pick one:")
    for i, market in enumerate(candidates, 1):
        print(f"{i}) {_poly_display_name(market)}")

    choice = int(input(f"\n{prefix}Enter Polymarket choice number: ")) - 1
    if choice < 0 or choice >= len(candidates):
        raise RuntimeError("Polymarket choice out of range")
    return candidates[choice]


def extract_kalshi_market_like(url_or_ticker):
    """Extracts Kalshi market path from URL (supports nested /markets/<event>/<market>)."""
    value = str(url_or_ticker or "").strip()
    if not value:
        return ""

    if "://" not in value and "kalshi.com" in value:
        value = f"https://{value}"

    parsed = urlparse(value)
    if parsed.scheme and parsed.netloc:
        parts = [p for p in parsed.path.split("/") if p]
        for i, part in enumerate(parts):
            if part.lower() == "markets" and i + 1 < len(parts):
                return "/".join(parts[i + 1 :]).strip()
        return ""

    # Fallback for direct ticker/event-like input.
    return value


def event_ticker_from_market_like(value):
    """Best-effort conversion of market-like value to Kalshi event ticker."""
    ticker = str(value or "").strip()
    if not ticker:
        return ""
    if "/" in ticker:
        ticker = ticker.split("/")[-1].strip()
    ticker = ticker.upper()
    if ticker.count("-") >= 2:
        return ticker.rsplit("-", 1)[0]
    return ticker


def _get_market_payload(market_like):
    """
    Resolves a market payload from possible market-like values.
    Handles nested URL path forms such as "<event>/<market>".
    """
    candidates = []
    for candidate in [market_like, str(market_like).split("/")[-1].strip()]:
        c = str(candidate or "").strip()
        if c and c not in candidates:
            candidates.append(c)

    for candidate in candidates:
        res = requests.get(f"{KALSHI_BASE}/markets/{candidate}", timeout=HTTP_TIMEOUT_SEC)
        if res.status_code == 404:
            continue
        res.raise_for_status()
        payload = res.json()
        market = payload.get("market")
        if isinstance(market, dict):
            return market
    return None


def subcontract_display_name(market):
    """Returns a stable human-readable subcontract name."""
    if not isinstance(market, dict):
        return "Unknown subcontract"

    # In event markets like "Who will win MVP?", the player/candidate is
    # usually stored in yes_sub_title while title is generic across all rows.
    yes_sub = str(market.get("yes_sub_title", "")).strip()
    if yes_sub:
        return yes_sub

    for key in ("title", "subtitle", "ticker"):
        value = str(market.get(key, "")).strip()
        if value:
            return value
    return "Unknown subcontract"


def _normalize_match_text(value):
    chars = []
    for ch in str(value or "").lower():
        if ch.isalnum():
            chars.append(ch)
        else:
            chars.append(" ")
    return " ".join("".join(chars).split())


def _poly_contract_match_text(market):
    if not isinstance(market, dict):
        return ""
    pieces = []
    for key in ("question", "title", "subtitle", "groupItemTitle", "slug"):
        val = str(market.get(key, "")).strip()
        if val:
            pieces.append(val)
    return _normalize_match_text(" ".join(pieces))


def _build_mapping_row(poly_market, poly_market_slug, kalshi_submarket):
    pair_id = get_next_pair_id()
    # Extract expiry from Polymarket (Gamma API returns endDate or end_date_iso)
    expiry_poly = (
        poly_market.get("endDate")
        or poly_market.get("end_date_iso")
        or poly_market.get("end_date")
        or ""
    )
    # Extract expiry from Kalshi (markets API returns close_time)
    expiry_kalshi = kalshi_submarket.get("close_time") or ""
    return {
        "pair_id": pair_id,
        "title_clean": poly_market.get("question", "N/A"),
        "category_tag": "default",
        "similarity_score": "1.0",
        "poly_market_id": poly_market.get("conditionId", "N/A"),
        "poly_slug": poly_market_slug,
        "poly_url": f"https://polymarket.com/market/{poly_market_slug}",
        "kalshi_market_id": kalshi_submarket["ticker"],
        "kalshi_url": f"https://kalshi.com/markets/{kalshi_submarket['ticker']}",
        "expiry_poly_utc": expiry_poly,
        "expiry_kalshi_utc": expiry_kalshi,
    }


def get_submarkets(market_like):
    """Fetches all markets linked to the same Kalshi event."""
    market_data = _get_market_payload(market_like)
    event_ticker = ""
    if isinstance(market_data, dict):
        event_ticker = str(market_data.get("event_ticker", "")).strip()
    if not event_ticker:
        event_ticker = event_ticker_from_market_like(market_like)
    if not event_ticker:
        return []

    markets = []
    cursor = None
    while True:
        params = {"event_ticker": event_ticker, "limit": 500}
        if cursor:
            params["cursor"] = cursor

        res = requests.get(f"{KALSHI_BASE}/markets", params=params, timeout=HTTP_TIMEOUT_SEC)
        res.raise_for_status()
        payload = res.json()
        page_markets = payload.get("markets", [])
        if isinstance(page_markets, list):
            markets.extend([m for m in page_markets if isinstance(m, dict)])

        cursor = payload.get("cursor")
        if not cursor or not page_markets:
            break

    # Deduplicate and attach a display name fallback for each subcontract.
    deduped = {}
    for market in markets:
        ticker = str(market.get("ticker", "")).strip()
        if not ticker:
            continue
        if ticker in deduped:
            continue
        market["display_name"] = subcontract_display_name(market)
        deduped[ticker] = market

    return list(deduped.values())


def _normalize_header_name(value):
    return "".join(ch for ch in str(value or "").strip().lower() if ch.isalnum())


def _looks_like_header(first_col, second_col):
    poly_header = _normalize_header_name(first_col)
    kalshi_header = _normalize_header_name(second_col)
    poly_candidates = {
        "polymarket",
        "poly",
        "polymarketlink",
        "polymarketurl",
        "polyurl",
        "polylink",
    }
    kalshi_candidates = {"kalshi", "kalshilink", "kalshiurl"}
    return poly_header in poly_candidates and kalshi_header in kalshi_candidates


def _iter_link_rows(path):
    suffix = path.suffix.lower()
    if suffix == ".csv":
        with path.open("r", newline="", encoding="utf-8-sig") as f:
            for row in csv.reader(f):
                yield row
        return
    if suffix == ".xlsx":
        try:
            from openpyxl import load_workbook
        except ImportError as exc:
            raise RuntimeError("Reading .xlsx files requires openpyxl. Run: pip install openpyxl") from exc
        workbook = load_workbook(path, read_only=True, data_only=True)
        try:
            sheet = workbook.active
            for row in sheet.iter_rows(values_only=True):
                yield list(row)
        finally:
            workbook.close()
        return
    raise RuntimeError("Input file must be .csv or .xlsx")


def load_link_pairs(input_file):
    path = Path(input_file)
    if not path.exists():
        raise RuntimeError(f"Input file does not exist: {input_file}")

    pairs = []
    for row_num, row in enumerate(_iter_link_rows(path), 1):
        first = str(row[0]).strip() if len(row) > 0 and row[0] is not None else ""
        second = str(row[1]).strip() if len(row) > 1 and row[1] is not None else ""

        if not first and not second:
            continue
        if row_num == 1 and _looks_like_header(first, second):
            continue
        if not first or not second:
            raise RuntimeError(
                f"Input row {row_num} must include Polymarket link in column 1 and Kalshi link in column 2"
            )
        pairs.append((row_num, first, second))

    if not pairs:
        raise RuntimeError("Input file has no valid link rows")
    return pairs


def build_output_rows(raw_poly_url, kalshi_url, context_label=""):
    poly_slug = extract_poly_slug(raw_poly_url)
    if not poly_slug:
        raise RuntimeError("Could not extract Polymarket slug from URL")

    poly_contracts = resolve_polymarket_contracts(poly_slug)
    if not poly_contracts:
        raise RuntimeError(f"No Polymarket contracts found for slug: {poly_slug}")

    kalshi_market_like = extract_kalshi_market_like(kalshi_url)
    if not kalshi_market_like:
        raise RuntimeError("Could not extract Kalshi market path from URL")

    submarkets = get_submarkets(kalshi_market_like)
    if not submarkets:
        raise RuntimeError(f"No Kalshi subcontracts found for input: {kalshi_market_like}")

    # Auto-map any Kalshi subcontract where its full normalized name is contained
    # in the normalized Polymarket contract text.
    auto_rows = []
    seen_pairs = set()
    for submarket in submarkets:
        kalshi_name = str(submarket.get("display_name", subcontract_display_name(submarket))).strip()
        kalshi_norm = _normalize_match_text(kalshi_name)
        if not kalshi_norm:
            continue
        for poly_market in poly_contracts:
            poly_text = _poly_contract_match_text(poly_market)
            if kalshi_norm and kalshi_norm in poly_text:
                poly_market_slug = str(poly_market.get("slug", "")).strip() or poly_slug
                pair_key = (str(poly_market.get("conditionId", "")), str(submarket.get("ticker", "")))
                if pair_key in seen_pairs:
                    continue
                seen_pairs.add(pair_key)
                auto_rows.append(_build_mapping_row(poly_market, poly_market_slug, submarket))

    if auto_rows:
        return auto_rows

    # Fallback behavior: interactive selection when no automatic contains-match found.
    prefix = f"{context_label} " if context_label else ""
    poly_data = resolve_polymarket_market(poly_slug, context_label=context_label)
    poly_market_slug = str(poly_data.get("slug", "")).strip() or poly_slug

    prefix = f"{context_label} " if context_label else ""
    print(f"\n{prefix}Which subcontract do you want to pick?")
    for i, m in enumerate(submarkets, 1):
        print(f"{i}) {m.get('display_name', subcontract_display_name(m))}")

    choice = int(input(f"\n{prefix}Enter choice number: ")) - 1
    if choice < 0 or choice >= len(submarkets):
        raise RuntimeError("Choice out of range")
    selected = submarkets[choice]

    return [_build_mapping_row(poly_data, poly_market_slug, selected)]


def parse_args():
    parser = argparse.ArgumentParser(
        description="Create mapping rows from Polymarket and Kalshi links (interactive or file batch mode)."
    )
    parser.add_argument(
        "input_file",
        nargs="?",
        help="Optional .csv or .xlsx file where column 1 is Polymarket link and column 2 is Kalshi link.",
    )
    return parser.parse_args()


def _is_duplicate(row, existing_keys):
    """Check if a row's (poly_market_id, kalshi_market_id) already exists."""
    pair_key = (
        str(row.get("poly_market_id", "")).strip(),
        str(row.get("kalshi_market_id", "")).strip(),
    )
    if pair_key[0] and pair_key[1] and pair_key in existing_keys:
        return True
    return False


def main():
    args = parse_args()
    writer = csv.DictWriter(sys.stdout, fieldnames=OUTPUT_FIELDS)

    existing_keys = load_existing_pair_keys()
    if existing_keys:
        print(f"Loaded {len(existing_keys)} existing pairs for duplicate checking", file=sys.stderr)

    duplicates_skipped = 0

    if args.input_file:
        pairs = load_link_pairs(args.input_file)
        successes = 0
        for row_num, poly_link, kalshi_link in pairs:
            context_label = f"[row {row_num}]"
            try:
                rows = build_output_rows(poly_link, kalshi_link, context_label=context_label)
            except Exception as exc:
                print(f"{context_label} Failed: {exc}", file=sys.stderr)
                continue
            for row in rows:
                if _is_duplicate(row, existing_keys):
                    print(f"{context_label} Skipped duplicate: {row.get('kalshi_market_id', '?')}", file=sys.stderr)
                    duplicates_skipped += 1
                    continue
                writer.writerow(row)
                successes += 1

        if duplicates_skipped:
            print(f"Skipped {duplicates_skipped} duplicate pair(s)", file=sys.stderr)
        if successes == 0 and duplicates_skipped == 0:
            raise RuntimeError("No rows were processed successfully")
        return

    raw_poly_url = input("Paste Polymarket link: ").strip()
    kalshi_url = input("Paste Kalshi link: ").strip()
    rows = build_output_rows(raw_poly_url, kalshi_url)
    for row in rows:
        if _is_duplicate(row, existing_keys):
            print(f"Skipped duplicate: {row.get('kalshi_market_id', '?')}", file=sys.stderr)
            duplicates_skipped += 1
            continue
        writer.writerow(row)

    if duplicates_skipped:
        print(f"Skipped {duplicates_skipped} duplicate pair(s)", file=sys.stderr)

if __name__ == "__main__":
    main()
