/**
 * app.js — dashboard logic (zero dependency).
 *
 * Data: /api/snapshot (har 2s poll) + /api/events (SSE, instant).
 * SSE fail ho jaye to polling hi kaafi hai — dashboard kabhi khali nahi dikhega.
 */

const $ = (id) => document.getElementById(id);
const fmt = (n, dp = 0) =>
  n === null || n === undefined || Number.isNaN(n)
    ? "—"
    : (n < 0 ? "-" : "") + "₹" + Math.abs(Number(n)).toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const num = (n, dp = 2) => (n === null || n === undefined || Number.isNaN(n) ? "—" : Number(n).toFixed(dp));
const esc = (s) => String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));

let lastSnapshot = null;
let feedRows = [];
let connected = false;

// ------------------------------------------------------------------ SSE
function connect() {
  const es = new EventSource("/api/events");
  es.onopen = () => setConn(true);
  es.onerror = () => setConn(false);
  const on = (type) => (e) => {
    try {
      const data = JSON.parse(e.data);
      handleEvent(type, data);
    } catch { /* ignore */ }
  };
  for (const t of ["snapshot", "tick", "signal", "ai", "order", "trade", "reject", "position", "status", "daySummary", "error"]) {
    es.addEventListener(t, on(t));
  }
}

function setConn(ok) {
  connected = ok;
  const dot = $("conn-dot");
  dot.className = "dot-live " + (ok ? "on" : "off");
  dot.title = ok ? "SSE connected" : "SSE disconnected (polling chal raha hai)";
}

function handleEvent(type, data) {
  if (type === "snapshot") { lastSnapshot = data; render(data); return; }
  if (type === "tick") {
    if (lastSnapshot) {
      lastSnapshot.market.ltp = data.ltp;
      lastSnapshot.market.vwap = data.vwap ?? lastSnapshot.market.vwap;
      if (data.position) lastSnapshot.position = data.position;
      renderMarketStrip(lastSnapshot);
      if (lastSnapshot.position) renderPosition(lastSnapshot);
    }
    return;
  }
  if (type === "trade" || type === "signal" || type === "ai" || type === "reject" || type === "error" || type === "order") {
    pushFeed(type, data);
  }
  if (type === "daySummary") pushFeed("trade", { ...data, type: "daySummary" });
  // status/reject ke baad turant refresh
  void refresh();
}

function pushFeed(type, data) {
  let text = "";
  if (type === "signal") text = `${esc(data.action).toUpperCase()} · ${esc(data.reason)} <span class="muted">[${esc(data.source)}]</span>`;
  else if (type === "ai") text = `AI ${esc(data.mode)} → <b>${esc(data.choice)}</b> (${num(data.confidence, 2)}) ${esc(data.reasoning)} <span class="muted">${esc(data.provider)}${data.mock ? " · mock" : ""}</span>`;
  else if (type === "trade") text = data.type === "daySummary"
      ? `DAY END · ${data.trades} trades · net ${fmt(data.net)} · charges ${fmt(data.charges)}`
      : `TRADE ${esc(data.optType)} ${data.strike} × ${data.qty} · net <b class="${data.net >= 0 ? "green" : "red"}">${fmt(data.net, 0)}</b> <span class="muted">${esc(data.reason)}</span>`;
  else if (type === "reject") text = `REJECT · ${esc(data.reason)} <span class="muted">[${esc(data.where)}]</span>`;
  else if (type === "error") text = `ERROR · ${esc(data.message)}`;
  else if (type === "order") text = `ORDER ${esc(data.side)} ${esc(data.symbol)} × ${data.qty} @ ₹${num(data.price, 2)}`;
  else text = `${esc(type)} ${esc(JSON.stringify(data)).slice(0, 120)}`;

  feedRows.unshift({ ts: Date.now(), type, text });
  if (feedRows.length > 60) feedRows.pop();
  renderFeed();
}

function renderFeed() {
  $("feed").innerHTML = feedRows
    .map((r) => {
      const t = new Date(r.ts).toLocaleTimeString("en-IN", { hour12: false, timeZone: "Asia/Kolkata" });
      return `<div class="row ${r.type}"><span class="t">${t}</span><span>${r.text}</span></div>`;
    })
    .join("");
}

// ------------------------------------------------------------------ render
function render(s) {
  if (!s) return;
  renderTop(s);
  renderStats(s);
  renderMarketStrip(s);
  renderPosition(s);
  renderSignal(s);
  renderAi(s);
  renderRisk(s);
  renderTrades(s);
  renderCurve(s);
  $("footer-meta").textContent = `strategy: ${s.strategy} (${s.strategySource}) · capital ₹${Number(s.risk.capital).toLocaleString("en-IN")} · risk/trade ₹${s.risk.riskPerTrade}`;
}

