"""
app.py — strategy service (zero dependencies, stdlib http.server).

Live TS engine isse signal maangta hai. Ye isliye hai ki strategy Python me likho,
live trading TypeScript me chale — same strategy code backtest + live dono me.

Endpoints
    GET  /health                 -> {ok, version, strategies, uptimeSec}
    GET  /strategies             -> [{name, description, params, timeframes, warmup}]
    POST /signal                 -> body: MarketState JSON, query: ?strategy=orb&p_key=val
                                    res: Signal JSON
    POST /signal/raw             -> {state, strategy, params} ek hi body me
    POST /backtest               -> {bars|synthetic, config} -> metrics (chhota backtest)
    GET  /indicators?symbol=..   -> supported indicator list

Chalane ke liye:  python py/run.py serve --port 8787
"""

from __future__ import annotations

import datetime as dt
import json
import os
import time
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional

from .. import __version__
from ..backtest import BacktestConfig, run_backtest
from ..data import generate_history
from ..strategies import create as create_strategy
from ..strategies import describe_all, names
from ..data.resample import IST
from ..types import MarketState, dumps

START_TS = time.time()

# strategy instances cache: key = name + sorted params
_CACHE: dict[str, Any] = {}


# Strategy instances request-to-request persist karte hain — warna ORB jaisi
# strategy ka "opening range set hua" jaisa intraday state har request pe ud jaata hai.
_STRATEGY_CACHE: dict[tuple, Any] = {}


def _session_key(state) -> str:
    """State ke ts se IST trading date nikalo (engine meta bheje to wahi)."""
    sess = (state.meta or {}).get("session")
    if sess:
        return str(sess)
    try:
        return dt.datetime.fromtimestamp(int(state.ts) / 1000, IST).strftime("%Y-%m-%d")
    except Exception:  # noqa: BLE001
        return ""


def get_strategy_cached(name: str, params: dict):
    """Cached instance + naya din aaye to reset_day()."""
    key = (name, tuple(sorted((k, str(v)) for k, v in params.items())))
    if key not in _STRATEGY_CACHE:
        _STRATEGY_CACHE[key] = get_strategy(name, params)
    return _STRATEGY_CACHE[key]


def get_strategy(name: str, params: dict):
    key = name + "|" + json.dumps(params, sort_keys=True, default=str)
    if key not in _CACHE:
        _CACHE[key] = create_strategy(name, **params)
    return _CACHE[key]


