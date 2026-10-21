# Prediction Market Spatial Arbitrage (PMSA): Polymarket × Kalshi

Traders@SMU, Spring 2026. Cross-venue arbitrage tooling for [Polymarket](https://polymarket.com) and [Kalshi](https://kalshi.com).

When the same event is listed on both venues, buying YES on one and NO on the other locks in a $1 payout per contract at settlement. If the combined cost, after fees and order-book slippage, is below $1, the difference is risk-free edge. This repository contains the bots that scan for those mispricings and trade them, and the pipelines that build the cross-venue market pairs they trade.

## How it works

1. **Pair generation:** markets on the two venues are matched (titles normalized, outcomes mapped, expiry and resolution times aligned) into a pairs file.
2. **Scan:** for each pair, the bot pulls both order books and evaluates both hedges (`BUY_KY_BUY_PN` and `BUY_KN_BUY_PY`). It walks order-book depth to price realistic fills, then applies each venue's fee formula.
3. **Filter:** trades must clear a minimum edge after fees (V6: `min_edge_pct`; V5: minimum annualized return `min_arr` and minimum dollar profit), and must pass a same-side guard that rejects mismatched pairs (directional bets rather than hedges).
4. **Execute:** paper mode by default. Live mode places both legs and records the actual fills.
5. **Manage:** V5 exits early when the combined bid converges toward $1. V6 holds positions to expiry. Open positions, cooldowns and failed or expired pairs are persisted to JSON so a restart resumes cleanly.

## Repository layout

| Path | Description |
|---|---|
| `V6.2/`, `V6.3/`, `V6.4/` | **V6 bot (current):** hold-to-expiry strategy, sports focus. CLI in `main.py`; engine, connectors, fee DSL, scheduler and trade export in `src/`. Loads daily pairs files from `input_files/`, with optional Dropbox sync and parallel scanning. |
| `VE6.3/` | Experimental branch of V6.3 used for the live small-capital test: credential validation before live runs, fills recorded from actual exchange data, IOC/FAK orders, 3-cycle opportunity confirmation, per-pair cooldowns. Changes are logged in `VE6.3/CHANGES.md`. |
| `V5/`, `V5.2/` | **V5 bot:** convergence-exit strategy, general markets. File-backed JSON state. |
| `Pairs Generator V6.2/`, `V6.3/`, `V6.4/` | Async sports pairs generator: scrapes both venues into SQLite, normalizes and matches sports markets, and exports pairs files for the V6 bots. |
| `Polytoken/` | Pair-row pipeline from Polymarket + Kalshi URLs: interactive and batch generation, validation, link/category backfill, expired-pair cleanup, retry of failed pairs. |
| `Information/` | Trade rules, trader instructions, fee documentation and design notes. |
| `Archived_Models/` | Earlier versions: V1 (TypeScript + React dashboard + Python bridge), V2 (Python + Streamlit + SQLite), V3 (TypeScript), V4 (Python), earlier V5/V6 snapshots (V5, V6 CSV, V6.1), and the `arb-scanner` Next.js web UI. |

## Quick start (V6)

```bash
cd V6.4
pip install -r requirements.txt
cp config.example.json config.json   # every key is documented inline
python main.py --config config.json validate   # check config and pairs file
python main.py --config config.json scan       # one scan, no trades
python main.py --config config.json run        # continuous scan + paper trading
```

The V5 bot uses the same `validate | scan | run` commands from `V5/`. See each version's own README for configuration fields, state files and connector details.

### Key configuration (V6)

| Field | Description |
|---|---|
| `mode` | `"paper"` or `"live"` |
| `pairs_file` | Path to the pairs Excel/CSV |
| `min_edge_pct` | Minimum edge after fees (e.g. `0.001` = 0.1%) |
| `scan_interval_seconds`, `pairs_per_cycle`, `max_workers` | Scan cadence and parallelism |
| `max_contracts` | Contract cap per trade |
| `exit_enabled`, `exit_target_total_price` | Optional early exit when YES bid + NO bid reaches the target |
| `fees.kalshi`, `fees.polymarket` | Fee formulas (DSL with `p`, `q`, `c`; Kalshi supports round-up-to-cent billing) |

## Pairs file

Required columns: `pair_id`, `kalshi_market_id`, `poly_slug`, `resolution_date`.
Multi-outcome markets also need `poly_outcomes_json`, `poly_token_ids_json` and `poly_primary_outcome` (the Polymarket outcome that maps to Kalshi YES).

## Tech stack

Python (asyncio, requests, pandas, openpyxl, SQLite), Kalshi REST API (RSA-signed requests), Polymarket Gamma and CLOB APIs. Archived versions also use TypeScript/Node, React, Next.js and Streamlit.

## Safety

- Always start in paper mode.
- Never commit `config.json` credentials, API keys, `.env` files or private keys.
- Cross-venue execution is best-effort. If one leg fills and the other does not, the position is flagged for manual hedging.
- Users are responsible for complying with each venue's terms of service and with the rules of their jurisdiction.
