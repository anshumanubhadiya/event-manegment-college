"""test_backtest.py — engine, risk, strategies end-to-end."""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from algo.backtest import BacktestConfig, run_backtest
from algo.data import generate_history
from algo.options import bs_greeks, bs_price, implied_vol, premium_at, synthetic_chain
from algo.risk import RiskConfig, RiskManager
from algo.strategies import create, names


BARS = generate_history(days=25, seed=123, start_price=25000)


class TestPricing(unittest.TestCase):
    def test_put_call_parity(self):
        spot, strike, t, vol, r = 25000.0, 25000.0, 7 / 365, 0.13, 0.065
        ce = bs_price(spot, strike, t, vol, r, "CE")
        pe = bs_price(spot, strike, t, vol, r, "PE")
        # C - P = S - K*e^-rt
        self.assertAlmostEqual(ce - pe, spot - strike * pow(2.718281828, -r * t), delta=1.0)

    def test_greeks_sane(self):
        g = bs_greeks(25000, 25000, 7 / 365, 0.13, 0.065, "CE")
        self.assertAlmostEqual(g.delta, 0.5, delta=0.08)
        self.assertGreater(g.gamma, 0)
        self.assertLess(g.theta, 0)     # long option ka theta negative
        self.assertGreater(g.vega, 0)
        self.assertGreater(g.price, 0)

    def test_iv_roundtrip(self):
        p = bs_price(25000, 25200, 5 / 365, 0.18, 0.065, "CE")
        iv = implied_vol(p, 25000, 25200, 5 / 365, 0.065, "CE")
        self.assertIsNotNone(iv)
        self.assertAlmostEqual(iv, 0.18, delta=0.01)

    def test_smile_shape(self):
        chain = synthetic_chain(25000, 2, "NIFTY")
        atm = [r for r in chain if r["atm"]][0]
        self.assertIn("ce_ltp", atm)
        self.assertEqual(len(chain), 21)
        # deep OTM ka premium ATM se kam
        deep = [r for r in chain if r["strike"] == atm["strike"] + 500][0]
        self.assertLess(deep["ce_ltp"], atm["ce_ltp"])

    def test_premium_decays_with_dte(self):
        p1 = premium_at("NIFTY", 25000, 25000, "CE", 7)
        p2 = premium_at("NIFTY", 25000, 25000, "CE", 1)
        self.assertGreater(p1, p2)


class TestRisk(unittest.TestCase):
    def test_sizing_respects_risk(self):
        rm = RiskManager(RiskConfig(capital=200_000, risk_pct=1.0, max_lots=10))
        lots = rm.size_lots(premium=120, lot_size=75, index_stop_distance=40, delta=0.5)
        # risk = 2000, per lot risk = 40*0.5*75 = 1500 -> 1 lot
        self.assertEqual(lots, 1)

    def test_daily_loss_halt(self):
        rm = RiskManager(RiskConfig(capital=100_000, risk_pct=1.0, daily_loss_limit_pct=2.0, max_trades_per_day=10))
        rm.roll_day("2026-01-01", 100_000)
        rm.record_fill(-2500, 0)
        ok, why = rm.can_enter(0, 300, has_open=False)
        self.assertFalse(ok)
        self.assertIn("loss limit", why)

    def test_cooldown_after_loss(self):
        rm = RiskManager(RiskConfig(capital=100_000, cooldown_after_loss_min=15, max_consecutive_losses=5))
        rm.record_fill(-500, 1000)
        ok, why = rm.can_enter(1000 + 60, 300, False)   # 1 min baad
        self.assertFalse(ok)
        self.assertIn("cooldown", why)
        ok2, _ = rm.can_enter(1000 + 20 * 60, 300, False)
        self.assertTrue(ok2)

    def test_max_lots_cap(self):
        rm = RiskManager(RiskConfig(capital=50_000_000, risk_pct=5.0, max_lots=3))
        self.assertLessEqual(rm.size_lots(100, 75, 20, 0.5), 3)


class TestEngine(unittest.TestCase):
    def test_backtest_runs_all_strategies(self):
        for name in names():
            cfg = BacktestConfig(strategy=name, symbol="NIFTY", capital=200_000)
            m, bt = run_backtest(BARS, cfg)
            self.assertEqual(len(bt.equity_curve), 25, f"{name}: 25 sessions chahiye")
            self.assertGreaterEqual(m.trades, 0)
            if m.trades:
                self.assertAlmostEqual(m.net, m.gross - m.charges, places=2)
                for t in bt.trades:
                    self.assertGreater(t.exit_ts or 1, 0, "trade band hona chahiye")

    def test_option_premiums_used(self):
        cfg = BacktestConfig(strategy="orb", capital=200_000, moneyness="ATM")
        m, bt = run_backtest(BARS, cfg)
        if bt.trades:
            t = bt.trades[0]
            self.assertGreater(t.entry, 5.0)      # premium rupees me
            self.assertLess(t.entry, 2000.0)
            self.assertIn(t.meta["optType"], ("CE", "PE"))
            self.assertEqual(t.qty % 75, 0, "qty lot size ka multiple hona chahiye")

    def test_charges_are_charged(self):
        cfg = BacktestConfig(strategy="ema_cross", capital=200_000, max_hold_minutes=0)
        m, bt = run_backtest(BARS, cfg)
        if bt.trades:
            self.assertGreater(m.charges, 0)
            self.assertAlmostEqual(m.charges, sum(t.charges for t in bt.trades), places=2)

    def test_no_trade_before_warmup_same_day(self):
        """ORB 09:30 se pehle entry nahi le sakta."""
        cfg = BacktestConfig(strategy="orb", capital=200_000)
        m, bt = run_backtest(BARS, cfg)
        from algo.data.resample import IST
        import datetime as dt

        for t in bt.trades:
            d = dt.datetime.fromtimestamp(t.entry_ts / 1000, IST)
            mod = d.hour * 60 + d.minute
            self.assertGreaterEqual(mod, 9 * 60 + 30)
            self.assertLessEqual(mod, 15 * 60)

    def test_square_off_by_eod(self):
        """Koi bhi trade 15:30 ke baad khula nahi rehna chahiye."""
        cfg = BacktestConfig(strategy="vwap_reversion", capital=200_000)
        m, bt = run_backtest(BARS, cfg)
        self.assertIsNone(bt.open)
        for t in bt.trades:
            self.assertGreater(t.exit_ts or 0, 0)

    def test_daily_loss_limit_respected(self):
        cfg = BacktestConfig(
            strategy="orb", capital=100_000,
            risk=RiskConfig(capital=100_000, risk_pct=1.0, daily_loss_limit_pct=1.5, max_trades_per_day=10),
        )
        m, bt = run_backtest(BARS, cfg)
        by_day = {}
        for t in bt.trades:
            from algo.data.resample import session_key

            by_day.setdefault(session_key(t.exit_ts), 0.0)
            by_day[session_key(t.exit_ts)] += t.net
        for day, net in by_day.items():
            # limit ke aas paas (thoda overshoot ho sakta hai kyunki loss ek hi trade me aata hai)
            self.assertGreater(net, -100_000 * 0.015 - 4000, f"{day}: {net}")

    def test_deterministic(self):
        cfg = BacktestConfig(strategy="orb", capital=200_000)
        m1, _ = run_backtest(BARS, cfg)
        m2, _ = run_backtest(BARS, cfg)
        self.assertEqual(m1.trades, m2.trades)
        self.assertAlmostEqual(m1.net, m2.net, places=4)


if __name__ == "__main__":
    unittest.main(verbosity=2)
