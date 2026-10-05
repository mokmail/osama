import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "@osama/core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const UI_DIST = path.join(REPO_ROOT, "ui", "dist");

const log = core.logger("api");
const PORT = Number(process.env.OSAMA_PORT ?? 5178);
const HOST = process.env.OSAMA_HOST ?? "127.0.0.1";

// ---------------------------------------------------------------------------
// SSE event bus
// ---------------------------------------------------------------------------

interface Client {
  id: number;
  res: http.ServerResponse;
}
const clients = new Set<Client>();
let nextClientId = 1;

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
// helpers
// ---------------------------------------------------------------------------

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "access-control-allow-origin": "*",
  });
  res.end(text);
}

function fail(res: http.ServerResponse, status: number, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  log.error(`${status}: ${message}`);
  json(res, status, { error: message });
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function q(url: URL, key: string): string | undefined {
  const v = url.searchParams.get(key);
  return v === null ? undefined : v;
}

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

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

function serveStatic(res: http.ServerResponse, pathname: string): boolean {
  if (!fs.existsSync(UI_DIST)) return false;
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  let file = path.join(UI_DIST, rel);
  if (!file.startsWith(UI_DIST)) return false;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    // SPA fallback
    file = path.join(UI_DIST, "index.html");
    if (!fs.existsSync(file)) return false;
  }
  const type = MIME[path.extname(file)] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  fs.createReadStream(file).pipe(res);
  return true;
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<void> | void;

const routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [];
function route(method: string, pattern: string, handler: Handler): void {
  // "/api/models/:id" -> /^\/api\/models\/([^/]+)$/
  const re = new RegExp(
    "^" + pattern.replace(/:[A-Za-z0-9_]+/g, "([^/]+)").replace(/\//g, "\\/") + "$",
  );
  routes.push({ method, pattern: re, handler });
}

// --- health / system -------------------------------------------------------

route("GET", "/api/health", (_req, res) => json(res, 200, { ok: true, version: "0.1.0", pid: process.pid }));

route("GET", "/api/system", async (_req, res) => {
  const gpu = await core.probeGpu();
  json(res, 200, {
    system: core.systemInfo(),
    gpu,
    accelerations: core.supportedAccelerations(),
    recommendedAcceleration: gpu.acceleration,
    paths: core.paths(),
  });
});

// --- stats (dashboard aggregate) -------------------------------------------

route("GET", "/api/stats", (_req, res) => json(res, 200, core.buildStats(activitySnapshot())));

route("GET", "/api/stats/series", (_req, res) => json(res, 200, { samples: core.getSeries() }));

core.startSeriesSampler(5000);

// --- engine ----------------------------------------------------------------

route("GET", "/api/engine", (_req, res) => {
  const engines = core.listInstalled();
  const active = core.getActiveEngine();
  json(res, 200, {
    engines,
    activeTag: active?.tag,
    active,
    knownTools: core.KNOWN_TOOLS,
  });
});

route("GET", "/api/engine/releases", async (_req, res, url) => {
  const limit = Number(q(url, "limit") ?? 8);
  json(res, 200, { releases: await core.listReleases(limit) });
});

route("GET", "/api/engine/plan", async (_req, res, url) => {
  const tag = q(url, "tag");
  const release = tag ? (await core.listReleases(30)).find((r) => r.tag === tag) : await core.latestRelease();
  if (!release) return fail(res, 404, new Error(`release ${tag} not found`));
  json(res, 200, {
    tag: release.tag,
    publishedAt: release.publishedAt,
    os: core.currentOs(),
    arch: core.currentArch(),
    variants: core.planForCurrentMachine(release),
  });
});

route("POST", "/api/engine/install", async (req, res) => {
  const body = await readBody(req);
  const acceleration = (body.acceleration ?? undefined) as core.Acceleration | undefined;
  // Run in the background; progress is streamed over /api/events.
  core
    .installEngine({
      tag: body.tag,
      acceleration,
      onProgress: (stage, p) => broadcast("install", { stage, progress: p }),
    })
    .then((engine) => broadcast("install", { stage: "installed", engine }))
    .catch((err) => broadcast("install", { stage: "error", error: String(err?.message ?? err) }));
  json(res, 202, { started: true });
});

route("POST", "/api/engine/activate", async (req, res) => {
  const body = await readBody(req);
  core.setActiveEngine(body.tag);
  json(res, 200, { ok: true, activeTag: body.tag });
});

route("DELETE", "/api/engine/:tag", (_req, res, url) => {
  const tag = decodeURIComponent(url.pathname.split("/").pop() ?? "");
  core.removeEngine(tag);
  json(res, 200, { ok: true });
});

// --- tools / commands ------------------------------------------------------

route("GET", "/api/tools", (_req, res) => {
  json(res, 200, { tools: core.allTools() });
});

route("POST", "/api/command/preview", async (req, res) => {
  const body = await readBody(req);
  const spec = core.toolSpec(body.tool);
  const argv = core.buildArgv(body.tool, body.values ?? {});
  json(res, 200, { binary: spec.binary, argv, command: core.renderCommand(spec.binary, argv) });
});

// --- one-shot tool runs ----------------------------------------------------

const RUNS = new Map<string, { id: string; tool: string; status: string; startedAt: number; result?: core.RunResult }>();

route("POST", "/api/run", async (req, res) => {
  const body = await readBody(req);
  const toolId = body.tool as core.ToolId;
  const spec = core.toolSpec(toolId);
  const argv = core.buildArgv(toolId, body.values ?? {});
  const binary = core.resolveTool(spec.binary);
  const runId = `run_${Date.now().toString(36)}`;
  broadcast("run", { id: runId, tool: toolId, stage: "start", command: core.renderCommand(spec.binary, argv) });
  core
    .runToCompletion(binary, argv, {
      cwd: body.cwd ?? core.paths().home,
      onLine: (line) => broadcast("run", { id: runId, tool: toolId, line }),
    })
    .then((result) => {
      broadcast("run", { id: runId, tool: toolId, stage: "done", result });
      RUNS.set(runId, { id: runId, tool: toolId, status: "done", startedAt: Date.now(), result });
    })
    .catch((err) => {
      broadcast("run", { id: runId, tool: toolId, stage: "error", error: String(err?.message ?? err) });
      RUNS.set(runId, { id: runId, tool: toolId, status: "error", startedAt: Date.now() });
    });
  json(res, 202, { runId, command: core.renderCommand(spec.binary, argv) });
});

// --- long-running processes ------------------------------------------------

route("POST", "/api/processes", async (req, res) => {
  const body = await readBody(req);
  const toolId = body.tool as core.ToolId;
  const spec = core.toolSpec(toolId);
  const values: core.ParamValues = { ...((body.values ?? {}) as core.ParamValues) };
  let port = Number(values.port ?? (spec.id === "rpc" ? 50052 : 8080));
  let host = String(values.host ?? "127.0.0.1");

  // A draft head (e.g. Qwen MTP) segfaults llama-server as the MAIN model — it
  // is only valid as a speculative-decoding --model-draft sidecar.
  if (spec.id === "server" && typeof values.model === "string") {
    const abs = path.resolve(String(values.model));
    const draft = core.listModels().find((m) => m.draftOnly && path.resolve(m.file) === abs);
    if (draft) {
      return fail(res, 422, new Error(
        `${path.basename(draft.file)} is a speculative-decoding draft head, not a main model — loading it directly crashes llama-server (SIGSEGV). Serve the full model and pass this file via the draft-model option instead.`,
      ));
    }
  }

  // Serving is exclusive: a server for another model steals the port and the
  // memory. When the request names the model it wants to serve, replace the
  // running one(s) — the UI asks for this explicitly.
  const exclusive = body.exclusive === true;
  let stopped: string[] = [];
  if (exclusive && (spec.id === "server" || spec.id === "rpc")) {
    stopped = await core.stopAllServers();
    if (stopped.length) await core.waitForPortFree(host, port, 6000);
  }

  // If the requested port is still taken (another app, or a server Osama does
  // not own), pick a free one instead of reporting a confusing bind failure.
  let reboundFrom: number | null = null;
  if ((spec.id === "server" || spec.id === "rpc") && !(await core.isPortFree(host, port))) {
    const alt = await core.findFreePort(host, port + 1);
    if (alt === null) {
      return fail(res, 409, new Error(`port ${port} on ${host} is in use and no free port was found nearby — pick another port`));
    }
    reboundFrom = port;
    port = alt;
    values.port = alt;
  }

  const argv = core.buildArgv(toolId, values);
  const binary = core.resolveTool(spec.binary);

  const info = core.startProcess({
    label: `${spec.title}${values.model ? " · " + path.basename(String(values.model)) : ""}`,
    tool: binary,
    argv,
    cwd: core.paths().home,
    url: spec.id === "server" ? `http://${host}:${port}` : spec.id === "rpc" ? `http://${host}:${Number(values.port ?? 50052)}` : undefined,
  });
  core.onProcessLine(info.id, (line) => broadcast("process", { id: info.id, line }));
  core.onProcessExit(info.id, (p) => broadcast("process", { id: info.id, stage: "exit", proc: p }));
  json(res, 201, {
    process: info,
    command: core.renderCommand(spec.binary, argv),
    ...(stopped.length ? { stopped } : {}),
    ...(reboundFrom !== null ? { reboundFrom } : {}),
  });
});

route("GET", "/api/processes", (_req, res) => json(res, 200, { processes: core.listProcesses() }));

route("GET", "/api/processes/:id/log", (_req, res, url) => {
  const id = decodeURIComponent(url.pathname.split("/")[3] ?? "");
  json(res, 200, { id, lines: core.processLog(id) });
});

route("POST", "/api/processes/prune", (_req, res) => {
  json(res, 200, { ok: true, pruned: core.pruneFinishedProcesses() });
});

route("POST", "/api/processes/:id/stop", async (_req, res, url) => {
  const id = decodeURIComponent(url.pathname.split("/")[3] ?? "");
  const ok = await core.stopProcess(id);
  json(res, 200, { ok });
});

// --- models ----------------------------------------------------------------

route("GET", "/api/models", (_req, res) => json(res, 200, { models: core.listModels() }));

route("POST", "/api/models/scan", (_req, res) => json(res, 200, { models: core.scanModelsDir() }));

route("POST", "/api/models/add", async (req, res) => {
  const body = await readBody(req);
  json(res, 200, { model: core.addModel({ file: body.file, repo: body.repo, name: body.name }) });
});

route("GET", "/api/models/:id/card", (_req, res, url) => {
  const id = decodeURIComponent(url.pathname.split("/")[3] ?? "");
  const m = core.getModel(id);
  if (!m) return fail(res, 404, new Error("model not found"));
  json(res, 200, { card: core.describeModel(m.file) });
});

route("DELETE", "/api/models/:id", (_req, res, url) => {
  const id = decodeURIComponent(url.pathname.split("/")[3] ?? "");
  const del = url.searchParams.get("deleteFile") === "true";
  core.removeModel(id, del);
  json(res, 200, { ok: true });
});

// --- hub -------------------------------------------------------------------

// The hub routes keep their names for the existing UI, now multi-source.
// `source` narrows to one hub (default: all of them).


/** SourceModel -> HubModel for the UI (adds id = ref so the UI can open repos). */
function toHubModel(m: core.SourceModel): HubModelUI {
  return {
    ...m,
    id: m.ref,
    name: m.name,
    instruct: /instruct|chat|-it\b|it$/i.test(m.ref) || m.tags.some((t) => /instruct|chat|conversational/i.test(t)),
  };
}
interface HubModelUI extends core.SourceModel {
  id: string;
  instruct: boolean;
}

route("GET", "/api/hub/search", async (_req, res, url) => {
  const query = q(url, "q") ?? "";
  const limit = Number(q(url, "limit") ?? 30);
  const sort = q(url, "sort") ?? "downloads";
  const source = (q(url, "source") ?? "");
  if (source === "huggingface") return json(res, 200, { models: await core.searchModels(query, { limit, sort }), errors: [] });
  if (source === "url") return json(res, 200, { models: [], errors: [] });
  const all = await core.searchAllSources(query, { limit, sort });
  const filtered = source && source !== "all" ? all.models.filter((m) => m.source === source) : all.models;
  json(res, 200, { models: filtered.map(toHubModel), errors: source && source !== "all" ? [] : all.errors });
});

route("GET", "/api/hub/trending", async (_req, res, url) => {
  const limit = Number(q(url, "limit") ?? 24);
  const source = (q(url, "source") ?? "");
  if (source === "huggingface") return json(res, 200, { models: await core.trendingModels(limit), errors: [] });
  const all = await core.trendingAllSources(limit);
  const filtered = source && source !== "all" ? all.models.filter((m) => m.source === source) : all.models;
  json(res, 200, { models: filtered.map(toHubModel), errors: source && source !== "all" ? [] : all.errors });
});

route("GET", "/api/hub/sources", (_req, res) => {
  json(res, 200, { sources: core.SOURCES });
});

// `/api/hub/repo?source=` defaults to huggingface; ref decides everything else.
route("GET", "/api/hub/repo", async (_req, res, url) => {
  const repo = q(url, "repo");
  if (!repo) return fail(res, 400, new Error("repo is required"));
  const source = (q(url, "source") ?? "huggingface") as core.SourceId;
  try {
    // "url" refs are direct gguf links
    const src: core.SourceId = source === "url" || /^https?:\/\//.test(repo) ? "url" : source;
    const r = await core.repoFilesAny(src, repo);
    json(res, 200, { ...r, id: r.ref });
  } catch (e) {
    return fail(res, 502, e as Error);
  }
});

// --- downloads -------------------------------------------------------------

route("GET", "/api/downloads", (_req, res) => json(res, 200, { downloads: core.listDownloads() }));

route("POST", "/api/downloads", async (req, res) => {
  const body = await readBody(req);
  const id = `d_${Date.now().toString(36)}`;
  broadcast("download", { id, repo: body.repo, file: body.file, stage: "start" });
  core
    .downloadModel({
      repo: body.repo,
      file: body.file,
      source: body.source ?? "huggingface",
      name: body.name,
      onProgress: (rec) =>
        broadcast("download", {
          id,
          repo: rec.repo,
          file: rec.file,
          stage: rec.status,
          received: rec.received,
          total: rec.total,
        }),
    })
    .then((model) => broadcast("download", { id, repo: body.repo, file: body.file, stage: "done", model }))
    .catch((err) => broadcast("download", { id, repo: body.repo, file: body.file, stage: "error", error: String(err?.message ?? err) }));
  json(res, 202, { id });
});

route("POST", "/api/downloads/:id/cancel", (_req, res, url) => {
  const id = decodeURIComponent(url.pathname.split("/")[3] ?? "");
  core.cancelDownload(id);
  json(res, 200, { ok: true });
});

// --- chat proxy (avoid CORS to the llama-server web UI) --------------------

route("POST", "/api/chat", async (req, res) => {
  const body = await readBody(req);
  const base = String(body.baseUrl ?? "http://127.0.0.1:8080");
  const apiKey = body.apiKey ? String(body.apiKey) : undefined;
  const payload = body.payload ?? body;
  const upstream = await fetch(`${base.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    // Upstream errors are JSON ({error:{message}}) — unwrap so the toast is a
    // sentence, not a JSON blob.
    let msg = text || upstream.statusText;
    try {
      const p1 = JSON.parse(text);
      msg = p1?.error?.message ?? p1?.error ?? p1?.message ?? text;
    } catch { /* plain text error body is fine */ }
    return fail(res, upstream.status, new Error(String(msg).slice(0, 400)));
  }
  res.writeHead(200, {
    "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
    "cache-control": "no-cache",
    "access-control-allow-origin": "*",
  });
  const reader = upstream.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
});

route("GET", "/api/server/health", async (_req, res, url) => {
  const base = q(url, "baseUrl") ?? "http://127.0.0.1:8080";
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2500) });
    json(res, 200, { ok: r.ok, status: r.status, body: await r.text().catch(() => "") });
  } catch (err) {
    json(res, 200, { ok: false, error: String((err as Error).message) });
  }
});

route("GET", "/api/server/props", async (_req, res, url) => {
  const base = q(url, "baseUrl") ?? "http://127.0.0.1:8080";
  try {
    const r = await fetch(`${base}/props`, { signal: AbortSignal.timeout(2500) });
    json(res, 200, { ok: r.ok, props: await r.json().catch(() => null) });
  } catch (err) {
    json(res, 200, { ok: false, error: String((err as Error).message) });
  }
});

route("GET", "/api/server/metrics", async (_req, res, url) => {
  const base = (q(url, "baseUrl") ?? "http://127.0.0.1:8080").replace(/\/$/, "");
  const out: Record<string, unknown> = { up: false, url: base };
  try {
    const [mRes, pRes] = await Promise.all([
      fetch(`${base}/metrics`, { signal: AbortSignal.timeout(2500) }),
      fetch(`${base}/props`, { signal: AbortSignal.timeout(2500) }),
    ]);
    if (!mRes.ok) throw new Error(`/metrics HTTP ${mRes.status}`);
    out.up = true;

    // Prometheus text format: `llamacpp:name value` (labels are not used here).
    const text = await mRes.text();
    const m = new Map<string, number>();
    for (const line of text.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const sp = line.lastIndexOf(" ");
      if (sp < 0) continue;
      const key = line.slice(0, sp).trim();
      const val = Number(line.slice(sp + 1));
      if (Number.isFinite(val)) m.set(key, val);
    }
    const num = (k: string): number | undefined => m.get(`llamacpp:${k}`);
    out.promptTokensTotal = num("prompt_tokens_total");
    out.tokensPredictedTotal = num("tokens_predicted_total");
    out.promptTps = num("prompt_tokens_seconds");
    out.predictedTps = num("predicted_tokens_seconds");
    out.requestsProcessing = num("requests_processing");
    out.requestsDeferred = num("requests_deferred");
    out.nDecodeTotal = num("n_decode_total");
    out.nTokensMax = num("n_tokens_max");
    const cached = num("prompt_tokens_cached_total") ?? 0;
    const prompt = out.promptTokensTotal as number | undefined;
    out.cacheReusePct =
      prompt && prompt + cached > 0 ? Math.round((cached / (prompt + cached)) * 100) : null;

    if (pRes.ok) {
      const props: any = await pRes.json().catch(() => null);
      if (props) {
        out.model = props.model_alias ?? props.model_path;
        out.ftype = props.model_ftype;
        out.build = props.build_info;
        out.slots = props.total_slots;
        out.nCtx = props.default_generation_settings?.n_ctx ?? props.n_ctx;
      }
    }
  } catch (err) {
    out.error = String((err as Error).message);
  }
  json(res, 200, out);
});

// --- events (SSE) ----------------------------------------------------------

route("GET", "/api/events", (req, res) => {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
  });
  res.write(`data: ${JSON.stringify({ type: "hello", data: { clientId: nextClientId }, ts: Date.now() })}\n\n`);
  const client: Client = { id: nextClientId++, res };
  clients.add(client);
  const keepAlive = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* ignore */
    }
  }, 15000);
  req.on("close", () => {
    clearInterval(keepAlive);
    clients.delete(client);
  });
});

// --- agentic mode: tools, approvals, the loop over SSE ---------------------
//
// Two endpoints. `GET /api/agent/tools` lets the UI show what the model may do.
// `POST /api/agent` runs one turn: it proxies to llama-server, executes the
// tool calls the model asks for, and streams every step as SSE. A mutating
// command parks the loop on a promise until the user answers on
// `POST /api/agent/approve/:id`, so approval is enforced server-side and a
// client that never answers simply times out into a denial.

const TOOL_TIMEOUT_MS = 120_000;
const APPROVAL_TIMEOUT_MS = 120_000;

/**
 * Where the agent's relative paths resolve. This is the user's chosen
 * workspace, never a bare home directory — a turn that defaulted to `$HOME`
 * could read and write anything the user owns.
 */
function agentWorkspace(): string {
  const ws = core.getWorkspace();
  try {
    fs.mkdirSync(ws, { recursive: true });
  } catch {
    /* the tools report a missing workspace themselves */
  }
  return ws;
}

interface PendingApproval {
  resolve: (allow: boolean) => void;
  timer: NodeJS.Timeout;
}
const pendingApprovals = new Map<string, PendingApproval>();

/**
 * Ask the user to approve a command. Parks the loop on a promise; the answer
 * arrives on `POST /api/agent/approve/:id`, or the request times out into a
 * denial so an unattended agent cannot run commands by default.
 */
function requestApproval(
  areq: { command: string; cwd: string },
  mode: "ask" | "auto",
  res: http.ServerResponse,
  signal: AbortSignal,
): Promise<boolean> {
  if (mode === "auto") return Promise.resolve(true);

  const id = `ap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const payload = { id, command: areq.command, cwd: areq.cwd, timeoutMs: APPROVAL_TIMEOUT_MS };
  broadcast("agent_approval", payload);
  sseSend(res, { type: "approval_request", ...payload });

  return new Promise<boolean>((resolve) => {
    // `finish` owns the cleanup so it is identical however it is reached — the
    // route, the timeout, or an abort. The route only calls `pending.resolve`.
    const finish = (allow: boolean): void => {
      pendingApprovals.delete(id);
      clearTimeout(timer);
      resolve(allow);
    };
    const timer = setTimeout(() => finish(false), APPROVAL_TIMEOUT_MS);
    pendingApprovals.set(id, { resolve: finish, timer });
    // A turn that was cancelled while parked must not wait out the timeout.
    if (signal.aborted) finish(false);
    else signal.addEventListener("abort", () => finish(false), { once: true });
  });
}

/**
 * Adapt llama-server's OpenAI-compatible SSE into agent `ModelChunk`s. Keeping
 * this in the server means core/agent.ts stays free of HTTP and is testable
 * without a model.
 */
function openaiTransport(ctx: { base: string; apiKey?: string }): core.AgentTransport {
  return async function* transport(payload) {
    const upstream = await fetch(`${ctx.base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(ctx.apiKey ? { authorization: `Bearer ${ctx.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: payload.model,
        messages: payload.messages,
        tools: payload.tools,
        tool_choice: "auto",
        stream: true,
        temperature: payload.temperature,
        top_p: payload.top_p,
        max_tokens: payload.max_tokens,
      }),
      signal: payload.signal,
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      throw new Error(text.slice(0, 400) || `upstream HTTP ${upstream.status}`);
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") return;
        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        if (parsed.error) {
          // llama.cpp sends {"error":{code,message}} with HTTP 200 on context
          // overflow — converting it here means the agent loop reports the
          // real cause instead of ending with an empty answer.
          const m = parsed.error.message ?? JSON.stringify(parsed.error);
          throw new Error(`Model error: ${String(m).slice(0, 300)}`);
        }
        const choice = parsed.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        const chunk: core.ModelChunk = {};
        if (typeof delta.content === "string" && delta.content) chunk.content = delta.content;
        if (Array.isArray(delta.tool_calls)) {
          chunk.toolCalls = delta.tool_calls.map((tc: any) => ({
            index: Number(tc.index ?? 0),
            id: tc.id,
            name: tc.function?.name,
            argumentsDelta: tc.function?.arguments,
          }));
        }
        if (choice.finish_reason) chunk.finishReason = String(choice.finish_reason);
        if (chunk.content || chunk.toolCalls || chunk.finishReason) yield chunk;
      }
    }
  };
}

function sseOpen(res: http.ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
  });
}

