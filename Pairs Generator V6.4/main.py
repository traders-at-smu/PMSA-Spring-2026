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
    print("=== V6.4: Async Sports Pairs Generator ===\n")

    print("=== Step 1 & 2: Scrape sports markets (async) ===\n")
    kalshi_scraper.run()
    print()
    polymarket_scraper.run()

    print("\n=== Step 3: Normalize market titles ===\n")
    normalize_markets.run()

    print("\n=== Step 4: Match sports pairs ===\n")
    match_sports.run()

    print("\n=== Step 5: Export to final pair format ===\n")
    pairs_converter.run()

    for suffix in ("", "-wal", "-shm"):
        p = DB_PATH + suffix
        if os.path.exists(p):
            os.remove(p)
    print("Database cleaned up.")

    print("\nDone. V6.4 Sports pairs exported to outputs/")


if __name__ == "__main__":
    main()
