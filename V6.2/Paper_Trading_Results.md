# Paper Trading Results
python3 -c "
import json
from datetime import datetime, timezone, timedelta

trades = []
with open('/root/PMSA/V6.2/data/entry_trades.json') as f:
    for line in f:
        line = line.strip()
        if line:
            trades.append(json.loads(line))

trades.sort(key=lambda x: x['timestamp'])

GAP = timedelta(seconds=20)

current = {}
sessions = []

for t in trades:
    pid = t['pair_id']
    ts = datetime.fromisoformat(t['timestamp'].replace('Z', '+00:00'))
    if pid not in current:
        current[pid] = [t]
    else:
        last_ts = datetime.fromisoformat(current[pid][-1]['timestamp'].replace('Z', '+00:00'))
        if ts - last_ts > GAP:
            sessions.append(current[pid])
            current[pid] = [t]
        else:
            current[pid].append(t)

for group in current.values():
    sessions.append(group)

results = []
for s in sessions:
    best = max(s, key=lambda x: x['total_profit'])
    start_ts = s[0]['timestamp'][5:16]
    end_ts = s[-1]['timestamp'][5:16]
    results.append((start_ts, best['total_profit'], best['title'], best['total_contracts'], best['edge_pct'], end_ts))

results.sort()

total_profit = sum(r[1] for r in results)

print(f'Total positions:   {len(sessions)}')
print(f'Total est. profit: \${total_profit:.2f}')
print()
for r in results:
    start, profit, title, contracts, edge, end = r
    print(f\"{title[:35]:<35} | {contracts}c | {edge}% | \${profit:.2f} | {start} -> {end}\")
"