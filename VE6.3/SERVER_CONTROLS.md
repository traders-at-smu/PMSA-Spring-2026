# VE6.3 Server Controls (LIVE BOT)

## SSH in
ssh -i ~/.ssh/pmsa-mx-key.pem ubuntu@78.13.242.21

## Start VE6.3
pkill -f "VE6.3/main.py"; cd /root/PMSA/VE6.3 && nohup python3 main.py --health-check run > nohup.out 2>&1 &

## Restart VE6.3 (pull + restart)
pkill -f "VE6.3/main.py"; cd /root/PMSA && git pull origin main && cd VE6.3 && nohup python3 main.py --health-check run > nohup.out 2>&1 &

## Tail live log
tail -f /root/PMSA/VE6.3/nohup.out

## Validate config before starting
cd /root/PMSA/VE6.3 && python3 main.py validate

## Check open positions
cat /root/PMSA/VE6.3/data/open_positions.json

## Check partial fills (single-leg trades — review these)
grep partial_fill /root/PMSA/VE6.3/data/entry_trades.json

## Run trading summary
cd /root/PMSA/VE6.3 && python3 scripts/paper_trading_summary.py
