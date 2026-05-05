# Server Controls



# Restart V6.3 & Pull
pkill -f "main.py run"; cd /root/PMSA && git pull origin main && cd V6.3 && nohup python3 main.py run > nohup.out 2>&1 &

# Check Paper Trading Summary
cd /root/PMSA/V6.3 && python3 scripts/paper_trading_summary.py
