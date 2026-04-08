# CLAUDE.md

## Project Overview
Monorepo for cross-venue prediction market arbitrage (Polymarket ↔ Kalshi). **V5 and V6 are both active codebases.** V1–V4 and arb-scanner are archived under `Archived_Models/`.

## Repository Structure
```
.
├── V5/                  # Active bot — convergence exit strategy
├── V6/                  # Active bot — hold-to-expiry strategy
├── Polytoken/           # Pair generation pipeline (polytoken + helper scripts)
├── Archived_Models/     # Legacy versions (V1–V4, arb-scanner) — read-only reference
├── Information/         # Trade rules, fee docs, design notes
├── api/                 # Vercel serverless endpoints (legacy)
├── pitch.html           # Technical pitch document
├── CLAUDE.md            # This file
├── README.md            # Human-facing project overview
└── TODO.MD              # Team task list
```

## V5 Architecture (Active Codebase)
```
V5/
├── main.py              # CLI entrypoint: validate | scan | run
├── bot.py               # Core engine: scan, evaluate_pair, _walk_depth, trade, exit, state
├── connectors.py        # KalshiConnector, PolymarketConnector, load_pairs
├── fees.py              # Fee formula DSL (parse_formula, apply_fee)
├── config.example.json  # All config keys with inline documentation
├── requirements.txt     # Python dependencies
├── weird_behavior_check.py  # Diagnostic script for token/strategy mismatches
└── [runtime JSON]       # entry_trades, exit_trades, opportunities, open_positions,
                         # cooldowns, failed_pairs, expired_pairs
```

## Polytoken Pipeline
```
Polytoken/
├── polytoken.py          # Pair row generator: interactive/batch mode, writes to pairs/{user}/pairs.csv
│                         #   --validate flag: live API checks (market open, CLOB accessible, price sanity)
│                         #   --user flag: target subfolder (defaults to OS login name)
├── clean_pairs.py        # Remove expired/resolved pairs from Excel
├── backfill_pairs_links.py  # Backfill/fix URLs and outcome columns in existing Excel rows
├── retry_failed_pairs.py   # Re-validate pairs in failed_pairs.json
├── pairs/                # Per-user staging CSVs: pairs/{username}/pairs.csv
└── counter.txt           # Auto-incrementing pair_id counter
```

The pipeline writes to `V5/Pairs_for_Kalshi_and_Polymarket.xlsx` via V5 startup merge. Run order for new pairs:
1. `polytoken.py [--validate]` — generate rows, optionally validate live, write to `pairs/{user}/pairs.csv`
2. Start V5 (`python main.py ... scan`) — merges all `pairs/*/pairs.csv` into master Excel at startup, then clears them
3. `backfill_pairs_links.py --apply` — fix/update URLs and outcome mapping (if needed)

## Key Commands
```bash
# V5 — from V5/ directory
python main.py --config config.json validate   # config + pairs file sanity check
python main.py --config config.json scan       # one-shot opportunity scan, no trades
python main.py --config config.json run        # continuous scan + execute loop

# Polytoken — from Polytoken/ directory
python polytoken.py                            # interactive mode (prompts for URLs); validates by default
python polytoken.py links.csv                 # batch mode from CSV/XLSX
python polytoken.py --no-validate             # skip live API validation
python polytoken.py --user dplynn links.csv   # explicit username override
# config.json: "user_pairs_dirs": ["../Polytoken/pairs", "/other/repo/Polytoken/pairs"]
python backfill_pairs_links.py                # dry-run: show URL/outcome updates
python backfill_pairs_links.py --apply        # write updates to Excel
python clean_pairs.py                         # remove expired pairs (dry-run by default)
```

## Configuration
- **V5 config:** `V5/config.example.json` → copy to `V5/config.json`
- `config.json` and `credentials.json` are gitignored — never commit them

## Coding Conventions
- Python 3.10+ with `from __future__ import annotations`
- Type hints everywhere, `dict[str, Any]` style (not `Dict`)
- `requests` for HTTP (synchronous only — no aiohttp)
- Fee calculations live in `fees.py` — don't duplicate in other modules
- Kalshi public URLs: `https://kalshi.com/markets/{event_ticker}/{event_slug}/{market_ticker}`
- Polymarket public URLs: `https://polymarket.com/event/{event_slug}`

## Important Patterns
- **Execution safety:** Live mode requires explicit `--execute` flag + `"mode": "live"` in config
- **Same-side guard:** `evaluate_pair` rejects strategies where `kp_cost / contracts < 0.60` (inverted/same-side pairs)
- **Multi-outcome markets:** Supported via `poly_outcomes_json`, `poly_token_ids_json`, `poly_primary_outcome` columns in the pairs Excel
- **URL resolution:** `_resolve_kalshi_url` prefers live API `event_url` (3-segment) over Excel-stored `kalshi_url`; `_resolve_polymarket_url` checks `poly_event_url` first
- **Polymarket fee rates:** Rates are fetched live via the fee-rate endpoint for the market’s token IDs. Formula: `p * (1-p) * rate * c` with fees rounded to 5 decimals. If the fee rate cannot be fetched, the pair is skipped and logged. `fees.polymarket.formula` is kept only for config validation.

## Secrets / .gitignore
Never commit: `config.json`, `credentials.json`, `.env`, `*.pem`, `*.key`, private keys
