import os
import sys
import unittest

THIS_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.abspath(os.path.join(THIS_DIR, ".."))
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

from model_v1 import model_decision


class ModelTradeRuleGatesTests(unittest.TestCase):
    def _base_inputs(self):
        opportunity_row = {
            "id": "t1",
            "sumAsks": 0.90,
            "selected_kal_ask": 0.40,
            "selected_poly_ask": 0.50,
            "days_to_resolution": 30,
            "kp_max": 0.99,
            "a_min": 0.10,
        }
        lob_metrics = {
            "topBookDepthUsd": 5000,
            "depthWithinProfitableBandUsd": 4500,
            "edgePersistence": 1.0,
        }
        snapshots = [
            {"timestamp": "2026-02-25T00:00:00Z", "grossEdgePerDollar": 0.02},
            {"timestamp": "2026-02-25T00:00:30Z", "grossEdgePerDollar": 0.02},
            {"timestamp": "2026-02-25T00:01:00Z", "grossEdgePerDollar": 0.02},
        ]
        return opportunity_row, lob_metrics, snapshots

    def test_trade_executes_when_all_rules_pass(self):
        row, lob, snapshots = self._base_inputs()
        decision = model_decision(row, lob, snapshots, bankroll_usd=10_000)
        self.assertTrue(decision["trade_rules_passed"])
        self.assertGreater(decision["recommended_cap"], 0.0)

    def test_trade_blocked_when_kpmax_fails(self):
        row, lob, snapshots = self._base_inputs()
        row["kp_max"] = 0.85  # Per-contract all-in cost is ~0.91, so this should fail.
        decision = model_decision(row, lob, snapshots, bankroll_usd=10_000)
        self.assertFalse(decision["trade_rules_passed"])
        self.assertEqual(decision["recommended_cap"], 0.0)
        self.assertFalse(decision["trade_rules"]["cond_kp_c_lt_kpmax"])

    def test_trade_blocked_when_annualized_min_fails(self):
        row, lob, snapshots = self._base_inputs()
        row["a_min"] = 10.0  # Intentionally too high.
        decision = model_decision(row, lob, snapshots, bankroll_usd=10_000)
        self.assertFalse(decision["trade_rules_passed"])
        self.assertEqual(decision["recommended_cap"], 0.0)
        self.assertFalse(decision["trade_rules"]["cond_annualized_edge_ge_amin"])


if __name__ == "__main__":
    unittest.main()