function sseSend(res: http.ServerResponse, event: unknown): void {
  try {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  } catch {
    /* client went away; the loop's abort will stop it */
  }
}

// --- scheduler runtime: fire jobs and tick the due list --------------------
//
// Jobs run against whatever server the chat uses (the same baseUrl), so the
// model + transport + approval policy are identical — a scheduled job is just
// a chat turn with no human typing.

let schedulerModel = "local";
let schedulerBase = "http://127.0.0.1:8080";
let schedulerApiKey = "";

route("GET", "/api/scheduler/config", (_req, res) => {
  json(res, 200, {
    baseUrl: schedulerBase,
    model: schedulerModel,
    apiKey: schedulerApiKey ? "***" : "",
    intervalMs: core.TICK_MS,
  });
});

route("POST", "/api/scheduler/config", async (req, res) => {
  const body = await readBody(req);
  if (typeof body.baseUrl === "string" && body.baseUrl.trim()) schedulerBase = body.baseUrl.trim().replace(/\/$/, "");
  if (typeof body.model === "string" && body.model.trim()) schedulerModel = body.model.trim();
  if (typeof body.apiKey === "string") schedulerApiKey = body.apiKey;
  json(res, 200, { ok: true, baseUrl: schedulerBase, model: schedulerModel, apiKey: schedulerApiKey ? "***" : "" });
});

