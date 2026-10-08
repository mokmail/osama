import process from "node:process";
import path from "node:path";
import * as core from "@osama/core";
import { fail, json, readBody, route, type RouteModule } from "../http.js";

/**
 * The model library, and the one-shot / long-running tool runs.
 *
 * A "run" is a tool that executes to completion (quantize, bench, edit …) and
 * streams its output; a "process" is one that keeps going until stopped
 * (llama-server, rpc). They are separate routes because they have opposite
 * lifecycles, but they share the argv builder and the resolved engine binary.
 */

/** Recently completed runs, bounded so a long session cannot grow forever. */
const RUNS = new Map<string, { id: string; tool: string; status: string; startedAt: number; result?: core.RunResult }>();
const MAX_RUNS = 100;

function rememberRun(id: string, rec: { id: string; tool: string; status: string; startedAt: number; result?: core.RunResult }): void {
  RUNS.set(id, rec);
  // Evict the oldest once past the cap — the UI only ever reads the newest.
  while (RUNS.size > MAX_RUNS) {
    const oldest = [...RUNS.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt)[0];
    if (!oldest) break;
    RUNS.delete(oldest[0]);
  }
}

export const modelRoutes: RouteModule = (deps) => [
  // --- models ---------------------------------------------------------------

  route("GET", "/api/models", ({ res }) => json(res, 200, { models: core.listModels() })),

  route("POST", "/api/models/scan", ({ res }) => json(res, 200, { models: core.scanModelsDir() })),

  route("POST", "/api/models/add", async ({ req, res }) => {
    const body = await readBody(req);
    try {
      json(res, 200, { model: core.addModel({ file: body.file, repo: body.repo, name: body.name }) });
    } catch (e) {
      fail(res, 400, e);
    }
  }),

  route("GET", "/api/models/:id/card", ({ res, url }) => {
    const id = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    const m = core.getModel(id);
    if (!m) return fail(res, 404, new Error("model not found"));
    json(res, 200, { card: core.describeModel(m.file) });
  }),

  route("DELETE", "/api/models/:id", ({ res, url }) => {
    const id = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    const del = url.searchParams.get("deleteFile") === "true";
    core.removeModel(id, del);
    json(res, 200, { ok: true });
  }),

  // --- GGUF metadata: read for the editor, and apply an edit ---------------

  route("GET", "/api/models/:id/metadata", ({ res, url }) => {
    const id = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    const m = core.getModel(id);
    if (!m) return fail(res, 404, new Error("model not found"));
    const meta = core.readMetadataSafe(m.file);
    if (!meta) return fail(res, 400, new Error("could not read this file's metadata"));
    json(res, 200, {
      file: m.file,
      metadata: meta,
      editable: core.EDITABLE_KEYS,
      contextKey: core.contextLengthKey(meta) ?? null,
      suggestedOutput: core.suggestOutput(m.file),
    });
  }),

  /**
   * Edit metadata and resave. Runs in the background like the other tool runs
   * and streams over SSE, then re-reads the result to prove the edit landed.
   */
  route("POST", "/api/models/edit", async ({ req, res }) => {
    const body = await readBody(req);
    const input = String(body.file ?? "");
    const output = String(body.output ?? core.suggestOutput(input));
    const edits = Array.isArray(body.edits) ? (body.edits as core.MetadataEdit[]) : [];
    try {
      core.assertDistinctPaths(input, output);
    } catch (e) {
      return fail(res, 400, e);
    }
    const plan = core.planEdit(input, output, edits, { dryRun: body.dryRun === true, keepSplit: body.keepSplit === true });
    if (!plan.ok) return fail(res, 400, new Error(plan.error));

    const runId = `edit_${Date.now().toString(36)}`;
    const before = core.readMetadataSafe(input);
    deps.broadcast("run", { id: runId, tool: "gguf-edit", stage: "start", command: core.renderCommand("llama-quantize", plan.argv) });

    let binary: string;
    try {
      binary = core.resolveTool("llama-quantize");
    } catch (e) {
      return fail(res, 400, e);
    }

    core
      .runToCompletion(binary, plan.argv, {
        cwd: core.paths().home,
        onLine: (line) => deps.broadcast("run", { id: runId, tool: "gguf-edit", line }),
      })
      .then((result) => {
        // Trust nothing: read the result back and report which edits landed.
        const after = body.dryRun ? before : core.readMetadataSafe(output);
        const unapplied = after ? core.verifyEdits(after, edits) : [];
        const ok = result.code === 0 && unapplied.length === 0;
        const payload = {
          id: runId,
          tool: "gguf-edit",
          stage: "done",
          result,
          output,
          before,
          after,
          unapplied,
          // The honest signal the UI needs: exit 0 is not proof an edit stuck.
          verified: result.code === 0 && unapplied.length === 0,
        };
        deps.broadcast("run", payload);
        rememberRun(runId, { id: runId, tool: "gguf-edit", status: ok ? "done" : "error", startedAt: Date.now(), result });
      })
      .catch((err) => {
        deps.broadcast("run", { id: runId, tool: "gguf-edit", stage: "error", error: String(err?.message ?? err) });
        rememberRun(runId, { id: runId, tool: "gguf-edit", status: "error", startedAt: Date.now() });
      });

    json(res, 202, { runId, output, command: core.renderCommand("llama-quantize", plan.argv), overrides: plan.overrides });
  }),

  /** The metadata an editor form should offer, for a file not yet in the library. */
  route("POST", "/api/gguf/inspect", async ({ req, res }) => {
    const body = await readBody(req);
    const file = String(body.file ?? "").trim();
    if (!file) return fail(res, 400, new Error("file is required"));
    const pre = core.isEditable(file);
    if (!pre.ok) return fail(res, 400, new Error(pre.reason ?? "not a GGUF"));
    const meta = core.readMetadataSafe(file);
    json(res, 200, { file, metadata: meta ?? {}, editable: core.EDITABLE_KEYS, suggestedOutput: core.suggestOutput(file) });
  }),

  // --- LoRA: inspect adapters, and merge them into a base -------------------

  route("GET", "/api/lora/inspect", ({ res, url }) => {
    const file = url.searchParams.get("file");
    if (!file) return fail(res, 400, new Error("file is required"));
    json(res, 200, { inspection: core.inspectLora(file), notes: core.LORA_NOTES });
  }),

  route("POST", "/api/lora/merge", async ({ req, res }) => {
    const body = await readBody(req);
    const base = String(body.model ?? "");
    const adapters = Array.isArray(body.lora) ? (body.lora as string[]) : [];
    const output = String(body.output ?? "");
    const plan = core.planLoraMerge(base, adapters, output, { threads: Number(body.threads) || undefined });
    if (!plan.ok) return fail(res, 400, new Error(plan.error));

    const runId = `lora_${Date.now().toString(36)}`;
    let binary: string;
    try {
      binary = core.resolveTool("llama-export-lora");
    } catch (e) {
      return fail(res, 400, e);
    }
    deps.broadcast("run", { id: runId, tool: "lora", stage: "start", command: core.renderCommand("llama-export-lora", plan.argv) });
    core
      .runToCompletion(binary, plan.argv, {
        cwd: core.paths().home,
        onLine: (line) => deps.broadcast("run", { id: runId, tool: "lora", line }),
      })
      .then((result) => {
        deps.broadcast("run", { id: runId, tool: "lora", stage: "done", result, output });
        rememberRun(runId, { id: runId, tool: "lora", status: result.code === 0 ? "done" : "error", startedAt: Date.now(), result });
      })
      .catch((err) => {
        deps.broadcast("run", { id: runId, tool: "lora", stage: "error", error: String(err?.message ?? err) });
        rememberRun(runId, { id: runId, tool: "lora", status: "error", startedAt: Date.now() });
      });
    json(res, 202, { runId, output, command: core.renderCommand("llama-export-lora", plan.argv) });
  }),

  // --- one-shot tool runs ---------------------------------------------------

  route("POST", "/api/run", async ({ req, res }) => {
    const body = await readBody(req);
    let toolId: core.ToolId;
    let spec: core.ToolSpec;
    let argv: string[];
    let binary: string;
    try {
      toolId = body.tool as core.ToolId;
      spec = core.toolSpec(toolId);
      argv = core.buildArgv(toolId, body.values ?? {});
      binary = core.resolveTool(spec.binary);
    } catch (e) {
      return fail(res, 400, e);
    }
    const runId = `run_${Date.now().toString(36)}`;
    deps.broadcast("run", { id: runId, tool: toolId, stage: "start", command: core.renderCommand(spec.binary, argv) });
    core
      .runToCompletion(binary, argv, {
        cwd: body.cwd ?? core.paths().home,
        onLine: (line) => deps.broadcast("run", { id: runId, tool: toolId, line }),
      })
      .then((result) => {
        deps.broadcast("run", { id: runId, tool: toolId, stage: "done", result });
        rememberRun(runId, { id: runId, tool: toolId, status: "done", startedAt: Date.now(), result });
      })
      .catch((err) => {
        deps.broadcast("run", { id: runId, tool: toolId, stage: "error", error: String(err?.message ?? err) });
        rememberRun(runId, { id: runId, tool: toolId, status: "error", startedAt: Date.now() });
      });
    json(res, 202, { runId, command: core.renderCommand(spec.binary, argv) });
  }),

  route("GET", "/api/run/:id", ({ res, url }) => {
    const id = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    const rec = RUNS.get(id);
    if (!rec) return fail(res, 404, new Error("no such run"));
    json(res, 200, { run: rec });
  }),

  // --- long-running processes ----------------------------------------------

  route("GET", "/api/processes", ({ res }) => json(res, 200, { processes: core.listProcesses() })),

  route("POST", "/api/processes", async ({ req, res }) => {
    const body = await readBody(req);
    let toolId: core.ToolId;
    let spec: core.ToolSpec;
    try {
      toolId = body.tool as core.ToolId;
      spec = core.toolSpec(toolId);
    } catch (e) {
      return fail(res, 400, e);
    }
    const values: core.ParamValues = { ...((body.values ?? {}) as core.ParamValues) };
    let port = Number(values.port ?? (spec.id === "rpc" ? 50052 : 8080));
    const host = String(values.host ?? "127.0.0.1");

    // A draft head (e.g. Qwen MTP) segfaults llama-server as the MAIN model —
    // it is only valid as a speculative-decoding --model-draft sidecar.
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

    let argv: string[];
    let binary: string;
    try {
      argv = core.buildArgv(toolId, values);
      binary = core.resolveTool(spec.binary);
    } catch (e) {
      return fail(res, 400, e);
    }

    const info = core.startProcess({
      label: `${spec.title}${values.model ? " · " + path.basename(String(values.model)) : ""}`,
      tool: binary,
      argv,
      cwd: core.paths().home,
      url: spec.id === "server" ? `http://${host}:${port}` : spec.id === "rpc" ? `http://${host}:${Number(values.port ?? 50052)}` : undefined,
    });
    core.onProcessLine(info.id, (line) => deps.broadcast("process", { id: info.id, line }));
    core.onProcessExit(info.id, (p) => deps.broadcast("process", { id: info.id, stage: "exit", proc: p }));
    json(res, 201, {
      process: info,
      command: core.renderCommand(spec.binary, argv),
      ...(stopped.length ? { stopped } : {}),
      ...(reboundFrom !== null ? { reboundFrom } : {}),
    });
  }),

  route("GET", "/api/processes/:id/log", ({ res, url }) => {
    const id = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    json(res, 200, { id, lines: core.processLog(id) });
  }),

  route("POST", "/api/processes/prune", ({ res }) => {
    json(res, 200, { ok: true, pruned: core.pruneFinishedProcesses() });
  }),

  route("POST", "/api/processes/:id/stop", async ({ res, url }) => {
    const id = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    const ok = await core.stopProcess(id);
    json(res, 200, { ok });
  }),

  // --- chat / server introspection -----------------------------------------

  route("POST", "/api/chat", async ({ req, res }) => {
    const body = await readBody(req);
    const base = String(body.baseUrl ?? "http://127.0.0.1:8080");
    const apiKey = body.apiKey ? String(body.apiKey) : undefined;
    const payload = { ...(body.payload ?? body) } as Record<string, unknown>;
    // A non-positive max_tokens means "unlimited". llama.cpp accepts -1, but
    // Ollama rejects it with invalid_request_error, so drop the field when it
    // is not a real cap. This is the shared proxy, so it fixes every caller.
    if (typeof payload.max_tokens === "number" && payload.max_tokens <= 0) delete payload.max_tokens;
    const upstream = await fetch(`${base.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(Number(body.timeoutMs) || 120_000),
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
  }),

  route("GET", "/api/server/health", async ({ res, url }) => {
    const base = url.searchParams.get("baseUrl") ?? "http://127.0.0.1:8080";
    try {
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2500) });
      json(res, 200, { ok: r.ok, status: r.status, body: await r.text().catch(() => "") });
    } catch (err) {
      json(res, 200, { ok: false, error: String((err as Error).message) });
    }
  }),

  route("GET", "/api/server/props", async ({ res, url }) => {
    const base = url.searchParams.get("baseUrl") ?? "http://127.0.0.1:8080";
    try {
      const r = await fetch(`${base}/props`, { signal: AbortSignal.timeout(2500) });
      json(res, 200, { ok: r.ok, props: await r.json().catch(() => null) });
    } catch (err) {
      json(res, 200, { ok: false, error: String((err as Error).message) });
    }
  }),

  route("GET", "/api/server/metrics", async ({ res, url }) => {
    const base = (url.searchParams.get("baseUrl") ?? "http://127.0.0.1:8080").replace(/\/$/, "");
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
      out.cacheReusePct = prompt && prompt + cached > 0 ? Math.round((cached / (prompt + cached)) * 100) : null;

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
  }),
];
