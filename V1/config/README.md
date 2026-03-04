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

Additional model rule environment variables (read directly by `model_v1.py`):

- `MODEL_RULE_KP_MAX` (default `1.0`)
- `MODEL_RULE_A_MIN` (default `0.0`)

These are used in the Python decision gate:

- `KP(c_new) < c_new`
- `KP(c) < KP_max`
- `A_e(c_new) >= A_min`

If any condition fails, model output sets `recommended_cap = 0`.

## Quick start

1. Copy `settings.local.example.json` to `settings.local.json`.
2. Fill API credentials and any local overrides.
3. Run `npm run dashboard`.
