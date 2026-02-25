"""
model_v1.py -- Decision Engine (Physical Model) v1
===================================================
Authors: Davis Lynn, Hayden Kreikemeier

Ports the TypeScript heuristic from src/services/arbitrageExecutionService.ts
(lines 456-485) into a standalone Python function for sizing + edge estimation.

REQUIRED INPUTS (what must be logged per opportunity):
------------------------------------------------------
1. opportunity_row (dict) -- one row from the screener output:
   - id              : str   -- unique opportunity identifier
   - venue           : str   -- "POLYMARKET" or "KALSHI"
   - strategy        : str   -- "BINARY_BUY_BOTH" or "EVENT_BUY_ALL_YES"
   - market          : str   -- human-readable market title
   - yesAsk          : float -- YES ask price (0-1)
   - noAsk           : float -- NO ask price (0-1)
   - bidDepth        : float -- top-of-book bid depth in USD
   - askDepth        : float -- top-of-book ask depth in USD
   - liquidity       : float -- total liquidity USD (Kalshi)
   - profitPerDollar : float -- raw gross edge from screener
   - numOutcomes     : int   -- 2 for binary, >2 for event groups
   - sumAsks         : float -- sum of all YES asks

2. lob_metrics (dict) -- limit-order-book metrics:
   - topBookDepthUsd             : float -- total top-of-book depth (USD)
   - depthWithinProfitableBandUsd: float -- depth within profitable band (USD)
   - edgePersistence             : float -- fallback persistence (0-1)

3. recent_snapshots (list[dict]) -- last 1-3 snapshots at ~30s intervals:
   Each element: {"timestamp": str, "grossEdgePerDollar": float}

OUTPUTS:
--------
Returns dict with exactly 4 keys:
   - expected_slippage : float -- expected slippage as fraction of notional
   - fill_prob_20s     : float -- probability of fill within 20 seconds (0-1)
   - expected_net_edge : float -- gross_edge - expected_slippage
   - recommended_cap   : float -- max $ notional to deploy
"""

import csv
import math
import os

# ---------- Constants (match TypeScript exactly) ----------
MODEL_MAX_CAP_RATIO = 0.20      # max fraction of bankroll per trade
DEFAULT_BANKROLL_USD = 10_000   # default bankroll
RULES_DEFAULT_KP_MAX = float(os.getenv("MODEL_RULE_KP_MAX", "1.0"))
RULES_DEFAULT_A_MIN = float(os.getenv("MODEL_RULE_A_MIN", "0.0"))
MODEL_MIN_SUM_ASKS = float(os.getenv("MODEL_MIN_SUM_ASKS", "0.2"))
MODEL_MAX_SUM_ASKS = float(os.getenv("MODEL_MAX_SUM_ASKS", "1.2"))
MODEL_MAX_EXPECTED_NET_EDGE = float(os.getenv("MODEL_MAX_EXPECTED_NET_EDGE", "0.5"))


# ---------- Helpers ----------

def clamp(value: float, lo: float, hi: float) -> float:
    """Clamp value to [lo, hi]. Equivalent to TS Math.min(hi, Math.max(lo, value))."""
    return max(lo, min(hi, value))


def ceil_to_cent(value: float) -> float:
    """Round up to nearest cent. Equivalent to TS Math.ceil(value * 100) / 100."""
    return math.ceil(value * 100) / 100


def as_float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def calc_kalshi_fee(contracts: float, price: float, maker: bool = False) -> float:
    """
    Kalshi fee formula (from Information/Execution Fees.md, owner: Quang):
      Taker: ceil_to_cent(0.07   * C * P * (1-P))
      Maker: ceil_to_cent(0.0175 * C * P * (1-P))
    Polymarket fees: $0.
    """
    k = 0.0175 if maker else 0.07
    return ceil_to_cent(k * contracts * price * (1 - price))


def calc_trade_rule_kalshi_fee(contracts: float, price: float) -> float:
    """
    Trade Rules fee schedule:
      Fee = roundup(0.007 * C * Ask_K* * (1-Ask_K*))
    """
    return ceil_to_cent(0.007 * contracts * price * (1 - price))