function renderTop(s) {
  const mode = $("pill-mode");
  mode.textContent = s.mode.toUpperCase() + (s.brokerSimulated ? " · no real money" : " · REAL ORDERS");
  mode.className = "pill mode " + s.mode;
  $("pill-symbol").textContent = `${s.market.symbol} · ${s.market.expiry} · ${s.instrument}`;
  $("pill-broker").textContent = `broker: ${s.broker} · ${s.product}`;
  $("pill-ai").textContent = `AI ${s.aiMode}${s.aiMode !== "off" ? " (" + s.aiProvider + ")" : ""}`;
  const clockText = `${s.clock.ist} IST${s.clock.virtual ? ` · ${s.clock.speed}x` : ""}`;
  $("pill-clock").textContent = clockText;
  const m = $("pill-market");
  m.textContent = s.market.open ? "market OPEN" : `${s.market.phase} · closed`;
  m.className = "pill " + (s.market.open ? "ok" : "warn");
  $("brand-sub").textContent = `${s.strategy} · feed: ${s.feed}`;
}

function renderStats(s) {
  const pos = s.position;
  const unreal = pos ? Number(pos.unrealized || 0) : 0;
  const net = Number(s.stats.net || 0);
  const dayTotal = net + unreal;
  const cards = [
    { label: "Equity", value: fmt(s.stats.equity), foot: `start ${fmt(s.stats.dayStartEquity)}` },
    { label: "Day P&L (net+open)", value: fmt(dayTotal), cls: dayTotal >= 0 ? "green" : "red", foot: `closed ${fmt(net)} · open ${fmt(unreal)}` },
    { label: "Trades", value: `${s.stats.trades}`, foot: `${s.stats.wins}W / ${s.stats.losses}L · ${num(s.stats.winRate, 1)}% win` },
    { label: "Charges", value: fmt(s.stats.charges), cls: "amber", foot: `gross ${fmt(s.stats.gross)}` },
    { label: "Max drawdown", value: fmt(s.stats.maxDD), cls: s.stats.maxDD > 0 ? "red" : "", foot: "peak-to-trough" },
    {
      label: "Risk status",
      value: s.risk.halted ? "HALTED" : "active",
      cls: s.risk.halted ? "red" : "green",
      foot: s.risk.halted ? s.risk.haltReason : `trades ${s.risk.tradesToday}/${s.risk.maxTradesPerDay} · halt at ${fmt(s.risk.dailyLossLimit)}`,
    },
  ];
  $("stats").innerHTML = cards
    .map((c) => `<div class="stat"><div class="label">${c.label}</div><div class="value ${c.cls || ""}">${c.value}</div><div class="foot">${esc(c.foot)}</div></div>`)
    .join("");
}

function renderMarketStrip(s) {
  $("curve-hint").textContent = `${s.market.symbol} ${num(s.market.ltp, 2)} · VWAP ${num(s.market.vwap, 1)} · ATR ${num(s.market.atr, 1)} · ATM ${s.market.atmStrike ?? "—"}`;
}

function renderPosition(s) {
  const p = s.position;
  const body = $("position-body");
  if (!p) {
    body.className = "empty";
    body.textContent = "Koi position nahi. Engine entry ka wait kar raha hai…";
    $("pos-hint").textContent = s.lastReject ? `last skip: ${s.lastReject}` : "flat";
    return;
  }
  body.className = "";
  const pnl = Number(p.unrealized || 0);
  const progressPct = Math.max(0, Math.min(100, Number(p.pnlPct || 0) + 50));
  $("pos-hint").textContent = `hOLD ${p.holdMinutes}m · delta ${p.delta} · ${p.tag}`;
  body.innerHTML = `
    <div class="pos-head">
      <div>
        <span class="leg">${esc(p.symbol)}</span>
        <span class="tag">${p.qty} qty · ${p.lots} lot(s)</span>
      </div>
      <div class="${pnl >= 0 ? "green" : "red"}"><b>${fmt(pnl, 0)}</b> <span class="muted">(${num(p.pnlPct, 1)}%)</span></div>
    </div>
    <div class="pos-grid">
      <div><div class="label">Entry / LTP</div><div class="value">₹${num(p.entry, 2)} / ₹${num(p.ltp, 2)}</div></div>
      <div><div class="label">Index entry</div><div class="value">${num(p.entryIndex, 1)}</div></div>
      <div><div class="label">Index SL / target</div><div class="value">${num(p.indexStop, 0)} / ${num(p.indexTarget, 0)}</div></div>
      <div><div class="label">Premium disaster stop</div><div class="value">₹${num(p.premiumSafety, 2)}</div></div>
    </div>
    <div class="bar"><i style="width:${progressPct}%"></i></div>`;
}

