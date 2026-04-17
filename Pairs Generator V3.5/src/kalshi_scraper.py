"""
Kalshi scraper — V3
Async HTTP via aiohttp with exponential backoff on 429 (ResearchNotes §1).
Incremental: records last successful run timestamp (ResearchNotes §5).
"""
import asyncio
import json
from datetime import datetime, timezone, timedelta

import aiohttp

from database import get_connection, init_db, get_last_fetched, set_last_fetched

BASE_URL    = "https://api.elections.kalshi.com/trade-api/v2"
BATCH_SIZE  = 50_000
CONCURRENCY = 3   # Kalshi is stricter — keep lower than Polymarket


SPORTS_TICKER_PREFIXES = (
    "KXNBA", "KXNHL", "KXMLB", "KXNFL", "KXMLS", "KXNCAA",
    "KXATP", "KXWTA", "KXGRAND", "KXPGA", "KXLPGA", "KXDP",
    "KXUFC", "KXBOXING",
    "KXUCL", "KXUEL", "KXUECL", "KXEPL", "KXPREMIER",
    "KXLALIGA", "KXSERIEA", "KXSERIEB", "KXBUNDESLIGA",
    "KXLIGUE", "KXLIGAMX", "KXLIGAPORTUGAL",
    "KXMLS", "KXNWSL", "KXBRASILEIRO", "KXARGPREM",
    "KXSUPERLIG", "KXEKSTRAKLASA", "KXBELGIANPL", "KXEREDIVISIE",
    "KXSCOTTISHPREM", "KXDENSUPERLIGA", "KXSLGREECE",
    "KXIPL", "KXT20", "KXKBO", "KXNPB", "KXCBAGAME",
    "KXEUROLEAGUE", "KXNBLGAME", "KXKBLGAME", "KXBBLGAME",
    "KXCS", "KXLOL", "KXVALORANT", "KXDOTA", "KXR6",
    "KXF1", "KXNASCAR", "KXINDYCAR",
    "KXAHLGAME", "KXKHLGAME", "KXSHLGAME",
    "KXAFLGAME", "KXALEAGUE", "KXNRLCHAMP", "KXRUGBY",
    "KXPGAH2H",
)

GOLF_TENNIS_PREFIXES = (
    "KXPGA", "KXLPGA", "KXDP", "KXGOLFMAJORS",
    "KXATPMATCH", "KXATPGRANDSLAM", "KXATPCHALLENGER",
    "KXWTAMATCH", "KXWTAGRANDSLAM", "KXWTACHALLENGER", "KXGRANDSLAM",
)

TITLE_KEYWORDS = {"basketball", "baseball", "football", "tennis", "golf",
                  "motorsport", "mma", "boxing", "cricket", "esports", "soccer"}


async def _fetch_page(session, sem, params, retries=5):
    """Async GET with exponential backoff on 429."""
    delay = 2
    async with sem:
        for attempt in range(retries):
            async with session.get(
                f"{BASE_URL}/markets",
                params=params,
                timeout=aiohttp.ClientTimeout(total=30),
            ) as resp:
                if resp.status == 429:
                    wait = delay * (2 ** attempt)
                    print(f"  Rate limited — waiting {wait}s...")
                    await asyncio.sleep(wait)
                    continue
                resp.raise_for_status()
                return await resp.json()
    raise RuntimeError("Max retries exceeded on Kalshi request")


def _is_sports(ticker, title, subtitle):
    return (
        any(ticker.startswith(p) for p in SPORTS_TICKER_PREFIXES)
        or any(k in title    for k in TITLE_KEYWORDS)
        or any(k in subtitle for k in TITLE_KEYWORDS)
    )


def flush(conn, cursor, batch, stored):
    now_utc = datetime.now(timezone.utc)

    for market in batch:
        ticker   = market.get("ticker", "").upper()
        subtitle = (market.get("subtitle", "") or "").lower()
        title    = (market.get("title",    "") or "").lower()

        if not _is_sports(ticker, title, subtitle):
            continue

        is_golf_tennis = any(ticker.startswith(p) for p in GOLF_TENNIS_PREFIXES)
        max_days_ahead = 14 if is_golf_tennis else 3

        exp_str = market.get("expected_expiration_time") or market.get("close_time", "")
        try:
            exp_dt = datetime.strptime(exp_str[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
        except (ValueError, TypeError):
            continue
        if exp_dt < now_utc - timedelta(hours=6) or exp_dt > now_utc + timedelta(days=max_days_ahead):
            continue

        try:
            cursor.execute(
                """
                INSERT OR REPLACE INTO markets_raw
                    (platform, market_id, title, description, category, end_date, raw_data)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "kalshi",
                    ticker,
                    market.get("title", ""),
                    market.get("subtitle", ""),
                    "sports_fees_v2",
                    exp_str,
                    json.dumps(market),
                ),
            )
            stored += 1
        except Exception as e:
            print(f"  Error storing market {ticker}: {e}")

    conn.commit()
    return stored


async def _run_async():
    init_db()
    print("Fetching Kalshi markets (async)...")

    last_fetched = get_last_fetched("kalshi")
    if last_fetched:
        print(f"  Incremental mode: fetching markets updated after {last_fetched}")
    else:
        print("  Full fetch (no prior state found)")

    run_start = datetime.now(timezone.utc).isoformat()

    now_utc = datetime.now(timezone.utc)
    min_ts  = int((now_utc - timedelta(days=1)).timestamp())
    max_ts  = int((now_utc + timedelta(days=20)).timestamp())

    conn    = get_connection()
    cur     = conn.cursor()
    sem     = asyncio.Semaphore(CONCURRENCY)
    pending = []
    stored  = 0
    total   = 0
    cursor_token = None

    async with aiohttp.ClientSession() as session:
        while True:
            params = {
                "limit":  1000,
                "status": "open",
                "min_ts": min_ts,
                "max_ts": max_ts,
            }
            if cursor_token:
                params["cursor"] = cursor_token

            data = await _fetch_page(session, sem, params)
            batch = data.get("markets", [])
            pending.extend(batch)
            total += len(batch)
            print(f"  Fetched {len(batch)} markets (total so far: {total})")

            if len(pending) >= BATCH_SIZE:
                stored = flush(conn, cur, pending, stored)
                print(f"  Flushed to DB (total stored: {stored})")
                pending.clear()

            cursor_token = data.get("cursor")
            if not cursor_token or not batch:
                break

    if pending:
        stored = flush(conn, cur, pending, stored)

    conn.close()
    set_last_fetched("kalshi", run_start)
    print(f"Stored {stored} Kalshi markets in database.")


def run():
    asyncio.run(_run_async())


if __name__ == "__main__":
    run()