/** Construct a transport that targets the user-configured scheduler backend. */
function schedulerTransport(): core.AgentTransport {
  return openaiTransport({ base: schedulerBase, apiKey: schedulerApiKey });
}

/** Approval policy: scheduled jobs never block on the user — auto/ask/deny per-job governs. */
function schedulerApproval(job: core.ScheduledJob): core.ApprovalPolicy {
  if (job.approval === "auto") return { approve: async () => true };
  if (job.approval === "deny") return { approve: async () => false };
  // 'ask' falls back to auto in unattended runs (no user attached). Real-time
  // "run now" still has the UI to ask; the scheduler tick does not.
  return { approve: async () => false };
}

/** Fire a single job synchronously, return the record. Server-side helper. */
async function fireJob(id: string): Promise<core.JobRun | null> {
  const job = core.getJob(id);
  if (!job) return null;
  return core.fireOne({
    jobId: id,
    transport: schedulerTransport(),
    model: schedulerModel,
    workspace: agentWorkspace(),
    approve: schedulerApproval(job),
  });
}

/** Periodic tick: every TICK_MS, fire any due jobs (sequentially). */
const schedulerTimer = setInterval(async () => {
  try {
    const jobs = core.dueJobs();
    if (!jobs.length) return;
    for (const j of jobs) {
      // Mark 'running' via a transient override so two ticks never fire the same job.
      core.updateJob(j.id, { enabled: false });
      core.updateJob(j.id, { enabled: true });
      const run = await fireJob(j.id);
      if (run) broadcast("scheduler_run", { jobId: j.id, name: j.name, run });
    }
  } catch (e) {
    broadcast("scheduler_error", { message: (e as Error).message });
  }
}, core.TICK_MS);
schedulerTimer.unref?.();

