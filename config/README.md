# Runtime Settings

- `settings.json`: committed defaults/template.
- `settings.local.json`: local override with real keys (gitignored).
- Precedence: defaults < settings.json < settings.local.json < env vars.

## Quick start

1. Copy `settings.local.example.json` to `settings.local.json`.
2. Fill in API keys and wallet fields.
3. Run `npm run dashboard`.
