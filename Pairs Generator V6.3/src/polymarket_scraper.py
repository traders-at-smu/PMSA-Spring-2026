"""
Polymarket scraper — V3
Async HTTP via aiohttp with a semaphore to respect rate limits (ResearchNotes §1).
Incremental: only stores markets created/updated after last successful run (ResearchNotes §5).
"""
import asyncio
import json
from datetime import datetime, timedelta, timezone

import aiohttp

from database import get_connection, init_db, get_last_fetched, set_last_fetched

GAMMA_URL   = "https://gamma-api.polymarket.com"
BATCH_SIZE  = 50_000
CONCURRENCY = 5   # max parallel requests (ResearchNotes §1 semaphore)


def _parse_end_dt(end_date: str):
    if not end_date:
        return None
    for fmt in (
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%dT%H:%M:%S.%fZ",
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M%z",
        "%Y-%m-%d",
    ):
        try:
            dt = datetime.strptime(end_date[:26], fmt)
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


GOLF_TOURNAMENT_KEYWORDS = {"pga", "lpga", "masters", "open championship", "us open", "golf"}

def flush(conn, cursor, batch, stored):
    now    = datetime.now(timezone.utc)

    for market in batch:
        category = (market.get("feeType") or market.get("category") or "").lower()
        question = market.get("question", "").lower()

        sports_keywords = {
            "sport", "nba", "nfl", "nhl", "mlb", "soccer", "basketball",
            "baseball", "football", "tennis", "golf", "motorsport", "mma",
            "boxing", "cricket", "esports",
            # Golf tournament phrases (NegRisk markets have feeType=None and no
            # sport keyword in the question, just the tournament name)
            "masters tournament", "pga championship", "pga tour", "lpga tour",
            "us open golf", "open championship",
        }
        # Also check the events array title/slug (NegRisk grouped markets)
        event_context = ""
        events_list = market.get("events") or []
        if events_list and isinstance(events_list, list):
            ev0 = events_list[0]
            event_context = ((ev0.get("title") or "") + " " + (ev0.get("slug") or "")).lower()

        is_sports = (
            any(k in category for k in sports_keywords)
            or any(k in question for k in sports_keywords)
            or any(k in event_context for k in sports_keywords | {"golf", "pga", "lpga", "masters"})
        )
        if not is_sports:
            continue

        # Golf/tournament markets often resolve weeks after the event — use a
        # wider window so winner markets don't get cut by the 14-day ceiling.
        is_golf = any(k in question for k in GOLF_TOURNAMENT_KEYWORDS) or "golf" in category
        cutoff = now + timedelta(days=30 if is_golf else 14)

        end_date = market.get("endDateIso", "") or market.get("closeTime", "")
        end_dt   = _parse_end_dt(end_date)
        six_hours_ago = now - timedelta(hours=6)
        if not end_dt or end_dt < six_hours_ago or end_dt > cutoff:
            continue

        try:
            cursor.execute(
                """
                INSERT OR REPLACE INTO markets_raw
                    (platform, market_id, title, description, category, end_date, raw_data)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "polymarket",
                    str(market.get("id", "")),
                    market.get("question", ""),
                    market.get("description", ""),
                    category,
                    market.get("endDateIso", ""),
                    json.dumps(market),
                ),
            )
            stored += 1
        except Exception as e:
            print(f"  Error storing market {market.get('id')}: {e}")

    conn.commit()
    return stored


async def _fetch_page(session, sem, offset, limit, last_fetched_iso):
    """Fetch one page of markets with rate-limit semaphore."""
    params = {"limit": limit, "offset": offset, "closed": "false", "order": "endDateIso", "ascending": "true"}
    # Note: Polymarket Gamma API does not support an updated_after filter.
    # Incremental efficiency is handled by INSERT OR REPLACE (no-op on duplicates).

    async with sem:
        async with session.get(f"{GAMMA_URL}/markets", params=params, timeout=aiohttp.ClientTimeout(total=30)) as resp:
            resp.raise_for_status()
            return await resp.json()


async def _run_async():
    init_db()
    print("Fetching Polymarket markets (async)...")

    last_fetched = get_last_fetched("polymarket")
    if last_fetched:
        print(f"  Last run: {last_fetched} (fetching all open markets; duplicates skipped by DB)")
    else:
        print("  First run — full fetch")

    run_start = datetime.now(timezone.utc).isoformat()

    conn    = get_connection()
    cur     = conn.cursor()
    sem     = asyncio.Semaphore(CONCURRENCY)
    pending = []
    stored  = 0
    total   = 0
    limit   = 100
    offset  = 0

    async with aiohttp.ClientSession() as session:
        while True:
            # Fetch the next batch of pages concurrently
            tasks = [
                _fetch_page(session, sem, offset + i * limit, limit, last_fetched)
                for i in range(CONCURRENCY)
            ]
            results = await asyncio.gather(*tasks, return_exceptions=True)

            exhausted = False
            for batch in results:
                if isinstance(batch, Exception):
                    print(f"  Page error: {batch}")
                    exhausted = True
                    break
                if not batch:
                    exhausted = True
                    break
                pending.extend(batch)
                total += len(batch)
                print(f"  Fetched {len(batch)} markets (total so far: {total})")
                if len(batch) < limit:
                    exhausted = True

            if len(pending) >= BATCH_SIZE:
                stored = flush(conn, cur, pending, stored)
                print(f"  Flushed to DB (total stored: {stored})")
                pending.clear()

            if exhausted:
                break

            offset += CONCURRENCY * limit

    if pending:
        stored = flush(conn, cur, pending, stored)

    conn.close()
    set_last_fetched("polymarket", run_start)
    print(f"Stored {stored} Polymarket markets in database.")


def run():
    asyncio.run(_run_async())


if __name__ == "__main__":
    run()