route("GET", "/api/agent/tools", (_req, res) => {
  json(res, 200, {
    tools: core.AGENT_TOOLS,
    readRoots: core.readRoots(),
    writableRoots: core.writableRoots(),
    workspace: core.getWorkspace(),
  });
});

// --- the workspaces the agent may work inside ------------------------------
//
// Agentic mode runs real tools, so which directory they act on is the user's
// call. Picking one widens the path jail to include it and persists the choice.

route("GET", "/api/workspaces", (_req, res) => {
  json(res, 200, {
    current: core.getWorkspace(),
    chosen: core.workspaceChosen(),
    default: core.defaultWorkspace(),
    candidates: core.workspaceCandidates(),
    readRoots: core.readRoots(),
    writableRoots: core.writableRoots(),
  });
});

route("POST", "/api/workspaces", async (req, res) => {
  const body = await readBody(req);
  const dir = String(body.path ?? "").trim();
  if (!dir) return fail(res, 400, new Error("path is required"));
  const r = core.setWorkspace(dir, { create: body.create !== false });
  if (!r.ok) return fail(res, 400, new Error(r.error ?? "could not use that folder"));
  broadcast("workspace", { path: r.path });
  log.info(`agent workspace set to ${r.path}${r.created ? " (created)" : ""}`);
  json(res, 200, { ok: true, path: r.path, created: r.created, readRoots: core.readRoots(), writableRoots: core.writableRoots() });
});

