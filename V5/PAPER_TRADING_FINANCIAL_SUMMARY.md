# Paper Trading Financial Summary
python3 << 'EOF'
import json
from datetime import datetime, timezone

def load_jsonl(path):
    trades = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                trades.append(json.loads(line))
    return trades

entry_trades = load_jsonl('/root/bot/V5/entry_trades.json')
exit_trades  = load_jsonl('/root/bot/V5/exit_trades.json')

seen = set()
unique_exits = []
for t in exit_trades:
    if t['trade_number'] not in seen:
        seen.add(t['trade_number'])
        unique_exits.append(t)

# Peak capital calculation
entry_by_number = {t['trade_number']: t for t in entry_trades}
events = []
for ex in exit_trades:
    entry_num = ex.get('corresponding_entry_trade_number')
    entry = entry_by_number.get(entry_num)
    if not entry:
        continue
    entry_ts = datetime.fromisoformat(entry['timestamp'].replace('Z', '+00:00'))
    exit_ts  = datetime.fromisoformat(ex['timestamp'].replace('Z', '+00:00'))
    cost     = ex.get('entry_kp_cost', 0)
    events.append((entry_ts, +cost))
    events.append((exit_ts,  -cost))
for en in entry_trades:
    cost = sum(f['k_price'] * f['contracts'] + f['p_price'] * f['contracts'] for f in en.get('fills', []))
    entry_ts = datetime.fromisoformat(en['timestamp'].replace('Z', '+00:00'))
    events.append((entry_ts, +cost))
events.sort(key=lambda x: x[0])
peak_capital = 0
current_capital = 0
peak_ts = None
for ts, delta in events:
    current_capital += delta
    if current_capital > peak_capital:
        peak_capital = current_capital
        peak_ts = ts

total_entry_cost       = sum(t.get('entry_kp_cost', 0) for t in unique_exits)
open_entry_cost        = sum(
    sum(f['k_price'] * f['contracts'] + f['p_price'] * f['contracts'] for f in t['fills'])
    for t in entry_trades
)
total_capital_deployed = total_entry_cost + open_entry_cost

total_exit_profit  = sum(t['total_profit'] for t in unique_exits)
total_exit_fees    = sum(t['fee'] for t in unique_exits)
avg_arr            = sum(t['arr'] for t in unique_exits) / len(unique_exits)
avg_hold_hrs       = sum(t['hold_duration_seconds'] for t in unique_exits) / len(unique_exits) / 3600
avg_exit_edge      = sum(t['edge_pct'] for t in unique_exits) / len(unique_exits)
best_arr_trade     = max(unique_exits, key=lambda t: t['arr'])
best_profit_trade  = max(unique_exits, key=lambda t: t['total_profit'])
worst_profit_trade = min(unique_exits, key=lambda t: t['total_profit'])

all_timestamps = [t['timestamp'] for t in entry_trades + exit_trades if 'timestamp' in t]
first_ts = min(datetime.fromisoformat(ts.replace('Z', '+00:00')) for ts in all_timestamps)
now = datetime.now(timezone.utc)
bot_uptime_seconds = (now - first_ts).total_seconds()
bot_uptime_days = bot_uptime_seconds / 86400
bot_uptime_hrs = bot_uptime_seconds / 3600

realized_arr = (total_exit_profit / peak_capital) / (bot_uptime_days / 365) * 100 if peak_capital > 0 and bot_uptime_days > 0 else 0

total_entry_profit  = sum(t['total_profit'] for t in entry_trades)
total_entry_fees    = sum(t['fee'] for t in entry_trades)
avg_entry_edge      = sum(t['edge_pct'] for t in entry_trades) / len(entry_trades)
best_entry_edge     = max(entry_trades, key=lambda t: t['edge_pct'])
worst_entry_edge    = min(entry_trades, key=lambda t: t['edge_pct'])
top_5_entry_edge    = sorted(entry_trades, key=lambda t: t['edge_pct'], reverse=True)[:5]
top_5_entry_profit  = sorted(entry_trades, key=lambda t: t['total_profit'], reverse=True)[:5]

total_profit_gross  = total_exit_profit + total_entry_profit
roi                 = (total_profit_gross / total_capital_deployed * 100) if total_capital_deployed > 0 else 0

