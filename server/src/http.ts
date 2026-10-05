import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { logger } from "@osama/core";

/**
 * The tiny HTTP toolkit the route modules share.
 *
 * Kept deliberately dependency-free: this is a localhost API for a desktop app,
 * so a framework would be more surface than it is worth. Everything the routes
 * need to agree on lives here — the JSON shape, the error shape, body reading
 * and the route matcher — so a fix lands once.
 */

const log = logger("http");

export interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
}

export type Handler = (ctx: Ctx) => Promise<void> | void;

/** One route: a method, a path pattern (`/api/models/:id`), and a handler. */
export interface Route {
  method: string;
  pattern: RegExp;
  /** The original pattern text, for diagnostics. */
  source: string;
  handler: Handler;
}

/** A module of routes: it declares what it needs, and returns what it adds. */
export type RouteModule = (deps: RouteDeps) => Route[];

/**
 * Everything a route module may depend on. Passed explicitly rather than
 * imported as globals so a module can be tested on its own and so the wiring
 * is visible in one place (`routes/index.ts`).
 */
export interface RouteDeps {
  /** Broadcast an event to every SSE subscriber. */
  broadcast: (type: string, data: unknown) => void;
  /** The live SSE clients, so a route can stream to one of them. */
  clients: Set<SseClient>;
  /** The directory the built UI is served from. */
  uiDist: string;
  /** SSE event counters for the dashboard (owned by the server core). */
  activity: () => Array<{ type: string; count: number; lastTs: number | null }>;
}

export interface SseClient {
  id: number;
  res: http.ServerResponse;
}

const MAX_BODY_BYTES = 64 * 1024 * 1024;

export function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "access-control-allow-origin": "*",
  });
  res.end(text);
}

export function fail(res: http.ServerResponse, status: number, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  log.error(`${status}: ${message}`);
  json(res, status, { error: message });
}

/**
 * Read and parse a JSON request body.
 *
 * Capped: without a limit a client can make the server buffer unbounded memory.
 * A malformed body yields `{}` rather than throwing, because every route
 * validates its own fields and a 400 from the handler carries a better message
 * than a generic parse error.
 */
export async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new Error(`request body exceeds ${Math.round(MAX_BODY_BYTES / 1024 / 1024)} MB`);
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** A query parameter, or undefined when absent (never the string "null"). */
export function q(url: URL, key: string): string | undefined {
  const v = url.searchParams.get(key);
  return v === null ? undefined : v;
}

/** The `:param` values of a matched route, in declaration order. */
export function params(route: Route, url: URL): string[] {
  const m = route.pattern.exec(url.pathname);
  return (m ?? []).slice(1).map((s) => decodeURIComponent(s ?? ""));
}

/** Build the matcher for a pattern such as `/api/models/:id/card`. */
export function compile(pattern: string): RegExp {
  return new RegExp("^" + pattern.replace(/:[A-Za-z0-9_]+/g, "([^/]+)").replace(/\//g, "\\/") + "$");
}

export function route(method: string, pattern: string, handler: Handler): Route {
  return { method, pattern: compile(pattern), source: pattern, handler };
}

export function sseOpen(res: http.ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
  });
}

export function sseSend(res: http.ServerResponse, event: unknown): void {
  try {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  } catch {
    /* client went away; the loop's abort will stop it */
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

/**
 * Serve a file from the built UI, with an SPA fallback.
 *
 * The containment check is `path.relative`, not `startsWith`: the old prefix
 * test let a sibling directory that merely *begins* with the same characters
 * (`ui/dist` vs `ui/dist-backup`) be served from outside the bundle.
 */
export function serveStatic(res: http.ServerResponse, uiDist: string, pathname: string): boolean {
  if (!fs.existsSync(uiDist)) return false;
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  // A NUL byte or a traversal segment in the decoded path is refused outright.
  if (rel.includes("\0")) return false;

  let file = path.resolve(uiDist, "." + (rel.startsWith("/") ? rel : `/${rel}`));
  const within = path.relative(path.resolve(uiDist), file);
  if (within.startsWith("..") || path.isAbsolute(within)) return false;

  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    // SPA fallback: an unknown path is a client route, not a missing asset.
    const index = path.join(uiDist, "index.html");
    if (!fs.existsSync(index)) return false;
    file = index;
  }
  const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  fs.createReadStream(file).pipe(res);
  return true;
}
