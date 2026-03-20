# Miguel

Assignee: Miguel Gutierrez
Status: Not Started

# Miguel — **Pair Matching + Quote Pull + Boxed-Arb Pre-Filter**

### What you must bring

**A. `pairs.csv` with at least 50 rows**

Each row must have:

- `pair_id` (unique)
- `poly_market_id`
- `kalshi_market_id`
- `title_clean`
- `expiry_poly_utc`
- `expiry_kalshi_utc`
- `similarity_score` (0–1)
- `category_tag` (even if rough: politics/macro/sports/crypto/other)

**B. A script `live_quotes.py`**

When run, it must print/save **every 30 seconds**:

- `timestamp`
- `pair_id`
- `poly_yes_ask, poly_no_ask`
- `kal_yes_ask, kal_no_ask`

Minimum: must work for **20+ pairs** without crashing.

**C. A script `raw_boxed_filter.py`**

For each pair in `pairs.csv`, compute:

- `cost1 = poly_yes_ask + kal_no_ask` (fees can be placeholder here)
- `cost2 = poly_no_ask + kal_yes_ask`
- `best_cost, best_direction, edge_raw = 1 - best_cost`

Output: `opportunities_raw.csv` sorted by `edge_raw` descending.

✅ Acceptance criteria for Wed:

- You can hit run and produce a ranked list of raw boxed-arb candidates in real time.