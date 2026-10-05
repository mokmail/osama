import * as core from "@osama/core";
import { fail, json, q, readBody, route, type RouteModule } from "../http.js";

/**
 * Model discovery across the hubs, and the download queue.
 *
 * Every hub is reached through `core.sources`, which normalises four very
 * different APIs (HF, ModelScope, CivitAI, the Ollama registry) plus direct
 * URLs into one `SourceModel` / `SourceRepo` shape. `toHubModel` adapts that
 * for the UI, which was written against the Hugging Face shape.
 */

interface HubModelUI extends core.SourceModel {
  id: string;
  instruct: boolean;
}

/** SourceModel -> the UI's HubModel (adds id = ref so a row can open its repo). */
function toHubModel(m: core.SourceModel): HubModelUI {
  return {
    ...m,
    id: m.ref,
    name: m.name,
    instruct: /instruct|chat|-it\b|it$/i.test(m.ref) || m.tags.some((t) => /instruct|chat|conversational/i.test(t)),
  };
}

export const hubRoutes: RouteModule = (deps) => [
  // The hub routes keep their names for the existing UI, now multi-source.
  // `source` narrows to one hub (default: all of them).

  route("GET", "/api/hub/search", async ({ res, url }) => {
    const query = q(url, "q") ?? "";
    const limit = Number(q(url, "limit") ?? 30);
    const sort = q(url, "sort") ?? "downloads";
    const source = q(url, "source") ?? "";
    if (source === "huggingface") return json(res, 200, { models: await core.searchModels(query, { limit, sort }), errors: [] });
    if (source === "url") return json(res, 200, { models: [], errors: [] });
    const all = await core.searchAllSources(query, { limit, sort });
    const filtered = source && source !== "all" ? all.models.filter((m) => m.source === source) : all.models;
    json(res, 200, { models: filtered.map(toHubModel), errors: source && source !== "all" ? [] : all.errors });
  }),

  route("GET", "/api/hub/trending", async ({ res, url }) => {
    const limit = Number(q(url, "limit") ?? 24);
    const source = q(url, "source") ?? "";
    if (source === "huggingface") return json(res, 200, { models: await core.trendingModels(limit), errors: [] });
    const all = await core.trendingAllSources(limit);
    const filtered = source && source !== "all" ? all.models.filter((m) => m.source === source) : all.models;
    json(res, 200, { models: filtered.map(toHubModel), errors: source && source !== "all" ? [] : all.errors });
  }),

  route("GET", "/api/hub/sources", ({ res }) => json(res, 200, { sources: core.SOURCES })),

  // `/api/hub/repo?source=` defaults to huggingface; ref decides everything else.
  route("GET", "/api/hub/repo", async ({ res, url }) => {
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
  }),

  // --- downloads ------------------------------------------------------------

  route("GET", "/api/downloads", ({ res }) => json(res, 200, { downloads: core.listDownloads() })),

  route("POST", "/api/downloads", async ({ req, res }) => {
    const body = await readBody(req);
    const id = `d_${Date.now().toString(36)}`;
    deps.broadcast("download", { id, repo: body.repo, file: body.file, stage: "start" });
    core
      .downloadModel({
        repo: body.repo,
        file: body.file,
        source: body.source ?? "huggingface",
        name: body.name,
        onProgress: (rec) =>
          deps.broadcast("download", {
            id,
            repo: rec.repo,
            file: rec.file,
            stage: rec.status,
            received: rec.received,
            total: rec.total,
          }),
      })
      .then((model) => deps.broadcast("download", { id, repo: body.repo, file: body.file, stage: "done", model }))
      .catch((err) => deps.broadcast("download", { id, repo: body.repo, file: body.file, stage: "error", error: String(err?.message ?? err) }));
    json(res, 202, { id });
  }),

  route("POST", "/api/downloads/:id/cancel", ({ res, url }) => {
    const id = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    core.cancelDownload(id);
    json(res, 200, { ok: true });
  }),
];