def _coerce_params(raw: dict[str, list[str]]) -> dict:
    """query string ke saare values strings hote hain — types infer karo."""
    out: dict[str, Any] = {}
    for k, v in raw.items():
        val = v[0] if isinstance(v, list) else v
        if isinstance(val, str):
            low = val.lower()
            if low in ("true", "false"):
                out[k] = low == "true"
                continue
            try:
                out[k] = int(val) if val.isdigit() or (val.startswith("-") and val[1:].isdigit()) else float(val)
                continue
            except ValueError:
                pass
        out[k] = val
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = f"algo-strategy-service/{__version__}"
    protocol_version = "HTTP/1.1"

    # ------------------------------------------------------------- plumbing #
    def _send(self, code: int, payload: Any, ctype: str = "application/json") -> None:
        body = payload if isinstance(payload, bytes) else dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args: Any) -> None:  # quiet by default
        if os.environ.get("SERVICE_VERBOSE"):
            print(f"[service] {self.address_string()} {fmt % args}")

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._send(204, b"")

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        raw = self.rfile.read(n)
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as e:
            raise ValueError(f"invalid JSON body: {e}") from e

    # ----------------------------------------------------------------- GET #
    def do_GET(self) -> None:  # noqa: N802
        try:
            parsed = urllib.parse.urlparse(self.path)
            q = urllib.parse.parse_qs(parsed.query)
            path = parsed.path.rstrip("/") or "/"

            if path in ("/", "/health"):
                return self._send(200, {
                    "ok": True, "service": "algo-strategy-service", "version": __version__,
                    "uptimeSec": round(time.time() - START_TS, 1), "strategies": names(),
                })
            if path == "/strategies":
                return self._send(200, {"strategies": describe_all()})
            if path == "/indicators":
                return self._send(200, {"indicators": ["ema", "sma", "rsi", "atr", "adx", "vwap", "stdev", "supertrend", "opening_range", "rolling_high", "rolling_low"]})
            if path == "/backtest":
                # convenience: GET ?strategy=orb&days=60&seed=42 (asli POST wahi logic)
                body = {
                    "strategy": (q.get("strategy") or ["orb"])[0],
                    "config": {"strategy": (q.get("strategy") or ["orb"])[0]},
                    "synthetic": {
                        "days": int((q.get("days") or ["60"])[0]),
                        "seed": int((q.get("seed") or ["42"])[0]),
                    },
                }
                return self._backtest(body)
            if path == "/strategy":
                name = (q.get("name") or ["orb"])[0]
                params = _coerce_params({k: v for k, v in q.items() if k != "name"})
                s = get_strategy(name, params)
                return self._send(200, s.describe())
            return self._send(404, {"error": f"unknown path {path}"})
        except Exception as e:  # noqa: BLE001
            return self._send(500, {"error": str(e), "trace": traceback.format_exc()[-800:]})

    # ---------------------------------------------------------------- POST #
    def do_POST(self) -> None:  # noqa: N802
        try:
            parsed = urllib.parse.urlparse(self.path)
            q = urllib.parse.parse_qs(parsed.query)
            path = parsed.path.rstrip("/") or "/"

            if path in ("/signal", "/signal/raw"):
                body = self._body()
                if path == "/signal/raw":
                    state_raw = body.get("state") or {}
                    name = body.get("strategy") or "orb"
                    params = body.get("params") or {}
                else:
                    state_raw = body
                    name = (q.get("strategy") or ["orb"])[0]
                    params = {k: v for k, v in _coerce_params(q).items() if k != "strategy"}
                    params.update(body.pop("params", {}) if isinstance(body, dict) else {})
                if not state_raw:
                    return self._send(400, {"error": "empty state"})
                state = MarketState.from_dict(state_raw)
                strat = get_strategy_cached(name, params)
                # day rollover — cached instance ka intraday state naye din pe reset
                session = _session_key(state)
                if session and getattr(strat, "_session", None) != session:
                    strat._session = session
                    strat.reset_day()
                sig = strat.run(state)
                diag = {
                    "strategy": strat.name,
                    "params": strat.params,
                    "ltp": state.ltp,
                    "vwap": None if state.vwap is None else round(state.vwap, 2),
                    "atr": None if state.atr is None else round(state.atr, 2),
                    "adx": None if state.adx is None else round(state.adx, 1),
                    "bars": {k: len(v) for k, v in state.bars.items()},
                }
                return self._send(200, {"signal": sig.to_dict(), "diag": diag})

            if path == "/backtest":
                return self._backtest(self._body())

            return self._send(404, {"error": f"unknown path {path}"})
        except Exception as e:  # noqa: BLE001
            return self._send(500, {"error": str(e), "trace": traceback.format_exc()[-800:]})

    # ------------------------------------------------------------- backtest #
    def _backtest(self, body: dict) -> None:
        """Backtest chala ke metrics + trades + equity return karta hai (synthetic ya bars)."""
        try:
            cfg_raw = dict(body.get("config") or {})
            bars_raw = body.get("bars")
            if bars_raw:
                from ..types import Bar

                bars = [Bar.from_dict(b) for b in bars_raw]
            else:
                gen = body.get("synthetic") or {}
                bars = generate_history(
                    symbol=str(gen.get("symbol", cfg_raw.get("symbol", "NIFTY"))),
                    days=int(gen.get("days", 20)),
                    seed=int(gen.get("seed", 42)),
                    start_price=float(gen.get("startPrice", 25000)),
                )
            risk_raw = dict(cfg_raw.pop("risk", {}) or {})
            from ..risk import RiskConfig

            cfg = BacktestConfig(**cfg_raw)
            if risk_raw:
                rcfg = RiskConfig(**{k: v for k, v in risk_raw.items()})
                cfg.risk = _merge_risk(cfg.risk, rcfg)
            m, bt = run_backtest(bars, cfg)
            out = {
                "metrics": m.to_dict(),
                "trades": [t.to_dict() for t in bt.trades[-50:]],
                "equity": bt.equity_curve,
                "config": {
                    "strategy": cfg.strategy,
                    "symbol": cfg.symbol,
                    "params": cfg.params,
                    "capital": cfg.capital,
                },
            }
            return self._send(200, out)
        except Exception as e:  # noqa: BLE001
            return self._send(500, {"error": str(e), "trace": traceback.format_exc()[-800:]})


def _merge_risk(base, override):
    for k, v in override.__dict__.items():
        setattr(base, k, v)
    return base


def serve(port: int = 8787, host: str = "0.0.0.0") -> None:
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"strategy service: http://{host}:{port}  (strategies: {', '.join(names())})")
    print(f"  GET  /health   GET /strategies   GET /indicators")
    print(f"  POST /signal   POST /signal/raw  POST /backtest")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    serve(int(os.environ.get("PORT", "8787")))
