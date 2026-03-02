import requests
import json
import re
import csv
import sys
import os

# API Constants
KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2"

def get_next_pair_id():
    """Reads the last used ID from a file and returns the next one."""
    if not os.path.exists("counter.txt"):
        with open("counter.txt", "w") as f:
            f.write("0")
        return "pair-0001"
    
    with open("counter.txt", "r") as f:
        content = f.read().strip()
        count = int(content) if content.isdigit() else 0
    
    count += 1
    with open("counter.txt", "w") as f:
        f.write(str(count))
        
    return f"pair-{count:04d}"

def extract_kalshi_ticker(url):
    match = re.search(r'kalshi\.com/markets/([^/?#]+)', url)
    return match.group(1) if match else None

def get_full_market_row():
    # 1. Polymarket Input
    poly_slug = input("Enter Polymarket slug: ").strip()
    poly_api = f"https://gamma-api.polymarket.com/markets?slug={poly_slug}"
    
    try:
        response = requests.get(poly_api)
        response.raise_for_status()
        markets = response.json()
        
        if not markets:
            print("Market not found.")
            return

        poly_data = markets[0]
        
        # 2. Kalshi Input
        kalshi_url = input("Paste Kalshi link: ").strip()
        kalshi_ticker = extract_kalshi_ticker(kalshi_url)

        # 3. Generate ID
        pair_id = get_next_pair_id()

        # Construct Row Data mapping to your requested headers
        row = {
            "pair_id": pair_id,
            "title_clean": poly_data.get("question", "N/A"),
            "category_tag": "default",
            "similarity_score": "1.0",
            "poly_market_id": poly_data.get("conditionId", "N/A"),
            "poly_slug": poly_slug,
            "poly_url": f"https://polymarket.com/market/{poly_slug}",
            "kalshi_market_id": kalshi_ticker or "N/A",
            "kalshi_url": kalshi_url if kalshi_ticker else "N/A"
        }
        
        # Print CSV Row
        writer = csv.DictWriter(sys.stdout, fieldnames=row.keys())
        # Uncomment the next line if you need the header row every time
        # writer.writeheader()
        writer.writerow(row)
        
    except Exception as e:
        print(f"An error occurred: {e}")

if __name__ == "__main__":
    get_full_market_row()