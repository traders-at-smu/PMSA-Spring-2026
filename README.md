# Polymarket + Kalshi Arbitrage Trader

This project scans Polymarket and Kalshi for cross-market/arbitrage opportunities, ranks opportunities with a decision model, and supports both:

- `PAPER` execution (simulated fills + expected PnL accounting)
- `LIVE` execution (uses configured API keys/wallet credentials)

It also includes a dashboard with a dedicated **Execution** tab for refresh, monitoring, and trade actuation.

## What The Bot Does

1. Fetches tradable markets from Polymarket and Kalshi.
2. Detects arbitrage patterns:
- binary mispricing (`YES + NO != 1`)
- event-group / basket mispricing (`sum(YES asks) < 1`)
3. Scores opportunities with a heuristic decision engine that outputs:
- expected slippage
- 20s fill probability
- expected net edge
- recommended cap
4. Produces executable trade plans.
5. Executes in:
- `PAPER` mode: records simulated fills and paper PnL
- `LIVE` mode: sends orders through configured venue APIs

## Key Features

- Non-blocking execution-state API (dashboard does not hang during long refreshes)
- Refresh sequencing + duration metadata
- Health endpoints for runtime diagnosis
- API rate-limit mitigation (retry + backoff, slower request pacing)
- Contract links in Execution table (open contract directly)
- JSON-based runtime config with local key override

## Project Layout

- `src/dashboard/server.ts` - Dashboard/API server
- `src/dashboard-ui/` - React dashboard frontend
- `src/services/arbitrageExecutionService.ts` - Execution planning + actuation service
- `src/screener.ts` - Polymarket screener
- `src/kalshiScreener.ts` - Kalshi screener
- `src/runtimeSettings.ts` - Unified runtime settings loader
- `src/scripts/smokeDashboard.ts` - Runtime smoke test
- `config/settings.json` - Committed default settings
- `config/settings.local.json` - Local secrets override (gitignored)

## Requirements

- Node.js 18+
- npm
- Internet access to venue APIs

## Configuration

### 1) Base config (committed)

Edit `config/settings.json` for non-secret defaults.

### 2) Local secrets (recommended)

1. Copy:

```bash
cp config/settings.local.example.json config/settings.local.json
```

2. Fill keys in `config/settings.local.json`:
- Polymarket wallet credentials
- Kalshi API credentials

`config/settings.local.json` is ignored by git.

### 3) Precedence

Runtime precedence is:

`defaults < config/settings.json < config/settings.local.json < environment variables`

## Install

```bash
npm install
cd src/dashboard-ui && npm install
cd ../..
```

## Boot The Dashboard + Trader

Run production-like dashboard stack (build UI then start API server):

```bash
npm run dashboard
```

On boot it logs:
- settings files loaded
- execution mode
- refresh start seq
- localhost and LAN URLs

Open the dashboard at the printed URL, then go to **Execution** tab.

## Development Modes

### Split frontend/backend dev

Backend:

```bash
npm run dashboard:server
```

Frontend (Vite dev server with `/api` proxy):

```bash
npm run dashboard:dev
```

## Validation / Testing

### Build checks

```bash
npm run build
npm run dashboard:build
```

### Runtime smoke test

```bash
npm run dashboard:smoke
```

Smoke test verifies:
- `/api/health` comes up
- execution state endpoint responds quickly
- refresh endpoint returns immediately
- state schema is valid and refresh sequence advances

## Important API Endpoints

- `GET /api/health`
- `GET /api/arbitrage/execution/health`
- `GET /api/arbitrage/execution/state`
- `POST /api/arbitrage/execution/refresh`
- `POST /api/arbitrage/execution/settings`
- `POST /api/arbitrage/execution/execute/:planId`
- `POST /api/arbitrage/execution/execute-top`

## Execution Modes

### PAPER

- No real orders sent
- Uses expected net PnL estimates
- Safe default for tuning

### LIVE

- Requires venue credentials configured
- Readiness shown in UI and health payload
- Orders are blocked when required credentials are missing

## Troubleshooting

### `Failed to load execution state` / timeout

- Confirm backend is running: `GET /api/health`
- Use smoke test: `npm run dashboard:smoke`
- Check execution tab phase (`Bootstrapping/Refreshing/Degraded/Ready`)

### `Kalshi refresh failed: 429`

- Bot now uses retry+backoff and slower request pacing.
- If persistent:
- reduce refresh frequency (`dashboard.refreshIntervalMs` in settings)
- ensure no other process is hitting Kalshi with same credentials/IP

### `Ready plans: 0`

This can be valid. Common causes:
- no current opportunities above edge threshold
- markets filtered as closed/not tradable
- bankroll/min-edge settings too strict

## Safety Notes

- Start in `PAPER` mode first.
- Do not store production keys in committed files.
- Use `config/settings.local.json` for local secrets.

## License / Disclaimer

This software is for educational/research purposes. You are responsible for exchange/API compliance, key security, and trading risk.
