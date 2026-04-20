import json
import re
import statistics
from datetime import datetime, date, timedelta
from collections import defaultdict
from pathlib import Path

MONTH_MAP = {
    'JAN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4, 'MAY': 5, 'JUN': 6,
    'JUL': 7, 'AUG': 8, 'SEP': 9, 'OCT': 10, 'NOV': 11, 'DEC': 12
}

def parse_game_date_from_token(token):
    m = re.search(r'-(\d{2})([A-Z]{3})(\d{2})', token)
    if not m:
        return None
    try:
        yy, mon, dd = m.group(1), m.group(2), m.group(3)
        year  = 2000 + int(yy)
        month = MONTH_MAP.get(mon)
        day   = int(dd)
        if not month:
            return None
        return date(year, month, day)
    except Exception:
        return None

def days_held(execution_date_str, game_date):
    try:
        exec_dt = date.fromisoformat(execution_date_str)
        return max((game_date - exec_dt).days, 0)
    except Exception:
        return None

def sep(char='─', width=95):
    print(char * width)

def header(title):
    print()
    sep()
    print(f'  {title}')
    sep()

trades = []
data_file = Path(__file__).parent.parent / "data" / "entry_trades.json"
with open(data_file) as f:
    for line in f:
        line = line.strip()
        if line:
            trades.append(json.loads(line))

trades.sort(key=lambda x: x['timestamp'])

GAP = timedelta(seconds=20)
CDT = timedelta(hours=-5)

current  = {}
sessions = []

for t in trades:
    pid = t['pair_id']
    ts  = datetime.fromisoformat(t['timestamp'].replace('Z', '+00:00'))
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
    ts  = datetime.fromisoformat(ts_str.replace('Z', '+00:00'))
    cdt = ts + CDT
    return cdt.strftime('%m-%d %I:%M%p').lower()

def duration(ts_start, ts_end):
    t1   = datetime.fromisoformat(ts_start.replace('Z', '+00:00'))
    t2   = datetime.fromisoformat(ts_end.replace('Z', '+00:00'))
    secs = int((t2 - t1).total_seconds())
    if secs == 0:      return '<15s', 0
    elif secs < 60:    return f'{secs}s', secs
    elif secs < 3600:  return f'{secs//60}m {secs%60}s', secs
    else:              return f'{secs//3600}h {(secs%3600)//60}m', secs

def dur_bucket(secs):
    if secs == 0:    return '<15s'
    if secs < 60:    return '15s-1m'
    if secs < 300:   return '1m-5m'
    if secs < 1800:  return '5m-30m'
    return '30m+'

# best record = max total_profit within session (correct — records are incremental updates)
results = []
for s in sessions:
    best      = max(s, key=lambda x: x['total_profit'])
    start_ts  = to_cdt(s[0]['timestamp'])
    end_ts    = to_cdt(s[-1]['timestamp'])
    dur_str, dur_secs = duration(s[0]['timestamp'], s[-1]['timestamp'])
    contracts = best['total_contracts']
    profit    = best['total_profit']
    edge      = best['edge_pct']
    fills     = best.get('fills', [])
    cost      = sum((f.get('k_price', 0) + f.get('p_price', 0)) * f.get('contracts', 0) for f in fills)
    exec_date = best.get('execution_date', '')
    token     = best.get('kalshi_token', '')
    game_date = parse_game_date_from_token(token)
    d_held    = days_held(exec_date, game_date) if game_date else None
    arr       = best.get('arr', None)
    results.append((
        s[0]['timestamp'], profit, best['title'], contracts, edge,
        start_ts, end_ts, cost, dur_str, dur_secs, exec_date, game_date, d_held, arr
    ))

results.sort()

total_profit    = sum(r[1] for r in results)
total_contracts = sum(r[3] for r in results)
total_spent     = sum(r[7] for r in results)
first_trade     = to_cdt(trades[0]['timestamp'])
last_trade      = to_cdt(trades[-1]['timestamp'])
total_edge_pct  = (total_profit / total_spent * 100) if total_spent > 0 else 0

edge_buckets_def = [
    ('<0.5%',   lambda e: e < 0.5),
    ('0.5-1%',  lambda e: 0.5 <= e < 1.0),
    ('1-2%',    lambda e: 1.0 <= e < 2.0),
    ('2-5%',    lambda e: 2.0 <= e < 5.0),
    ('5-10%',   lambda e: 5.0 <= e < 10.0),
    ('10%+',    lambda e: e >= 10.0),
]

