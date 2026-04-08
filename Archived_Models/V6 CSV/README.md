# V6 CSV — Kalshi × Polymarket Arbitrage Bot

High-performance, CSV-driven arbitrage engine for Kalshi and Polymarket.

## Key Features
- **CSV Workflow**: Runs off daily `.csv` files provided via the `input_files/` directory.
- **Hot-Reloading**: Automatically detects and switches to new pairs files dropped into `input_files/` while the bot is running.
- **Expiry-Hold Strategy**: Designed to hold positions until expiry for guaranteed settlement at $1.00/contract.
- **Structured Workspace**: All code is in `src/`, all runtime data and logs are in `data/`.

## Structure

```
V6 CSV/
├── main.py                # CLI entrypoint: validate | scan | run
├── config.json            # Active configuration
├── config.example.json    # Example configuration with documentation
├── requirements.txt       # Python dependencies
├── input_files/           # Drop daily CSV pairs files here
│   └── output-04-05-26.csv
├── src/                   # Core engine and connectors
│   ├── bot.py             # Evaluation, execution, and reload logic
│   ├── connectors.py      # Exchange APIs and pairs loading
│   └── fees.py            # Fee calculation DSL
└── data/                  # Runtime state and logs
    ├── open_positions.json # Active positions state
    ├── entry_trades.json   # Entry trade log
    ├── exit_trades.json    # Settlement/exit log
    ├── opportunities.json  # Detected opportunity log
    ├── failed_pairs.json   # Log of pairs that failed fetching
    └── bad_pairs.json      # Log of inverted/mismatched pairs
```

## Usage

1. **Configure**: Copy `config.example.json` to `config.json` and add your API credentials.
2. **Pairs**: Drop your latest arbitrage pairs CSV into the `input_files/` directory.
3. **Run**:
   ```bash
   python main.py run
   ```

The bot will automatically pick up the newest CSV in `input_files/` at startup and watch for new files while running.