function renderSignal(s) {
  const sig = s.lastSignal || {};
  const body = $("signal-body");
  body.className = "kv";
  body.innerHTML = `
    <div class="k">action</div><div class="v ${sig.action === "buy" ? "green" : sig.action === "sell" ? "red" : "muted"}">${esc(sig.action || "—")}</div>
    <div class="k">reason</div><div class="v">${esc(sig.reason || "—")}</div>
    <div class="k">confidence</div><div class="v">${num(sig.confidence, 2)}</div>
    <div class="k">source</div><div class="v">${esc(s.strategySource)} (${esc(s.strategyMode)})</div>
    ${s.lastReject ? `<div class="k">last skip</div><div class="v amber">${esc(s.lastReject)}</div>` : ""}`;
}

function renderAi(s) {
  const ai = s.lastAi;
  const body = $("ai-body");
  $("ai-mode-hint").textContent = s.aiMode === "off" ? "band hai" : `mode: ${s.aiMode}`;
  body.className = "kv";
  if (!ai) {
    body.innerHTML = `<div class="k">status</div><div class="v">${s.aiMode === "off" ? "AI off hai (AI_MODE=off)" : "abhi koi decision nahi"}</div>`;
    return;
  }
  body.innerHTML = `
    <div class="k">mode</div><div class="v">${esc(ai.mode)}</div>
    <div class="k">choice</div><div class="v ${ai.blocked ? "amber" : "green"}">${esc(ai.choice)} ${ai.blocked ? "(block)" : ""}</div>
    <div class="k">confidence</div><div class="v">${num(ai.confidence, 2)}</div>
    <div class="k">provider</div><div class="v">${esc(ai.provider)}${ai.mock ? " · mock" : ""}</div>
    <div class="k">latency</div><div class="v">${ai.latencyMs} ms</div>
    <div class="k">reasoning</div><div class="v">${esc(ai.reasoning)}</div>`;
}

function renderRisk(s) {
  const r = s.risk;
  $("risk-body").innerHTML = `
    <div class="k">realized today</div><div class="v ${r.realizedToday >= 0 ? "green" : "red"}">${fmt(r.realizedToday)}</div>
    <div class="k">charges today</div><div class="v amber">${fmt(r.chargesToday)}</div>
    <div class="k">trades today</div><div class="v">${r.tradesToday} / ${r.maxTradesPerDay}</div>
    <div class="k">consecutive losses</div><div class="v">${r.consecutiveLosses}</div>
    <div class="k">daily loss limit</div><div class="v">${fmt(r.dailyLossLimit)}</div>
    <div class="k">risk per trade</div><div class="v">${fmt(r.riskPerTrade)}</div>
    <div class="k">halt</div><div class="v ${r.halted ? "red" : "green"}">${r.halted ? esc(r.haltReason) : "nahi"}</div>
    <div class="k">kill switch</div><div class="v">${r.killSwitch ? "file mili!" : "clear"}</div>`;
}