// The directory browser behind the workspace picker: subdirectories of any
// readable folder, so the user can navigate to theirs instead of typing it.
route("GET", "/api/browse", (_req, res, url) => {
  const r = core.browseDirectories(q(url, "path") ?? core.getWorkspace());
  if (!r.ok) return fail(res, 400, new Error(r.error ?? "cannot list that folder"));
  json(res, 200, { path: r.path, parent: r.parent ?? null, home: r.home ?? null, entries: r.entries ?? [] });
});

// --- workspace files: the composer's `@`-mention picker --------------------
//
// The chat composer can reference a file inside the agent workspace by typing
// `@`. These two routes back that picker: one lists the workspace's files, the
// other inlines the chosen one so it ships as a normal text attachment.

route("GET", "/api/workspace/files", (_req, res, url) => {
  const max = Number(q(url, "max") ?? 2000);
  const r = core.listWorkspaceFiles(Number.isFinite(max) ? max : 2000);
  json(res, 200, r);
});

route("GET", "/api/workspace/file", (_req, res, url) => {
  const rel = q(url, "path");
  if (!rel) return fail(res, 400, new Error("path is required"));
  const r = core.readWorkspaceFile(rel);
  if (!r.ok) return fail(res, 400, new Error(r.error));
  json(res, 200, r);
});

// --- skill store: install skills from skills.sh / GitHub --------------------
//
// The ecosystem ships skills as SKILL.md bundles in GitHub repos (skills.sh is
// the directory). These routes resolve a source to the skills inside it and
// copy the chosen one into .osama/skills, which the catalog scans.

route("GET", "/api/skills/store", async (_req, res, url) => {
  const source = q(url, "source");
  if (!source) return fail(res, 400, new Error("source is required — try owner/repo or a skills.sh link"));
  try {
    const parsed = core.parseSkillSource(source);
    const skills = await core.listRemoteSkills(parsed);
    json(res, 200, { owner: parsed.owner, repo: parsed.repo, ref: parsed.ref ?? null, skills });
  } catch (e) {
    fail(res, 400, e);
  }
});

route("POST", "/api/skills/install", async (req, res) => {
  const body = await readBody(req);
  try {
    const parsed = core.parseSkillSource(String(body.source ?? ""));
    const skillPath = String(body.skill ?? "").trim();
    if (!skillPath && body.skill !== "") return fail(res, 400, new Error("skill path is required"));
    const installed = await core.installRemoteSkill(parsed, skillPath);
    broadcast("skill", { stage: "installed", id: installed.id, name: installed.name });
    log.info(`installed skill ${installed.id} from ${parsed.owner}/${parsed.repo} (${installed.files.length} file(s))`);
    json(res, 200, { ok: true, skill: installed, skills: core.discoverSkills(core.skillRoots()) });
  } catch (e) {
    fail(res, 400, e);
  }
});

route("POST", "/api/skills/remove", async (req, res) => {
  const body = await readBody(req);
  const id = String(body.id ?? "").trim();
  if (!id) return fail(res, 400, new Error("id is required"));
  const r = core.removeInstalledSkill(id);
  if (!r.ok) return fail(res, 400, new Error(r.error ?? "could not remove"));
  broadcast("skill", { stage: "removed", id });
  log.info(`removed skill ${id}`);
  json(res, 200, { ok: true, skills: core.discoverSkills(core.skillRoots()) });
});

// --- PDF text extraction for chat attachments -------------------------------
//
// The chat refuses binary attachments, and a PDF is binary on the wire but
// text inside. The UI posts the raw bytes here and gets back the extracted
// text (page-marked), which it inlines like any other text attachment.

