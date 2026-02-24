# Polymarket + Kalshi Arbitrage Dashboard

Cross-venue arbitrage scanner/executor with a React dashboard, TypeScript backend, and a Python decision-model bridge (`model_v1.py`).

## Current architecture

- Node/TypeScript API server: `src/dashboard/server.ts`
- React dashboard (Vite): `src/dashboard-ui/`
- Execution planner + executor: `src/services/arbitrageExecutionService.ts`
- Python model bridge client: `src/services/pythonModelClient.ts`
- Miguel pipeline service (pairs/quotes/raw opportunities): `src/services/miguelService.ts`
- Python scripts:
  - `model_v1.py` (standalone demo + core model function)
  - `python/model_v1_bridge.py` (JSON stdin/stdout bridge used by backend)
  - `python/build_pairs.py`
  - `python/live_quotes.py`
  - `python/raw_boxed_filter.py`

## Requirements

- Node.js 18+
- npm
- Python 3.11+ on PATH as `python` (or configure `python.pythonExecutable`)
- Internet access to Polymarket/Kalshi APIs

## Setup

1. Install dependencies:

```bash
npm install
cd src/dashboard-ui && npm install
cd ../..
```

2. Configure runtime settings:

- Base defaults: `config/settings.json`
- Local overrides/secrets: `config/settings.local.json` (gitignored)
- Copy starter template from `config/settings.local.example.json`

Precedence:

`defaults < config/settings.json < config/settings.local.json < env vars`

## Run

### Dashboard (API + built UI)

```bash
npm run dashboard
```

### Backend only

```bash
npm run dashboard:server
```

### Frontend dev server

```bash
npm run dashboard:dev
```

## Build and validation

```bash
npm run build
npm run dashboard:build
npm run dashboard:smoke
python -m py_compile model_v1.py python/model_v1_bridge.py python/build_pairs.py python/live_quotes.py python/raw_boxed_filter.py
```

## Python model usage

### Standalone console demo

```bash
python model_v1.py
```

Reads `opportunities_raw.csv` and prints model outputs (`expected_slippage`, `fill_prob_20s`, `expected_net_edge`, `recommended_cap`).

### Backend model authority

Execution planning calls Python through `python/model_v1_bridge.py`. Health/status exposed in API and execution state.

## Miguel pipeline commands

```bash
npm run miguel:pairs
npm run miguel:quotes:once
npm run miguel:quotes
npm run miguel:raw
```

Output files:

- `pairs.csv`
- `python/data/live_quotes.csv`
- `opportunities_raw.csv`
- `python/data/model_v1_section_d.json`

## API endpoints (current)

### Core health

- `GET /api/health`
- `GET /api/arbitrage/execution/health`

### Execution

- `GET /api/arbitrage/execution/state`
- `POST /api/arbitrage/execution/settings`
- `POST /api/arbitrage/execution/refresh`
- `POST /api/arbitrage/execution/execute/:planId`
- `POST /api/arbitrage/execution/execute-top`
- `GET /api/arbitrage/execution/export/plans.csv`
- `GET /api/arbitrage/execution/export/history.csv`
- `GET /api/arbitrage/execution/export/history.json`
- `GET /api/arbitrage/execution/export/history.jsonl`

### Model v1 (Python bridge)

- `GET /api/model-v1/health`
- `POST /api/model-v1/evaluate`

### Miguel pipeline

- `GET /api/miguel/status`
- `POST /api/miguel/pairs/rebuild`
- `POST /api/miguel/live-quotes/start`
- `POST /api/miguel/live-quotes/stop`
- `POST /api/miguel/opportunities/rebuild`
- `GET /api/miguel/opportunities/latest`
- `GET /api/miguel/model-v1/top?limit=3`

## Notes

- Start in `PAPER` mode before enabling `LIVE`.
- Keep real keys in `config/settings.local.json` only.
- Persistent execution log path: `logs/execution-history.jsonl`.
