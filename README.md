# Polymarket × Kalshi Arbitrage Bot

Cross-venue prediction market arbitrage tooling for [Polymarket](https://polymarket.com) and [Kalshi](https://kalshi.com).

**Active codebases:**
- **`V6/`** — Current active bot, **Sports focus**.
- **`V5/`** — Current active bot, **General focus**.
- **`V6 EXP/`** — **Experimental branch** for new features and testing.

Legacy versions (V1–V4) and the arb-scanner web app are preserved under `Archived_Models/` for reference.

---

## Repository Layout

```
.
├── V6/              # Active bot (Sports focus)
├── V5/              # Active bot (General focus)
├── V6 EXP/          # Experimental branch
├── Pairs Generator V3/ # New pair generation & matching logic
├── Polytoken/       # Legacy pair generation pipeline
├── Archived_Models/ # Legacy: V1-V4, V6 CSV, arb-scanner
├── Information/     # Fee docs, trade rules, design notes
└── api/             # Vercel serverless endpoints (legacy)
```

---

## V5 Quick Start

### 1) Install dependencies

```bash
cd V5
pip install -r requirements.txt
```

### 2) Configure

```bash
cp config.example.json config.json
```

Edit `config.json` — at minimum set `pairs_file`, `mode`, `min_arr`, `max_contracts`, and the `fees` block.
For live trading, also add `kalshi.api_key`, `kalshi.private_key_base64`, and Polymarket credentials.

### 3) Validate config

```bash
python main.py --config config.json validate
```

### 4) Scan (no trades)

```bash
python main.py --config config.json scan
```

### 5) Run continuously (paper mode)

```bash
python main.py --config config.json run
```

Add `--execute` to actually place orders (requires `"mode": "live"` in config).

---

## Polytoken — Pair Generation Pipeline

Converts Polymarket + Kalshi market URLs into rows in `V5/Pairs_for_Kalshi_and_Polymarket.xlsx`.

### Install dependencies

```bash
pip install requests openpyxl
```

### Add new pairs (interactive)

```bash
cd Polytoken
python polytoken.py
```

Prompts for a Polymarket URL, a Kalshi URL, and submarket selection.

### Add new pairs (batch from CSV/XLSX)

```bash
python polytoken.py links.csv
```

Input columns: `polymarket` (URL), `kalshi` (URL). Optional header row is supported.

### Fix URLs / outcome mapping in existing rows

```bash
python backfill_pairs_links.py             # dry-run: preview changes
python backfill_pairs_links.py --apply     # write updates to Excel
```

### Validate and append rows

```bash
python check_and_append_v2.py
```

### Remove expired pairs

```bash
python clean_pairs.py                      # dry-run
python clean_pairs.py --apply
```

---

## Pairs File

The shared pairs file is `V5/Pairs_for_Kalshi_and_Polymarket.xlsx`.

Required columns: `pair_id`, `kalshi_market_id` (ticker), `poly_slug`, `resolution_date`.

Optional outcome-mapping columns (needed for non-binary markets):
- `poly_outcomes_json` — JSON array of Polymarket outcome labels
- `poly_token_ids_json` — JSON array of corresponding CLOB token IDs
- `poly_primary_outcome` — which outcome maps to Kalshi YES
- `poly_event_url` — Polymarket event page URL
- `kalshi_url` — Kalshi market URL (3-segment: `/{event}/{slug}/{ticker}`)

---

## Safety

- Always start in paper mode (`"mode": "paper"`) before enabling live trading.
- Never commit `config.json`, `credentials.json`, `.env`, or private keys.
- The bot writes state to JSON files in `V5/` — these are gitignored and crash-resilient.

---

## Archived Versions

| Version | Stack | Notes |
|---------|-------|-------|
| V1 | TypeScript + React + Python bridge | Copy-trading origin, dashboard UI |
| V2 | Python + Streamlit | SQLite state, full copy-trading stack |
| V3 | TypeScript | Intermediate iteration |
| V4 | Python | Direct predecessor to V5 |
| arb-scanner | Next.js | Web UI for live arb scanning |