print("=" * 70)
print("                 FULL FINANCIAL SUMMARY")
print("=" * 70)

print(f"""
💵 CAPITAL
   Total Capital Deployed  : ${total_capital_deployed:,.2f}
     └ In Closed Trades    : ${total_entry_cost:,.2f}
     └ In Open Trades      : ${open_entry_cost:,.2f}
   Peak Capital Deployed   : ${peak_capital:,.2f} (at {peak_ts.strftime('%Y-%m-%d %H:%M UTC')})
   Overall ROI             : {roi:.4f}%
   Bot Uptime              : {bot_uptime_hrs:.1f} hrs ({bot_uptime_days:.2f} days)
   First Trade             : {first_ts.strftime('%Y-%m-%d %H:%M:%S UTC')}
""")

print(f"""💰 REALIZED P&L (Closed — {len(unique_exits)} trades)
   Net Profit              : ${total_exit_profit:.4f}
   Exit Fees (info only)   : ${total_exit_fees:.2f}
   Avg ARR (per trade)     : {avg_arr:.2f}%
   Realized ARR (portfolio): {realized_arr:.2f}%
     └ Basis: peak capital ${peak_capital:,.2f} over {bot_uptime_days:.2f} days
   Avg Hold Time           : {avg_hold_hrs:.2f} hrs
   Avg Edge at Exit        : {avg_exit_edge:.2f}%

   🏆 Best ARR             : {best_arr_trade['arr']}% | ${best_arr_trade['total_profit']} profit
                             {best_arr_trade['title']}
   🏆 Best Profit          : ${best_profit_trade['total_profit']} | ARR {best_profit_trade['arr']}%
                             {best_profit_trade['title']}
   ⚠️  Worst Profit        : ${worst_profit_trade['total_profit']} | ARR {worst_profit_trade['arr']}%
                             {worst_profit_trade['title']}
""")

print(f"""📊 UNREALIZED P&L (Open — {len(entry_trades)} trades)
   Capital at Risk         : ${open_entry_cost:,.2f}
   Est. Net Profit         : ${total_entry_profit:.2f}
   Entry Fees (info only)  : ${total_entry_fees:.2f}
   Avg Edge                : {avg_entry_edge:.2f}%

   🏆 Best Edge            : {best_entry_edge['edge_pct']}% — {best_entry_edge['title']}
   ⚠️  Worst Edge          : {worst_entry_edge['edge_pct']}% — {worst_entry_edge['title']}

   Top 5 by Edge:""")
for t in top_5_entry_edge:
    print(f"     {t['edge_pct']}% | ${t['total_profit']:.2f} est. | {t['total_contracts']} contracts | {t['title'][:45]}")

print(f"""
   Top 5 by Est. Profit:""")
for t in top_5_entry_profit:
    print(f"     ${t['total_profit']:.2f} | {t['edge_pct']}% edge | {t['total_contracts']} contracts | {t['title'][:45]}")

print(f"""
🧾 OVERALL
   Total Trades            : {len(entry_trades) + len(unique_exits)}
     └ Open                : {len(entry_trades)}
     └ Closed              : {len(unique_exits)}
   Total Capital Deployed  : ${total_capital_deployed:,.2f}
   Peak Capital Deployed   : ${peak_capital:,.2f}
   Realized Net Profit     : ${total_exit_profit:.4f}
   Unrealized Est. Profit  : ${total_entry_profit:.2f}
   Combined Net Profit     : ${total_profit_gross:.2f}
   Overall ROI             : {roi:.4f}%
   Realized ARR (portfolio): {realized_arr:.2f}%
""")

print("-" * 70)
print("EXIT TRADE BREAKDOWN")
print("-" * 70)
print(f"{'#':<8} {'Cost':>8} {'Net Profit':>10} {'Fee(ref)':>8} {'Contracts':>10} {'ARR':>10} {'Hold':>6}   Market")
print("-" * 70)
for t in unique_exits:
    hold = t['hold_duration_seconds'] / 3600
    cost = t.get('entry_kp_cost', 0)
    print(f"{t['trade_number']:<8} ${cost:>6.2f} ${t['total_profit']:>8.4f} ${t['fee']:>6.2f} {t['total_contracts']:>10} {t['arr']:>9.2f}% {hold:>5.1f}h   {t['title'][:30]}")

print("=" * 70)
EOF