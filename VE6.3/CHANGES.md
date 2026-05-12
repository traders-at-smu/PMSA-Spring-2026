# VE6.3 — Changes from V6.3

This file tracks every difference between VE6.3 and its source, V6.3.

---

## Status
VE6.3 was forked from V6.3 on 2026-05-05. 18 changes tracked (+ 1 capital test change).

---

## Capital Test

Changes made specifically for the $100 test run. These will be reverted or adjusted before the full live deployment.

| Date | File | Description |
|------|------|-------------|
| 2026-05-05 | `config.json` | `max_contracts` reduced from 1000 to 1 for $100 capital test. |
| 2026-05-12 | `config.json` | `max_contracts` raised from 1 to 5. |

---

## Change Log

| Date | File | Description |
|------|------|-------------|
| 2026-05-05 | `main.py` | `_effective_mode()`: replaced silent paper fallback with configurable abort. When `fallback_to_paper=false` and credentials are missing, exits with a clear `FATAL` error instead of silently running paper. |
| 2026-05-05 | `main.py` | `_validate_live_credentials()`: new function. Called in `cmd_run()` before scan loop when mode=live. Authenticates against Kalshi and Polymarket balance endpoints. Aborts on failure. |
| 2026-05-05 | `main.py` | `cmd_run()`: credential validation gate added after `_build_connectors()` for live mode. |
| 2026-05-05 | `src/bot.py` | `_resolve_execution_mode()`: reads `fallback_to_paper` from top-level config (not buried in `holdings` sub-key). When `fallback_to_paper=false` and credentials missing mid-run, sends SIGTERM for clean shutdown. |
| 2026-05-05 | `src/bot.py` | `run_loop()`: SIGTERM handler registered at startup, maps to KeyboardInterrupt so positions are saved to disk on any shutdown signal. |
| 2026-05-05 | `src/bot.py` | `run_loop()`: broad `except Exception` added so unexpected errors log to nohup.out and resume after 10s instead of crashing the bot. |
| 2026-05-05 | `src/bot.py` | `execute_live()`: entry log built entirely from actual exchange fill data — no scan/quoted values. Nothing written to `entry_trades.json` if Kalshi fills 0. Entry contains actual contracts, weighted average fill price per leg, actual costs, and profit calculated from real fills. `edge_pct` and `arr` recalculated from actual data. Scan fields (`fee`, `p_leg_prices`, `p_leg_spend`, scanned `fills`) removed entirely from live entries. `legs_filled` values: `"both"` (fully hedged), `"mismatch"` (Polymarket filled less than Kalshi), `"kalshi_only"` (Polymarket failed entirely), `"none"` (Kalshi failed, nothing logged). |
| 2026-05-05 | `src/bot.py` | `run_scan()`: `on_new_position` guard now skips recording when `legs_filled="none"` (both legs failed). Previously would write a phantom position to disk with full contract counts. |
| 2026-05-05 | `src/bot.py` | `run_scan()`: added `execute_approved_ids` parameter. Pairs not in the approved set are displayed as opportunities but not executed — prints "awaiting 3-cycle confirmation". |
| 2026-05-05 | `src/bot.py` | `run_loop()`: 3-cycle confirmation before entry. Opportunity streaks tracked per pair; execution only allowed after 3 consecutive cycles with an arb. Streak resets if arb disappears or execution is attempted. |
| 2026-05-05 | `src/bot.py` | `run_loop()`: 1-hour cooldown after entry. Pair added to `data/cooldowns.json` with 1-hour expiry the moment a trade executes. Cooled-down pairs excluded from scanning entirely until expiry. Cooldowns persist across restarts. |
| 2026-05-05 | `src/bot.py` | `_record_open_position()`: stores actual fill counts, actual fill prices, and actual costs from exchange responses rather than quoted/requested values. |
| 2026-05-05 | `src/connectors.py` | `KalshiConnector.place_order()`: changed from limit order to IOC market order. Price fields removed. `time_in_force: immediate_or_cancel` added. Exchange cancels unfilled remainder automatically. |
| 2026-05-05 | `src/connectors.py` | `KalshiConnector.cancel_order()`: new method. Cancels a Kalshi order by order_id. Available for manual use; not called during normal entry (IOC handles it). |
| 2026-05-05 | `scripts/paper_trading_summary.py` | Rewritten for live trading. Cost from `total_cost`/`k_actual_cost`/`p_actual_cost`. Contracts from `k_contracts_filled`. Profit from actual fills. Filters out `legs_filled="none"` and paper trades. Added Fill Quality section showing hedged vs mismatch vs kalshi_only breakdown. Partial fill profit shown as K/P range. Session grouping removed. Title changed to "LIVE TRADING SUMMARY". |
| 2026-05-05 | `src/connectors.py` | `PolymarketConnector.place_order()`: changed to FAK order using `OrderArgs(price=0.99, size=contracts)` on Polymarket International CLOB. `size` is contract count (confirmed from py-clob-client source). Price cap of $0.99 acts as market sweep. Raises if `takingAmount` is 0. |
| 2026-05-05 | `config.json` | `mode` changed from `"paper"` to `"live"`. `fallback_to_paper: false` added. Doc string updated from V6.2 to VE6.3. |
| 2026-05-05 | `SERVER_CONTROLS.md` | Replaced V6.3 commands with VE6.3-specific commands. `pkill` scoped to `VE6.3/main.py`. `--health-check` flag on all start commands. |
| 2026-05-06 | `src/connectors.py` | Kalshi: fixed signing bug — message now includes full path `/trade-api/v2/...` not just `/portfolio/...`. Base URL updated to `external-api.kalshi.com` (recommended production host). `urlparse` added to extract base path for signing. |
| 2026-05-06 | `src/connectors.py` | Polymarket: `get_balance()` fixed for py-clob-client 0.34.6. `get_balance()` no longer exists — replaced with `get_balance_allowance(BalanceAllowanceParams(asset_type=AssetType.COLLATERAL))`. |