route("POST", "/api/extract/pdf", async (req, res) => {
  const chunks: Buffer[] = [];
  let total = 0;
  const cap = 64 * 1024 * 1024;
  try {
    for await (const c of req) {
      total += (c as Buffer).length;
      if (total > cap) return fail(res, 400, new Error("PDF is larger than 64 MB"));
      chunks.push(c as Buffer);
    }
  } catch {
    return fail(res, 400, new Error("could not read the upload"));
  }
  const body = Buffer.concat(chunks);

  // Two shapes accepted: raw bytes (content-type: application/pdf) or a JSON
  // envelope { data: base64 } from clients that cannot send binary bodies.
  let pdf: Buffer = body;
  const ct = String(req.headers["content-type"] ?? "");
  if (ct.includes("application/json")) {
    try {
      const parsed = JSON.parse(body.toString("utf8")) as { data?: string };
      if (!parsed.data) return fail(res, 400, new Error("data (base64) is required"));
      pdf = Buffer.from(parsed.data, "base64");
    } catch {
      return fail(res, 400, new Error("invalid JSON body"));
    }
  }

  const r = await core.extractPdfText(pdf);
  if (!r.ok) return fail(res, 400, new Error(r.error ?? "could not read the PDF"));
  json(res, 200, { ok: true, text: r.text, pages: r.pages, scanned: r.scanned ?? false, truncated: r.truncated ?? false });
});

// --- context, memory and skills introspection ------------------------------
//
// The agent can call these as tools; the UI reads them directly so the user can
// see the same numbers without spending a model turn.

/** The running server the UI is aimed at, for measuring against. */
function agentBase(url: URL | null, fallback = "http://127.0.0.1:8080"): string {
  const fromQuery = url ? q(url, "baseUrl") : null;
  return (fromQuery ?? fallback).replace(/\/$/, "");
}

route("GET", "/api/agent/context", async (_req, res, url) => {
  const base = agentBase(url);
  const meter = core.createMeter(base);
  const messages = (() => {
    try {
      const raw = q(url, "messages");
      return raw ? (JSON.parse(raw) as core.ChatMessage[]) : [];
    } catch {
      return [];
    }
  })();
  const b = await core.measureContext(meter, messages, q(url, "tools") === "1" ? core.toolSchemas() : []);
  json(res, 200, { ...b, baseUrl: base, toolSupport: await toolSupportOf(base) });
});

/**
 * Measure a conversation that is too long to fit in a query string. The UI uses
 * this: a real transcript with attachments blows past any URL length limit, and
 * a truncated measurement is worse than none.
 */
route("POST", "/api/agent/context", async (req, res) => {
  const body = await readBody(req);
  const base = String(body.baseUrl ?? "http://127.0.0.1:8080").replace(/\/$/, "");
  const messages = Array.isArray(body.messages) ? (body.messages as core.ChatMessage[]) : [];
  const meter = core.createMeter(base);
  const b = await core.measureContext(meter, messages, body.tools === false ? [] : core.toolSchemas());
  json(res, 200, { ...b, baseUrl: base, toolSupport: await toolSupportOf(base) });
});

