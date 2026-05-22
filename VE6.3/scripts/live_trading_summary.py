import json
import re
import sys
import statistics
from datetime import datetime, date, timedelta
from collections import defaultdict
from pathlib import Path

SPORT_PREFIXES = [
    ('ATPCHALLENGER', 'ATP Challenger'),
    ('ATP',           'ATP'),
    ('WTA',           'WTA'),
    ('KBO',           'KBO'),
    ('MLB',           'MLB'),
    ('NBA',           'NBA'),
    ('NHL',           'NHL'),
    ('NFL',           'NFL'),
    ('NCAABB',        'NCAAB'),
    ('NCAAFB',        'NCAAF'),
    ('MLS',           'MLS'),
    ('EPL',           'EPL'),
    ('UEFA',          'UEFA'),
    ('WNBA',          'WNBA'),
    ('CFL',           'CFL'),
]

def parse_sport(token):
    if not token:
        return 'Unknown'
    s = token.upper().split('-')[0]
    if s.startswith('KX'):
        s = s[2:]
    for prefix, label in SPORT_PREFIXES:
        if s.startswith(prefix):
            return label
    return s[:12] if s else 'Unknown'

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

def to_cdt(ts_str):
    CDT = timedelta(hours=-5)
    ts  = datetime.fromisoformat(ts_str.replace('Z', '+00:00'))
    cdt = ts + CDT
    return cdt.strftime('%m-%d %I:%M%p').lower()

def get_cost(trade):
    """Return actual total cost spent from live fill data."""
    if 'total_cost' in trade:
        return float(trade['total_cost'])
    return float(trade.get('k_actual_cost', 0.0)) + float(trade.get('p_actual_cost', 0.0))

def get_contracts(trade):
    """Return actual contracts filled."""
    return trade.get('k_contracts_filled', trade.get('total_contracts', 0))

def get_fill_summary(trade):
    """Return a readable fill summary string."""
    legs = trade.get('legs_filled', 'both')
    k = trade.get('k_contracts_filled', 0)
    p = trade.get('p_contracts_filled', 0)
    if legs == 'both' and k == p:
        return f'{k}c hedged'
    elif legs == 'mismatch':
        return f'K:{k}c/P:{p}c mismatch'
    elif legs == 'kalshi_only':
        return f'{k}c Kalshi only'
    return f'{k}c/{p}c'

def parse_sides(strategy: str):
    """Return (k_side, p_side) as 'YES' or 'NO' from strategy string."""
    s = (strategy or '').upper()
    k_side = 'YES' if ('KY' in s or 'KBY' in s) else 'NO'
    p_side = 'YES' if 'PY' in s else 'NO'
    return k_side, p_side


# ── Account balances ───────────────────────────────────────────────────────────

def _fetch_balances():
    """Fetch live balances from Kalshi and Polymarket. Returns dict or None on failure."""
    try:
        root = Path(__file__).parent.parent
        sys.path.insert(0, str(root / "src"))

        cfg = {}
        config_path = root / "config.json"
        keys_path   = root / "api-keys.json"
        if config_path.exists():
            with config_path.open() as f:
                cfg.update(json.load(f))
        if keys_path.exists():
            with keys_path.open() as f:
                for k, v in json.load(f).items():
                    if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                        cfg[k] = {**cfg.get(k, {}), **v}
                    else:
                        cfg[k] = v

        from connectors import KalshiConnector, PolymarketConnector
        k_cfg = cfg.get("kalshi", {})
        p_cfg = cfg.get("polymarket", {})
        proxy_cfg = cfg.get("proxy", {})

        kalshi = KalshiConnector(
            api_key=k_cfg.get("api_key", ""),
            private_key_base64=k_cfg.get("private_key_base64", ""),
            base_url=k_cfg.get("base_url", ""),
            proxy_config=proxy_cfg,
        )
        poly = PolymarketConnector(
            private_key=p_cfg.get("private_key", ""),
            api_key=p_cfg.get("api_key", ""),
            api_secret=p_cfg.get("api_secret", ""),
            api_passphrase=p_cfg.get("api_passphrase", ""),
            funder_address=p_cfg.get("funder_address", ""),
            clob_url=p_cfg.get("clob_url", ""),
            gamma_url=p_cfg.get("gamma_url", ""),
            proxy_config=proxy_cfg,
        )
        return {
            "kalshi":     kalshi.get_balance(),
            "polymarket": poly.get_balance(),
        }
    except Exception as exc:
        return {"error": str(exc)}



