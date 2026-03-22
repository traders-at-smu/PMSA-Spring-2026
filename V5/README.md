# Kalshi × Polymarket Arb Bot v5 (Updated Overview)

## Project Overview
Single-node Python arbitrage bot for Kalshi ↔ Polymarket markets.

- `V5` is a lightweight CLI-first implementation (no Streamlit web UI).
- Supports paper and live trading.
- Depth-walking arbitrage in both directions (K YES + P NO, K NO + P YES).
- Tracks open positions, cooldowns, exit rules, and permanent failures as JSON.
- Configurable fees with safe formula DSL.

## Repository Structure

```
V5/
├── main.py              # CLI entrypoint (validate, scan, run)
├── bot.py               # core engine: scan, evaluate, trade, exit, state
├── connectors.py        # Kalshi/Polymarket adapters + pair loader
├── fees.py              # fee formula DSL (parse + apply)
├── config.example.json  # documented config keys and defaults
├── config.json          # user config (should be private)
├── entry_trades.json    # historical entry trades log (append-only)
├── exit_trades.json     # historical exit trades log (append-only)
├── opportunities.json   # scan opportunity logging
├── failed_pairs.json    # permanently failed pairs to skip
├── expired_pairs.json   # expired/resolved pairs log
├── open_positions.json  # active positions state
├── cooldowns.json       # per-pair cooldown state
├── fees.py              # fee math and rounding implementations
├── connectors.py        # market data + order placement clients
├── bot.py               # arbitrage and risk flow
└── requirements.txt     # dependencies
```

## Key commands

```bash
cd V5
python main.py --config config.json validate   # config sanity + pairs existence
python main.py --config config.json scan       # one-shot scan, no execution
python main.py --config config.json run        # continuous scan+execute loop
```

## Main behavior

- `main.py` loads config and pairs, validates required keys (`mode`, `min_arr`, `max_contracts`, `fees`, `pairs_file`).
- `run_scan`:
  - fetches Kalshi + Polymarket orderbook data in parallel threads (default 6 workers)
  - evaluates arbitrage for each pair with `evaluate_pair` and `_walk_depth`
  - logs opportunities (`opportunities.json`)
  - executes trades in `paper` or `live` mode (with entry minimum profit filtering)
  - handles transient/perm errors, updates failed/expired logs
- `run_loop`:
  - continuous scanning with intervals (`scan_interval_seconds`)
  - open-position and cooldown pair counting / skipping
  - periodic exit checks (`exit_enabled`, `exit_target_total_price`, `exit_max_hold_seconds`)

## Fee model

- `fees.py` provides formula DSL via `parse_formula`.
- Allowed variables: `p` (price probability), `q` (1-p), `c` (contract count).
- No function calls, only math operators.
- Kalshi supports `round_up_to_cent` to match actual billing.

## Connectors

- `KalshiConnector` (read quotes, place limit orders via signed RSA headers)
- `PolymarketConnector` (read CLOB/Gamma endpoints, resolve yes/no token IDs, place CLOB orders)
- Both connectors support no auth for book-only (paper).

## Open / exit state and safety

- `open_positions.json` holds active trades with entry metadata.
- `cooldowns.json` stops pair reopening until cooldown expires.
- `failed_pairs.json` / `expired_pairs.json` persist skip lists across restarts.
- Opportunity filters:
  - `min_arr`
  - `min_profit_dollars`
  - `max_contracts`

## Notes

- This is the V5 version of the bot from prior V2 architecture.
- No SQLite, no dashboard, no copy-trading orchestration.
- State is file-backed and crash-resilient for long runs.
