# Kalshi + Polymarket Mispricing Bot

Cross-exchange arbitrage bot with:
- Market pulls from Kalshi and Polymarket CLOB.
- Strategy logic from your trade rules in a standalone compute file.
- Paper and live modes for both venues.
- Streamlit dashboard with raw API payload inspection.
- Runtime live safety controls (`ARM LIVE` + typed confirmation token).

## 1) Setup

```bash
python -m venv .venv
. .venv/Scripts/Activate.ps1
pip install -r requirements.txt
```

## 2) Configure

1. Copy `config/config.example.json` to `config/config.json`.
2. Set mapping file path in config (`paths.mapping_file`).
3. Paper mode: no credentials file is required (public order books are used).
4. Live mode only: copy `config/credentials.example.json` to `config/credentials.json` and fill credentials.

Note: if `paths.mapping_file` is still `data/pairs.example.csv` and `Pairs_for_Kalshi_and_Polymarket.xlsx` exists in repo root, the runtime auto-switches to that XLSX.

## 3) Mapping File Schema (`.csv` or `.xlsx`)

Required columns:
- `pair_id`
- `kalshi_ticker`
- `polymarket_market_slug`
- `polymarket_yes_token_id`
- `polymarket_no_token_id`
- `resolution_time_utc` (ISO8601)
- `active` (`true/false`)

Optional:
- `category` (used for Polymarket fee bucket, defaults to `default`)
- `notes`

Alternate schema supported (your pairing spreadsheet):
- `pair_id`
- `kalshi_market_id`
- `poly_slug`
- optional `category_tag`, `active`

When token IDs are missing or stale, the bot auto-resolves Polymarket token IDs from `poly_slug` via the public Gamma API.

## 4) CLI Commands

Validate config:
```bash
python -m src.main --config config/config.json validate-config
```

One scan (no trading):
```bash
python -m src.main --config config/config.json scan
```

Single trade cycle:
```bash
python -m src.main --config config/config.json trade-once --mode paper
```

Continuous loop:
```bash
python -m src.main --config config/config.json run --execute --mode paper
```

Live arming example:
```bash
python -m src.main --config config/config.json --credentials config/credentials.json trade-once --mode live --arm-live --confirm-token <TOKEN>
```

## 5) Dashboard

Launch via CLI wrapper:
```bash
python -m src.main --config config/config.json dashboard
```

Dashboard includes:
- Raw Kalshi and Polymarket API JSON per cycle.
- Normalized quote table.
- Opportunity table with edge metrics.
- Cycle error table (failed/skipped pairs).
- Order ledger and alerts.
- Mode switch + `ARM LIVE` + manual `Run Trade Cycle Now`.

## 6) Standalone Model File

`src/strategy_model.py` can run independently:

```bash
python src/strategy_model.py --input sample_snapshot.json --config config/config.json
```

## 7) Fee Logic (Configurable)

Kalshi (default):
- `fee = ceil_to_cent(rate * C * P * (1-P))`
- default `rate = 0.07`

Polymarket:
- `fee = C * feeRate * (p * (1-p))^exponent`
- category-specific fee buckets in config (`fees.polymarket.categories`).

## 8) Safety Notes

Live mode only executes when safety gates pass:
- mode is `live`
- `ARM LIVE` is enabled
- typed confirmation token matches and is unexpired
- valid Kalshi and Polymarket live credentials are present

## 9) Tests

```bash
pytest -q
```

## 10) Important implementation notes

- Kalshi orderbook provides bids; asks are derived using reciprocal binary pricing.
- Kalshi market tickers can be auto-resolved from API metadata (`/markets`) when mapping tickers are stale or point to event IDs.
- Cross-venue execution is best-effort. If one leg fails after the other succeeds, an alert is recorded for manual hedge handling.
- `config/credentials.json` and runtime DB/log files are gitignored.
