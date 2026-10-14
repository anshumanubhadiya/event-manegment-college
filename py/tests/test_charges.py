"""test_charges.py — Indian charges model."""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from algo.charges import breakeven_points, cost_pct_of_premium, order_charges, round_trip_charges


class TestCharges(unittest.TestCase):
    def test_options_buy_has_no_stt(self):
        c = order_charges("zerodha", "options", "buy", 75, 120.0)
        self.assertEqual(c.stt, 0.0)
        self.assertAlmostEqual(c.brokerage, 20.0)
        self.assertGreater(c.stamp, 0)
        self.assertGreater(c.gst, 0)

    def test_options_sell_has_stt(self):
        c = order_charges("zerodha", "options", "sell", 75, 120.0)
        self.assertAlmostEqual(c.stt, 75 * 120.0 * 0.001, places=4)

    def test_round_trip_is_sum(self):
        a = round_trip_charges("zerodha", "options", 75, 120.0, 145.0)
        b1 = order_charges("zerodha", "options", "buy", 75, 120.0)
        b2 = order_charges("zerodha", "options", "sell", 75, 145.0)
        self.assertAlmostEqual(a.total, b1.total + b2.total, places=4)
        self.assertGreater(a.total, 40.0)   # 2 x ₹20 brokerage + taxes

    def test_delivery_equity_free_brokerage(self):
        c = order_charges("zerodha", "equity_delivery", "buy", 100, 1000.0)
        self.assertEqual(c.brokerage, 0.0)
        self.assertAlmostEqual(c.stt, 100 * 1000.0 * 0.001, places=4)

    def test_intraday_brokerage_capped(self):
        small = order_charges("zerodha", "equity_intraday", "buy", 10, 100.0)
        self.assertLessEqual(small.brokerage, 20.0)
        big = order_charges("zerodha", "equity_intraday", "buy", 100_000, 100.0)
        self.assertAlmostEqual(big.brokerage, 20.0, places=4)

    def test_breakeven_and_cost_pct(self):
        be = breakeven_points("zerodha", 75, 120.0)
        self.assertGreater(be, 0.5)   # ~₹0.6-0.7 per unit
        self.assertLess(be, 2.0)
        cheap = cost_pct_of_premium("zerodha", 75, 20.0)
        costly = cost_pct_of_premium("zerodha", 75, 400.0)
        self.assertGreater(cheap, costly, "sasta premium -> charges ka % zyada")
        self.assertGreater(cheap, 1.5)

    def test_all_brokers_known(self):
        for b in ("zerodha", "angelone", "fyers", "upstox", "dhan", "paper"):
            c = round_trip_charges(b, "options", 75, 100.0, 100.0)
            self.assertGreater(c.total, 0, b)


if __name__ == "__main__":
    unittest.main(verbosity=2)
