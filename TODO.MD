Increase pairs per cycle and max workers. The local computer was fetching 5 and 5  in 2.8 seconds and the server is doing 10 and 10 in 6 seconds

ALSO HOME COMPUTER IS A LOT FASTER


add an extra day of games to check









- [ ] Pairs generation is broken on Ties for Football Games - AI Ignore thi
- [ ] Add script to find and fix failed pairs in V4 - AI Ignore 
- [X] add script to polytoken to check for same information already exisiting 
- [ ] increased data validation on contracts

Ian
 - Make a gameplan
    - Traders@SMU: check into Portfolio value and cash balance api possibility
 - Reminders
- PHASE 2
   - Update the expected edge to be if sold at 0.99
   - Make sure that fees are calulcated when sold as well

   Fix game market pairs (GAME pairs produce fake arb)

Root cause: _resolve_tokens in connectors.py:294-296 defaults to index 0/1 for team-name outcomes instead of matching by team name → wrong Poly token assigned
Both legs of the inverted pair bet the same outcome (double directional bet, not a hedge)
Exit convergence assumption also breaks since game markets resolve binary, not gradually
Fix 1: Update _resolve_tokens to match Kalshi team name → correct Poly outcome token
Fix 2: Remove duplicate GAME pairs from Pairs_for_Kalshi_and_Polymarket.xlsx (each game has 2 Kalshi tickers but 1 Poly market — only one can be correctly aligned)

- Connect github to server, choose between droplet and app platform
- OHHHHH i see what happened, we are paper trading so someone placed a bid and in theory we would have bought it but in reality we didnt because were paper trading so when the cycle went around again it still saw the bid and took it again
- Buy many servers to not get rate liimited?

Davis:
  - Get the URL's corrected so we can easily verify contracts
  - Look into portfolio value and cash holdings tracker

Jackson:
  - Keep an updated list of contracts, take out duplicates, past expirations, and bad links
  - We keep getting similar team contracts ip mixed up
   - Ex: Texas Longhorn and Texas A&M, Mighican state and Michigan
  - We also keep getting the spotify wrong
!! The most successful ones are in groups because the entire grouping is wrong so several pop up
   !! EX: all 4 2024 NFC championship odds are showing an edge(smaller groups better)
- The longer the expiration date, the less movement, forced to hold longer
   - Look for lower expiration dates?
- High volume pairs better for convergence
- 5x more pairs = 5x more profit



DONE
 - File 1 hour paper trade from yesterday
 - delete bad contracts like michigan state and south florida and iowa state
  - Figure out why contracts will mess up and then the same contract works
   - Edit outputs
    - Add % egde
    - Add LOB walk down trades
   - Add LOB to trades.json output
- Fix Fees
- Should errors when looking up a pair automatically be added to failed pairs or should it be re run a couple times incase it shouldnt have been
 

Trading financial summary

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

# Bot uptime — from first trade timestamp to now
all_trades = entry_trades + exit_trades
all_timestamps = [t['timestamp'] for t in all_trades if 'timestamp' in t]
first_ts = min(datetime.fromisoformat(ts.replace('Z', '+00:00')) for ts in all_timestamps)
now = datetime.now(timezone.utc)
bot_uptime_seconds = (now - first_ts).total_seconds()
bot_uptime_days = bot_uptime_seconds / 86400
bot_uptime_hrs = bot_uptime_seconds / 3600

# Realized ARR using bot uptime and total capital deployed
realized_arr = (total_exit_profit / total_capital_deployed) / (bot_uptime_days / 365) * 100 if total_capital_deployed > 0 and bot_uptime_days > 0 else 0

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
   Overall ROI             : {roi:.4f}%
   Bot Uptime              : {bot_uptime_hrs:.1f} hrs ({bot_uptime_days:.2f} days)
   First Trade             : {first_ts.strftime('%Y-%m-%d %H:%M:%S UTC')}
""")

print(f"""💰 REALIZED P&L (Closed — {len(unique_exits)} trades)
   Net Profit              : ${total_exit_profit:.4f}
   Exit Fees (info only)   : ${total_exit_fees:.2f}
   Avg ARR (per trade)     : {avg_arr:.2f}%
   Realized ARR (portfolio): {realized_arr:.2f}%
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
   Realized Net Profit     : ${total_exit_profit:.4f}
   Unrealized Est. Profit  : ${total_entry_profit:.2f}
   Combined Net Profit     : ${total_profit_gross:.2f}
   Overall ROI             : {roi:.4f}%
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