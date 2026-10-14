/**
 * server.ts — engine ke saath chalta dashboard + REST API.
 *
 *   GET  /                    dashboard (web/ folder se, zero build)
 *   GET  /api/snapshot        poora live state (position, risk, stats, curve)
 *   GET  /api/history         pichhle events (ring buffer)
 *   GET  /api/config          config (secrets ke bina)
 *   GET  /api/health          server + python strategy service status
 *   GET  /api/events          SSE — tick/signal/ai/order/trade/position/pnl
 *   POST /api/command         {cmd: pause|resume|squareOff|flatten}
 *   GET  /api/backtest        python service se backtest proxy (?days=60&strategy=orb)
 *
 * Kyun SSE aur polling dono? SSE instant updates deta hai; snapshot polling
 * fallback hai agar proxy SSE ko buffer kar de.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { config } from "../config.ts";
import { fetchJson } from "../util.ts";
import type { Engine } from "../engine/engine.ts";
import { BROKER_LIST } from "../broker/list.ts";
import { LOCAL_STRATEGIES } from "../strategy/local.ts";

interface SSEClient {
  res: ServerResponse;
  id: number;
}

export class ApiServer {
  private clients = new Set<SSEClient>();
  private history: Array<Record<string, unknown>> = [];
  private clientSeq = 0;
  private startedAt = Date.now();
  private pingTimer?: NodeJS.Timeout;
  private server = createServer((req, res) => {
    void this.handle(req, res);
  });

  constructor(
    private engine: Engine,
    private version = "0.1.0",
  ) {}

  /** Engine ke events → SSE broadcast + history. */
  onEvent(type: string, payload: Record<string, unknown>): void {
    const rec = { ts: Date.now(), type, ...payload };
    this.history.push(rec);
    if (this.history.length > 5000) this.history.splice(0, this.history.length - 5000);
    // tick bahut aate hain — history me sirf important rakho
    if (this.history.length > 1500 && type === "tick") this.history.splice(0, 500);
    this.broadcast(type, rec);
  }

  private broadcast(type: string, payload: unknown): void {
    const data = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const c of [...this.clients]) {
      try {
        c.res.write(data);
      } catch {
        this.clients.delete(c);
      }
    }
  }

  listen(): Promise<void> {
    return new Promise((resolvePromise) => {
      this.server.listen(config.server.port, config.server.host, () => {
        this.pingTimer = setInterval(() => this.broadcast("ping", { ts: Date.now() }), 15_000);
        console.log(`[server] dashboard: http://${config.server.host}:${config.server.port}  (SSE /api/events)`);
        resolvePromise();
      });
    });
  }

  async close(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const c of this.clients) {
      try {
        c.res.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  // ------------------------------------------------------------------ routing
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    try {
      if (path === "/api/snapshot") return this.json(res, this.engine.snapshot());
      if (path === "/api/history") {
        const limit = Number(url.searchParams.get("limit") ?? 200);
        return this.json(res, this.history.slice(-limit));
      }
      if (path === "/api/health") {
        const serviceUp = await this.pingService();
        return this.json(res, {
          ok: true,
          version: this.version,
          uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
          mode: config.mode,
          paused: this.engine.isPaused(),
          strategyService: { url: config.strategy.url, up: serviceUp },
          localStrategies: Object.keys(LOCAL_STRATEGIES),
          brokers: BROKER_LIST,
        });
      }
      if (path === "/api/config") return this.json(res, this.safeConfig());
      if (path === "/api/events") return this.sse(req, res);
      if (path === "/api/command" && req.method === "POST") return this.command(req, res);
      if (path === "/api/backtest") return this.backtest(url, res);
      if (path.startsWith("/api/")) return this.json(res, { error: "not found", path }, 404);
      return this.static(res, path);
    } catch (e) {
      this.json(res, { error: (e as Error).message }, 500);
    }
  }

  private json(res: ServerResponse, body: unknown, status = 200): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(text);
  }

  private sse(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`retry: 3000\n\n`);
    const client: SSEClient = { res, id: ++this.clientSeq };
    this.clients.add(client);
    // shuru me ek snapshot
    res.write(`event: snapshot\ndata: ${JSON.stringify(this.engine.snapshot())}\n\n`);
    req.on("close", () => {
      this.clients.delete(client);
    });
  }

  private async command(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const cmd = String(body["cmd"] ?? "");
    switch (cmd) {
      case "pause":
        this.engine.setPaused(true);
        return this.json(res, { ok: true, cmd, paused: true });
      case "resume":
        this.engine.setPaused(false);
        return this.json(res, { ok: true, cmd, paused: false });
      case "squareOff":
        await this.engine.squareOffNow("manual square-off (dashboard)");
        return this.json(res, { ok: true, cmd, position: this.engine.positionSnapshot() });
      case "flatten":
        await this.engine.squareOffNow("dashboard: flatten all");
        return this.json(res, { ok: true, cmd });
      default:
        return this.json(res, { ok: false, error: `unknown cmd "${cmd}" (pause|resume|squareOff|flatten)` }, 400);
    }
  }

  /** Python strategy service ko forward karo (backtest wahi karta hai — Python me likha hai). */
  private async backtest(url: URL, res: ServerResponse): Promise<void> {
    const days = Number(url.searchParams.get("days") ?? 60);
    const strategy = String(url.searchParams.get("strategy") ?? config.strategy.name);
    const seed = url.searchParams.get("seed");
    try {
      const out = await fetchJson<Record<string, unknown>>(
        `${config.strategy.url}/backtest`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            strategy,
            config: { strategy, params: {} },
            synthetic: { days, seed: seed ? Number(seed) : 42 },
          }),
        },
        120_000,
      );
      return this.json(res, out);
    } catch (e) {
      return this.json(
        res,
        {
          error: "python strategy service nahi mila",
          detail: (e as Error).message,
          hint: `Terminal 2 me chalao: python3 py/run.py serve  (ya py/run.py backtest --strategy ${strategy})`,
          url: config.strategy.url,
        },
        503,
      );
    }
  }

  private async pingService(): Promise<boolean> {
    try {
      const r = await fetchJson<{ ok?: boolean }>(`${config.strategy.url}/health`, {}, 1200);
      return Boolean(r?.ok);
    } catch {
      return false;
    }
  }

  private safeConfig(): Record<string, unknown> {
    return {
      mode: config.mode,
      market: config.market,
      strategy: { name: config.strategy.name, mode: config.strategy.mode, url: config.strategy.url, params: config.strategy.params },
      broker: { name: config.broker.name, product: config.broker.product, slippagePct: config.broker.slippagePct },
      ai: { mode: config.ai.mode, provider: config.ai.provider, model: config.ai.model, hasKey: Boolean(config.ai.apiKey), minConfidence: config.ai.minConfidence },
      risk: config.risk,
      server: { host: config.server.host, port: config.server.port },
      demo: config.demo,
      dataDir: config.dataDir,
      killSwitchFile: config.killSwitchFile,
    };
  }

  // ------------------------------------------------------------------ static
  private static(res: ServerResponse, path: string): void {
    const dashboardDir = resolve(process.cwd(), "src/server/dashboard");
    const file = path === "/" ? "index.html" : path.replace(/^\//, "");
    const full = resolve(dashboardDir, file);
    if (!full.startsWith(dashboardDir)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    try {
      const data = readFileSync(full);
      const ext = extname(full);
      const type =
        ext === ".html" ? "text/html; charset=utf-8" : ext === ".css" ? "text/css; charset=utf-8" : ext === ".js" ? "application/javascript; charset=utf-8" : "text/plain; charset=utf-8";
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
      res.end(data);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
    }
  }
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolvePromise(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch {
        resolvePromise({});
      }
    });
    req.on("error", () => resolvePromise({}));
  });
}
