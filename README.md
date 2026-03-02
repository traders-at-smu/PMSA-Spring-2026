# Polymarket Copy Trading Bot

Monorepo for cross-venue trading/arbitrage tooling across Polymarket and Kalshi.

This repository currently contains two implementations:

- `V1`: TypeScript + React dashboard + Python model bridge.
- `V2`: Python-first bot + Streamlit dashboard with live safety controls.

## Repository layout

```text
.
|-- V1/   # TypeScript backend + React dashboard + Python model bridge
|-- V2/   # Python bot + Streamlit dashboard
`-- README.md
```

## Which version should you use?

- Use `V1` if you want the Node/TypeScript service stack with a React UI and Python scoring bridge.
- Use `V2` if you want a pure Python workflow with CLI commands and Streamlit dashboard.

## Shared prerequisites

- Git
- Internet access for Kalshi/Polymarket APIs
- API credentials if running live trading (paper mode works with limited/no private keys depending on command)

---

## V1 Quick Start (TypeScript + React + Python bridge)

### 1) Install dependencies

```powershell
cd V1
npm install
cd src/dashboard-ui
npm install
cd ../..
```

### 2) Configure runtime settings

```powershell
Copy-Item config/settings.local.example.json config/settings.local.json
```

Fill `V1/config/settings.local.json` with local credentials/secrets.

### 3) Run

```powershell
npm run dashboard
```

Useful commands:

```powershell
npm run dashboard:server
npm run dashboard:dev
npm run build
npm run dashboard:smoke
npm run miguel:pairs
npm run miguel:quotes:once
npm run miguel:quotes
npm run miguel:raw
```

Details: see `V1/README.md`.

---

## V2 Quick Start (Python + Streamlit)

### 1) Create venv and install dependencies

```powershell
cd V2
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

### 2) Configure

```powershell
Copy-Item config/config.example.json config/config.json
Copy-Item credentials.example.json credentials.json
```

Update `V2/config/config.json` and `V2/credentials.json`.

### 3) Run commands

Validate config:

```powershell
python -m src.main --config config/config.json validate-config
```

Scan once:

```powershell
python -m src.main --config config/config.json scan
```

Trade cycle (paper):

```powershell
python -m src.main --config config/config.json trade-once --mode paper
```

Continuous loop:

```powershell
python -m src.main --config config/config.json run --execute --mode paper
```

Dashboard:

```powershell
python -m src.main --config config/config.json dashboard
```

Details: see `V2/README.md`.

---

## Safety and secrets

- Start in paper mode before attempting live mode.
- Never commit secrets (`settings.local.json`, `credentials.json`, private keys, `.env` files).
- Both `V1` and `V2` include version-specific `.gitignore` files to keep runtime artifacts out of git.

## Testing and validation

- `V1`: use npm build/smoke scripts and Python unit tests described in `V1/README.md`.
- `V2`: run `pytest -q`.

## Notes

- `V1` and `V2` are intentionally separate codepaths with different runtime models.
- Keep dependencies and configs isolated per version for predictable behavior.
