import * as core from "@osama/core";
import { fail, json, readBody, route, type RouteModule } from "../http.js";

/**
 * MLX: the Apple-silicon engine beside llama.cpp.
 *
 * One module, one prefix. MLX is not part of the llama.cpp registry (see
 * docs/mlx-macos.md), so nothing here reads or writes `registry.json`, and the
 * llama.cpp routes know nothing about it. Progress for an install streams over
 * the same SSE bus under its own `mlx` event type.
 */
/**
 * Why MLX cannot run here, or null when it can.
 *
 * MLX is Apple silicon only, and this is checked on both sides: the UI does not
 * render the card or the provider button at all on another machine, and every route
 * that would *do* something refuses with the same sentence. Refusing matters for
 * more than tidiness — `install` shells out to `uv` and pip, and a fetch would spend
 * real bandwidth on a model that could never be served here. `GET /api/mlx/status`
 * deliberately stays open: it is how a client finds out.
 */
function unsupported(): string | null {
  const support = core.mlxSupport();
  return support.supported ? null : (support.reason ?? "MLX is not supported on this machine.");
}

export const mlxRoutes: RouteModule = (deps) => [
  /** Support, runtime and what is on disk — one call for the UI card. */
  route("GET", "/api/mlx/status", async ({ res }) => {
    const runtime = await core.detectRuntime();
    json(res, 200, {
      support: core.mlxSupport(),
      runtime,
      paths: core.mlxPaths(),
      models: core.listMlxModels().length,
    });
  }),

  /**
   * Create/refresh Osama's MLX environment.
   *
   * Backgrounded like the llama.cpp install: the request returns as soon as the
   * work starts and the log arrives on the event bus, line by line.
   */
  route("POST", "/api/mlx/install", async ({ res }) => {
    const why = unsupported();
    if (why) return fail(res, 409, new Error(why));
    core
      .installRuntime((e) => deps.broadcast("mlx", e))
      .then((runtime) => deps.broadcast("mlx", { stage: "installed", runtime }))
      .catch((err) => deps.broadcast("mlx", { stage: "error", error: String(err?.message ?? err) }));
    json(res, 202, { started: true });
  }),

  /** MLX models: directories under the models dir that mlx-lm can load. */
  route("GET", "/api/mlx/models", ({ res }) => {
    json(res, 200, { models: core.listMlxModels() });
  }),

  /** Describe one directory — the "is this actually an MLX model?" question. */
  route("GET", "/api/mlx/model", ({ res, url }) => {
    const dir = url.searchParams.get("dir");
    if (!dir) return fail(res, 400, new Error("dir is required"));
    if (!core.isMlxModelDir(dir)) {
      return fail(res, 422, new Error(`${dir} is not an MLX model directory — it needs config.json and at least one .safetensors file`));
    }
    json(res, 200, { model: core.describeMlxModel(dir, "external") });
  }),

  /**
   * Start an MLX server.
   *
   * Same rules as the llama.cpp server route: serving is exclusive, a taken port
   * gets a free neighbour instead of a confusing bind failure, and the process is
   * supervised (logs and exit go out on the bus).
   */
  route("POST", "/api/mlx/serve", async ({ req, res }) => {
    const why = unsupported();
    if (why) return fail(res, 409, new Error(why));
    const body = await readBody(req);
    const model = String(body.model ?? "");
    if (!model) return fail(res, 400, new Error("model is required"));
    if (!core.isMlxModelDir(model)) {
      return fail(res, 422, new Error(`${model} is not an MLX model directory — a directory with config.json and .safetensors weights`));
    }
    // Refuse what the runtime cannot load, before a port is bound: otherwise the
    // server comes up, /v1/models answers 200, /health answers 503 forever, and the
    // UI shows a load that never finishes. `force` overrides.
    if (body.force !== true) {
      const refusal = core.mlxServeRefusal(model);
      if (refusal) return fail(res, 409, new Error(refusal));
    }
    const runtime = await core.detectRuntime();
    if (!runtime.ready) return fail(res, 409, new Error(runtime.detail));

    let host = String(body.host ?? "127.0.0.1");
    let port = Number(body.port ?? 8082);
    if (!(await core.isPortFree(host, port))) {
      const alt = await core.findFreePort(host, port + 1);
      if (alt === null) return fail(res, 409, new Error(`port ${port} on ${host} is in use and no free port was found nearby`));
      port = alt;
    }

    const stopped = body.exclusive === false ? [] : await core.stopAllServers();

    const opts = {
      model,
      host,
      port,
      temp: body.temp === undefined ? undefined : Number(body.temp),
      topP: body.topP === undefined ? undefined : Number(body.topP),
      topK: body.topK === undefined ? undefined : Number(body.topK),
      minP: body.minP === undefined ? undefined : Number(body.minP),
      maxTokens: body.maxTokens === undefined ? undefined : Number(body.maxTokens),
      chatTemplate: body.chatTemplate ? String(body.chatTemplate) : undefined,
      adapterPath: body.adapterPath ? String(body.adapterPath) : undefined,
      draftModel: body.draftModel ? String(body.draftModel) : undefined,
      numDraftTokens: body.numDraftTokens === undefined ? undefined : Number(body.numDraftTokens),
      trustRemoteCode: body.trustRemoteCode === true,
    };

    let cmd: { tool: string; argv: string[]; cwd: string };
    try {
      cmd = core.mlxServeCommand(runtime, opts);
    } catch (e) {
      return fail(res, 409, e);
    }

    const info = core.startProcess({
      label: `MLX server · ${model.split("/").pop()}`,
      tool: cmd.tool,
      argv: cmd.argv,
      // mlx-lm requires the model to live under the process cwd (see mlx.ts),
      // and the interpreter must not inherit the launcher's PYTHONPATH
      cwd: cmd.cwd,
      env: core.mlxProcessEnv(),
      url: `http://${host}:${port}`,
    });
    core.onProcessLine(info.id, (line) => deps.broadcast("process", { id: info.id, line }));
    core.onProcessExit(info.id, (p) => {
      deps.broadcast("process", { id: info.id, stage: "exit", proc: p });
      // A failed load leaves a traceback; the hint turns it into the one sentence
      // that says what to do — the difference between a stuck spinner and a fix.
      if (p.status === "failed" || (typeof p.exitCode === "number" && p.exitCode !== 0)) {
        const hint = core.mlxFailureHint(core.processLog(info.id, 200));
        if (hint) deps.broadcast("mlx", { stage: "error", error: hint, processId: info.id });
      }
    });
    json(res, 201, {
      process: info,
      command: `cd ${cmd.cwd} && ${[cmd.tool, ...cmd.argv].join(" ")}`,
      runtime: { source: runtime.source, mlxLmVersion: runtime.mlxLmVersion },
      ...(stopped.length ? { stopped } : {}),
    });
  }),

  /** Where MLX models can come from. */
  route("GET", "/api/mlx/sources", ({ res }) => {
    json(res, 200, { sources: core.mlxSources() });
  }),

  /** Search the MLX catalogue (Hugging Face's `mlx` tag, or one publisher). */
  route("GET", "/api/mlx/search", async ({ res, url }) => {
    const why = unsupported();
    if (why) return fail(res, 409, new Error(why));
    const q = url.searchParams.get("q") ?? "";
    const source = (url.searchParams.get("source") ?? "mlx") as core.MlxSourceId;
    const limit = Number(url.searchParams.get("limit") ?? 24);
    try {
      json(res, 200, await core.searchMlxModels(q, { source, limit }));
    } catch (e) {
      fail(res, 502, e);
    }
  }),

  /** What one repo would cost to fetch — size, bits, window — before fetching it. */
  route("GET", "/api/mlx/repo", async ({ res, url }) => {
    const why = unsupported();
    if (why) return fail(res, 409, new Error(why));
    const ref = url.searchParams.get("ref");
    if (!ref) return fail(res, 400, new Error("ref is required"));
    const source = (url.searchParams.get("source") ?? "mlx") as core.MlxSourceId;
    try {
      json(res, 200, { plan: await core.planMlxRepo(ref, { source }) });
    } catch (e) {
      fail(res, 422, e);
    }
  }),

  /**
   * Fetch a whole MLX repo into the models dir.
   *
   * Backgrounded like every other download: progress arrives on the bus under the
   * usual `download` event, tagged so the MLX view can pick out its own.
   */
  route("POST", "/api/mlx/download", async ({ req, res }) => {
    const why = unsupported();
    if (why) return fail(res, 409, new Error(why));
    const body = await readBody(req);
    const ref = String(body.ref ?? "").trim();
    if (!ref) return fail(res, 400, new Error("ref is required"));
    const source = (body.source ?? "mlx") as core.MlxSourceId;
    const id = `mlx_${Date.now().toString(36)}`;
    deps.broadcast("download", { id, kind: "mlx", repo: ref, stage: "start" });
    core
      .downloadMlxRepo(ref, {
        source,
        onEvent: (e) =>
          deps.broadcast("download", {
            id,
            kind: "mlx",
            repo: ref,
            file: e.file,
            stage: e.stage === "file" ? "downloading" : e.stage,
            index: e.index,
            count: e.count,
            received: e.received,
            total: e.total,
            dir: e.dir,
            error: e.error,
          }),
      })
      .then((r) => deps.broadcast("download", { id, kind: "mlx", repo: ref, stage: "done", dir: r.dir, model: r.model }))
      .catch((err) => deps.broadcast("download", { id, kind: "mlx", repo: ref, stage: "error", error: String(err?.message ?? err) }));
    json(res, 202, { id });
  }),

  /** Delete a downloaded model. Guarded in core: MLX model, under the models dir, not in use. */
  route("POST", "/api/mlx/remove", async ({ req, res }) => {
    const body = await readBody(req);
    const dir = String(body.dir ?? "");
    if (!dir) return fail(res, 400, new Error("dir is required"));
    try {
      json(res, 200, { ok: true, ...(await core.removeMlxModel(dir, { force: body.force === true })) });
    } catch (e) {
      fail(res, 409, e);
    }
  }),

  /** What an MLX server is serving — from `/v1/models`, since there is no `/props`. */
  route("GET", "/api/mlx/info", async ({ res, url }) => {
    const baseUrl = url.searchParams.get("baseUrl");
    if (!baseUrl) return fail(res, 400, new Error("baseUrl is required"));
    json(res, 200, await core.probeMlxServer(baseUrl));
  }),
];
