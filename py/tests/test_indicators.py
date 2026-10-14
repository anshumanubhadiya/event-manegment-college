"""test_indicators.py — indicators aur data utilities."""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from algo.data import generate_history, resample
from algo.data.resample import minutes_to_close, session_key, session_split
from algo.indicators import adx, atr, ema, rsi, sma, stdev, supertrend, vwap_intraday
from algo.instruments import next_expiry, strike_for
from algo.types import Bar

import datetime as dt


class TestIndicators(unittest.TestCase):
    def test_sma_and_ema_known_values(self):
        vals = [1, 2, 3, 4, 5, 6]
        s = sma(vals, 3)
        self.assertEqual(s[0], None)
        self.assertAlmostEqual(s[2], 2.0)
        self.assertAlmostEqual(s[5], 5.0)
        e = ema(vals, 3)
        self.assertAlmostEqual(e[2], 2.0)          # seed = SMA
        self.assertAlmostEqual(e[3], 3.0)          # k=0.5 -> 4*0.5 + 2*0.5 = 3
        self.assertAlmostEqual(e[5], 5.0)

    def test_rsi_bounds_and_extremes(self):
        up = [float(i) for i in range(1, 40)]
        r = rsi(up, 14)
        self.assertIsNotNone(r[-1])
        self.assertGreater(r[-1], 95)  # sirf up moves -> ~100
        down = [float(40 - i) for i in range(1, 40)]
        self.assertLess(rsi(down, 14)[-1], 5)

    def test_atr_positive(self):
        bars = generate_history(days=3, seed=1)
        h = [b.high for b in bars[:200]]
        l = [b.low for b in bars[:200]]
        c = [b.close for b in bars[:200]]
        a = atr(h, l, c, 14)[-1]
        self.assertIsNotNone(a)
        self.assertGreater(a, 0)

    def test_adx_range(self):
        bars = generate_history(days=4, seed=3)
        h = [b.high for b in bars[:375]]
        l = [b.low for b in bars[:375]]
        c = [b.close for b in bars[:375]]
        a, pdi, mdi = adx(h, l, c, 14)
        if a[-1] is not None:
            self.assertGreaterEqual(a[-1], 0)
            self.assertLessEqual(a[-1], 100)

    def test_supertrend_flips(self):
        bars = generate_history(days=2, seed=9)
        h = [b.high for b in bars]
        l = [b.low for b in bars]
        c = [b.close for b in bars]
        line, up = supertrend(h, l, c, 10, 3.0)
        self.assertEqual(len(line), len(bars))
        self.assertTrue(any(up) and not all(up), "supertrend ko dono direction me jaana chahiye")

    def test_vwap_reasonable(self):
        bars = generate_history(days=1, seed=5)
        h = [b.high for b in bars]
        l = [b.low for b in bars]
        c = [b.close for b in bars]
        v = [b.volume for b in bars]
        vw = vwap_intraday(h, l, c, v)[-1]
        self.assertAlmostEqual(vw, sum(b.typical * b.volume for b in bars) / sum(b.volume for b in bars), delta=1.0)
        self.assertGreater(vw, min(l))
        self.assertLess(vw, max(h))

    def test_stdev(self):
        s = stdev([1, 2, 3, 4, 5, 6], 3)
        self.assertIsNotNone(s[-1])
        self.assertAlmostEqual(s[3], (0.5 + 0.5) ** 0.5 * 0 + ((2 - 3) ** 2 + (3 - 3) ** 2 + (4 - 3) ** 2) ** 0.5 / 3 ** 0.5, places=5)


class TestData(unittest.TestCase):
    def test_session_generation(self):
        bars = generate_history(days=2, seed=11)
        days = session_split(bars)
        self.assertEqual(len(days), 2)
        for day, bs in days.items():
            self.assertEqual(len(bs), 375, "ek din 09:15-15:30 = 375 one-min bars")
            self.assertTrue(bs[0].low <= bs[0].open <= bs[0].high)
            self.assertTrue(bs[-1].low <= bs[-1].close <= bs[-1].high)

    def test_weekends_skipped(self):
        bars = generate_history(days=5, seed=2)
        for day in session_split(bars):
            d = dt.date.fromisoformat(day)
            self.assertLess(d.weekday(), 5, f"{day} weekend hai")

    def test_resample(self):
        bars = generate_history(days=1, seed=4)
        r5 = resample(bars, "5m")
        self.assertEqual(len(r5), 75)
        self.assertAlmostEqual(r5[0].open, bars[0].open)
        self.assertAlmostEqual(r5[0].close, bars[4].close)
        self.assertAlmostEqual(r5[0].high, max(b.high for b in bars[:5]))
        self.assertAlmostEqual(r5[0].low, min(b.low for b in bars[:5]))
        self.assertAlmostEqual(sum(b.volume for b in r5), sum(b.volume for b in bars), delta=1)
        r15 = resample(bars, "15m")
        self.assertEqual(len(r15), 25)

    def test_minutes_to_close_and_session_key(self):
        bars = generate_history(days=1, seed=6)
        self.assertEqual(minutes_to_close(bars[0].ts), 375)
        self.assertEqual(minutes_to_close(bars[-1].ts), 1)
        self.assertEqual(session_key(bars[0].ts), session_key(bars[-1].ts))


class TestInstruments(unittest.TestCase):
    def test_strike_selection(self):
        spot = 25_237.0
        self.assertEqual(strike_for("NIFTY", spot, "CE", "ATM"), 25250)
        self.assertEqual(strike_for("NIFTY", spot, "CE", "OTM1"), 25300)
        self.assertEqual(strike_for("NIFTY", spot, "CE", "OTM2"), 25350)
        self.assertEqual(strike_for("NIFTY", spot, "CE", "ITM1"), 25200)
        self.assertEqual(strike_for("NIFTY", spot, "PE", "OTM1"), 25200)
        self.assertEqual(strike_for("NIFTY", spot, "PE", "ITM1"), 25300)

    def test_expiry_tuesday(self):
        e = next_expiry("NIFTY", dt.date(2026, 10, 14))  # Wednesday
        self.assertEqual(e.weekday(), 1)                 # Tuesday
        self.assertGreaterEqual(e, dt.date(2026, 10, 14))
        s = next_expiry("SENSEX", dt.date(2026, 10, 14))
        self.assertEqual(s.weekday(), 3)                 # Thursday


if __name__ == "__main__":
    unittest.main(verbosity=2)