function renderTrades(s) {
  const tbody = document.querySelector("#trades tbody");
  const rows = (s.trades || []).map((t) => {
    const time = new Date(t.entryTs).toLocaleString("en-IN", { hour12: false, timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
    return `<tr>
      <td>${esc(t.id)}</td>
      <td>${time}</td>
      <td class="left">${esc(t.optType)} ${t.strike}${t.aiChoice ? ` <span class="muted">· ai:${esc(t.aiChoice)}</span>` : ""}</td>
      <td>${t.qty}</td>
      <td>${num(t.entryPremium, 2)}</td>
      <td>${num(t.exitPremium, 2)}</td>
      <td class="left muted">${num(t.entryIndex, 0)} → ${num(t.exitIndex, 0)}</td>
      <td>${fmt(t.gross, 0)}</td>
      <td class="amber">${fmt(t.charges, 0)}</td>
      <td class="${t.net >= 0 ? "green" : "red"}"><b>${fmt(t.net, 0)}</b></td>
      <td>${t.holdMinutes}m</td>
      <td class="left reason">${esc(t.reason)}</td>
    </tr>`;
  });
  tbody.innerHTML = rows.join("");
  $("trades-hint").textContent = `${s.trades.length} trades · ${s.stats.wins}W/${s.stats.losses}L · CSV: data/trades.csv`;
}

function renderCurve(s) {
  const canvas = $("curve");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = 150;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const points = (s.curve || []).map(Number);
  const base = Number(s.risk.capital);
  if (points.length < 2) {
    ctx.strokeStyle = "#223049";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#64748b";
    ctx.font = "12px ui-sans-serif";
    ctx.fillText("Equity curve — pehle trade ke baad dikhega", 10, h / 2 - 8);
    return;
  }
  const data = [base, ...points];
  const min = Math.min(...data);
  const max = Math.max(...data);
  const pad = (max - min) * 0.15 || base * 0.002;
  const y = (v) => h - ((v - (min - pad)) / (max - min + 2 * pad)) * h;
  const x = (i) => (i / (data.length - 1)) * w;

  // zero-line (base capital)
  ctx.strokeStyle = "#223049";
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, y(base));
  ctx.lineTo(w, y(base));
  ctx.stroke();
  ctx.setLineDash([]);

  const up = points[points.length - 1] >= base;
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, up ? "rgba(33,208,122,.35)" : "rgba(255,92,108,.35)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.beginPath();
  ctx.moveTo(x(0), y(data[0]));
  data.forEach((v, i) => ctx.lineTo(x(i), y(v)));
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  ctx.strokeStyle = up ? "#21d07a" : "#ff5c6c";
  ctx.lineWidth = 2;
  data.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.stroke();
}

// ------------------------------------------------------------------ actions
$("btn-pause").addEventListener("click", async () => {
  const isPaused = (lastSnapshot?.risk?.halted ?? false) || $("btn-pause").dataset.paused === "1";
  const cmd = isPaused ? "resume" : "pause";
  await fetch("/api/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cmd }) });
  $("btn-pause").dataset.paused = cmd === "pause" ? "1" : "0";
  $("btn-pause").textContent = cmd === "pause" ? "Resume" : "Pause";
});

$("btn-square").addEventListener("click", async () => {
  $("btn-square").textContent = "Square off…";
  await fetch("/api/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cmd: "squareOff" }) });
  $("btn-square").textContent = "Square off";
  void refresh();
});

$("btn-backtest").addEventListener("click", async () => {
  const card = $("backtest-card");
  const out = $("backtest-out");
  card.hidden = false;
  out.textContent = "Python backtest chal raha hai… (60 din, synthetic data)";
  try {
    const res = await fetch(`/api/backtest?days=60&strategy=${encodeURIComponent(lastSnapshot?.strategy || "orb")}`);
    const data = await res.json();
    if (data.error) {
      out.textContent = `⚠️ ${data.error}\n${data.hint ?? ""}\n${data.detail ?? ""}`;
      return;
    }
    const m = data.metrics || {};
    const r = (v, d = 2) => (typeof v === "number" ? v.toFixed(d) : "—");
    const money = (v) => (typeof v === "number" ? `₹${Math.round(v).toLocaleString("en-IN")}` : "—");
    out.textContent =
      `STRATEGY ${data.config?.strategy} · ${m.trading_days} din · ${m.trades} trades ` +
      `(W${m.wins}/L${m.losses}, ${r(m.win_rate, 1)}%)\n` +
      `net ${money(m.net)}  |  gross ${money(m.gross)} − charges ${money(m.charges)}\n` +
      `PF ${r(m.profit_factor)}  ·  expectancy ${money(m.avg_trade)}/trade  ·  maxDD ${money(m.max_drawdown)} (${r(m.max_drawdown_pct, 1)}%)\n` +
      `return ${r(m.return_pct)}%  ·  Sharpe ${r(m.sharpe)}  ·  best day ${money(m.best_day)} / worst ${money(m.worst_day)}\n` +
      `avg win ${money(m.avg_win)} · avg loss ${money(m.avg_loss)} · lagatar loss max ${m.max_consec_losses}\n` +
      `\n@ "synthetic data" — real edge jaanne ke liye apna CSV do: python3 py/run.py backtest --strategy ${data.config?.strategy} --data <csv>`;
  } catch (e) {
    out.textContent = `⚠️ ${e.message}`;
  }
});

// ------------------------------------------------------------------ loop
async function refresh() {
  try {
    const res = await fetch("/api/snapshot", { cache: "no-store" });
    const s = await res.json();
    lastSnapshot = s;
    render(s);
  } catch { /* ignore */ }
}

connect();
void refresh();
setInterval(refresh, 2000); // polling fallback (SSE ke saath bhi — cheap hai)
