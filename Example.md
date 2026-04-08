python main.py --config config.json run
PS D:\GitHub\PMSA\V6 EXP> python main.py --config config.json run
  [scheduler] Background updater active. Target time: 03:00 daily.
  [run] Using latest CSV: input_files\output-04-06-26.csv
  [scheduler] Running initial startup update...

  ┌──────────────────────────────────────────────────────────┐
  │  SCHEDULED UPDATE: Running Pairs Generator V3...    │
  └──────────────────────────────────────────────────────────┘
      █       █
     ██      ███                           █
     ██      █ █  ███████                 ██                      ██████     ██████ ███     ███ ███   ██
    ████  █  █ █     █                    ██                     ██    ███  ███████ ███    ████ ███   ██
 ██ ██ █  █  █ █     █    ████ ███    ██████  ████   ████ ████  ██ ███████  ███  ██ ████   ████ ███   ██
 ██ ██ █ ███ █ █     █    ███ ██ ██  ██  ███ ███ ██  ███ ██  █ ██ ██  █████ ████    ████  █████ ███   ██
 ██ ██ █ █ █ █ █     █    ██      ██ █    ██ ██   ██ ██  ██    ██ █    ██ █ ███████ ███████████ ███   ██
████████ █ █ █ █     █    █   ██████ █    ██ ███████ █    ████ █  █    ██ █   █████ ███████████ ███  ███
████ ███ █ █ ███     █    █   █   ██ █    ██ █       █      ████  █    ██ █ ██   ██ ███████ ███ ███  ███
████ ██  █ █ ███     █    █   █   ██ ██  ███ ██   █  █   █   ████ ██  ███ █ ███████ ███ ███ ███ ████████
████     ███  █      █    █   ██████  ██████  █████  █   █████  █ █████████ ██████  ███     ███  ██████
████     ███                                                    ██
 ██       █                                                      ███████
                                                                   ████

  V6 Arbitrage Bot
  Pairs:     106
  Mode:      PAPER
  Logs:      data/entry_trades.json
  Positions: data/open_positions.json
------------------------------------------------------------
  Loaded 54 previously expired pair(s) from data/expired_pairs.json — these will be skipped.
  Loaded 1 bad pair(s) from data/bad_pairs.json — these will be skipped.
  Loaded 1 open position(s) from data/open_positions.json

Bot running — press Ctrl+C to stop.

[16:16:02] Fetching pairs 1–0 of 106  (10 workers)...  (50 skipped — failed/expired/bad)
  All pairs are in the failed log — nothing to scan.
  0 new entry trade(s) this cycle  | next scan in 2s...

[16:16:04] Fetching pairs 51–95 of 106  (10 workers)...  (5 skipped — failed/expired/bad)
  Fetched 45 pairs in 5.4s
  0 opportunity(ies) found
  0 new entry trade(s) this cycle  | next scan in 2s...

[16:16:11] Fetching pairs 101–106 of 106  (10 workers)...  (44 skipped — failed/expired/bad)
  Fetched 6 pairs in 0.8s
  0 opportunity(ies) found
  0 new entry trade(s) this cycle  | next scan in 2s...

... lots of pairs ... 

[16:24:06] Fetching pairs 79–106 of 106  (10 workers)...  (22 skipped — failed/expired/bad)
  [16:16:01] [scheduler] Pairs Generator V3 finished successfully.
    [scheduler] Copying output-04-08-26.csv to input_files/...
    [scheduler] Update complete. Bot will hot-reload automatically.

  Fetched 28 pairs in 3.9s
  0 opportunity(ies) found
  0 new entry trade(s) this cycle  | next scan in 2s...

  [reload] Found new pairs file: input_files\output-04-08-26.csv
  [reload] Loaded 162 active pair(s)

[16:24:13] Fetching pairs 23–22 of 162  (10 workers)...  (50 skipped — failed/expired/bad)
  All pairs are in the failed log — nothing to scan.
  0 new entry trade(s) this cycle  | next scan in 2s...

[16:24:15] Fetching pairs 73–117 of 162  (10 workers)...  (5 skipped — failed/expired/bad)
  Fetched 45 pairs in 6.1s
  0 opportunity(ies) found
  0 new entry trade(s) this cycle  | next scan in 2s...

[16:24:23] Fetching pairs 123–172 of 162  (10 workers)...

Shutdown requested — leaving positions open to settle at expiry.
Stopped.
