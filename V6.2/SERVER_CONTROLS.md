# Server Controls

# Stop, pull, restart
pkill -f "main.py run"; cd /root/PMSA && git stash && git pull origin main && git checkout stash -- V6.2/data/entry_trades.json V6.2/data/open_positions.json && cd V6.2 && nohup python3 main.py run > nohup.out 2>&1 &

# Check Paper Trading Summary
cd /root/PMSA/V6.2 && python3 scripts/paper_trading_summary.py

