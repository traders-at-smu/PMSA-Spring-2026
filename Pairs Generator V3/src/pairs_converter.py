import csv
import os
import re
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUTS_DIR = os.path.join(BASE_DIR, "..", "outputs")
INPUT_FILE = os.path.join(OUTPUTS_DIR, "matched_sports_pairs.csv")

def get_output_filename():
    """Generates a filename in the format output-mm-dd-yy.csv."""
    now = datetime.now()
    return os.path.join(OUTPUTS_DIR, now.strftime("output-%m-%d-%y.csv"))

def extract_slug(url):
    """Extracts the slug from a Polymarket URL."""
    if not url:
        return ""
    # Matches everything after /event/
    match = re.search(r"/event/([^/?#]+)", url)
    return match.group(1) if match else ""

# Maps sport/category to Polymarket fee labels
CATEGORY_MAP = {
    "Sports":             "sports_fees_v2",
    "Soccer":             "sports_fees_v2",
    "Basketball":         "sports_fees_v2",
    "Baseball":           "sports_fees_v2",
    "Ice Hockey":         "sports_fees_v2",
    "American Football":  "sports_fees_v2",
    "Tennis":             "sports_fees_v2",
    "Golf":               "sports_fees_v2",
    "Motorsport":         "sports_fees_v2",
    "MMA":                "sports_fees_v2",
    "Boxing":             "sports_fees_v2",
    "Cricket":            "sports_fees_v2",
    "Esports":            "sports_fees_v2",
    "Politics":           "politics_fees",
    "Crypto":             "crypto_fees_v2",
    "Weather":            "weather_fees",
    "Economics":          "economics_fees",
    "Finance":            "finance_prices_fees",
    "Culture":            "culture_fees",
    "Tech":               "tech_fees",
}

def run():
    if not os.path.exists(INPUT_FILE):
        print(f"Error: {INPUT_FILE} not found. Please run the matching process first.")
        return

    output_file = get_output_filename()
    print(f"Translating {INPUT_FILE} to {output_file}...")

    results = []
    with open(INPUT_FILE, "r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for i, row in enumerate(reader):
            # Calculate a basic similarity score
            shared_teams = row.get("shared_teams", "").split(";")
            shared_count = len([t for t in shared_teams if t.strip()])
            days_apart = int(row.get("days_apart", 0))
            similarity_score = min(1.0, (shared_count - (days_apart * 0.1)) / 2.0) if shared_count >= 2 else 0.0
            
            # Map sport to Polymarket fee tag
            sport = row.get("sport", "Sports")
            fee_tag = CATEGORY_MAP.get(sport, "general_fees")
            
            converted = {
                "pair_id": i + 1,
                "title_clean": row.get("poly_title", ""),
                "category_tag": fee_tag,
                "similarity_score": round(similarity_score, 2),
                "poly_market_id": row.get("poly_market_id", ""),
                "poly_slug": row.get("poly_slug", ""),
                "poly_url": row.get("poly_url", ""),
                "kalshi_market_id": row.get("kalshi_market_id", ""),
                "kalshi_url": row.get("kalshi_url", ""),
                "poly_event_url": row.get("poly_event_url", ""),
                "poly_outcomes_json": row.get("poly_outcomes", "[]"),
                "poly_token_ids_json": row.get("poly_token_ids", "[]"),
                "poly_primary_outcome": row.get("poly_outcome", ""),
                "expiry_poly_utc": row.get("expiry_poly_utc", ""),
                "expiry_kalshi_utc": row.get("expiry_kalshi_utc", ""),
                "resolution_time_utc": row.get("resolution_time", "")
            }
            results.append(converted)

    if not results:
        print("No records found to convert.")
        return

    fieldnames = [
        "pair_id", "title_clean", "category_tag", "similarity_score",
        "poly_market_id", "poly_slug", "poly_url",
        "kalshi_market_id", "kalshi_url",
        "poly_event_url", "poly_outcomes_json", "poly_token_ids_json",
        "poly_primary_outcome", "expiry_poly_utc", "expiry_kalshi_utc",
        "resolution_time_utc"
    ]

    with open(output_file, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(results)

    print(f"Successfully converted {len(results)} pairs to {output_file}")

if __name__ == "__main__":
    run()