# ── Summary ────────────────────────────────────────────────────────────────────
sep('═', 95)
print('  PAPER TRADING SUMMARY')
sep('═', 95)
print(f'  Period            {first_trade}  →  {last_trade} CDT')
print(f'  Positions         {len(results):,}')
print(f'  Contracts         {total_contracts:,}')
print(f'  Capital deployed  ${total_spent:,.2f}')
print(f'  Est. profit       ${total_profit:,.2f}')
print(f'  Total edge        {total_edge_pct:.2f}%')
print()
print(f'  Note: each session uses max(total_profit) — records are incremental')
print(f'  updates within a position. {len([s for s in sessions if len(s)>1])} of {len(sessions)} sessions had multiple records.')
sep('═', 95)

# ── Trade log ─────────────────────────────────────────────────────────────────
header('TRADE LOG')
print(f"  {'Market':<35} {'Ctrs':>6}  {'Edge':>6}  {'Profit':>9}  {'Window':<22}  {'ARR':>7}")
sep()
for r in results:
    _, profit, title, contracts, edge, start, end, cost, dur_str, dur_secs, exec_d, game_dt, d_held, arr = r
    arr_str  = f'{arr:.0f}%' if arr is not None else 'n/a'
    win_str  = f'{start} ({dur_str})'
    print(f"  {title[:35]:<35} {contracts:>6,}  {edge:>5}%  ${profit:>8,.2f}  {win_str:<32}  {arr_str:>7}")

# ── Per-pair breakdown ─────────────────────────────────────────────────────────
header('PER-PAIR BREAKDOWN  (sorted by profit)')
print(f"  {'Market':<38}  {'Pos':>3}  {'Contracts':>9}  {'Spent':>9}  {'Profit':>8}  {'ROI':>6}  {'Avg ARR':>8}")
sep()

pair_stats = defaultdict(lambda: {'count': 0, 'profit': 0.0, 'contracts': 0, 'cost': 0.0, 'edges': [], 'arrs': []})
for r in results:
    _, profit, title, contracts, edge, _, _, cost, _, _, _, _, _, arr = r
    pair_stats[title]['count']     += 1
    pair_stats[title]['profit']    += profit
    pair_stats[title]['contracts'] += contracts
    pair_stats[title]['cost']      += cost
    if isinstance(edge, (int, float)):
        pair_stats[title]['edges'].append(edge)
    if arr is not None:
        pair_stats[title]['arrs'].append(arr)

for title, s in sorted(pair_stats.items(), key=lambda x: -x[1]['profit']):
    roi     = s['profit'] / s['cost'] * 100 if s['cost'] > 0 else 0
    avg_arr = sum(s['arrs']) / len(s['arrs']) if s['arrs'] else 0
    print(f"  {title[:38]:<38}  {s['count']:>3}  {s['contracts']:>9,}  ${s['cost']:>8,.2f}  ${s['profit']:>7,.2f}  {roi:>5.1f}%  {avg_arr:>7.0f}%")

# ── Edge distribution ──────────────────────────────────────────────────────────
header('EDGE DISTRIBUTION')
edges = [r[4] for r in results if isinstance(r[4], (int, float))]
if edges:
    med = statistics.median(edges)
    avg = sum(edges) / len(edges)
    std = statistics.stdev(edges) if len(edges) > 1 else 0
    print(f'  min {min(edges):.2f}%   max {max(edges):.2f}%   median {med:.2f}%   mean {avg:.2f}%   stdev {std:.2f}%')
    print()
    print(f"  {'Bucket':<10}  {'Count':>5}  {'% pos':>6}  {'Profit':>10}  {'% profit':>9}  Bar")
    sep()
    for label, fn in edge_buckets_def:
        matched      = [r for r in results if isinstance(r[4], (int, float)) and fn(r[4])]
        count        = len(matched)
        bkt_profit   = sum(m[1] for m in matched)
        pct_pos      = count / len(edges) * 100 if edges else 0
        pct_profit   = bkt_profit / total_profit * 100 if total_profit > 0 else 0
        bar          = '█' * int(pct_pos / 3)
        print(f"  {label:<10}  {count:>5}  {pct_pos:>5.1f}%  ${bkt_profit:>9,.2f}  {pct_profit:>8.1f}%  {bar}")

# ── ARR distribution ───────────────────────────────────────────────────────────
header('ARR DISTRIBUTION  (from record — actual hours to game start)')
arr_rows   = [(r[2], r[3], r[7], r[1], r[13]) for r in results if r[13] is not None]
valid_arrs = [r[4] for r in arr_rows]

