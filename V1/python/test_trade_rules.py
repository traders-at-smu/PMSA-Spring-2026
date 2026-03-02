import csv
import json
import os
import subprocess
import sys
import tempfile
import unittest

THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if THIS_DIR not in sys.path:
    sys.path.insert(0, THIS_DIR)

from raw_boxed_filter import calc_kalshi_fee, calc_strategy_total_cost


class TradeRulesMathTests(unittest.TestCase):
    def test_kalshi_fee_roundup_to_cent(self) -> None:
        fee = calc_kalshi_fee(1.0, 0.52)
        # 0.007 * 1 * 0.52 * 0.48 = 0.0017472 -> rounds up to $0.01
        self.assertEqual(fee, 0.01)

    def test_strategy_cost_includes_fee(self) -> None:
        total = calc_strategy_total_cost(1.0, kalshi_ask=0.40, polymarket_ask=0.56)
        # 0.40 + 0.56 + roundup(0.007*0.40*0.60=0.00168) = 0.97
        self.assertAlmostEqual(total, 0.97, places=6)


class TradeRulesPipelineTests(unittest.TestCase):
    def test_raw_filter_emits_only_valid_arbitrage_and_metrics(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            pairs_path = os.path.join(tmp, "pairs.csv")
            quotes_path = os.path.join(tmp, "quotes.csv")
            out_path = os.path.join(tmp, "opportunities_raw.csv")
            section_d_path = os.path.join(tmp, "section_d.json")

            with open(pairs_path, "w", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(
                    f,
                    fieldnames=[
                        "pair_id",
                        "poly_market_id",
                        "kalshi_market_id",
                        "title_clean",
                        "expiry_poly_utc",
                        "expiry_kalshi_utc",
                        "similarity_score",
                        "category_tag",
                    ],
                )
                writer.writeheader()
                writer.writerow(
                    {
                        "pair_id": "pair-0001",
                        "poly_market_id": "p1",
                        "kalshi_market_id": "k1",
                        "title_clean": "test market 1",
                        "expiry_poly_utc": "2026-03-10T00:00:00Z",
                        "expiry_kalshi_utc": "2026-03-12T00:00:00Z",
                        "similarity_score": "0.8",
                        "category_tag": "other",
                    }
                )
                writer.writerow(
                    {
                        "pair_id": "pair-0002",
                        "poly_market_id": "p2",
                        "kalshi_market_id": "k2",
                        "title_clean": "test market 2",
                        "expiry_poly_utc": "2026-03-10T00:00:00Z",
                        "expiry_kalshi_utc": "2026-03-12T00:00:00Z",
                        "similarity_score": "0.8",
                        "category_tag": "other",
                    }
                )

            with open(quotes_path, "w", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(
                    f,
                    fieldnames=[
                        "timestamp",
                        "pair_id",
                        "poly_market_id",
                        "kalshi_market_id",
                        "poly_yes_ask",
                        "poly_no_ask",
                        "kal_yes_ask",
                        "kal_no_ask",
                        "poly_yes_bid",
                        "poly_no_bid",
                        "kal_yes_bid",
                        "kal_no_bid",
                    ],
                )
                writer.writeheader()
                # Arbitrage row: BUY_KY_PN = 0.40 + 0.56 + 0.01 = 0.97 < 1
                writer.writerow(
                    {
                        "timestamp": "2026-02-25T10:00:00Z",
                        "pair_id": "pair-0001",
                        "poly_market_id": "p1",
                        "kalshi_market_id": "k1",
                        "poly_yes_ask": "0.61",
                        "poly_no_ask": "0.56",
                        "kal_yes_ask": "0.40",
                        "kal_no_ask": "0.51",
                        "poly_yes_bid": "0.60",
                        "poly_no_bid": "0.39",
                        "kal_yes_bid": "0.39",
                        "kal_no_bid": "0.50",
                    }
                )
                # No-arb row: both strategies >= 1 after fees
                writer.writerow(
                    {
                        "timestamp": "2026-02-25T10:00:00Z",
                        "pair_id": "pair-0002",
                        "poly_market_id": "p2",
                        "kalshi_market_id": "k2",
                        "poly_yes_ask": "0.60",
                        "poly_no_ask": "0.60",
                        "kal_yes_ask": "0.50",
                        "kal_no_ask": "0.50",
                        "poly_yes_bid": "0.59",
                        "poly_no_bid": "0.40",
                        "kal_yes_bid": "0.49",
                        "kal_no_bid": "0.49",
                    }
                )

            # Keep this test deterministic and offline by stubbing depth calls.
            env = os.environ.copy()
            cmd = (
                "import raw_boxed_filter as r; "
                "r.poly_depth=lambda _:{'bidDepth':100.0,'askDepth':120.0}; "
                "r.kalshi_depth=lambda _:{'top':300.0}; "
                "raise SystemExit(r.main())"
            )
            subprocess.run(
                [
                    "python",
                    "-c",
                    cmd,
                    "--pairs",
                    pairs_path,
                    "--quotes",
                    quotes_path,
                    "--out",
                    out_path,
                    "--section-d",
                    section_d_path,
                ],
                check=True,
                cwd=THIS_DIR,
                env=env,
            )

            with open(out_path, newline="", encoding="utf-8") as f:
                rows = list(csv.DictReader(f))
            self.assertEqual(len(rows), 1)
            row = rows[0]

            self.assertEqual(row["pair_id"], "pair-0001")
            self.assertEqual(row["best_direction"], "BUY_KY_PN")
            self.assertAlmostEqual(float(row["kypn_cost_c1"]), 0.97, places=6)
            self.assertAlmostEqual(float(row["edge_dollar_c1"]), 0.03, places=6)
            self.assertAlmostEqual(float(row["edge_pct_c1"]), 0.03 / 0.97, places=6)
            self.assertGreater(float(row["annualized_edge_c1"]), 0.0)

            with open(section_d_path, "r", encoding="utf-8") as f:
                section_d = json.load(f)
            self.assertEqual(section_d["count"], 1)
            self.assertEqual(section_d["top"][0]["best_direction"], "BUY_KY_PN")


if __name__ == "__main__":
    unittest.main()