/** Cached per server URL: the template cannot change without a restart. */
const toolSupportCache = new Map<string, core.ToolSupport>();
async function toolSupportOf(base: string): Promise<core.ToolSupport> {
  const hit = toolSupportCache.get(base);
  if (hit) return hit;
  try {
    const r = await fetch(`${base}/props`, { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const p: any = await r.json();
      const support = core.detectToolSupport(p?.chat_template);
      toolSupportCache.set(base, support);
      return support;
    }
  } catch {
    /* server absent — fall through */
  }
  return "unknown";
}

route("GET", "/api/agent/skills", (_req, res) => {
  const skills = core.discoverSkills();
  json(res, 200, { skills, roots: core.skillRoots() });
});

route("GET", "/api/agent/memory", (_req, res) => {
  const s = core.memoryStats();
  json(res, 200, {
    entries: core.listMemory(),
    block: core.memoryBlock(),
    stats: s,
    budgets: s.budget,
    used: s.chars,
  });
});

route("POST", "/api/agent/memory/forget", async (req, res) => {
  const body = await readBody(req);
  const r = core.forgetMemory(String(body.selector ?? ""));
  json(res, 200, { ok: r.ok, removed: r.removed });
});

/** Manual save from the memory modal (the agent's save_memory tool uses the same store). */
route("POST", "/api/agent/memory/save", async (req, res) => {
  const body = await readBody(req);
  const scope = body.scope === "workspace" ? "workspace" : "global";
  const tags = Array.isArray(body.tags) ? body.tags.map(String) : [];
  const r = core.saveMemory(String(body.text ?? ""), scope, tags);
  if (!r.ok) return fail(res, 400, new Error(r.error ?? "could not save"));
  json(res, 200, { ok: true, entry: r.entry, used: r.used, budget: r.budget });
});

/** The live task list. Sent whole, like dsh's todo/write snapshot. */
let agentTodos: core.TodoItem[] = [];
route("GET", "/api/agent/todos", (_req, res) => {
  json(res, 200, { todos: agentTodos });
});

// --- artifacts: files the agent produced, newest first ---------------------

route("GET", "/api/agent/artifacts", (_req, res) => {
  const out: Array<{ file: string; op: string; at: string; sessionId: string }> = [];
  for (const s of core.listSessions()) {
    const rec = core.readSession(s.id);
    if (!rec) continue;
    for (const e of rec.events) {
      if (e.kind !== "artifact" || !e.data.file) continue;
      out.push({
        file: String(e.data.file),
        op: String(e.data.op ?? "write"),
        at: new Date(e.ts).toISOString(),
        sessionId: rec.id,
      });
    }
  }
  out.sort((a, b) => (b.at > a.at ? 1 : -1));
  json(res, 200, { artifacts: out.slice(0, 50) });
});

// --- durable sessions ------------------------------------------------------

route("GET", "/api/sessions", (_req, res) => {
  json(res, 200, { sessions: core.listSessions() });
});

route("GET", "/api/sessions/:id", (req, res, url) => {
  const id = decodeURIComponent(url.pathname.split("/")[3] ?? "");
  const rec = core.readSession(id);
  if (!rec) return fail(res, 404, new Error("no such session"));
  json(res, 200, { session: rec });
});

route("DELETE", "/api/sessions/:id", (req, res, url) => {
  const id = decodeURIComponent(url.pathname.split("/")[3] ?? "");
  json(res, 200, { ok: core.deleteSession(id) });
});

// --- scheduler / cronjobs --------------------------------------------------

route("GET", "/api/scheduler/jobs", (_req, res) => {
  json(res, 200, { jobs: core.listJobs() });
});

route("POST", "/api/scheduler/jobs", async (req, res) => {
  const body = await readBody(req);
  const r = core.createJob({
    name: String(body.name ?? "").trim(),
    prompt: String(body.prompt ?? "").trim(),
    intervalMin: Math.max(core.MIN_INTERVAL_MIN, Math.floor(Number(body.intervalMin ?? 0) || 0)),
    approval: (body.approval === "ask" || body.approval === "auto" || body.approval === "deny") ? body.approval : "auto",
    tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
  });
  if (!r.ok || !r.job) return fail(res, 400, new Error(r.error ?? "could not create job"));
  json(res, 201, { job: r.job });
});

route("PATCH", "/api/scheduler/jobs/:id", async (req, res, url) => {
  const id = decodeURIComponent(url.pathname.split("/")[4] ?? "");
  const body = await readBody(req);
  const patch: core.UpdateJobInput = {};
  if (typeof body.name === "string") patch.name = body.name;
  if (typeof body.prompt === "string") patch.prompt = body.prompt;
  if (typeof body.intervalMin === "number") patch.intervalMin = body.intervalMin;
  if (body.approval === "ask" || body.approval === "auto" || body.approval === "deny") patch.approval = body.approval;
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (Array.isArray(body.tags)) patch.tags = body.tags.map(String);
  const r = core.updateJob(id, patch);
  if (!r.ok || !r.job) return fail(res, 400, new Error(r.error ?? "could not update job"));
  json(res, 200, { job: r.job });
});

route("DELETE", "/api/scheduler/jobs/:id", (_req, res, url) => {
  const id = decodeURIComponent(url.pathname.split("/")[4] ?? "");
  const job = core.getJob(id);
  if (!job) return fail(res, 404, new Error("no such job"));
  json(res, 200, { ok: core.deleteJob(id) });
});

route("POST", "/api/scheduler/jobs/:id/run", async (req, res, url) => {
  const id = decodeURIComponent(url.pathname.split("/")[4] ?? "");
  // Fire immediately against the running model; the response is the run record.
  const run = await fireJob(id);
  if (!run) return fail(res, 404, new Error("no such job"));
  json(res, 200, { run });
});

route("GET", "/api/scheduler/jobs/:id/history", (_req, res, url) => {
  const id = decodeURIComponent(url.pathname.split("/")[4] ?? "");
  const job = core.getJob(id);
  if (!job) return fail(res, 404, new Error("no such job"));
  json(res, 200, { runs: job.history });
});

/** Parked ask_user_question calls, answered by POST /api/agent/answer/:id. */
interface PendingQuestion extends core.PendingQuestion {
  resolve: (text: string | null) => void;
  timer: NodeJS.Timeout;
  res: http.ServerResponse;
}
const pendingQuestions = new Map<string, PendingQuestion>();

route("POST", "/api/agent/answer/:id", async (req, res, url) => {
  const id = decodeURIComponent(url.pathname.split("/")[4] ?? "");
  const body = await readBody(req);
  const q = pendingQuestions.get(id);
  if (!q) return fail(res, 404, new Error("no pending question with that id"));
  // single cleanup site, same pattern that fixed the approval double-delete
  clearTimeout(q.timer);
  pendingQuestions.delete(id);
  q.resolve(String(body.answer ?? "").trim() || "(no answer given)");
  json(res, 200, { ok: true });
});

route("POST", "/api/agent", async (req, res) => {
  const body = await readBody(req);
  const base = String(body.baseUrl ?? "http://127.0.0.1:8080").replace(/\/$/, "");
  const model = String(body.model ?? "local");
  const apiKey = body.apiKey ? String(body.apiKey) : undefined;
  const history = Array.isArray(body.messages) ? body.messages : [];
  const approvalMode = body.approval === "auto" ? "auto" : "ask";
  const workspace = agentWorkspace();

  if (!history.length) return fail(res, 400, new Error("messages is required"));

  // Abort the loop when the browser disconnects, so tools stop immediately.
  // Must be `res`, not `req`: `req` emits "close" as soon as the request body
  // has been read, which would abort the turn before it ever runs.
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });

  const approval = {
    approve: (areq: { command: string; cwd: string }) => requestApproval(areq, approvalMode, res, ac.signal),
  };

  // Mid-turn steering: notes POSTed to /api/agent/steer/:turn are drained
  // between the loop's steps. Registered BEFORE sseOpen so a note that
  // arrives during the first model call is not lost.
  const turnId = `t${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const steer = core.createSteerQueue();
  activeSteers.set(turnId, steer);

  sseOpen(res);
  sseSend(res, { type: "turn", id: turnId });
  try {
    agentTodos = [];
    // one durable session per turn
    const sessionId = core.newSessionId();
    appendUserMessage(sessionId, workspace, history, body.system);

    for await (const ev of core.runAgent({
      transport: openaiTransport({ base, apiKey }),
      model,
      history,
      system: typeof body.system === "string" ? body.system : undefined,
      workspace,
      maxSteps: Number.isFinite(body.maxSteps) ? Number(body.maxSteps) : undefined,
      approval,
      signal: ac.signal,
      temperature: typeof body.temperature === "number" ? body.temperature : undefined,
      top_p: typeof body.top_p === "number" ? body.top_p : undefined,
      max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : undefined,
      // The context tools measure against the server this turn actually uses.
      meter: core.createMeter(base),
      injectMemory: body.memory !== false,
      injectSkills: body.skills !== false,
      // Skills the user switched on in the composer — injected inline.
      activeSkills: Array.isArray(body.activeSkills) ? body.activeSkills.map(String).slice(0, 12) : undefined,
      todos: agentTodos,
      sessionId,
      askUser: (q, timeoutMs) => askTheUser(q, timeoutMs, res, ac.signal),
      web: { search: webSearch, fetch: webFetch },
      steer,
      allowDelegate: body.delegate !== false && approvalMode === "auto",
      compactApprove: async (info) => {
        // Same approval UX as commands: park the loop on a promise.
        return requestApproval({ command: `compact ${info.older} older message(s)`, cwd: workspace }, approvalMode, res, ac.signal);
      },
    })) {
      sseSend(res, ev);
      // The task list changed — let the UI update without another round-trip.
      if (ev.type === "tool_result" && ev.name === "write_todo") {
        core.appendEvents(sessionId, workspace, [{ kind: "todo", data: { todos: agentTodos } }]);
        sseSend(res, { type: "todos", todos: agentTodos });
      }
      if (ev.type === "final" || ev.type === "error") break;
    }
  } catch (e) {
    sseSend(res, { type: "error", message: String((e as Error).message) });
  } finally {
    activeSteers.delete(turnId);
  }
  res.end();
});

/** Live turns that accept steering notes (Hermes-style mid-run course correction). */
const activeSteers = new Map<string, core.SteerQueue>();
route("POST", "/api/agent/steer/:id", async (req, res, url) => {
  const id = decodeURIComponent(url.pathname.split("/")[4] ?? "");
  const q = activeSteers.get(id);
  if (!q) return fail(res, 404, new Error("no running turn with that id — it may have finished"));
  const body = await readBody(req);
  const text = String(body.text ?? "").trim();
  if (!text) return fail(res, 400, new Error("text is required"));
  q.push(text);
  json(res, 200, { ok: true, queued: q.size });
});

/** Persist the user side of the turn so session_search can find it later. */
function appendUserMessage(sessionId: string, workspace: string, history: Array<{ role: string; content: unknown }>, system: unknown): void {
  const last = history[history.length - 1];
  if (!last || last.role !== "user") return;
  const preview = typeof last.content === "string" ? last.content : JSON.stringify(last.content ?? "");
  core.appendEvents(sessionId, workspace, [
    { kind: "message", data: { role: "user", preview: preview.slice(0, 2000), system: Boolean(system) } },
  ]);
}

/**
 * ask_user_question: parks the loop the same way an approval does, pushes the
 * question over SSE and the event bus, and returns the user's answer.
 */
function askTheUser(q: core.PendingQuestion, timeoutMs: number, res: http.ServerResponse, signal: AbortSignal): Promise<string | null> {
  const finish = (owner: PendingQuestion | undefined, answer: string | null): void => {
    if (!owner) return;
    clearTimeout(owner.timer);
    pendingQuestions.delete(q.id);
    owner.resolve(answer);
  };
  const ssePayload = { id: q.id, question: q.question, options: q.options, timeoutMs };
  broadcast("agent_question", ssePayload);
  sseSend(res, { type: "question", ...ssePayload });

  return new Promise<string | null>((resolve) => {
    const owner: PendingQuestion = {
      ...q,
      resolve: resolve,
      timer: setTimeout(() => finish(owner, null), timeoutMs),
      res,
    };
    pendingQuestions.set(q.id, owner);
    if (signal.aborted) finish(owner, null);
    else signal.addEventListener("abort", () => finish(owner, null), { once: true });
  });
}

/* ------------------------------------------------------------ web tool hooks */
//
// These are the same calls dsh's tool-web makes; Osama has no provider keys, so
// they go out through public endpoints that need none and degrade gracefully
// offline (a structured error the model can act on, never a crash).

async function webSearch(query: string): Promise<Array<{ title: string; url: string; snippet?: string }>> {
  try {
    const r = await fetch(
      `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      { signal: AbortSignal.timeout(10_000), headers: { "user-agent": "Mozilla/5.0 (Osama local agent)" } },
    );
    if (!r.ok) return [];
    const html = await r.text();
    const out: Array<{ title: string; url: string; snippet?: string }> = [];
    // result links look like /l/?uddg=<encoded>, or direct hrefs with a title
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) && out.length < 8) {
      let url = m[1]!;
      if (url.includes("uddg=")) {
        const u = /uddg=([^&]+)/.exec(url);
        if (u) url = decodeURIComponent(u[1]!);
      }
      out.push({ title: stripTags(m[2]!).slice(0, 160), url });
    }
    return out;
  } catch {
    return [];
  }
}