if valid_arrs:
    cost_w = sum(r[2] * r[4] for r in arr_rows) / sum(r[2] for r in arr_rows)
    ctr_w  = sum(r[1] * r[4] for r in arr_rows) / sum(r[1] for r in arr_rows)
    print(f'  min {min(valid_arrs):.0f}%   max {max(valid_arrs):.0f}%   median {statistics.median(valid_arrs):.0f}%   mean {sum(valid_arrs)/len(valid_arrs):.0f}%')
    print(f'  Cost-weighted avg ARR:      {cost_w:.0f}%')
    print(f'  Contracts-weighted avg ARR: {ctr_w:.0f}%')
    print()
    arr_buckets = [
        ('<25%',     lambda a: a < 25),
        ('25-50%',   lambda a: 25  <= a < 50),
        ('50-100%',  lambda a: 50  <= a < 100),
        ('100-200%', lambda a: 100 <= a < 200),
        ('200-500%', lambda a: 200 <= a < 500),
        ('500%+',    lambda a: a >= 500),
    ]
    print(f"  {'Bucket':<12}  {'Count':>5}  {'% pos':>6}  {'Profit':>10}  {'% profit':>9}  {'Avg ARR':>8}  Bar")
    sep()
    for label, fn in arr_buckets:
        matched    = [r for r in arr_rows if fn(r[4])]
        count      = len(matched)
        bkt_profit = sum(m[3] for m in matched)
        avg_arr    = sum(m[4] for m in matched) / count if count else 0
        pct_pos    = count / len(valid_arrs) * 100 if valid_arrs else 0
        pct_profit = bkt_profit / total_profit * 100 if total_profit > 0 else 0
        bar        = '█' * int(pct_pos / 3)
        print(f"  {label:<12}  {count:>5}  {pct_pos:>5.1f}%  ${bkt_profit:>9,.2f}  {pct_profit:>8.1f}%  {avg_arr:>7.0f}%  {bar}")

# ── Arb window persistence ─────────────────────────────────────────────────────
header('ARB WINDOW PERSISTENCE')
window_buckets      = {'<15s': [0,0.0], '15s-1m': [0,0.0], '1m-5m': [0,0.0], '5m-30m': [0,0.0], '30m+': [0,0.0]}
single_profit = 0.0; single_count = 0
multi_profit  = 0.0; multi_count  = 0

for r in results:
    secs   = r[9]
    profit = r[1]
    b      = dur_bucket(secs)
    window_buckets[b][0] += 1
    window_buckets[b][1] += profit
    if secs == 0:
        single_count += 1; single_profit += profit
    else:
        multi_count  += 1; multi_profit  += profit

total = len(results)
print(f"  {'Duration':<10}  {'Count':>5}  {'% pos':>6}  {'Profit':>10}  {'% profit':>9}  {'Avg profit':>10}  Bar")
sep()
for label, (count, profit) in window_buckets.items():
    pct_pos    = count / total * 100 if total > 0 else 0
    pct_profit = profit / total_profit * 100 if total_profit > 0 else 0
    avg_p      = profit / count if count else 0
    bar        = '█' * int(pct_pos / 3)
    print(f"  {label:<10}  {count:>5}  {pct_pos:>5.1f}%  ${profit:>9,.2f}  {pct_profit:>8.1f}%  ${avg_p:>9.2f}  {bar}")

print()
if single_count:
    print(f"  Instant (<15s)     {single_count:>3} sessions  ${single_profit:>8.2f}  avg ${single_profit/single_count:.2f}/session")
if multi_count:
    print(f"  Persistent (15s+)  {multi_count:>3} sessions  ${multi_profit:>8.2f}  avg ${multi_profit/multi_count:.2f}/session")

# ── Edge x Duration cross-tab ──────────────────────────────────────────────────
header('EDGE BUCKET × ARB WINDOW')
dur_labels = ['<15s', '15s-1m', '1m-5m', '5m-30m', '30m+']

print('  Count / total profit per cell')
print(f"  {'':12}" + ''.join(f"  {d:>12}" for d in dur_labels) + f"  {'Total':>12}")
sep()
for label, fn in edge_buckets_def:
    matched = [r for r in results if isinstance(r[4], (int, float)) and fn(r[4])]
    if not matched:
        continue
    by_dur = defaultdict(list)
    for r in matched:
        by_dur[dur_bucket(r[9])].append(r[1])
    row = f'  {label:<12}'
    for d in dur_labels:
        items = by_dur.get(d, [])
        row  += f'  {len(items):>3}/${sum(items):>7.2f}' if items else f'  {"--":>12}'
    row += f'  {len(matched):>3}/${sum(r[1] for r in matched):>7.2f}'
    print(row)

print()
print('  Avg profit per session per cell')
print(f"  {'':12}" + ''.join(f"  {d:>10}" for d in dur_labels))
sep()
for label, fn in edge_buckets_def:
    matched = [r for r in results if isinstance(r[4], (int, float)) and fn(r[4])]
    if not matched:
        continue
    by_dur = defaultdict(list)
    for r in matched:
        by_dur[dur_bucket(r[9])].append(r[1])
    row = f'  {label:<12}'
    for d in dur_labels:
        items = by_dur.get(d, [])
        row  += f'  ${sum(items)/len(items):>8.2f}' if items else f'  {"--":>10}'
    print(row)

sep('═', 95)