def calc_trade_rule_kp(contracts: float, kalshi_ask: float, polymarket_ask: float) -> float:
    return (
        contracts * kalshi_ask
        + contracts * polymarket_ask
        + calc_trade_rule_kalshi_fee(contracts, kalshi_ask)
    )


def calc_gross_edge(sum_asks: float) -> float:
    """
    Gross edge per dollar = (1 - sumAsks) / max(sumAsks, 0.0001).

    For binary: sumAsks = yesAsk + noAsk.
    For event group: sumAsks = sum of all YES asks.
    Source: arbitrageExecutionService.ts lines 491, 558, 613, 681.
    """
    return (1.0 - sum_asks) / max(sum_asks, 0.0001)


def derive_lob_metrics(row: dict) -> dict:
    """
    Derive lob_metrics from a raw opportunity row, replicating the per-venue
    logic in buildXxxPlan methods:

    Polymarket binary (lines 496-497):
      topBookDepthUsd = bidDepth + askDepth
      depthWithinProfitableBandUsd = min(bidDepth, askDepth)

    Kalshi binary (line 618):
      topBookDepthUsd = liquidity
      depthWithinProfitableBandUsd = liquidity * 0.02

    Kalshi event group (lines 687-688):
      topBookDepthUsd = numOutcomes * 1500
      depthWithinProfitableBandUsd = numOutcomes * 800
    """
    venue = row.get("venue", "")
    strategy = row.get("strategy", "")

    if venue == "POLYMARKET":
        bid = float(row.get("bidDepth", 0))
        ask = float(row.get("askDepth", 0))
        return {
            "topBookDepthUsd": bid + ask,
            "depthWithinProfitableBandUsd": min(bid, ask),
            "edgePersistence": 0.0,
        }
    elif strategy == "EVENT_BUY_ALL_YES":
        n = int(row.get("numOutcomes", 2))
        return {
            "topBookDepthUsd": n * 1500,
            "depthWithinProfitableBandUsd": n * 800,
            "edgePersistence": 0.0,
        }
    else:  # Kalshi binary
        liq = float(row.get("liquidity", 0))
        return {
            "topBookDepthUsd": liq,
            "depthWithinProfitableBandUsd": liq * 0.02,
            "edgePersistence": 0.0,
        }

def describe_legs(row: dict) -> str:
    """
    Human-readable leg routing for demo output.
    """
    direction = str(row.get("best_direction", "")).upper()
    if direction == "BUY_KY_PN":
        return "KAL YES + POLY NO"
    if direction == "BUY_KN_PY":
        return "KAL NO + POLY YES"
    if direction == "POLY_YES_KAL_NO":
        return "POLY YES + KAL NO"
    if direction == "POLY_NO_KAL_YES":
        return "POLY NO + KAL YES"

    venue = str(row.get("venue", "")).upper()
    strategy = str(row.get("strategy", "")).upper()
    if strategy == "BINARY_BUY_BOTH":
        if venue == "POLYMARKET":
            return "POLY YES + POLY NO"
        if venue == "KALSHI":
            return "KAL YES + KAL NO"
    if strategy == "EVENT_BUY_ALL_YES":
        return "ALL YES OUTCOMES"
    return "N/A"


