# V5 — Kalshi × Polymarket Arbitrage Bot

Lightweight Python CLI arbitrage engine. No dashboard, no SQLite — state is file-backed JSON.

## Structure

```
V5/
├── main.py                  # CLI entrypoint: validate | scan | run
├── bot.py                   # Core engine: evaluate_pair, _walk_depth, trade, exit
├── connectors.py            # KalshiConnector, PolymarketConnector, load_pairs
├── fees.py                  # Fee formula DSL (parse_formula, apply_fee)
├── config.example.json      # All config keys with inline documentation
├── requirements.txt         # Python dependencies
├── weird_behavior_check.py  # Diagnostic: flags token/strategy mismatches in logs
├── Pairs_for_Kalshi_and_Polymarket.xlsx  # Active pairs database
├── entry_trades.json        # Append-only entry trade log
├── exit_trades.json         # Append-only exit trade log
├── opportunities.json       # Scan opportunity log
├── open_positions.json      # Active position state
├── cooldowns.json           # Per-pair cooldown state
├── failed_pairs.json        # Pairs that errored permanently (skipped)
└── expired_pairs.json       # Pairs removed due to expiry/resolution
```

## Commands

```bash
cd V5
python main.py --config config.json validate   # config + pairs file sanity check
python main.py --config config.json scan       # one-shot scan, no execution
python main.py --config config.json run        # continuous scan + execute loop
```

Add `--execute` to `run` to place real orders (requires `"mode": "live"` in config).

## Configuration

Copy `config.example.json` to `config.json` and fill in your values.

Key fields:

| Field | Description |
|-------|-------------|
| `mode` | `"paper"` or `"live"` |
| `pairs_file` | Path to the pairs Excel/CSV |
| `min_arr` | Minimum annualised return (e.g. `0.20` = 20%) |
| `min_profit_dollars` | Minimum absolute edge per trade |
| `max_contracts` | Contract count cap per trade |
| `scan_interval_seconds` | Seconds between scan cycles |
| `fees.kalshi` | Kalshi fee formula + rounding |
| `fees.polymarket` | Polymarket fee formula |
| `exit_enabled` | Whether to check exit conditions |
| `exit_target_total_price` | Total price threshold to exit (e.g. `0.99`) |

## Pairs File

`Pairs_for_Kalshi_and_Polymarket.xlsx` — managed by the `Polytoken/` pipeline.

Required columns: `pair_id`, `kalshi_market_id`, `poly_slug`, `resolution_date`.

Optional outcome-mapping columns (needed for multi-outcome / non-binary markets):

| Column | Purpose |
|--------|---------|
| `poly_outcomes_json` | JSON array of Polymarket outcome labels |
| `poly_token_ids_json` | JSON array of corresponding CLOB token IDs |
| `poly_primary_outcome` | Outcome label that maps to Kalshi YES |
| `poly_event_url` | Polymarket event page URL |
| `kalshi_url` | Kalshi market URL (fallback if live API call fails) |

## Arbitrage Logic

- Two strategies evaluated per pair: `BUY_KY_BUY_PN` and `BUY_KN_BUY_PY`
- `_walk_depth` walks the order book to simulate realistic fill costs and slippage
- Fee-aware edge calculation: `edge = contracts × exit_target − kp_cost − est_exit_fee`
- **Same-side guard:** strategies where `kp_cost / contracts < 0.60` are rejected as likely inverted pairs (directional bets, not hedges)
- URLs resolved at scan time: Kalshi uses 3-segment live API URL (`/{event_ticker}/{event_slug}/{market_ticker}`); Polymarket uses `poly_event_url` when available

## Fee Model

`fees.py` provides a formula DSL. Variables: `p` (price), `q` (1−p), `c` (contract count).
Example: `"0.07 * p * c"` — 7% taker fee on notional.
Kalshi supports `round_up_to_cent` to match actual billing behavior.

## State Files

All JSON state files are append-only or full-replace and crash-resilient:
- `open_positions.json` — read on startup to resume tracking live positions
- `cooldowns.json` — prevents re-entering the same pair too soon after a trade
- `failed_pairs.json` — pairs are added here on repeated API/validation errors and skipped forever
- `expired_pairs.json` — pairs removed from the active set at runtime due to expiry

## Connectors

**`KalshiConnector`**
- Public read (orderbook, market data) requires no credentials
- Order placement uses RSA-signed headers (`api_key` + `private_key_base64`)
- `_event_url` builds the navigable public market URL from the events API

**`PolymarketConnector`**
- Gamma API for market metadata and token IDs
- CLOB API for orderbook depth and order placement
- `_resolve_tokens` maps YES/NO to correct CLOB token IDs (supports multi-outcome via `poly_primary_outcome`)

## Proxy support

**Why:** Polymarket's CLOB API blocks US datacenter IP ranges (including DigitalOcean). All Kalshi and Polymarket traffic is routed through a Bright Data Dedicated ISP proxy so the bot's egress IP appears as a Sweden residential address instead of the server's datacenter IP.

**How to enable:** In `api-keys.json`, set `proxy.enabled` to `true` and fill in `host`, `port`, `username`, and `password`. The `config.json` `proxy` block contains only documentation defaults — actual credentials live in `api-keys.json`.

```json
"proxy": {
    "enabled": true,
    "host": "brd.superproxy.io",
    "port": 33335,
    "username": "brd-customer-...",
    "password": "...",
    "verify_ssl": true
}
```

**How to verify:** When starting `python3 main.py run` or `python3 main.py scan`, the startup output prints three health-check lines once before the scan loop begins:

```
  [proxy] ✓ Proxy egress IP: 12.34.56.78
  [proxy] ✓ Polymarket geoblock: country=SE blocked=False
  [proxy] ✓ Kalshi status: exchange_active=True trading_active=True
```

These lines appear once at process startup only — not per scan cycle.

**SSL:** `verify_ssl` should stay `true` unless explicitly debugging a TLS interception issue with the proxy. Setting it to `false` disables certificate verification for all sessions.

**Provider note:** Tested with Bright Data Dedicated ISP, egress country Sweden. Other countries work as long as they are not on Kalshi's or Polymarket's geo-restricted lists. The proxy URL for the `py_clob_client_v2` CLOB client is injected via `HTTPS_PROXY`/`HTTP_PROXY` environment variables (the client library does not expose a proxies constructor parameter).
