import os
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

import kalshi_scraper
import polymarket_scraper
import normalize_markets
import match_sports
import pairs_converter

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "markets.db")


def main():
    print("=== V6.32: Async Sports Pairs Generator ===\n")

    print("=== Step 1 & 2: Scrape sports markets (async) ===\n")
    kalshi_scraper.run()
    print()
    polymarket_scraper.run()

    print("\n=== Step 3: Normalize market titles ===\n")
    normalize_markets.run()

    print("\n=== Step 4: Match sports pairs ===\n")
    match_sports.run()

    # DEBUG: sample Polymarket sports rows to diagnose 0-match issue
    import sqlite3, json
    _conn = sqlite3.connect(DB_PATH)
    _conn.row_factory = sqlite3.Row
    _rows = _conn.execute("""
        SELECT mr.title, mr.end_date, mn.normalized_title, mn.outcome, mr.raw_data
        FROM markets_raw mr
        JOIN markets_normalized mn ON mr.id = mn.raw_id
        WHERE mr.platform = 'polymarket'
        LIMIT 5
    """).fetchall()
    print("\nDEBUG — sample Polymarket sports rows:")
    for _r in _rows:
        _rd = json.loads(_r["raw_data"])
        print(f"  title: {_r['title'][:70]}")
        print(f"  end_date: {_r['end_date']}  outcome: {_r['outcome']}")
        print(f"  slug: {_rd.get('slug','')[:60]}")
        print(f"  gameStartTime: {_rd.get('gameStartTime','')}  endDateIso: {_rd.get('endDateIso','')}")
        print()
    _conn.close()

    print("\n=== Step 5: Export to final pair format ===\n")
    pairs_converter.run()

    for suffix in ("", "-wal", "-shm"):
        p = DB_PATH + suffix
        if os.path.exists(p):
            os.remove(p)
    print("Database cleaned up.")

    print("\nDone. V6.32 Sports pairs exported to outputs/")


if __name__ == "__main__":
    main()
