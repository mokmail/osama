import * as core from "@osama/core";
import { json, readBody, route, type RouteModule } from "../http.js";

/**
 * The SSE event stream.
 *
 * One connection per client, fanning out every mutation the server makes
 * (downloads, installs, process output, agent approvals/questions, skills).
 * The counters behind it (see the server entry) drive the dashboard's activity
 * panel, so this route owns both the transport and the tally that feeds it.
 */

const KEEPALIVE_MS = 15_000;

export const eventRoutes: RouteModule = (deps) => [
  route("GET", "/api/events", ({ req, res }) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });

    const client = { id: nextId++, res };
    deps.clients.add(client);
    res.write(`data: ${JSON.stringify({ type: "hello", data: { clientId: client.id }, ts: Date.now() })}\n\n`);

    // A comment frame every 15 s keeps proxies and the browser from dropping a
    // connection that has simply been quiet.
    const keepAlive = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* the close handler will clean up */
      }
    }, KEEPALIVE_MS);

    req.on("close", () => {
      clearInterval(keepAlive);
      deps.clients.delete(client);
    });
  }),

  /** Recent log records, for a client that connected after boot. */
  route("GET", "/api/logs", ({ res, url }) => {
    const limit = Number(url.searchParams.get("limit") ?? 200);
    json(res, 200, { records: core.recent(Number.isFinite(limit) ? limit : 200) });
  }),

  /** The engine's own version + uptime, handy for the About panel. */
  route("GET", "/api/engine/version", ({ res }) => {
    json(res, 200, { version: "0.2.0", uptimeMs: Math.round(process.uptime() * 1000), home: core.osamaHome() });
  }),
];

let nextId = 1;