# Load trades — live only, skip legs_filled="none"
trades = []
data_file = Path(__file__).parent.parent / "data" / "entry_trades.json"
with open(data_file) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        t = json.loads(line)
        if not isinstance(t, dict):
            continue
        if t.get('legs_filled') == 'none':
            continue
        if t.get('mode', 'live') != 'live':
            continue
        trades.append(t)

if not trades:
    print("No live trades found in entry_trades.json")
    exit(0)

trades.sort(key=lambda x: x['timestamp'])

CDT_OFFSET = timedelta(hours=-5)
first_trade = to_cdt(trades[0]['timestamp'])
last_trade  = to_cdt(trades[-1]['timestamp'])

# Build one result per trade
results = []
for t in trades:
    token     = t.get('kalshi_token', '')
    game_date = parse_game_date_from_token(token)
    exec_date = t.get('execution_date', '')
    d_held    = days_held(exec_date, game_date) if game_date else None
    contracts = get_contracts(t)
    cost      = get_cost(t)
    profit    = float(t.get('total_profit', 0.0))
    edge      = float(t.get('edge_pct', 0.0))
    arr       = t.get('arr', None)
    legs      = t.get('legs_filled', 'both')
    fill_sum  = get_fill_summary(t)
    k_side, p_side = parse_sides(t.get('strategy', ''))

    k_price        = t.get('k_actual_price', 0.0)
    p_price        = t.get('p_actual_price', 0.0)
    p_scanned      = t.get('p_scanned_price', 0.0)
    profit_if_k    = t.get('profit_if_kalshi_wins')
    profit_if_p    = t.get('profit_if_poly_wins')

    if profit_if_k is not None:
        if legs == 'kalshi_only' or not p_price:
            p_implied = p_scanned if p_scanned else None
            p_k = (k_price + (1.0 - p_implied)) / 2.0 if p_implied else k_price if k_price else 0.5
        else:
            p_k = (k_price + (1.0 - p_price)) / 2.0 if k_price else 0.5
        ev = p_k * profit_if_k + (1.0 - p_k) * profit_if_p
    else:
        ev = profit

    results.append({
        'timestamp':      t['timestamp'],
        'profit':         profit,
        'ev':             ev,
        'title':          t.get('title', ''),
        'contracts':      contracts,
        'edge':           edge,
        'cdt':            to_cdt(t['timestamp']),
        'cost':           cost,
        'exec_date':      exec_date,
        'game_date':      game_date,
        'd_held':         d_held,
        'arr':            arr,
        'token':          token,
        'legs':           legs,
        'fill_sum':       fill_sum,
        'k_price':        k_price,
        'p_price':        p_price,
        'p_scanned_price': p_scanned,
        'k_cost':         t.get('k_actual_cost', 0.0),
        'p_cost':         t.get('p_actual_cost', 0.0),
        'k_contracts':    t.get('k_contracts_filled', 0),
        'p_contracts':    t.get('p_contracts_filled', 0),
        'k_side':         k_side,
        'p_side':         p_side,
        'profit_if_k':    profit_if_k,
        'profit_if_p':    profit_if_p,
    })

results.sort(key=lambda r: r['timestamp'])

total_profit    = sum(r['ev'] for r in results)
total_contracts = sum(r['contracts'] for r in results)
total_spent     = sum(r['cost'] for r in results)
total_edge_pct  = (total_profit / total_spent * 100) if total_spent > 0 else 0
partial_count   = sum(1 for r in results if r['legs'] != 'both')

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
print('  LIVE TRADING SUMMARY')
sep('═', 95)
print(f'  Period            {first_trade}  →  {last_trade} CDT')
print(f'  Positions         {len(results):,}')
print(f'  Contracts         {total_contracts:,}')
print(f'  Capital deployed  ${total_spent:,.2f}')
print(f'  Actual profit     ${total_profit:,.2f}')
print(f'  Total edge        {total_edge_pct:.2f}%')
if partial_count:
    print(f'  Partial fills     {partial_count} (see trade log for details)')
sep('═', 95)

# ── Account balances ───────────────────────────────────────────────────────────
header('ACCOUNT BALANCES')
balances = _fetch_balances()
if "error" in balances:
    print(f'  Could not fetch balances: {balances["error"]}')
