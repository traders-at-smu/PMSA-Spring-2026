import csv
import json
import sqlite3
from collections import Counter
from database import get_connection


def _normalize_token_ids_list(raw):
    """Return a list of token ID strings, handling pre-serialized strings."""
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, list) else []
        except Exception:
            return []
    return list(raw) if raw else []


def _normalize_token_ids(raw):
    """Return a JSON array string of token IDs, handling pre-serialized strings."""
    return json.dumps(_normalize_token_ids_list(raw))

KALSHI_MARKET_URL    = "https://kalshi.com/markets/{event_ticker}"
POLYMARKET_EVENT_URL = "https://polymarket.com/event/{slug}"

import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_FILE = os.path.join(BASE_DIR, "..", "outputs", "matched_pairs.csv")


def run():
    conn = get_connection()

    rows = conn.execute("""
        SELECT
            k.market_id                                        AS kalshi_id,
            kr.raw_data                                        AS kalshi_raw,
            kr.title                                           AS kalshi_title,
            k.category                                         AS kalshi_category,
            k.normalized_title                                 AS kalshi_normalized,
            p.market_id                                        AS poly_id,
            pr.title                                           AS poly_title,
            p.category                                         AS poly_category,
            p.outcome                                          AS poly_outcome,
            p.normalized_title                                 AS poly_normalized,
            pr.raw_data                                        AS poly_raw
        FROM markets_normalized k
        JOIN markets_normalized p
            ON k.normalized_title = p.normalized_title
        JOIN markets_raw kr
            ON kr.platform = 'kalshi'  AND kr.market_id = k.market_id
        JOIN markets_raw pr
            ON pr.platform = 'polymarket' AND pr.market_id = p.market_id
        WHERE k.platform = 'kalshi'
          AND p.platform = 'polymarket'
        ORDER BY k.normalized_title
    """).fetchall()

    conn.close()

    if not rows:
        print("No matched pairs found.")
        return

    # Count by category
    counts = Counter()
    for row in rows:
        counts[row['kalshi_category'] or 'None'] += 1
    
    print(f"Exported {len(rows)} matched pairs to {OUTPUT_FILE}")
    print("Breakdown by category:")
    for cat, count in counts.most_common():
        print(f"  {cat}: {count}")

    with open(OUTPUT_FILE, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow([
            "pair_id", "title_clean", "category_tag", "similarity_score",
            "poly_market_id", "poly_slug", "poly_url",
            "kalshi_market_id", "kalshi_url",
            "poly_event_url", "poly_outcomes_json", "poly_token_ids_json",
            "poly_primary_outcome", "expiry_poly_utc", "expiry_kalshi_utc",
            "resolution_time_utc"
        ])

        for i, row in enumerate(rows):
            poly_raw = {}
            try:
                poly_raw = json.loads(row["poly_raw"] or "{}")
            except Exception:
                pass

            kalshi_raw = {}
            try:
                kalshi_raw = json.loads(row["kalshi_raw"] or "{}")
            except Exception:
                pass

            slug = poly_raw.get("slug", "")
            poly_url = f"https://polymarket.com/event/{slug}" if slug else ""
            
            # Kalshi URL
            ticker = kalshi_raw.get("event_ticker") or row["kalshi_id"]
            kalshi_url = KALSHI_MARKET_URL.format(event_ticker=ticker)

            outcomes_raw = poly_raw.get("outcomes")
            if isinstance(outcomes_raw, str):
                try:
                    outcomes = json.loads(outcomes_raw)
                except:
                    outcomes = [outcomes_raw]
            else:
                outcomes = outcomes_raw or []

            primary_outcome = row["poly_outcome"]
            if not primary_outcome and outcomes:
                primary_outcome = outcomes[0]

            # Normalize and align tokens so primary_outcome is always at index 0
            token_ids = _normalize_token_ids_list(poly_raw.get("clobTokenIds", []))
            if (primary_outcome and len(outcomes) >= 2 and len(token_ids) >= 2
                    and outcomes[0].strip().lower() != primary_outcome.strip().lower()
                    and outcomes[1].strip().lower() == primary_outcome.strip().lower()):
                outcomes = [outcomes[1], outcomes[0]]
                token_ids = [token_ids[1], token_ids[0]]

            writer.writerow([
                i + 1,
                row["kalshi_normalized"],
                row["kalshi_category"],
                1.0, # Similarity score for exact matches
                row["poly_id"],
                slug,
                poly_url,
                row["kalshi_id"],
                kalshi_url,
                poly_url,
                json.dumps(outcomes),
                json.dumps(token_ids),
                primary_outcome,
                poly_raw.get("endDateIso") or poly_raw.get("closeTime", ""),
                kalshi_raw.get("close_time", ""),
                poly_raw.get("endDateIso") or ""
            ])


if __name__ == "__main__":
    run()
