"""Shared data types. Yeh shapes TS live engine ke saath JSON contract banate hain."""

from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass, field
from typing import Any, Literal, Optional

Action = Literal["buy", "sell", "hold", "exit"]
Side = Literal["buy", "sell"]
ProductType = Literal["MIS", "NRML", "CNC"]
OptionType = Literal["CE", "PE"]
OrderType = Literal["MARKET", "LIMIT", "SL", "SL-M"]


# --------------------------------------------------------------------------- #
# JSON helpers
# --------------------------------------------------------------------------- #
def _clean(x: Any) -> Any:
    """NaN / Inf -> None so json.dumps never explodes."""
    if isinstance(x, float):
        if math.isnan(x) or math.isinf(x):
            return None
        return x
    if isinstance(x, dict):
        return {k: _clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_clean(v) for v in x]
    return x


def to_jsonable(obj: Any) -> Any:
    """dataclass / nested structure -> plain JSON-safe python objects."""
    if hasattr(obj, "to_dict"):
        return _clean(obj.to_dict())
    if isinstance(obj, dict):
        return _clean({k: to_jsonable(v) for k, v in obj.items()})
    if isinstance(obj, (list, tuple)):
        return [_clean(to_jsonable(v)) for v in obj]
    if hasattr(obj, "__dataclass_fields__"):
        return _clean(asdict(obj))
    return _clean(obj)


def dumps(obj: Any) -> str:
    return json.dumps(to_jsonable(obj), separators=(",", ":"), allow_nan=False)


# --------------------------------------------------------------------------- #
# Market data
# --------------------------------------------------------------------------- #
@dataclass
class Bar:
    """One OHLCV candle. ts = epoch milliseconds (IST session ka wall clock)."""

    ts: int
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0

    @property
    def typical(self) -> float:
        return (self.high + self.low + self.close) / 3.0

    def to_dict(self) -> dict:
        return {
            "ts": self.ts,
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "volume": self.volume,
        }

    @staticmethod
    def from_dict(d: dict) -> "Bar":
        return Bar(
            ts=int(d["ts"]),
            open=float(d["open"]),
            high=float(d["high"]),
            low=float(d["low"]),
            close=float(d["close"]),
            volume=float(d.get("volume", 0.0)),
        )


@dataclass
class Position:
    """Open position (index side). qty signed: + long, - short."""

    symbol: str
    qty: int = 0
    entry: float = 0.0
    stop: Optional[float] = None
    target: Optional[float] = None
    opened_ts: Optional[int] = None
    tag: str = ""
    option_symbol: Optional[str] = None  # e.g. NIFTY25OCT23500CE
    option_entry: Optional[float] = None
    lots: int = 0

    @property
    def side(self) -> str:
        if self.qty > 0:
            return "long"
        if self.qty < 0:
            return "short"
        return "flat"

    @staticmethod
    def from_dict(d: dict) -> "Position":
        """Wire contract tolerance: unknown keys (id/optType/strike...) ignore, `side` derive hota hai."""
        known = {f for f in ("symbol", "qty", "entry", "stop", "target",
                             "opened_ts", "tag", "option_symbol", "option_entry", "lots")}
        alias = {"openedTs": "opened_ts", "optionSymbol": "option_symbol", "optionEntry": "option_entry"}
        clean = {}
        for k, v in d.items():
            kk = alias.get(k, k)
            if kk in known and kk != "side":
                clean[kk] = v
        return Position(**clean)

    def unrealized(self, ltp: float) -> float:
        return self.qty * (ltp - self.entry)

    def to_dict(self) -> dict:
        return {
            "symbol": self.symbol,
            "qty": self.qty,
            "side": self.side,
            "entry": self.entry,
            "stop": self.stop,
            "target": self.target,
            "openedTs": self.opened_ts,
            "tag": self.tag,
            "optionSymbol": self.option_symbol,
            "optionEntry": self.option_entry,
            "lots": self.lots,
        }


@dataclass
class Signal:
    """Strategy ka output. Yeh live engine aur backtest dono consume karte hain."""

    action: Action
    reason: str = ""
    confidence: float = 0.5  # 0..1
    stop: Optional[float] = None  # index price pe stop
    target: Optional[float] = None
    lots: Optional[int] = None  # strategy khud sizing de sake (warna engine risk se nikaalta hai)
    tag: str = ""
    meta: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "action": self.action,
            "reason": self.reason,
            "confidence": round(float(self.confidence), 4),
            "stop": self.stop,
            "target": self.target,
            "lots": self.lots,
            "tag": self.tag,
            "meta": self.meta,
        }

    @staticmethod
    def from_dict(d: dict) -> "Signal":
        return Signal(
            action=d.get("action", "hold"),
            reason=d.get("reason", ""),
            confidence=float(d.get("confidence", 0.5)),
            stop=d.get("stop"),
            target=d.get("target"),
            lots=d.get("lots"),
            tag=d.get("tag", ""),
            meta=d.get("meta") or {},
        )