else:
    k = balances.get("kalshi", {})
    p = balances.get("polymarket", {})
    print(f'  Kalshi cash         ${k.get("balance", 0.0):>10,.2f}')
    print(f'  Kalshi portfolio    ${k.get("portfolio_value", 0.0):>10,.2f}')
    print(f'  Polymarket cash     ${p.get("cash", 0.0):>10,.2f}')
    k_total = k.get("balance", 0.0) + k.get("portfolio_value", 0.0)
    p_total = p.get("cash", 0.0)
    print('  ' + '─' * 40)
    print(f'  Total account value ${k_total + p_total:>10,.2f}')

# ── Trade log ─────────────────────────────────────────────────────────────────
TLOG_W = 110
header('TRADE LOG')
print(f"  {'Market':<26}  {'Kalshi':<24}  {'Polymarket':<24}  {'Cost':>7}  {'Profit (EV / K / P)':>26}  {'Time (CDT)':<14}  {'ARR':>6}")
print('  ' + '─' * (TLOG_W - 2))
for r in results:
    arr_str = f"{r['arr']:.0f}%" if r['arr'] is not None else 'n/a'

    kc = r['k_contracts']
    pc = r['p_contracts']
    k_leg = f"{r['k_side']:<3}  {kc}c @ ${r['k_price']:.3f}"
    if r['legs'] == 'kalshi_only':
        p_leg = '—'
    else:
        p_leg = f"{r['p_side']:<3}  {pc:.1f}c @ ${r['p_price']:.3f}"

    if r['profit_if_k'] is not None:
        profit_str = f"EV:${r['ev']:+.2f}  K:${r['profit_if_k']:.2f}/P:${r['profit_if_p']:.2f}"
    else:
        profit_str = f"${r['ev']:>+8,.2f}"

    print(
        f"  {r['title'][:26]:<26}  {k_leg:<24}  {p_leg:<24}  "
        f"${r['cost']:>6,.2f}  {profit_str:>26}  {r['cdt']:<14}  {arr_str:>6}"
    )

# ── Per-pair breakdown ─────────────────────────────────────────────────────────
header('PER-PAIR BREAKDOWN  (sorted by profit)')
print(f"  {'Market':<38}  {'Pos':>3}  {'Contracts':>9}  {'Spent':>9}  {'Profit':>8}  {'ROI':>6}  {'Avg ARR':>8}")
sep()

pair_stats = defaultdict(lambda: {'count': 0, 'profit': 0.0, 'contracts': 0, 'cost': 0.0, 'edges': [], 'arrs': []})
for r in results:
    s = pair_stats[r['title']]
    s['count']     += 1
    s['profit']    += r['profit']
    s['contracts'] += r['contracts']
    s['cost']      += r['cost']
    if isinstance(r['edge'], (int, float)):
        s['edges'].append(r['edge'])
    if r['arr'] is not None:
        s['arrs'].append(r['arr'])

for title, s in sorted(pair_stats.items(), key=lambda x: -x[1]['profit']):
    roi     = s['profit'] / s['cost'] * 100 if s['cost'] > 0 else 0
    avg_arr = sum(s['arrs']) / len(s['arrs']) if s['arrs'] else 0
    avg_arr_str = f"{avg_arr:.0f}%" if s['arrs'] else 'n/a'
    print(f"  {title[:38]:<38}  {s['count']:>3}  {s['contracts']:>9,}  ${s['cost']:>8,.2f}  ${s['profit']:>7,.2f}  {roi:>5.1f}%  {avg_arr_str:>8}")

# ── Edge distribution ──────────────────────────────────────────────────────────
header('EDGE DISTRIBUTION  (from actual fills)')
edges = [r['edge'] for r in results if isinstance(r['edge'], (int, float))]
if edges:
    med = statistics.median(edges)
    avg = sum(edges) / len(edges)
    std = statistics.stdev(edges) if len(edges) > 1 else 0
    print(f'  min {min(edges):.2f}%   max {max(edges):.2f}%   median {med:.2f}%   mean {avg:.2f}%   stdev {std:.2f}%')
    print()
    print(f"  {'Bucket':<10}  {'Count':>5}  {'% pos':>6}  {'Profit':>10}  {'% profit':>9}  Bar")
    sep()
    for label, fn in edge_buckets_def:
        matched    = [r for r in results if isinstance(r['edge'], (int, float)) and fn(r['edge'])]
        count      = len(matched)
        bkt_profit = sum(m['profit'] for m in matched)
        pct_pos    = count / len(edges) * 100 if edges else 0
        pct_profit = bkt_profit / total_profit * 100 if total_profit > 0 else 0
        bar        = '█' * int(pct_pos / 3)
        print(f"  {label:<10}  {count:>5}  {pct_pos:>5.1f}%  ${bkt_profit:>9,.2f}  {pct_profit:>8.1f}%  {bar}")

