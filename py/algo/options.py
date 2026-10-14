"""
options.py — Black-Scholes pricing, greeks, implied vol, synthetic option chain.

India me historical option data mehnga/durlabh hota hai, aur backtest ke liye
option premium chahiye. Isliye do raaste:

  1) Real data ho to use karo (CSV loader se option bars load karo).
  2) Nahi ho to `SyntheticChain` index price se BS ke through realistic premium
     generate karta hai (IV smile ke saath) — backtest isse chalta hai.

Ye approximation hai (real option data me skew/term-structure noise hota hai),
isliye premium-based PnL ko indicative maano aur live paper-trade se validate karo.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

SQRT_2PI = math.sqrt(2 * math.pi)


# --------------------------------------------------------------------------- #
# Normal distribution helpers
# --------------------------------------------------------------------------- #
def _cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / SQRT_2PI


# --------------------------------------------------------------------------- #
# Black-Scholes
# --------------------------------------------------------------------------- #
@dataclass
class Greeks:
    price: float
    delta: float
    gamma: float
    theta: float  # per day
    vega: float   # per 1% vol
    iv: float

    def to_dict(self) -> dict:
        return {
            "price": round(self.price, 2),
            "delta": round(self.delta, 4),
            "gamma": round(self.gamma, 6),
            "theta": round(self.theta, 3),
            "vega": round(self.vega, 3),
            "iv": round(self.iv, 4),
        }


def bs_price(
    spot: float,
    strike: float,
    t_years: float,
    vol: float,
    rate: float = 0.065,
    opt_type: str = "CE",
    dividend_yield: float = 0.0,
) -> float:
    """European Black-Scholes (index options European hote hain — theek hai)."""
    if t_years <= 0:
        intrinsic = spot - strike if opt_type.upper() in ("CE", "CALL") else strike - spot
        return max(intrinsic, 0.0)
    if vol <= 0:
        vol = 0.01
    is_call = opt_type.upper() in ("CE", "CALL")
    d1 = (math.log(spot / strike) + (rate - dividend_yield + 0.5 * vol * vol) * t_years) / (vol * math.sqrt(t_years))
    d2 = d1 - vol * math.sqrt(t_years)
    df_r = math.exp(-rate * t_years)
    df_q = math.exp(-dividend_yield * t_years)
    if is_call:
        return spot * df_q * _cdf(d1) - strike * df_r * _cdf(d2)
    return strike * df_r * _cdf(-d2) - spot * df_q * _cdf(-d1)


def bs_greeks(
    spot: float,
    strike: float,
    t_years: float,
    vol: float,
    rate: float = 0.065,
    opt_type: str = "CE",
    dividend_yield: float = 0.0,
) -> Greeks:
    is_call = opt_type.upper() in ("CE", "CALL")
    t = max(t_years, 1e-6)
    v = max(vol, 0.01)
    d1 = (math.log(spot / strike) + (rate - dividend_yield + 0.5 * v * v) * t) / (v * math.sqrt(t))
    d2 = d1 - v * math.sqrt(t)
    df_r = math.exp(-rate * t)
    df_q = math.exp(-dividend_yield * t)
    price = bs_price(spot, strike, t, v, rate, opt_type, dividend_yield)
    delta = df_q * _cdf(d1) if is_call else -df_q * _cdf(-d1)
    gamma = df_q * _pdf(d1) / (spot * v * math.sqrt(t))
    vega = spot * df_q * _pdf(d1) * math.sqrt(t) / 100.0  # per 1% vol
    if is_call:
        theta_year = -(spot * df_q * _pdf(d1) * v) / (2 * math.sqrt(t)) - rate * strike * df_r * _cdf(d2) + dividend_yield * spot * df_q * _cdf(d1)
    else:
        theta_year = -(spot * df_q * _pdf(d1) * v) / (2 * math.sqrt(t)) + rate * strike * df_r * _cdf(-d2) - dividend_yield * spot * df_q * _cdf(-d1)
    return Greeks(price=price, delta=delta, gamma=gamma, theta=theta_year / 365.0, vega=vega, iv=v)


def implied_vol(
    price: float, spot: float, strike: float, t_years: float, rate: float = 0.065, opt_type: str = "CE"
) -> Optional[float]:
    """Newton + bisection fallback. Arbitrage-violating price pe None."""
    if t_years <= 0 or price <= 0:
        return None
    intrinsic = max(spot - strike, 0.0) if opt_type.upper() in ("CE", "CALL") else max(strike - spot, 0.0)
    if price < intrinsic - 1e-6:
        return None
    lo, hi = 0.01, 4.0
    for _ in range(80):
        mid = (lo + hi) / 2
        p = bs_price(spot, strike, t_years, mid, rate, opt_type)
        if abs(p - price) < 1e-4:
            return mid
        if p > price:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2


# --------------------------------------------------------------------------- #
# IV smile + synthetic chain
# --------------------------------------------------------------------------- #
@dataclass
class ChainConfig:
    """Synthetic chain ke parameters — realistic bana diye hain."""

    base_iv: float = 0.13          # NIFTY ka typical ATM IV (~13%)
    skew: float = 0.45             # OTM puts mehnga (put skew)
    smile: float = 2.2             # smile jitna deep
    rate: float = 0.065
    strike_band: int = 10          # ATM ke aas paas kitne strikes
    expiry_hour: int = 15          # expiry 3:30pm

    def vol_for(self, spot: float, strike: float, t_years: float) -> float:
        """Strike ke hisaab se IV: ATM pe base, wings pe zyada."""
        if spot <= 0:
            return self.base_iv
        z = math.log(strike / spot) / max(math.sqrt(max(t_years, 1 / 365)), 0.02)
        iv = self.base_iv + self.skew * (-z) * 0.06 + self.smile * z * z * 0.012
        term = 1.0 + 0.35 * max(0.0, (7 - t_years * 365) / 7)  # short-dated me vol thoda high
        return max(0.05, min(2.0, iv * term))


def synthetic_chain(
    spot: float,
    expiry_days: float,
    symbol: str,
    step: Optional[int] = None,
    cfg: Optional[ChainConfig] = None,
    opt_types: tuple[str, ...] = ("CE", "PE"),
) -> list[dict]:
    """
    Ek synthetic option chain row list. Live service bhi isko use karta hai jab
    broker chain available na ho (dashboard demo ke liye).
    """
    from .instruments import meta as imeta

    c = cfg or ChainConfig()
    step = step or imeta(symbol).strike_step
    atm = int(round(spot / step) * step)
    t = max(expiry_days, 0.0) / 365.0
    out: list[dict] = []
    for i in range(-c.strike_band, c.strike_band + 1):
        strike = atm + i * step
        iv = c.vol_for(spot, strike, max(t, 1e-4))
        row = {"strike": strike, "atm": i == 0}
        for ot in opt_types:
            g = bs_greeks(spot, strike, max(t, 1e-6), iv, c.rate, ot)
            row[f"{ot.lower()}_ltp"] = round(g.price, 2)
            row[f"{ot.lower()}_iv"] = round(iv, 4)
            row[f"{ot.lower()}_delta"] = round(g.delta, 4)
            row[f"{ot.lower()}_theta"] = round(g.theta, 3)
            row[f"{ot.lower()}_oi"] = int(max(1_000, 5_000_000 * math.exp(-abs(i) / 3.0)))
        out.append(row)
    return out


def premium_at(
    symbol: str,
    spot: float,
    strike: int,
    opt_type: str,
    dte_days: float,
    iv: Optional[float] = None,
    cfg: Optional[ChainConfig] = None,
) -> float:
    """Ek option ka theoretical premium (backtest ke liye)."""
    c = cfg or ChainConfig()
    t = max(dte_days, 0.0) / 365.0
    v = iv if iv is not None else c.vol_for(spot, strike, max(t, 1e-4))
    return round(bs_price(spot, strike, max(t, 1e-6), v, c.rate, opt_type), 2)


def delta_at(symbol: str, spot: float, strike: int, opt_type: str, dte_days: float, iv: Optional[float] = None) -> float:
    c = ChainConfig()
    t = max(dte_days, 0.0) / 365.0
    v = iv if iv is not None else c.vol_for(spot, strike, max(t, 1e-4))
    return bs_greeks(spot, strike, max(t, 1e-6), v, c.rate, opt_type).delta


def demo() -> None:
    spot, strike, dte = 25250.0, 25250, 2
    for ot in ("CE", "PE"):
        g = bs_greeks(spot, strike, dte / 365, 0.13, 0.065, ot)
        print(f"NIFTY {strike} {ot} @ spot {spot}, {dte} DTE: {g.to_dict()}")
    print(f"IV back-solve check: {implied_vol(g.price, spot, strike, dte / 365, 0.065, 'CE'):.4f}")
    print("\nSmile (CE):")
    for i in (-3, -1, 0, 1, 3):
        k = strike + i * 50
        print(f"  {k}: IV {ChainConfig().vol_for(spot, k, dte / 365):.3f}  prem {premium_at('NIFTY', spot, k, 'CE', dte):.2f}")


if __name__ == "__main__":
    demo()