async function webFetch(url: string): Promise<{ title?: string; content: string; url: string }> {
  // The core implementation: markdown-ish extraction, JSON passthrough, SSRF
  // guard, graceful network errors — one code path for the tool and the UI.
  const r = await core.fetchReadable(url);
  if (!r.ok && r.error && !r.text) return { content: `(${r.error})`, url };
  return { title: r.title, content: r.text ?? "", url: r.url };
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

route("POST", "/api/agent/approve/:id", async (req, res, url) => {
  const id = decodeURIComponent(url.pathname.split("/")[4] ?? "");
  const body = await readBody(req);
  const pending = pendingApprovals.get(id);
  if (!pending) return fail(res, 404, new Error("no pending approval with that id"));
  // `pending.resolve` performs its own cleanup — deleting here as well would
  // strand the promise (the earlier bug: the map lookup came back empty).
  pending.resolve(body.allow === true);
  json(res, 200, { ok: true, allowed: body.allow === true });
});

/**
 * Compact a chat conversation on demand: the UI sends the current message list
 * (just as it would send for /api/agent), and we summarise the older turns via
 * a one-shot call to the model. The reply carries the new (shorter) message
 * list, which the UI replaces in its local state.
 */
route("POST", "/api/agent/compact", async (req, res) => {
  const body = await readBody(req);
  const base = String(body.baseUrl ?? "http://127.0.0.1:8080").replace(/\/$/, "");
  const model = String(body.model ?? "local");
  const messages = Array.isArray(body.messages) ? body.messages as core.AgentMessage[] : [];
  if (!messages.length) return fail(res, 400, new Error("messages required"));

  const meter = core.createMeter(base);
  const breakdown = await core.measureContext(meter, messages, []);
  const plan = core.planCompaction(messages, breakdown.used, breakdown.window);
  if (!plan.needed) {
    return json(res, 200, { ok: true, compacted: false, reason: plan.reason, used: breakdown.used, window: breakdown.window, messages });
  }
  // One-shot, no tools, just want the summary text. Use the same transport
  // shape the agent loop uses so behaviour matches.
  const prompt = core.summarizationPrompt(plan.older, 768);
  const transport = openaiTransport({ base });
  let summary = "";
  try {
    for await (const chunk of transport({
      model,
      messages: [
        { role: "system", content: "You condense conversation transcripts into compact summaries. Follow the instructions in the user message exactly." },
        { role: "user", content: prompt },
      ],
      tools: [],
      stream: true,
    })) {
      if (chunk.content) summary += chunk.content;
      if (chunk.finishReason) break;
    }
  } catch (e) {
    return fail(res, 502, e as Error);
  }
  summary = summary.trim();
  if (!summary) return fail(res, 502, new Error("summarisation returned nothing"));
  const newMessages = core.applyCompaction(summary, plan.recent);
  json(res, 200, {
    ok: true,
    compacted: true,
    reason: plan.reason,
    before: messages.length,
    after: newMessages.length,
    summary: summary.slice(0, 800),
    messages: newMessages,
  });
});

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
    if (serveStatic(res, url.pathname)) return;
    return json(res, 404, { error: "not found" });
  }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    if (!r.pattern.test(url.pathname)) continue;
    try {
      await r.handler(req, res, url);
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
});

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
