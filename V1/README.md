# Polymarket Copy Trading Bot (V1)

TypeScript + Python trading system for monitoring opportunities, scoring them with `model_v1.py`, and running a local dashboard + execution API.

## What is in V1

- TypeScript backend API/server (`src/dashboard/server.ts`)
- React dashboard (`src/dashboard-ui`)
- Arbitrage execution service and planner (`src/services/arbitrageExecutionService.ts`)
- Python bridge + model (`python/model_v1_bridge.py`, `model_v1.py`)
- Trader pipeline scripts for pairs/quotes/opportunities (`python/*.py`)

## Requirements

- Node.js 18+
- npm
- Python 3.11+ available as `python`

## Quick start

1. Install dependencies:

```bash
npm install
cd src/dashboard-ui && npm install && cd ../..
```

2. Create local config:

```bash
copy config\settings.local.example.json config\settings.local.json
```

3. Fill in API credentials in `config/settings.local.json`.

4. Start dashboard API + build UI:

```bash
npm run dashboard
```

## Core commands

```bash
npm run dashboard          # Build UI then run API server
npm run dashboard:server   # Run API server only
npm run dashboard:dev      # Run Vite frontend dev server
npm run build              # Build TypeScript backend
npm run dashboard:smoke    # Basic dashboard smoke script
```

## Trader pipeline commands

```bash
npm run trader:pairs
npm run trader:quotes:once
npm run trader:quotes
npm run trader:raw
```

Generated pipeline artifacts are local runtime files and are gitignored (`pairs.csv`, `opportunities_raw.csv`, and `python/data/*` outputs).

## Model and rule gates

`model_v1.py` enforces all of the following before recommending size:

- `KP(c_new) < c_new`
- `KP(c) < KP_max`
- `A_e(c_new) >= A_min`

Rule defaults can be changed with:

- `MODEL_RULE_KP_MAX` (default `1.0`)
- `MODEL_RULE_A_MIN` (default `0.0`)

If any rule fails, `recommended_cap` is forced to `0`.

## Config precedence

Runtime settings load in this order:

`defaults < config/settings.json < config/settings.local.json < env vars`

Keep secrets in `config/settings.local.json` only.

## Useful endpoints

- `GET /api/health`
- `GET /api/arbitrage/execution/health`
- `GET /api/arbitrage/execution/state`
- `POST /api/arbitrage/execution/execute-top`
- `GET /api/model-v1/health`
- `POST /api/model-v1/evaluate`
- `GET /api/trader/status`

## Validation

```bash
npm run build
npm run dashboard:build
python -m py_compile model_v1.py python/model_v1_bridge.py python/build_pairs.py python/live_quotes.py python/raw_boxed_filter.py python/test_trade_rules.py python/test_model_trade_rules.py
python -m unittest python/test_trade_rules.py python/test_model_trade_rules.py -v
```

## Safety note

Use `PAPER` mode first and verify behavior before any `LIVE` execution settings.