# ── ARR distribution ───────────────────────────────────────────────────────────
header('ARR DISTRIBUTION  (actual days to expiry)')
arr_rows = [r for r in results if r['arr'] is not None]
valid_arrs = [r['arr'] for r in arr_rows]

if valid_arrs:
    cost_w = sum(r['cost'] * r['arr'] for r in arr_rows) / sum(r['cost'] for r in arr_rows) if total_spent > 0 else 0
    ctr_w  = sum(r['contracts'] * r['arr'] for r in arr_rows) / sum(r['contracts'] for r in arr_rows) if total_contracts > 0 else 0
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
        matched    = [r for r in arr_rows if fn(r['arr'])]
        count      = len(matched)
        bkt_profit = sum(m['profit'] for m in matched)
        avg_arr    = sum(m['arr'] for m in matched) / count if count else 0
        pct_pos    = count / len(valid_arrs) * 100 if valid_arrs else 0
        pct_profit = bkt_profit / total_profit * 100 if total_profit > 0 else 0
        bar        = '█' * int(pct_pos / 3)
        print(f"  {label:<12}  {count:>5}  {pct_pos:>5.1f}%  ${bkt_profit:>9,.2f}  {pct_profit:>8.1f}%  {avg_arr:>7.0f}%  {bar}")

# ── Fill quality ───────────────────────────────────────────────────────────────
header('FILL QUALITY')
print(f"  {'Status':<20}  {'Count':>5}  {'Contracts':>9}  {'Spent':>9}  {'Profit':>9}")
sep()
for legs_label in ['both', 'mismatch', 'kalshi_only']:
    matched = [r for r in results if r['legs'] == legs_label]
    if not matched:
        continue
    count      = len(matched)
    contracts  = sum(r['contracts'] for r in matched)
    cost       = sum(r['cost'] for r in matched)
    profit     = sum(r['profit'] for r in matched)
    print(f"  {legs_label:<20}  {count:>5}  {contracts:>9,}  ${cost:>8,.2f}  ${profit:>8,.2f}")

# ── Sport breakdown ────────────────────────────────────────────────────────────
header('SPORT BREAKDOWN  (sorted by profit)')
print(f"  {'Sport':<14}  {'Pos':>3}  {'Contracts':>9}  {'Spent':>9}  {'Profit':>8}  {'ROI':>6}  {'Avg edge':>9}  {'Avg ARR':>8}")
sep()

sport_stats = defaultdict(lambda: {'count': 0, 'profit': 0.0, 'contracts': 0, 'cost': 0.0, 'edges': [], 'arrs': []})
for r in results:
    sport = parse_sport(r['token'])
    sport_stats[sport]['count']     += 1
    sport_stats[sport]['profit']    += r['profit']
    sport_stats[sport]['contracts'] += r['contracts']
    sport_stats[sport]['cost']      += r['cost']
    if isinstance(r['edge'], (int, float)):
        sport_stats[sport]['edges'].append(r['edge'])
    if r['arr'] is not None:
        sport_stats[sport]['arrs'].append(r['arr'])

for sport, s in sorted(sport_stats.items(), key=lambda x: -x[1]['profit']):
    roi         = s['profit'] / s['cost'] * 100 if s['cost'] > 0 else 0
    avg_edge    = sum(s['edges']) / len(s['edges']) if s['edges'] else 0
    avg_arr     = sum(s['arrs']) / len(s['arrs']) if s['arrs'] else 0
    avg_arr_str = f"{avg_arr:.0f}%" if s['arrs'] else 'n/a'
    print(f"  {sport:<14}  {s['count']:>3}  {s['contracts']:>9,}  ${s['cost']:>8,.2f}  ${s['profit']:>7,.2f}  {roi:>5.1f}%  {avg_edge:>8.2f}%  {avg_arr_str:>8}")

sep('═', 95)
