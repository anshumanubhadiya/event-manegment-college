"""
Indian broker charges — realistic model.

Zerodha, Angel One, Fyers, Upstox, Dhan ke brokerage slabs, plus STT / exchange
transaction charges / SEBI fee / stamp duty / GST. Numbers 2025-26 ke hisaab se
hain; broker ya government rate badle to `BROKERS` dict me update kar dena —
baaki sab automatic adjust ho jayega.

Rates ke source: broker pricing pages + NSE/BSE transaction charge circulars.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Optional

Segment = Literal["options", "futures", "equity_intraday", "equity_delivery"]
Side = Literal["buy", "sell"]


# --------------------------------------------------------------------------- #
# Statutory rates (2025-26)
# --------------------------------------------------------------------------- #
# STT / CTT
STT_OPTIONS_SELL = 0.001          # 0.1% of premium, sell side only (Oct 2024 se)
STT_OPTIONS_EXERCISE = 0.00125    # 0.125% of intrinsic, ITM exercise on expiry
STT_FUTURES_SELL = 0.0002         # 0.02% sell side
STT_EQUITY_INTRADAY_SELL = 0.00025
STT_EQUITY_DELIVERY = 0.001       # both sides

# Exchange transaction charges (NSE default; BSE thoda alag)
EXCH_TXN = {
    "NSE": {"options": 0.0003503, "futures": 0.0000173, "equity": 0.0000297},
    "BSE": {"options": 0.000325, "futures": 0.0000182, "equity": 0.0000375},
}
SEBI_TURNOVER = 0.000001          # ₹10 per crore
STAMP = {
    "options": 0.00003,           # 0.003% buy side
    "futures": 0.00002,           # 0.002% buy side
    "equity_intraday": 0.00003,
    "equity_delivery": 0.00015,
}
GST_RATE = 0.18                   # on (brokerage + exchange txn + SEBI fee)


# --------------------------------------------------------------------------- #
# Brokerage slabs (per executed order, per side) — flat models, realistic min/max
# --------------------------------------------------------------------------- #
@dataclass
class BrokerageSlab:
    """flat: flat rupees per order. pct: % of turnover. Jo lagega wahi use hota hai."""

    flat: float = 20.0
    pct: Optional[float] = None
    cap: Optional[float] = None
    note: str = ""


BROKERS: dict[str, dict[str, BrokerageSlab]] = {
    "zerodha": {
        "options": BrokerageSlab(flat=20.0, note="₹20 per order"),
        "futures": BrokerageSlab(flat=20.0, note="₹20 per order"),
        "equity_intraday": BrokerageSlab(flat=20.0, pct=0.0003, cap=20.0, note="min(₹20, 0.03%)"),
        "equity_delivery": BrokerageSlab(flat=0.0, note="delivery free"),
    },
    "angelone": {
        "options": BrokerageSlab(flat=20.0, note="₹20 per order"),
        "futures": BrokerageSlab(flat=20.0, note="₹20 per order"),
        "equity_intraday": BrokerageSlab(flat=20.0, pct=0.0003, cap=20.0, note="min(₹20, 0.03%)"),
        "equity_delivery": BrokerageSlab(flat=0.0, note="delivery free"),
    },
    "fyers": {
        "options": BrokerageSlab(flat=20.0, note="₹20 per order"),
        "futures": BrokerageSlab(flat=20.0, note="₹20 per order"),
        "equity_intraday": BrokerageSlab(flat=20.0, pct=0.0003, cap=20.0),
        "equity_delivery": BrokerageSlab(flat=0.0),
    },
    "upstox": {
        "options": BrokerageSlab(flat=20.0, note="₹20 per order"),
        "futures": BrokerageSlab(flat=20.0),
        "equity_intraday": BrokerageSlab(flat=20.0, pct=0.0005, cap=20.0),
        "equity_delivery": BrokerageSlab(flat=0.0),
    },
    "dhan": {
        "options": BrokerageSlab(flat=20.0, note="₹20 per order"),
        "futures": BrokerageSlab(flat=20.0),
        "equity_intraday": BrokerageSlab(flat=20.0, pct=0.0003, cap=20.0),
        "equity_delivery": BrokerageSlab(flat=0.0),
    },
    "paper": {
        "options": BrokerageSlab(flat=20.0, note="paper me bhi real charges"),
        "futures": BrokerageSlab(flat=20.0),
        "equity_intraday": BrokerageSlab(flat=20.0, pct=0.0003, cap=20.0),
        "equity_delivery": BrokerageSlab(flat=0.0),
    },
}


@dataclass
class ChargeBreakdown:
    brokerage: float = 0.0
    stt: float = 0.0
    exchange: float = 0.0
    sebi: float = 0.0
    stamp: float = 0.0
    gst: float = 0.0
    total: float = 0.0

    def to_dict(self) -> dict:
        return {
            "brokerage": round(self.brokerage, 2),
            "stt": round(self.stt, 2),
            "exchange": round(self.exchange, 2),
            "sebi": round(self.sebi, 2),
            "stamp": round(self.stamp, 2),
            "gst": round(self.gst, 2),
            "total": round(self.total, 2),
        }


def _brokerage(broker: str, segment: Segment, turnover: float) -> float:
    slab = BROKERS.get(broker, BROKERS["zerodha"])[segment]
    fee = slab.flat
    if slab.pct is not None:
        pct_fee = turnover * slab.pct
        fee = min(fee, pct_fee) if slab.cap else pct_fee
    if slab.cap is not None:
        fee = min(fee, slab.cap)
    return round(fee, 4)


def order_charges(
    broker: str,
    segment: Segment,
    side: Side,
    qty: float,
    price: float,
    exchange: str = "NSE",
    lot_size: int = 1,
    orders: int = 1,
) -> ChargeBreakdown:
    """
    Ek order ke charges. qty = total units (lots * lot_size).
    orders = kitne orders me execute hua (brokerage per order lagti hai).
    """
    turnover = abs(qty) * abs(price)
    c = ChargeBreakdown()

    c.brokerage = _brokerage(broker, segment, turnover) * orders

    if segment == "options":
        if side == "sell":
            c.stt = turnover * STT_OPTIONS_SELL
    elif segment == "futures":
        if side == "sell":
            c.stt = turnover * STT_FUTURES_SELL
    elif segment == "equity_intraday":
        if side == "sell":
            c.stt = turnover * STT_EQUITY_INTRADAY_SELL
    elif segment == "equity_delivery":
        c.stt = turnover * STT_EQUITY_DELIVERY

    exch_key = "options" if segment == "options" else "futures" if segment == "futures" else "equity"
    c.exchange = turnover * EXCH_TXN.get(exchange, EXCH_TXN["NSE"])[exch_key]
    c.sebi = turnover * SEBI_TURNOVER
    if side == "buy":
        c.stamp = turnover * STAMP[segment]

    c.gst = (c.brokerage + c.exchange + c.sebi) * GST_RATE
    c.total = c.brokerage + c.stt + c.exchange + c.sebi + c.stamp + c.gst
    return c


def round_trip_charges(
    broker: str,
    segment: Segment,
    qty: float,
    entry: float,
    exit: float,
    exchange: str = "NSE",
    orders_per_leg: int = 1,
    option_side: Side = "buy",
) -> ChargeBreakdown:
    """
    Poora round trip: entry order + exit order.
    Options me: buy-side entry (STT 0) + sell-side exit (STT 0.1%).
    option_side='buy' matlab long option (CE/PE khareeda) — sabse common.
    """
    entry_side: Side = option_side
    exit_side: Side = "sell" if option_side == "buy" else "buy"
    a = order_charges(broker, segment, entry_side, qty, entry, exchange, orders=orders_per_leg)
    b = order_charges(broker, segment, exit_side, qty, exit, exchange, orders=orders_per_leg)
    return ChargeBreakdown(
        brokerage=a.brokerage + b.brokerage,
        stt=a.stt + b.stt,
        exchange=a.exchange + b.exchange,
        sebi=a.sebi + b.sebi,
        stamp=a.stamp + b.stamp,
        gst=a.gst + b.gst,
        total=a.total + b.total,
    )


def breakeven_points(broker: str, qty: float, entry: float, segment: Segment = "options") -> float:
    """Premium me kitne points chahiye bas charges cover karne ke liye."""
    c = round_trip_charges(broker, segment, qty, entry, entry)
    if qty <= 0:
        return 0.0
    return c.total / qty


def cost_pct_of_premium(broker: str, qty: float, premium: float) -> float:
    """Charges as % of premium paid — small premiums pe yeh brutal hota hai."""
    if premium <= 0 or qty <= 0:
        return 0.0
    c = round_trip_charges(broker, "options", qty, premium, premium)
    return c.total / (qty * premium) * 100


# Quick self-check / demo
def _demo() -> None:
    qty, entry, exit_ = 75, 120.0, 145.0  # 1 lot NIFTY ATM
    c = round_trip_charges("zerodha", "options", qty, entry, exit_)
    gross = qty * (exit_ - entry)
    print(f"NIFTY 1 lot (75 qty): gross ₹{gross:.2f}")
    print(f"  charges: {c.to_dict()}")
    print(f"  net     ₹{gross - c.total:.2f}  (breakeven {breakeven_points('zerodha', qty, entry):.2f} pts)")
    print(f"  charges as % of premium: {cost_pct_of_premium('zerodha', qty, entry):.2f}%")


if __name__ == "__main__":
    _demo()
