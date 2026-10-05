import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "@osama/core";
import { fail, json, serveStatic, type Route, type RouteDeps, type SseClient } from "./http.js";
import { buildRoutes } from "./routes/index.js";

/**
 * Osama's local engine API.
 *
 * This file is deliberately thin: it owns the HTTP listener, the SSE fan-out,
 * the request dispatcher and the process reaper on shutdown. Every endpoint
 * lives in `routes/`, wired from `routes/index.ts`. Keeping the shell small is
 * what lets a new capability be added as one module plus one line.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const UI_DIST = path.join(REPO_ROOT, "ui", "dist");

const log = core.logger("api");
const PORT = Number(process.env.OSAMA_PORT ?? 5178);
const HOST = process.env.OSAMA_HOST ?? "127.0.0.1";

// ---------------------------------------------------------------------------
// SSE event bus
// ---------------------------------------------------------------------------

const clients = new Set<SseClient>();

function broadcast(type: string, data: unknown): void {
  noteActivity(type);
  const payload = `data: ${JSON.stringify({ type, data, ts: Date.now() })}\n\n`;
  for (const c of clients) {
    try {
      c.res.write(payload);
    } catch {
      clients.delete(c);
    }
  }
}

core.onLog((r) => broadcast("log", r));

// ---------------------------------------------------------------------------
// activity counters — fed by the SSE bus, read by the dashboard stats
// ---------------------------------------------------------------------------

const ACTIVITY = new Map<string, { count: number; lastTs: number | null }>();

function noteActivity(type: string): void {
  const cur = ACTIVITY.get(type) ?? { count: 0, lastTs: null };
  ACTIVITY.set(type, { count: cur.count + 1, lastTs: Date.now() });
}

function activitySnapshot(): Array<{ type: string; count: number; lastTs: number | null }> {
  return [...ACTIVITY.entries()]
    .map(([type, v]) => ({ type, count: v.count, lastTs: v.lastTs }))
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

const deps: RouteDeps = { broadcast, clients, uiDist: UI_DIST, activity: activitySnapshot };
const routes: Route[] = buildRoutes(deps);

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type,authorization",
    });
    return res.end();
  }

  if (!url.pathname.startsWith("/api/")) {
    if (serveStatic(res, UI_DIST, url.pathname)) return;
    return json(res, 404, { error: "not found" });
  }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    if (!r.pattern.test(url.pathname)) continue;
    try {
      await r.handler({ req, res, url });
    } catch (err) {
      if (!res.headersSent) fail(res, 500, err);
    }
    return;
  }
  json(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
});

server.listen(PORT, HOST, () => {
  log.info(`Osama engine API listening on http://${HOST}:${PORT}`);
  log.info(`UI bundle: ${fs.existsSync(UI_DIST) ? UI_DIST : "(not built yet — run `npm run build:ui`)"}`);
  log.info(`${routes.length} routes registered`);
});

// ---------------------------------------------------------------------------
// shutdown
// ---------------------------------------------------------------------------

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log.info(`received ${sig}, shutting down`);
    // Spawned children do not die with their parent — reap them, or the next
    // start leaks a llama-server still holding its port.
    const killed = core.killAllProcesses();
    if (killed) log.info(`killed ${killed} managed process(es)`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  });
}

// Same reap on an unhandled crash: a leaked server is worse than a fast exit.
process.on("exit", () => {
  try {
    core.killAllProcesses();
  } catch {
    /* nothing more we can do */
  }
});
