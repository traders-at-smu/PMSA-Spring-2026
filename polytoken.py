import csv
import os
import sys
from urllib.parse import urlparse

import requests

# API Constants
KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2"
HTTP_TIMEOUT_SEC = 10

def get_next_pair_id():
    if not os.path.exists("counter.txt"):
        with open("counter.txt", "w") as f: f.write("0")
        return "pair-0001"
    with open("counter.txt", "r") as f:
        count = int(f.read().strip())
    count += 1
    with open("counter.txt", "w") as f: f.write(str(count))
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

def main():
    raw_poly_url = input("Paste Polymarket link: ").strip()
    poly_slug = extract_poly_slug(raw_poly_url)
    if not poly_slug:
        raise RuntimeError("Could not extract Polymarket slug from URL")

    poly_api = f"https://gamma-api.polymarket.com/markets?slug={poly_slug}"
    poly_resp = requests.get(poly_api, timeout=HTTP_TIMEOUT_SEC).json()
    if isinstance(poly_resp, list) and not poly_resp:
        raise RuntimeError(f"No Polymarket market found for slug: {poly_slug}")
    poly_data = poly_resp[0] if isinstance(poly_resp, list) else poly_resp

    kalshi_url = input("Paste Kalshi link: ").strip()
    kalshi_market_like = extract_kalshi_market_like(kalshi_url)
    if not kalshi_market_like:
        raise RuntimeError("Could not extract Kalshi market path from URL")

    submarkets = get_submarkets(kalshi_market_like)
    if not submarkets:
        raise RuntimeError(f"No Kalshi subcontracts found for input: {kalshi_market_like}")

    print("\nWhich subcontract do you want to pick?")
    for i, m in enumerate(submarkets, 1):
        print(f"{i}) {m.get('display_name', subcontract_display_name(m))}")

    choice = int(input("\nEnter choice number: ")) - 1
    if choice < 0 or choice >= len(submarkets):
        raise RuntimeError("Choice out of range")
    selected = submarkets[choice]

    pair_id = get_next_pair_id()
    row = {
        "pair_id": pair_id,
        "title_clean": poly_data.get("question", "N/A"),
        "category_tag": "default",
        "similarity_score": "1.0",
        "poly_market_id": poly_data.get("conditionId", "N/A"),
        "poly_slug": poly_slug,
        "poly_url": f"https://polymarket.com/market/{poly_slug}",
        "kalshi_market_id": selected["ticker"],
        "kalshi_url": f"https://kalshi.com/markets/{selected['ticker']}",
    }

    writer = csv.DictWriter(sys.stdout, fieldnames=row.keys())
    writer.writerow(row)

if __name__ == "__main__":
    main()
