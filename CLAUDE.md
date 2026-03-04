# CLAUDE.md

## Project Overview
Monorepo for cross-venue prediction market trading (Polymarket ↔ Kalshi). Contains two independent bot versions, an arb scanner web app, and utilities.

## Repository Structure
- **V1/** — TypeScript + React dashboard + Python model bridge (legacy, copy trading origin)
- **V2/** — Python-first bot + Streamlit dashboard (primary active codebase)
- **arb-scanner/** — Next.js web app for live arbitrage scanning
- **Polytoken/** — CLI utility to generate pair mapping CSV rows from URLs
- **api/** — Vercel serverless endpoints for public data
- **pitch.html** — Technical pitch document

## V2 Architecture (Primary Codebase)
```
V2/src/
├── main.py              # CLI entrypoint (scan, trade-once, run, copy-scan, copy-run, dashboard)
├── service.py           # BotService orchestrates cycles, wires all modules together
├── strategy_model.py    # Depth-walking arbitrage evaluation (imports from fees.py)
├── fees.py              # Shared fee calculations (Kalshi + Polymarket with maker rebate)
├── execution.py         # Paper/live order placement with risk checks + notifications
├── portfolio.py         # Position tracking, mark-to-market P&L
├── risk.py              # Pre-trade risk checks, drawdown circuit breaker
├── notifications.py     # Telegram + Discord webhook alerts
├── copy_trading.py      # Leaderboard monitoring, suspicion scoring, trade signals
├── pair_discovery.py    # Automated Kalshi↔Polymarket fuzzy title matching
├── models.py            # Data classes (MarketQuote, PairSnapshot, OpportunityDecision)
├── state_store.py       # SQLite persistence (orders, positions, alerts, copy signals)
├── mapping_loader.py    # CSV/XLSX pair mapping loader
├── config.py            # Config validation + credential loading
├── dashboard.py         # Streamlit UI (Trading, Portfolio, Copy Trading, Ops, Raw tabs)
└── connectors/
    ├── kalshi.py         # KalshiClient (RSA-signed requests, market discovery, title similarity)
    └── polymarket.py     # PolymarketClient (Gamma API + CLOB)
```

## Key Commands
```bash
# V2 (from V2/ directory)
python -m src.main --config config/config.json validate-config
python -m src.main --config config/config.json scan
python -m src.main --config config/config.json trade-once --mode paper
python -m src.main --config config/config.json run --execute --mode paper
python -m src.main --config config/config.json copy-scan
python -m src.main --config config/config.json copy-run
python -m src.main --config config/config.json dashboard
pytest -q  # Run tests

# V1 (from V1/ directory)
npm run dashboard
npm run build
```

## Configuration
- **V2 config:** `V2/config/config.example.json` → copy to `config.json`
- **V2 credentials:** `V2/config/credentials.example.json` → copy to `credentials.json`
- **V1 config:** `V1/config/settings.local.example.json` → copy to `settings.local.json`
- New features (risk, notifications, copy_trading, pair_discovery) are **off by default** in config

## Coding Conventions
- Python 3.10+ with `from __future__ import annotations`
- Type hints everywhere, `dict[str, Any]` style (not `Dict`)
- Dataclasses for models, no Pydantic
- SQLite for state persistence (no ORM)
- `requests` for HTTP (no aiohttp)
- Tests in `V2/tests/` using pytest
- Fee calculations live in `fees.py` — don't duplicate in other modules
- Title similarity logic is in both `kalshi.py` (KalshiClient methods) and `pair_discovery.py` (standalone functions)

## Important Patterns
- **Execution safety:** Live mode requires ARM LIVE + typed confirmation token with TTL
- **Risk checks** run before every trade via `ExecutionEngine.risk_manager`
- **Notifications** are non-blocking and swallow errors (never crash the bot)
- **Copy trading** runs on independent cycle from arbitrage (separate poll interval)
- **Pair discovery** caches results and requires manual activation by default

## Secrets / .gitignore
Never commit: `credentials.json`, `settings.local.json`, `.env`, `*.csv` (data files), private keys, `state.db`
