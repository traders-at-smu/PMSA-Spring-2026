# Runtime Settings

Runtime config is loaded from:

- `settings.json`: committed defaults/template
- `settings.local.json`: local override with real keys (gitignored)

Precedence:

`defaults < settings.json < settings.local.json < env vars`

## Sections in settings

- `dashboard`: API host/port and refresh cadence
- `execution`: PAPER/LIVE mode and execution thresholds
- `apiKeys`: Polymarket and Kalshi credentials
- `externalApis`: upstream market data endpoints
- `python`: Python executable + model/miguel script paths

## Python settings

Current keys:

- `python.pythonExecutable` (default: `python`)
- `python.modelBridgePath` (default: `python/model_v1_bridge.py`)
- `python.miguelScriptsDir` (default: `python`)
- `python.miguel.pollIntervalSec` (default: `30`)
- `python.miguel.minPairs` (default: `50`)

Environment variable overrides:

- `PYTHON_EXECUTABLE`
- `MODEL_V1_BRIDGE_PATH`
- `MIGUEL_SCRIPTS_DIR`
- `MIGUEL_POLL_INTERVAL_SEC`
- `MIGUEL_MIN_PAIRS`

## Quick start

1. Copy `settings.local.example.json` to `settings.local.json`.
2. Fill API credentials and any local overrides.
3. Run `npm run dashboard`.