def evaluate_trade_rules(opportunity_row: dict, recommended_cap: float) -> dict:
    """
    Required trade gates:
      1) KP(c_new) < c_new
      2) KP(c) < KP_max
      3) A_e(c_new) >= A_min
    """
    sum_asks = max(as_float(opportunity_row.get("sumAsks"), 0.0), 0.000001)
    c_existing = max(as_float(opportunity_row.get("c"), 1.0), 1.0)
    c_new = max(recommended_cap / sum_asks, 0.0)

    selected_kal_ask = as_float(opportunity_row.get("selected_kal_ask"), 0.0)
    selected_poly_ask = as_float(opportunity_row.get("selected_poly_ask"), 0.0)

    if selected_kal_ask > 0 and selected_poly_ask > 0:
        kp_c = calc_trade_rule_kp(c_existing, selected_kal_ask, selected_poly_ask)
        kp_c_new = calc_trade_rule_kp(c_new, selected_kal_ask, selected_poly_ask)
    else:
        # Fallback when venue-split asks are unavailable.
        kp_c = c_existing * sum_asks
        kp_c_new = c_new * sum_asks

    kp_max = as_float(opportunity_row.get("kp_max"), RULES_DEFAULT_KP_MAX)
    a_min = as_float(opportunity_row.get("a_min"), RULES_DEFAULT_A_MIN)
    days_to_resolution = max(
        as_float(
            opportunity_row.get("days_to_resolution", opportunity_row.get("daysToResolution")),
            365.0,
        ),
        0.000001,
    )

    cond_1 = c_new > 0 and kp_c_new < c_new
    cond_2 = kp_c < kp_max
    edge_pct_c_new = ((c_new - kp_c_new) / kp_c_new) if kp_c_new > 0 else -1.0
    annualized_edge = (edge_pct_c_new * 365.0) / days_to_resolution
    cond_3 = annualized_edge >= a_min

    return {
        "pass": bool(cond_1 and cond_2 and cond_3),
        "kp_c": kp_c,
        "kp_c_new": kp_c_new,
        "c_new": c_new,
        "kp_max": kp_max,
        "a_min": a_min,
        "annualized_edge_c_new": annualized_edge,
        "cond_kp_cnew_lt_cnew": cond_1,
        "cond_kp_c_lt_kpmax": cond_2,
        "cond_annualized_edge_ge_amin": cond_3,
    }


# ---------- Core Decision Function ----------

def model_decision(
    opportunity_row: dict,
    lob_metrics: dict,
    recent_snapshots: list,
    bankroll_usd: float = DEFAULT_BANKROLL_USD,
) -> dict:
    """
    V1 heuristic decision model.

    Faithfully ports arbitrageExecutionService.ts::modelDecision (lines 456-485).

    FORMULA WALKTHROUGH:
    --------------------
    Step 1  gross_edge         = (1 - sumAsks) / sumAsks
    Step 2  persistence        = positive_snapshots / total  (or fallback)
    Step 3  effective_depth    = max(1, min(topDepth, bandDepth))
    Step 4  depth_ratio        = effective_depth / (bankroll * 0.20)   [0, 1]
    Step 5  fill_prob_20s      = 0.70 * depth_ratio + 0.30 * persistence  [0.05, 0.99]
    Step 6  slippage_mult      = 1 - depth_ratio                      [0.08, 1]
    Step 7  expected_slippage  = gross_edge * 0.35 * slippage_mult
    Step 8  expected_net_edge  = gross_edge - expected_slippage
    Step 9  edge_strength      = expected_net_edge / 0.05             [0, 1]
    Step 10 recommended_cap    = bankroll * min(0.20, fill_prob * edge_strength)
    """
    # --- Step 1: Gross edge ---
    sum_asks = float(opportunity_row.get("sumAsks", 0))
    if sum_asks < MODEL_MIN_SUM_ASKS or sum_asks > MODEL_MAX_SUM_ASKS:
        return {
            "expected_slippage": 0.0,
            "fill_prob_20s": 0.05,
            "expected_net_edge": 0.0,
            "recommended_cap": 0.0,
            "trade_rules_passed": False,
            "trade_rules": {
                "pass": False,
                "reason": f"sumAsks out of range [{MODEL_MIN_SUM_ASKS}, {MODEL_MAX_SUM_ASKS}]",
            },
        }
    gross_edge = calc_gross_edge(sum_asks)

    # --- Step 2: Edge persistence ---
    if len(recent_snapshots) == 0:
        persistence = float(lob_metrics.get("edgePersistence", 0))
    else:
        positive = sum(1 for s in recent_snapshots if s.get("grossEdgePerDollar", 0) > 0)
        persistence = positive / len(recent_snapshots)

    # --- Step 3: Effective depth ---
    top_depth = float(lob_metrics.get("topBookDepthUsd", 0))
    band_depth = float(lob_metrics.get("depthWithinProfitableBandUsd", 0))
    effective_depth = max(1, min(top_depth, band_depth))

    # --- Step 4: Depth ratio ---
    depth_ratio = clamp(effective_depth / (bankroll_usd * MODEL_MAX_CAP_RATIO), 0, 1)

    # --- Step 5: Fill probability (70% depth, 30% persistence) ---
    fill_prob = clamp(depth_ratio * 0.7 + persistence * 0.3, 0.05, 0.99)

    # --- Step 6: Slippage multiplier (thin book = more slippage) ---
    slippage_multiplier = clamp(1 - depth_ratio, 0.08, 1)

    # --- Step 7: Expected slippage (35% base, scaled by book thickness) ---
    expected_slippage = gross_edge * 0.35 * slippage_multiplier

    # --- Step 8: Net edge after slippage ---
    expected_net_edge = gross_edge - expected_slippage
    expected_net_edge = clamp(expected_net_edge, -MODEL_MAX_EXPECTED_NET_EDGE, MODEL_MAX_EXPECTED_NET_EDGE)

    # --- Step 9: Edge strength normalized to 5% baseline ---
    edge_strength_scaled = clamp(expected_net_edge / 0.05, 0, 1)

    # --- Step 10: Kelly-inspired cap, hard-capped at 20% of bankroll ---
    recommended_cap = bankroll_usd * min(
        MODEL_MAX_CAP_RATIO,
        fill_prob * edge_strength_scaled,
    )

    trade_rules = evaluate_trade_rules(opportunity_row, recommended_cap)
    if not trade_rules["pass"]:
        recommended_cap = 0.0

    return {
        "expected_slippage": max(0.0, expected_slippage),
        "fill_prob_20s": fill_prob,
        "expected_net_edge": expected_net_edge,
        "recommended_cap": max(0.0, recommended_cap),
        "trade_rules_passed": trade_rules["pass"],
        "trade_rules": trade_rules,
    }


