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
CDT = timedelta(hours=-5)

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

def to_cdt(ts_str):
    ts = datetime.fromisoformat(ts_str.replace('Z', '+00:00'))
    cdt = ts + CDT
    return cdt.strftime('%m-%d %I:%M%p').lower()

def duration(ts_start, ts_end):
    t1 = datetime.fromisoformat(ts_start.replace('Z', '+00:00'))
    t2 = datetime.fromisoformat(ts_end.replace('Z', '+00:00'))
    secs = int((t2 - t1).total_seconds())
    if secs == 0:
        return '<15s', 0
    elif secs < 60:
        return f'{secs}s', secs
    elif secs < 3600:
        return f'{secs//60}m {secs%60}s', secs
    else:
        return f'{secs//3600}h {(secs%3600)//60}m', secs

results = []
for s in sessions:
    best = max(s, key=lambda x: x['total_profit'])
    start_ts = to_cdt(s[0]['timestamp'])
    end_ts = to_cdt(s[-1]['timestamp'])
    dur_str, dur_secs = duration(s[0]['timestamp'], s[-1]['timestamp'])
    contracts = best['total_contracts']
    profit = best['total_profit']
    edge = best['edge_pct']
    fills = best.get('fills', [])
    cost = sum((f.get('k_price', 0) + f.get('p_price', 0)) * f.get('contracts', 0) for f in fills)
    results.append((s[0]['timestamp'], profit, best['title'], contracts, edge, start_ts, end_ts, cost, dur_str, dur_secs))

results.sort()

total_profit = sum(r[1] for r in results)
total_contracts = sum(r[3] for r in results)
total_spent = sum(r[7] for r in results)

first_trade = to_cdt(trades[0]['timestamp'])
last_trade = to_cdt(trades[-1]['timestamp'])

total_edge_pct = (total_profit / total_spent * 100) if total_spent > 0 else 0
annualized_edge = total_edge_pct * 365
yearly_profit = total_profit * 365

print(f'Period:            {first_trade} -> {last_trade} CDT')
print(f'Total positions:   {len(results):,}')
print(f'Total contracts:   {total_contracts:,}')
print(f'Total spent:       \${total_spent:,.2f}')
print(f'Total est. profit: \${total_profit:,.2f}')
print(f'Total edge:        {total_edge_pct:.2f}%')
print(f'Annualized edge:   {annualized_edge:.1f}%')
print(f'1yr est. profit:   \${yearly_profit:,.2f}')
print()
for r in results:
    _, profit, title, contracts, edge, start, end, cost, dur_str, dur_secs = r
    print(f\"{title[:35]:<35} | {contracts:,}c | {edge}% | \${profit:,.2f} | {start} -> {end} ({dur_str})\")

buckets = {'<15s': [0, 0.0], '15s-1m': [0, 0.0], '1m-5m': [0, 0.0], '5m-30m': [0, 0.0], '30m+': [0, 0.0]}
for r in results:
    secs = r[9]
    profit = r[1]
    if secs == 0:
        buckets['<15s'][0] += 1
        buckets['<15s'][1] += profit
    elif secs < 60:
        buckets['15s-1m'][0] += 1
        buckets['15s-1m'][1] += profit
    elif secs < 300:
        buckets['1m-5m'][0] += 1
        buckets['1m-5m'][1] += profit
    elif secs < 1800:
        buckets['5m-30m'][0] += 1
        buckets['5m-30m'][1] += profit
    else:
        buckets['30m+'][0] += 1
        buckets['30m+'][1] += profit

total = len(results)
print()
print('Open duration breakdown:')
for label, (count, profit) in buckets.items():
    pct = count / total * 100 if total > 0 else 0
    bar = '#' * int(pct / 2)
    print(f'  {label:<10} {count:>4} ({pct:5.1f}%)  \${profit:,.2f}  {bar}')
"