@dataclass
class MarketState:
    """
    Strategy ko yehi dikhta hai. Live engine (TS) isko bana ke poora bhejta hai,
    backtest engine same shape khud banata hai — isliye ek hi strategy code
    dono jagah chalta hai.
    """

    symbol: str  # NIFTY / BANKNIFTY / SENSEX
    ts: int
    ltp: float
    bars: dict[str, list[Bar]] = field(default_factory=dict)  # timeframe -> bars (oldest first)
    prev_close: Optional[float] = None
    day_open: Optional[float] = None
    day_high: Optional[float] = None
    day_low: Optional[float] = None
    vwap: Optional[float] = None
    atr: Optional[float] = None
    adx: Optional[float] = None
    position: Optional[Position] = None
    day_pnl: float = 0.0
    trades_today: int = 0
    consecutive_losses: int = 0
    minutes_to_close: int = 0
    # option chain snapshot (agar broker/service se available ho)
    atm_strike: Optional[float] = None
    iv: Optional[float] = None
    pcr: Optional[float] = None
    meta: dict = field(default_factory=dict)

    # -- convenience accessors strategies ke liye --------------------------- #
    def series(self, tf: str = "5m") -> list[Bar]:
        return self.bars.get(tf, [])

    def closes(self, tf: str = "5m") -> list[float]:
        return [b.close for b in self.bars.get(tf, [])]

    def highs(self, tf: str = "5m") -> list[float]:
        return [b.high for b in self.bars.get(tf, [])]

    def lows(self, tf: str = "5m") -> list[float]:
        return [b.low for b in self.bars.get(tf, [])]

    def volumes(self, tf: str = "5m") -> list[float]:
        return [b.volume for b in self.bars.get(tf, [])]

    def to_dict(self) -> dict:
        return {
            "symbol": self.symbol,
            "ts": self.ts,
            "ltp": self.ltp,
            "bars": {tf: [b.to_dict() for b in bars] for tf, bars in self.bars.items()},
            "prevClose": self.prev_close,
            "dayOpen": self.day_open,
            "dayHigh": self.day_high,
            "dayLow": self.day_low,
            "vwap": self.vwap,
            "atr": self.atr,
            "adx": self.adx,
            "position": self.position.to_dict() if self.position else None,
            "dayPnl": self.day_pnl,
            "tradesToday": self.trades_today,
            "consecutiveLosses": self.consecutive_losses,
            "minutesToClose": self.minutes_to_close,
            "atmStrike": self.atm_strike,
            "iv": self.iv,
            "pcr": self.pcr,
            "meta": self.meta,
        }

    @staticmethod
    def from_dict(d: dict) -> "MarketState":
        bars = {
            tf: [Bar.from_dict(b) for b in lst] for tf, lst in (d.get("bars") or {}).items()
        }
        pos = d.get("position")
        return MarketState(
            symbol=d.get("symbol", "NIFTY"),
            ts=int(d.get("ts", 0)),
            ltp=float(d.get("ltp", 0.0)),
            bars=bars,
            prev_close=d.get("prevClose"),
            day_open=d.get("dayOpen"),
            day_high=d.get("dayHigh"),
            day_low=d.get("dayLow"),
            vwap=d.get("vwap"),
            atr=d.get("atr"),
            adx=d.get("adx"),
            position=Position.from_dict(pos) if pos else None,
            day_pnl=float(d.get("dayPnl", 0.0)),
            trades_today=int(d.get("tradesToday", 0)),
            consecutive_losses=int(d.get("consecutiveLosses", 0)),
            minutes_to_close=int(d.get("minutesToClose", 0)),
            atm_strike=d.get("atmStrike"),
            iv=d.get("iv"),
            pcr=d.get("pcr"),
            meta=d.get("meta") or {},
        )


# --------------------------------------------------------------------------- #
# Execution
# --------------------------------------------------------------------------- #
@dataclass
class Order:
    """Broker order request (live engine broker adapters ko yehi jaata hai)."""

    symbol: str
    side: Side
    qty: int
    order_type: OrderType = "MARKET"
    price: Optional[float] = None
    trigger_price: Optional[float] = None
    product: ProductType = "MIS"
    tag: str = ""
    exchange: str = "NFO"
    order_id: Optional[str] = None
    status: str = "NEW"

    def to_dict(self) -> dict:
        return {
            "symbol": self.symbol,
            "side": self.side,
            "qty": self.qty,
            "orderType": self.order_type,
            "price": self.price,
            "triggerPrice": self.trigger_price,
            "product": self.product,
            "tag": self.tag,
            "exchange": self.exchange,
            "orderId": self.order_id,
            "status": self.status,
        }


@dataclass
class Trade:
    """Completed round trip — journal ka core record."""

    symbol: str
    side: Side  # option side (buy/sell) jo execute hua
    qty: int
    entry_ts: int
    entry: float
    exit_ts: int = 0
    exit: float = 0.0
    gross: float = 0.0
    charges: float = 0.0
    net: float = 0.0
    reason: str = ""
    entry_reason: str = ""
    tag: str = ""
    stop: Optional[float] = None
    target: Optional[float] = None
    index_entry: Optional[float] = None
    index_exit: Optional[float] = None
    option_symbol: Optional[str] = None
    lots: int = 0
    meta: dict = field(default_factory=dict)

    @property
    def win(self) -> bool:
        return self.net > 0

    def to_dict(self) -> dict:
        return {
            "symbol": self.symbol,
            "side": self.side,
            "qty": self.qty,
            "entryTs": self.entry_ts,
            "entry": round(self.entry, 2),
            "exitTs": self.exit_ts,
            "exit": round(self.exit, 2),
            "gross": round(self.gross, 2),
            "charges": round(self.charges, 2),
            "net": round(self.net, 2),
            "reason": self.reason,
            "entryReason": self.entry_reason,
            "tag": self.tag,
            "stop": self.stop,
            "target": self.target,
            "indexEntry": self.index_entry,
            "indexExit": self.index_exit,
            "optionSymbol": self.option_symbol,
            "lots": self.lots,
            "win": self.win,
            "meta": self.meta,
        }

    def to_row(self) -> dict:
        """Flat row for CSV export."""
        d = self.to_dict()
        d.pop("meta", None)
        return d
