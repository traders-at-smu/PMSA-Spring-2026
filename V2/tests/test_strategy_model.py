from src.strategy_model import compute_kalshi_fee, compute_polymarket_fee, evaluate_pair_snapshot


def test_kalshi_fee_ceil_cent():
    fee = compute_kalshi_fee(c=5, p=0.53, rate=0.07)
    assert fee >= 0
    assert round(fee, 2) == fee


def test_polymarket_fee_positive():
    fee = compute_polymarket_fee(c=10, p=0.4, fee_rate=0.0175, exponent=1)
    assert fee > 0


def test_pair_evaluation_returns_two_strategies():
    snapshot = {
        "pair_id": "p1",
        "days_to_resolution": 10,
        "category": "default",
        "kalshi": {"yes_ask": 0.45, "no_ask": 0.55},
        "polymarket": {"yes_ask": 0.43, "no_ask": 0.56},
    }
    cfg = {
        "fixed_contract_size": 5,
        "kp_max_per_trade": 4.95,
        "annualized_edge_min": 0.05,
        "fees": {
            "kalshi": {"enabled": True, "rate": 0.07, "round_mode": "ceil_cent"},
            "polymarket": {"enabled": True, "default": {"fee_rate": 0.0175, "exponent": 1}, "categories": {}},
        },
    }
    out = evaluate_pair_snapshot(snapshot, cfg)
    assert len(out) == 2
    assert out[0].pair_id == "p1"


def test_depth_walk_sizes_contracts_until_arb_ends():
    snapshot = {
        "pair_id": "p2",
        "days_to_resolution": 10,
        "category": "default",
        "kalshi": {"yes_ask": 0.4, "no_ask": 0.6},
        "polymarket": {"yes_ask": 0.6, "no_ask": 0.45},
        "depth": {
            "kalshi": {
                "buy_yes": [
                    {"price": 0.4, "size": 2},
                    {"price": 0.48, "size": 4},
                ],
                "buy_no": [{"price": 0.6, "size": 10}],
            },
            "polymarket": {
                "yes_asks": [{"price": 0.6, "size": 10}],
                "no_asks": [
                    {"price": 0.45, "size": 3},
                    {"price": 0.55, "size": 4},
                ],
            },
        },
    }
    cfg = {
        "fixed_contract_size": 1,
        "kp_max_per_trade": 100,
        "annualized_edge_min": 0.0,
        "fees": {
            "kalshi": {"enabled": False, "rate": 0.07, "round_mode": "ceil_cent"},
            "polymarket": {"enabled": False, "default": {"fee_rate": 0.0175, "exponent": 1}, "categories": {}},
        },
    }
    out = evaluate_pair_snapshot(snapshot, cfg)
    target = next(d for d in out if d.strategy == "BUY_KY_BUY_PN")

    assert target.contracts == 3
    assert target.trade is True
    assert target.kalshi_price == 0.48
    assert target.polymarket_price == 0.45
    assert target.metadata["contracts_available_kalshi_side"] == 6
    assert target.metadata["contracts_available_polymarket_side"] == 7
    assert target.metadata["contracts_before_arb_ends"] == 3
