"""
engine.py — backtest engine.

Kya karta hai:
  1. 1-min index bars lo (synthetic ya CSV se).
  2. Har minute: us waqt tak jo bars *close ho chuke* hain unse MarketState banao
     (strategy ke primary timeframe boundary pe strategy call hoti hai).
  3. Signal aaya to **next bar ke open** pe entry (realistic — repaint nahi).
  4. Index signal ko option leg me translate karo: strike select, BS se premium,
     delta-based SL/target, risk-based lots.
  5. Har minute stop/target check (intra-bar high/low se), 15:14 pe square-off.
  6. Charges lagao, trade journal + daily PnL banao, metrics nikalo.

Agar `use_options=False` ho to PnL index points me hoga (research mode).
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from typing import Any, Optional

from ..charges import round_trip_charges
from ..data.resample import IST, minute_of_day, minutes_to_close, resample, session_key, session_split
from ..indicators import adx as adx_fn, atr as atr_fn, vwap_intraday
from ..instruments import days_to_expiry, meta as imeta, option_symbol, strike_for
from ..options import ChainConfig, delta_at, premium_at
from ..risk import RiskConfig, RiskManager, should_square_off
from ..strategies import create as create_strategy
from ..types import Bar, MarketState, Position, Signal, Trade
from .metrics import Metrics, compute as compute_metrics


@dataclass
class BacktestConfig:
    symbol: str = "NIFTY"
    strategy: str = "orb"
    params: dict = field(default_factory=dict)
    capital: float = 200_000.0
    risk: RiskConfig = field(default_factory=RiskConfig)
    broker: str = "zerodha"           # charges model
    product: str = "MIS"
    # option leg
    use_options: bool = True
    moneyness: str = "ATM"            # ATM | OTM1 | OTM2 | ITM1
    option_type_mode: str = "auto"    # auto (buy->CE, sell->PE) | CE | PE
    iv: float = 0.13
    # execution frictions
    slippage_pct: float = 0.35        # premium ka % (option entry/exit)
    slippage_points: float = 0.0      # index points (use_options=False)
    trail_after_r: float = 0.0        # 0 = off, 1.0 = 1R ke baad breakeven
    max_hold_minutes: int = 0         # 0 = off
    square_off_at: str = "15:14"
    warmup_bars: int = 0              # 0 = strategy ka apna warmup
    start: Optional[str] = None       # "YYYY-MM-DD"
    end: Optional[str] = None
    seed: int = 42

    def risk_cfg(self) -> RiskConfig:
        r = self.risk
        r.square_off_at = self.square_off_at
        r.moneyness = self.moneyness
        r.option_type_mode = self.option_type_mode
        return r


@dataclass
class _OpenTrade:
    entry_ts: int
    index_entry: float
    strike: int
    opt_type: str
    option_symbol: str
    premium_entry: float
    lots: int
    qty: int
    lot_size: int
    premium_stop: float
    premium_target: float
    index_stop: float
    index_target: float
    dte_at_entry: float
    signal: Signal
    trailing: bool = False
    entry_charge: float = 0.0
    sizing: str = "ok"


class Backtest:
    def __init__(self, cfg: Optional[BacktestConfig] = None):
        self.cfg = cfg or BacktestConfig()
        self.symbol = self.cfg.symbol.upper()
        self.im = imeta(self.symbol)
        self.risk = RiskManager(self.cfg.risk_cfg())
        self.chain_cfg = ChainConfig(base_iv=self.cfg.iv)
        self.strategy = create_strategy(self.cfg.strategy, **self.cfg.params)
        self.trades: list[Trade] = []
        self.equity_curve: list[dict] = []
        self.events: list[dict] = []
        self.open: Optional[_OpenTrade] = None
        self._session_ctx: dict = {}
        self._day_open: Optional[float] = None

    # ------------------------------------------------------------------ run #
    def run(self, bars: list[Bar], verbose: bool = False) -> Metrics:
        if not bars:
            raise ValueError("bars khali hain")
        days = session_split(bars)
        keys = sorted(days)
        if self.cfg.start:
            keys = [k for k in keys if k >= self.cfg.start]
        if self.cfg.end:
            keys = [k for k in keys if k <= self.cfg.end]
        if not keys:
            raise ValueError("date filter ke baad koi session nahi bacha")

        # pichhle session ke bars (prev close / warmup) — cumulative history
        history: list[Bar] = []
        for day in keys:
            day_bars = days[day]
            if not day_bars:
                continue
            self._run_day(day, day_bars, history, verbose)
            history.extend(day_bars)

        # agar din ke end pe khula reh gaya (nahi hona chahiye, par safety)
        if self.open:
            self._close_trade(self.open, self.open.index_entry, self.open.premium_entry, "force close (end of data)", bars[-1].ts)
            self.open = None

        return compute_metrics(self.trades, self.cfg.capital, self._daily())

    # --------------------------------------------------------------- per day #
    def _run_day(self, day: str, day_bars: list[Bar], history: list[Bar], verbose: bool) -> None:
        self.strategy.reset_day()
        day_date = dt.datetime.fromtimestamp(day_bars[0].ts / 1000, IST).date()
        prev_close = history[-1].close if history else day_bars[0].open
        self._day_open = day_bars[0].open
        self.risk.roll_day(day, self.risk.state.equity())
        tfs = sorted(set(self.strategy.timeframes) | {"1m", "5m", "15m"})
        tf_primary = self.strategy.timeframes[0]
        tf_primary_min = max(1, self._tf_min(tf_primary))

        # incremental resampler: har bar pe sirf naya bucket banta hai (O(1) per bar)
        closed: dict[str, list[Bar]] = {tf: [] for tf in tfs}
        bucket: dict[str, dict] = {tf: {"id": None, "bars": []} for tf in tfs}
        pending: Optional[Signal] = None

        highs_all: list[float] = []
        lows_all: list[float] = []
        closes_all: list[float] = []
        vols_all: list[float] = []

        for i, bar in enumerate(day_bars):
            highs_all.append(bar.high)
            lows_all.append(bar.low)
            closes_all.append(bar.close)
            vols_all.append(bar.volume)
            mod = minute_of_day(bar.ts)
            offset = mod - (9 * 60 + 15)

            # ------- 1. open trade management (har minute, intra-bar) ------ #
            if self.open is not None:
                self._manage_open(self.open, bar, day_date)

            # ------- 2. pending signal ka execution (next bar open) ------- #
            if pending is not None and self.open is None:
                self._enter(pending, bar, day_date)
                pending = None

            # ------- 3. candles band karo (sirf completed bars) ----------- #
            completed_primary = False
            for tf in tfs:
                tfm = max(1, self._tf_min(tf))
                b = offset // tfm
                st = bucket[tf]
                if st["id"] is None:
                    st["id"] = b
                elif b != st["id"]:
                    if st["bars"]:
                        closed[tf].append(_aggregate(st["bars"]))
                    st["bars"] = []
                    st["id"] = b
                st["bars"].append(bar)
                if offset % tfm == tfm - 1:  # yeh bar bucket ka aakhri hai
                    closed[tf].append(_aggregate(st["bars"]))
                    st["bars"] = []
                    st["id"] = None
                    if tf == tf_primary:
                        completed_primary = True

            if not completed_primary:
                continue

            # ------- 4. state (sirf closed candles) + strategy ------------ #
            state = self._build_state(day, bar, closed, prev_close, day_date,
                                      highs_all, lows_all, closes_all, vols_all)
            sig = self.strategy.run(state)
            if verbose and sig.action != "hold":
                print(f"  [{day} {mod // 60:02d}:{mod % 60:02d}] {sig.action.upper():5} {sig.reason}")

            if sig.action == "exit":
                if self.open is not None:
                    self._close_trade(self.open, bar.close, self._premium(self.open, bar.close, day_date, bar.ts),
                                      f"signal exit: {sig.reason}", bar.ts)
                    self.open = None
                continue

            if sig.action in ("buy", "sell") and self.open is None:
                pending = sig
                self.events.append({"strategy": self.strategy.name, "day": day, "ts": bar.ts,
                                    "action": sig.action, "reason": sig.reason, "confidence": sig.confidence})
            elif sig.action == "hold":
                self.events.append({"strategy": self.strategy.name, "day": day, "ts": bar.ts,
                                    "action": "hold", "reason": sig.reason})

            # ------- 5. time based square off ----------------------------- #
            if should_square_off(mod, self.cfg.risk_cfg()) and self.open is not None:
                self._close_trade(self.open, bar.close, self._premium(self.open, bar.close, day_date, bar.ts),
                                  "square-off (MIS)", bar.ts)
                self.open = None

        # din ke end pe sab band
        if self.open is not None:
            last = day_bars[-1]
            self._close_trade(self.open, last.close, self._premium(self.open, last.close, day_date, last.ts),
                              "EOD square-off", last.ts)
            self.open = None

        self.equity_curve.append(
            {
                "day": day,
                "equity": round(self.risk.state.equity(), 2),
                "realized": round(self.risk.state.realized_today, 2),
                "trades": self.risk.state.trades_today,
            }
        )

    # -------------------------------------------------------------- helpers #
    def _tf_min(self, tf: str) -> int:
        from ..data.resample import tf_minutes

        return tf_minutes(tf)

    def _build_state(
        self,
        day: str,
        bar: Bar,
        closed: dict[str, list[Bar]],
        prev_close: float,
        day_date: dt.date,
        highs: list[float],
        lows: list[float],
        closes: list[float],
        vols: list[float],
    ) -> MarketState:
        h, l, c, v = highs, lows, closes, vols
        vwap = vwap_intraday(h, l, c, v)[-1] if h else None
        # ATR/ADX strategy ke primary timeframe se (5m ka ATR 1m se realistic hota hai)
        tfp = self.strategy.timeframes[0] if self.strategy.timeframes else "1m"
        pb = closed.get(tfp) or []
        if len(pb) >= 16:
            h, l, c = [b.high for b in pb], [b.low for b in pb], [b.close for b in pb]
        atr_v = atr_fn(h, l, c, 14)[-1]
        adx_v = adx_fn(h, l, c, 14)[0][-1]
        dte = self._dte(day_date, bar.ts)
        atm = round(bar.close / self.im.strike_step) * self.im.strike_step
        iv_atm = self.chain_cfg.vol_for(bar.close, atm, max(dte, 1e-3) / 365)
        return MarketState(
            symbol=self.symbol,
            ts=bar.ts,
            ltp=bar.close,
            bars={tf: list(bs) for tf, bs in closed.items()},
            prev_close=prev_close,
            day_open=self._day_open if self._day_open else bar.open,
            day_high=max(h) if h else bar.high,
            day_low=min(l) if l else bar.low,
            vwap=vwap,
            atr=atr_v,
            adx=adx_v,
            position=self._position_snapshot(bar.close),
            day_pnl=self.risk.state.realized_today,
            trades_today=self.risk.state.trades_today,
            consecutive_losses=self.risk.state.consecutive_losses,
            minutes_to_close=minutes_to_close(bar.ts),
            atm_strike=atm,
            iv=iv_atm,
            meta={"session": day, "mode": "backtest", "prevClose": prev_close},
        )

    def _position_snapshot(self, index_ltp: float) -> Optional[Position]:
        if self.open is None:
            return None
        o = self.open
        premium = self._premium(o, index_ltp, dt.datetime.fromtimestamp(o.entry_ts / 1000, IST).date())
        return Position(
            symbol=self.symbol,
            qty=o.qty,
            entry=o.index_entry,
            stop=o.index_stop,
            target=o.index_target,
            opened_ts=o.entry_ts,
            tag=o.signal.tag,
            option_symbol=o.option_symbol,
            option_entry=o.premium_entry,
            lots=o.lots,
        )

    def _dte(self, day_date: dt.date, ts: int) -> float:
        """
        Fractional days-to-expiry. Expiry day pe bhi time value bachi rehti hai —
        15:14 pe 0DTE ka premium 0 nahi hota, isliye session ka fraction count karte hain.
        """
        d = float(days_to_expiry(self.symbol, day_date))
        if d <= 0:
            return max(minutes_to_close(ts) / 375.0, 0.01)
        return d

    def _premium(self, o: _OpenTrade, index_price: float, day_date: dt.date, ts: int = 0) -> float:
        """Aaj ke index price pe option ka theoretical premium (DTE adjust hoke)."""
        dte = self._dte(day_date, ts or o.entry_ts)
        return premium_at(self.symbol, index_price, o.strike, o.opt_type, dte, cfg=self.chain_cfg)

    def _enter(self, sig: Signal, bar: Bar, day_date: dt.date) -> None:
        """Next bar ke open pe entry (index + option leg)."""
        index_entry = bar.open
        mod = minute_of_day(bar.ts)
        cfg = self.cfg
        rcfg = cfg.risk_cfg()

        # entry window / risk checks
        if not (9 * 60 + 15 <= mod <= 15 * 60 + 25):
            return

        opt_type = "CE" if sig.action == "buy" else "PE"
        if rcfg.option_type_mode.upper() in ("CE", "PE"):
            opt_type = rcfg.option_type_mode.upper()

        if not cfg.use_options:
            # index points mode (research)
            qty = max(1, int(self.risk.size_lots(premium=max(index_entry * 0.01, 1), lot_size=self.im.lot_size,
                                                  index_stop_distance=(abs(index_entry - (sig.stop or index_entry)) or 20), delta=1.0)))
            idx_stop = sig.stop or (index_entry - 20 if sig.action == "buy" else index_entry + 20)
            self.open = _OpenTrade(
                entry_ts=bar.ts, index_entry=index_entry, strike=0, opt_type=opt_type, option_symbol=f"{self.symbol} (index pts)",
                premium_entry=index_entry, lots=qty, qty=qty * self.im.lot_size, lot_size=self.im.lot_size,
                premium_stop=idx_stop, premium_target=sig.target or (index_entry + (index_entry - idx_stop) * 2),
                index_stop=idx_stop, index_target=sig.target or 0.0, dte_at_entry=0, signal=sig, entry_charge=0.0,
                sizing="index-mode",
            )
            return

        strike = strike_for(self.symbol, index_entry, opt_type, rcfg.moneyness)
        dte_days = self._dte(day_date, bar.ts)
        prem = premium_at(self.symbol, index_entry, strike, opt_type, dte_days, cfg=self.chain_cfg)
        prem_entry = round(prem * (1 + cfg.slippage_pct / 100), 2)

        # real premium ke saath risk guard (sasta option = charges kha jaate hain)
        ok, why = self.risk.can_enter(bar.ts / 1000, minutes_to_close(bar.ts), has_open=False, premium=prem_entry)
        if not ok:
            self.events.append({"ts": bar.ts, "action": "reject", "reason": why, "signal": sig.to_dict()})
            return

        # ---- risk levels: exit INDEX level se decide hota hai, premium se PnL ----
        idx_stop = sig.stop
        if idx_stop is None:
            idx_stop = index_entry - 25 if sig.action == "buy" else index_entry + 25
        sl_points = abs(index_entry - idx_stop)
        d = abs(delta_at(self.symbol, index_entry, strike, opt_type, dte_days))
        d = max(d, 0.15)
        # 1 lot ka risk = index SL ka premium equivalent (delta ke through), premium se zyada nahi
        risk_move = min(sl_points * d, prem_entry)
        sizing_stop = round(max(prem_entry - risk_move, 0.05), 2)
        # disaster stop: index stop galat ho / IV crush ho to premium is se neeche nahi jaane dena
        safety_move = min(sl_points * d * 1.6, prem_entry * rcfg.premium_safety_pct / 100.0)
        premium_safety = round(max(prem_entry - max(safety_move, risk_move * 1.2), 0.05), 2)

        idx_target = sig.target
        if idx_target is None:
            idx_target = index_entry + sl_points * 2 if sig.action == "buy" else index_entry - sl_points * 2

        lots, sizing_note = self.risk.size_lots_for_premium(prem_entry, sizing_stop, self.im.lot_size)
        if sig.lots:
            lots, sizing_note = int(sig.lots), "strategy-specified"
        if lots <= 0:
            self.events.append({"ts": bar.ts, "action": "reject", "reason": sizing_note, "signal": sig.to_dict()})
            return

        qty = lots * self.im.lot_size
        oc = round_trip_charges(cfg.broker, "options", qty, prem_entry, prem_entry)
        self.open = _OpenTrade(
            entry_ts=bar.ts,
            index_entry=index_entry,
            strike=strike,
            opt_type=opt_type,
            option_symbol=option_symbol(self.symbol, _next_expiry(self.symbol, day_date), strike, opt_type),
            premium_entry=prem_entry,
            lots=lots,
            qty=qty,
            lot_size=self.im.lot_size,
            premium_stop=premium_safety,
            premium_target=premium_at(self.symbol, idx_target, strike, opt_type, dte_days, cfg=self.chain_cfg),
            index_stop=round(idx_stop, 2),
            index_target=round(idx_target, 2),
            dte_at_entry=dte_days,
            signal=sig,
            entry_charge=oc.total / 2,
            sizing=sizing_note,
        )
        self.events.append({
            "ts": bar.ts, "action": "entry", "side": sig.action, "strike": strike, "optType": opt_type,
            "premium": prem_entry, "lots": lots, "qty": qty,
            "indexStop": round(idx_stop, 2), "indexTarget": round(idx_target, 2),
            "premiumSafety": premium_safety, "premiumTarget": round(self.open.premium_target, 2),
            "indexEntry": index_entry, "reason": sig.reason, "strategy": sig.tag, "sizing": sizing_note,
        })

    def _manage_open(self, o: _OpenTrade, bar: Bar, day_date: dt.date) -> None:
        """
        Exit poori tarah INDEX level se decide hota hai (strategy ne wahi diya tha),
        premium sirf PnL ke liye compute hoti hai. Isliye option ka premium SL
        index stop se pehle cut nahi karta.
        Long option (CE/PE khareeda) hai, to hum index upar jaane pe jeette hain (CE)
        ya neeche jaane pe (PE).
        """
        mod = minute_of_day(bar.ts)
        long_index = o.opt_type == "CE"  # CE = index upar jaaye to profit
        p_stop_premium = self._premium(o, o.index_stop, day_date, bar.ts)

        # ---- breakeven trail (index based) ---- #
        if self.cfg.trail_after_r > 0 and not o.trailing:
            r = abs(o.index_entry - o.index_stop)
            moved = (bar.high - o.index_entry) if long_index else (o.index_entry - bar.low)
            if r > 0 and moved >= r * self.cfg.trail_after_r:
                o.trailing = True
                # index stop ko entry pe shift karo (breakeven), premium ke hisaab se nahi
                o.index_stop = o.index_entry

        # ---- 1. index stop ---- #
        stop_hit = (bar.low <= o.index_stop) if long_index else (bar.high >= o.index_stop)
        if stop_hit:
            self._close_trade(o, o.index_stop, p_stop_premium, "index SL hit", bar.ts)
            return

        # ---- 2. index target ---- #
        target_hit = (bar.high >= o.index_target) if long_index else (bar.low <= o.index_target)
        if target_hit:
            p_tgt = self._premium(o, o.index_target, day_date, bar.ts)
            self._close_trade(o, o.index_target, p_tgt, "index target hit", bar.ts)
            return

        # ---- 3. disaster stop (IV crush / gap) ---- #
        premium_low = self._premium(o, bar.low, day_date, bar.ts)
        premium_high = self._premium(o, bar.high, day_date, bar.ts)
        if premium_low <= o.premium_stop:
            self._close_trade(o, bar.low, o.premium_stop, "premium disaster stop", bar.ts)
            return

        # ---- 4. max hold ---- #
        if self.cfg.max_hold_minutes and (bar.ts - o.entry_ts) / 60000 >= self.cfg.max_hold_minutes:
            self._close_trade(o, bar.close, self._premium(o, bar.close, day_date, bar.ts), "max hold time", bar.ts)
            return

        # ---- 5. square off ---- #
        if should_square_off(mod, self.cfg.risk_cfg()):
            self._close_trade(o, bar.close, self._premium(o, bar.close, day_date, bar.ts), "square-off (MIS)", bar.ts)

    def _close_trade(self, o: _OpenTrade, index_exit: float, premium_exit_raw: float, reason: str, exit_ts: int = 0) -> None:
        cfg = self.cfg
        if cfg.use_options:
            premium_exit = round(premium_exit_raw * (1 - cfg.slippage_pct / 100), 2)
            premium_exit = max(premium_exit, 0.05)
            gross = (premium_exit - o.premium_entry) * o.qty
            ch = round_trip_charges(cfg.broker, "options", o.qty, o.premium_entry, premium_exit)
        else:
            premium_exit = index_exit - cfg.slippage_points if o.signal.action == "buy" else index_exit + cfg.slippage_points
            gross = (premium_exit - o.premium_entry) * o.qty
            ch = round_trip_charges(cfg.broker, "equity_intraday", o.qty, o.premium_entry, premium_exit)
        net = gross - ch.total
        t = Trade(
            symbol=self.symbol,
            side="buy",  # index options me hum long premium hote hain (CE ya PE)
            qty=o.qty,
            entry_ts=o.entry_ts,
            entry=o.premium_entry,
            exit_ts=exit_ts or o.entry_ts,
            exit=premium_exit,
            gross=round(gross, 2),
            charges=round(ch.total, 2),
            net=round(net, 2),
            reason=reason,
            entry_reason=o.signal.reason,
            tag=o.signal.tag,
            stop=o.index_stop,
            target=o.index_target,
            index_entry=o.index_entry,
            index_exit=round(index_exit, 2),
            option_symbol=o.option_symbol,
            lots=o.lots,
            meta={
                "strike": o.strike, "optType": o.opt_type, "dteAtEntry": round(o.dte_at_entry, 2),
                "chargesDetail": ch.to_dict(), "signalMeta": o.signal.meta, "sizing": o.sizing,
                "indexStop": o.index_stop, "indexTarget": o.index_target, "premiumSafety": o.premium_stop,
            },
        )
        self.trades.append(t)
        self.risk.record_fill(net, t.entry_ts / 1000)
        self.open = None

    def _daily(self) -> list[dict]:
        from .metrics import _daily_from_trades

        return _daily_from_trades(self.trades)


def _aggregate(chunk: list[Bar]) -> Bar:
    """Ek bucket ke bars ko ek candle me badlo (open first, close last, high/low/vol agg)."""
    return Bar(
        ts=chunk[0].ts,
        open=chunk[0].open,
        high=max(b.high for b in chunk),
        low=min(b.low for b in chunk),
        close=chunk[-1].close,
        volume=sum(b.volume for b in chunk),
    )


def _next_expiry(symbol: str, day: dt.date) -> dt.date:
    from ..instruments import next_expiry

    return next_expiry(symbol, day)


def run_backtest(bars: list[Bar], cfg: Optional[BacktestConfig] = None, verbose: bool = False) -> tuple[Metrics, Backtest]:
    bt = Backtest(cfg)
    m = bt.run(bars, verbose=verbose)
    return m, bt
