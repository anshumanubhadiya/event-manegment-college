"""
Index instruments metadata — lot size, strike step, expiry rules, tick size.

IMPORTANT: SEBI/exchange time-time pe ye badalte hain (lot size revision, expiry
weekday change). Ye defaults 2025-26 ke hain — live jaane se pehle apne broker ke
instrument master se verify kar lo. Sab kuch yahan se config hota hai.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import Optional

# Weekly expiry weekdays: 0=Mon ... 6=Sun.
# Sept 2025 ke revision ke baad: NSE (NIFTY) Tuesday, BSE (SENSEX) Thursday.
# Bank Nifty / FinNifty ka weekly band ho gaya — unka monthly only hai.
WEEKLY_EXPIRY_WEEKDAY: dict[str, Optional[int]] = {
    "NIFTY": 1,        # Tuesday
    "BANKNIFTY": None,  # monthly only (last Tuesday)
    "FINNIFTY": None,   # monthly only
    "MIDCPNIFTY": None,  # monthly only
    "NIFTYNXT50": None,
    "SENSEX": 3,       # Thursday
    "BANKEX": 3,
    "SENSEX50": 3,
}

# Monthly expiry = last <weekday> of the month
MONTHLY_EXPIRY_WEEKDAY: dict[str, int] = {
    "NIFTY": 1,        # last Tuesday
    "BANKNIFTY": 2,    # last Wednesday (verify)
    "FINNIFTY": 1,
    "MIDCPNIFTY": 1,
    "NIFTYNXT50": 1,
    "SENSEX": 3,       # last Thursday
    "BANKEX": 3,
    "SENSEX50": 3,
}


@dataclass(frozen=True)
class IndexMeta:
    symbol: str
    exchange: str          # NFO / BFO
    lot_size: int
    strike_step: int
    tick_size: float = 0.05
    weekly: bool = True
    option_exchange_token_prefix: str = ""


INDICES: dict[str, IndexMeta] = {
    "NIFTY": IndexMeta("NIFTY", "NFO", lot_size=75, strike_step=50, weekly=True),
    "BANKNIFTY": IndexMeta("BANKNIFTY", "NFO", lot_size=35, strike_step=100, weekly=False),
    "FINNIFTY": IndexMeta("FINNIFTY", "NFO", lot_size=65, strike_step=50, weekly=False),
    "MIDCPNIFTY": IndexMeta("MIDCPNIFTY", "NFO", lot_size=120, strike_step=25, weekly=False),
    "NIFTYNXT50": IndexMeta("NIFTYNXT50", "NFO", lot_size=25, strike_step=100, weekly=False),
    "SENSEX": IndexMeta("SENSEX", "BFO", lot_size=20, strike_step=100, weekly=True),
    "BANKEX": IndexMeta("BANKEX", "BFO", lot_size=30, strike_step=100, weekly=False),
}

MONTH_CODES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]

# NSE trading holidays — apne broker ke calendar se verify karna. Isme sirf
# wo din hain jo hamesha fixed hote hain; movable festivals har saal update karo.
# (Engine in dates pe trading skip karta hai.)
NX_HOLIDAYS_2026 = [
    "2026-01-26",  # Republic Day
    "2026-03-04",  # Holi (approx)
    "2026-04-03",  # Good Friday (approx)
    "2026-04-14",  # Ambedkar Jayanti
    "2026-05-01",  # Maharashtra Day
    "2026-08-15",  # Independence Day
    "2026-10-02",  # Gandhi Jayanti
    "2026-11-09",  # Diwali Balipratipada (approx)
    "2026-12-25",  # Christmas
]


def meta(symbol: str) -> IndexMeta:
    s = symbol.upper()
    if s not in INDICES:
        raise KeyError(f"unknown index '{symbol}'. Known: {', '.join(INDICES)}")
    return INDICES[s]


def is_holiday(day: dt.date, holidays: Optional[list[str]] = None) -> bool:
    hs = holidays if holidays is not None else NX_HOLIDAYS_2026
    return day.strftime("%Y-%m-%d") in set(hs)


def is_trading_day(day: dt.date, holidays: Optional[list[str]] = None) -> bool:
    return day.weekday() < 5 and not is_holiday(day, holidays)


def _last_weekday_of_month(year: int, month: int, weekday: int) -> dt.date:
    if month == 12:
        nxt = dt.date(year + 1, 1, 1)
    else:
        nxt = dt.date(year, month + 1, 1)
    day = nxt - dt.timedelta(days=1)
    while day.weekday() != weekday:
        day -= dt.timedelta(days=1)
    return day


def next_expiry(symbol: str, from_day: dt.date, holidays: Optional[list[str]] = None) -> dt.date:
    """
    Series ka next expiry date. Weekly available ho to weekly, warna monthly.
    Agar expiry day holiday hai to ek din pehle (exchange ka rule).
    """
    s = symbol.upper()
    m = meta(s)
    wk = WEEKLY_EXPIRY_WEEKDAY.get(s)
    if m.weekly and wk is not None:
        days_ahead = (wk - from_day.weekday()) % 7
        exp = from_day + dt.timedelta(days=days_ahead)
        while is_holiday(exp, holidays):
            exp -= dt.timedelta(days=1)
        return exp
    wk_month = MONTHLY_EXPIRY_WEEKDAY.get(s, 1)
    exp = _last_weekday_of_month(from_day.year, from_day.month, wk_month)
    if exp < from_day:
        ny, nm = (from_day.year + 1, 1) if from_day.month == 12 else (from_day.year, from_day.month + 1)
        exp = _last_weekday_of_month(ny, nm, wk_month)
    while is_holiday(exp, holidays):
        exp -= dt.timedelta(days=1)
    return exp


def days_to_expiry(symbol: str, from_day: dt.date, holidays: Optional[list[str]] = None) -> int:
    return (next_expiry(symbol, from_day, holidays) - from_day).days


def option_symbol(symbol: str, expiry: dt.date, strike: int, opt_type: str, weekly: Optional[bool] = None) -> str:
    """
    Trading symbol banao (Zerodha style — broker adapter apne format me convert karega):
      NIFTY  weekly   -> NIFTY25OCT23500CE    (YYMMMDD nahi, NSE weekly: NIFTY25O07... hmm)
    Zerodha ka actual format do tarah ka hai:
      weekly : NIFTY 25OCT 23500 CE  -> "NIFTY25OCT23500CE"  (monthly numeric also seen)
      NSE weekly instrument token format: "NIFTY25OCT23500CE" works on NSE monthly;
      weekly ke liye NSE "NIFTY25O0712350CE"? — NSE ka weekly format: NIFTY25102323500CE (YYMMDD).
    Isliye: yahan hum broker-agnostic string banate hain aur broker adapter
    instrument master se exact trading_symbol uthata hai.
    """
    m = meta(symbol)
    use_weekly = m.weekly if weekly is None else weekly
    yy = expiry.strftime("%y")
    if use_weekly:
        # NSE/BSE weekly instrument naming: SYMBOL + YYMMDD + STRIKE + CE/PE
        return f"{m.symbol}{yy}{expiry.strftime('%m%d')}{int(strike)}{opt_type}"
    return f"{m.symbol}{yy}{MONTH_CODES[expiry.month - 1]}{int(strike)}{opt_type}"


def atm_strike(symbol: str, spot: float) -> int:
    """Spot ke nearest strike."""
    m = meta(symbol)
    return int(round(spot / m.strike_step) * m.strike_step)


def strike_for(symbol: str, spot: float, opt_type: str, moneyness: str = "ATM", steps: int = 0) -> int:
    """
    Option ke liye strike choose karo.

      opt_type  : "CE" | "PE"
      moneyness : "ATM" | "OTM1" | "OTM2" | "ITM1" | "ITM2"  ("OTM" = OTM1)
      steps     : moneyness me number na ho to yeh use hota hai

    CE: OTM = strike > spot (upar), ITM = strike < spot
    PE: OTM = strike < spot (neeche), ITM = strike > spot
    """
    m = meta(symbol)
    atm = atm_strike(symbol, spot)
    ms = (moneyness or "ATM").upper().replace(" ", "")
    is_call = opt_type.upper() in ("CE", "CALL")
    if ms in ("ATM", "ATM0", ""):
        n, kind = 0, "atm"
    else:
        kind = "otm" if ms.startswith("OTM") else "itm" if ms.startswith("ITM") else "atm"
        tail = ms.replace("OTM", "").replace("ITM", "")
        n = int(tail) if tail.isdigit() else (steps or 1)
    if n == 0:
        return int(atm)
    up = (kind == "otm") == is_call  # CE OTM -> upar; PE ITM -> upar
    return int(atm + (n if up else -n) * m.strike_step)


def summary() -> str:
    lines = ["Index    Exchange  Lot   StrikeStep  Weekly"]
    for k, v in INDICES.items():
        lines.append(
            f"{k:<8} {v.exchange:<9} {v.lot_size:<5} {v.strike_step:<11} {'yes' if v.weekly else 'no (monthly)'}"
        )
    return "\n".join(lines)


if __name__ == "__main__":
    print(summary())
    today = dt.date(2026, 10, 14)
    for sym in ("NIFTY", "BANKNIFTY", "SENSEX"):
        e = next_expiry(sym, today)
        print(f"{sym}: next expiry {e} ({days_to_expiry(sym, today)} DTE), symbol {option_symbol(sym, e, 25000, 'CE')}")