# ---------- Demo ----------

if __name__ == "__main__":
    CSV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "opportunities_raw.csv")

    with open(CSV_PATH, newline="") as f:
        reader = csv.DictReader(f)
        rows = list(reader)

    # Varied snapshot scenarios to show how persistence affects output:
    #   Row 1: 2/2 positive  (persistence = 1.0)  -- stable edge
    #   Row 2: 1/3 positive  (persistence = 0.33) -- flickering edge
    #   Row 3: 0 snapshots   (persistence = 0.0)  -- brand-new opportunity
    snapshot_scenarios = [
        [
            {"timestamp": "2026-02-24T12:00:00Z", "grossEdgePerDollar": 0.042},
            {"timestamp": "2026-02-24T12:00:30Z", "grossEdgePerDollar": 0.038},
        ],
        [
            {"timestamp": "2026-02-24T12:00:00Z", "grossEdgePerDollar": 0.11},
            {"timestamp": "2026-02-24T12:00:30Z", "grossEdgePerDollar": -0.01},
            {"timestamp": "2026-02-24T12:01:00Z", "grossEdgePerDollar": -0.005},
        ],
        [],
    ]

    print("=" * 90)
    print("  DECISION ENGINE v1 -- Demo on 3 Opportunities")
    print(f"  Bankroll: ${DEFAULT_BANKROLL_USD:,.0f}")
    print("=" * 90)

    for i, row in enumerate(rows):
        lob = derive_lob_metrics(row)
        snapshots = snapshot_scenarios[i % len(snapshot_scenarios)]
        gross_edge = calc_gross_edge(float(row["sumAsks"]))
        decision = model_decision(row, lob, snapshots)

        venue = row.get("venue", "")
        strategy = row.get("strategy", "")

        # Intermediate values for display
        eff_depth = max(1, min(lob["topBookDepthUsd"], lob["depthWithinProfitableBandUsd"]))
        dr = clamp(eff_depth / (DEFAULT_BANKROLL_USD * MODEL_MAX_CAP_RATIO), 0, 1)
        sm = clamp(1 - dr, 0.08, 1)
        if len(snapshots) == 0:
            pers = 0.0
            pers_label = "fallback (no snapshots)"
        else:
            pos = sum(1 for s in snapshots if s.get("grossEdgePerDollar", 0) > 0)
            pers = pos / len(snapshots)
            pers_label = f"{pos}/{len(snapshots)} positive snapshots"

        print(f"\n{'-' * 90}")
        print(f"  Opportunity {i + 1}: {row.get('market', 'N/A')}")
        print(f"  Venue: {venue}  |  Strategy: {strategy}")
        print(f"  Legs: {describe_legs(row)}")
        print(f"{'-' * 90}")

        print(f"\n  INPUTS:")
        print(f"    sumAsks              = {float(row['sumAsks']):.4f}")
        print(f"    gross_edge           = {gross_edge:.6f}  ({gross_edge * 100:.2f}%)")
        print(f"    topBookDepthUsd      = ${lob['topBookDepthUsd']:,.0f}")
        print(f"    profitableBandDepth  = ${lob['depthWithinProfitableBandUsd']:,.0f}")
        print(f"    recent_snapshots     = {len(snapshots)} ({pers_label})")

        print(f"\n  INTERMEDIATE CALCULATIONS:")
        print(f"    effective_depth      = ${eff_depth:,.0f}")
        print(f"    depth_ratio          = {dr:.4f}")
        print(f"    persistence          = {pers:.4f}")
        print(f"    slippage_multiplier  = {sm:.4f}")
        es_scaled = clamp(decision["expected_net_edge"] / 0.05, 0, 1)
        print(f"    edge_strength_scaled = {es_scaled:.4f}")

        print(f"\n  MODEL OUTPUTS:")
        print(f"    expected_slippage    = {decision['expected_slippage']:.6f}  ({decision['expected_slippage'] * 100:.3f}%)")
        print(f"    fill_prob_20s        = {decision['fill_prob_20s']:.4f}  ({decision['fill_prob_20s'] * 100:.1f}%)")
        print(f"    expected_net_edge    = {decision['expected_net_edge']:.6f}  ({decision['expected_net_edge'] * 100:.3f}%)")
        print(f"    recommended_cap      = ${decision['recommended_cap']:,.2f}")

        # Kalshi fee estimate
        if venue == "KALSHI":
            cap = decision["recommended_cap"]
            sum_asks_val = float(row["sumAsks"])
            if strategy == "BINARY_BUY_BOTH" and sum_asks_val > 0:
                contracts = math.floor((cap / sum_asks_val) * 100) / 100
                yes_ask = float(row["yesAsk"])
                no_ask = float(row["noAsk"])
                fee_yes = calc_kalshi_fee(contracts, yes_ask)
                fee_no = calc_kalshi_fee(contracts, no_ask)
                fee_total = fee_yes + fee_no
                print(f"\n  KALSHI FEES (taker):")
                print(f"    contracts            = {contracts:.2f}")
                print(f"    fee (YES leg)        = ${fee_yes:.2f}")
                print(f"    fee (NO leg)         = ${fee_no:.2f}")
                print(f"    fee (total)          = ${fee_total:.2f}")
                if cap > 0:
                    net_after_fees = decision["expected_net_edge"] - (fee_total / cap)
                    print(f"    net_edge_after_fees  = {net_after_fees:.6f}  ({net_after_fees * 100:.3f}%)")
            elif strategy == "EVENT_BUY_ALL_YES" and sum_asks_val > 0:
                n_outcomes = int(row.get("numOutcomes", 2))
                contracts = math.floor((cap / sum_asks_val) * 100) / 100
                avg_price = sum_asks_val / n_outcomes if n_outcomes > 0 else 0
                fee_per_leg = calc_kalshi_fee(contracts, avg_price)
                fee_total = fee_per_leg * n_outcomes
                print(f"\n  KALSHI FEES (taker, {n_outcomes} legs):")
                print(f"    contracts            = {contracts:.2f}")
                print(f"    fee (per leg)        = ${fee_per_leg:.2f}")
                print(f"    fee (total)          = ${fee_total:.2f}")
                if cap > 0:
                    net_after_fees = decision["expected_net_edge"] - (fee_total / cap)
                    print(f"    net_edge_after_fees  = {net_after_fees:.6f}  ({net_after_fees * 100:.3f}%)")

    print(f"\n{'=' * 90}")
    print("  END OF DEMO -- all 4 outputs ready for Ian's sizing formula")
    print(f"{'=' * 90}")
