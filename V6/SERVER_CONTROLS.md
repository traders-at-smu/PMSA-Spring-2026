# Bot Server Controls

# Start

# Stop, pull, start(clears jsons)
pkill -f "python3 main.py" && cd ~/PMSA && git checkout -- . && git clean -fd && git pull && cd V6 && nohup python3 main.py run > data/bot.log 2>&1 & echo "Bot PID: $!"

# Stop, pull, start(keeps jsons)


# View Entry Trades
python3 -c "
import json
trades = []
with open('/root/PMSA/V6/data/entry_trades.json') as f:
    for line in f:
        line = line.strip()
        if line:
            trades.append(json.loads(line))
for t in trades:
    print(f\"{t['trade_number']} | {t['timestamp'][5:16]} | {t['title'][:40]} | {t['total_contracts']}c | {t['edge_pct']}% | ARR:{t['arr']}% | \${t['total_profit']:.2f}\")"

# View Running Log
tail -f ~/PMSA/V6/data/bot.log
