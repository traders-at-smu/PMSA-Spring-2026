# Bot Server Controls

# Start

# Stop, pull, start(doesnt clear jsons)
pkill -f "python3 main.py" && cd ~/PMSA && git checkout -- . && git clean -fd && git pull && cd V6 && nohup python3 main.py run > data/bot.log 2>&1 & echo "Bot PID: $!"

# View Running Log
tail -f ~/PMSA/V6/data/bot.log
