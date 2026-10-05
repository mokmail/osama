import process from "node:process";
import * as core from "@osama/core";
import { json, readBody, route, type RouteModule } from "../http.js";

/**
 * Health, machine probing, and the engine/tool catalogue.
 *
 * These are the routes the UI hits first on load and the ones the smoke test
 * asserts against, so they stay deliberately thin: probe, list, build a command
 * preview. Nothing here mutates.
 */
export const systemRoutes: RouteModule = (deps) => [
  route("GET", "/api/health", ({ res }) => json(res, 200, { ok: true, version: "0.2.0", pid: process.pid })),

  route("GET", "/api/system", async ({ res }) => {
    const gpu = await core.probeGpu();
    json(res, 200, {
      system: core.systemInfo(),
      gpu,
      accelerations: core.supportedAccelerations(),
      recommendedAcceleration: gpu.acceleration,
      paths: core.paths(),
    });
  }),

  // --- stats (dashboard aggregate) -----------------------------------------

  route("GET", "/api/stats", ({ res }) => json(res, 200, core.buildStats(deps.activity()))),

  route("GET", "/api/stats/series", ({ res }) => json(res, 200, { samples: core.getSeries() })),

  // --- engine ---------------------------------------------------------------

  route("GET", "/api/engine", ({ res }) => {
    const engines = core.listInstalled();
    const active = core.getActiveEngine();
    json(res, 200, { engines, activeTag: active?.tag, active, knownTools: core.KNOWN_TOOLS });
  }),

  route("GET", "/api/engine/releases", async ({ res, url }) => {
    const limit = Number(url.searchParams.get("limit") ?? 8);
    json(res, 200, { releases: await core.listReleases(limit) });
  }),

  route("GET", "/api/engine/plan", async ({ res, url }) => {
    const tag = url.searchParams.get("tag") ?? undefined;
    const release = tag ? (await core.listReleases(30)).find((r) => r.tag === tag) : await core.latestRelease();
    if (!release) return json(res, 404, { error: `release ${tag} not found` });
    json(res, 200, {
      tag: release.tag,
      publishedAt: release.publishedAt,
      os: core.currentOs(),
      arch: core.currentArch(),
      variants: core.planForCurrentMachine(release),
    });
  }),

  route("POST", "/api/engine/install", async ({ req, res }) => {
    const body = await readBody(req);
    const acceleration = (body.acceleration ?? undefined) as core.Acceleration | undefined;
    // Run in the background; progress is streamed over /api/events.
    core
      .installEngine({
        tag: body.tag,
        acceleration,
        onProgress: (stage, p) => deps.broadcast("install", { stage, progress: p }),
      })
      .then((engine) => deps.broadcast("install", { stage: "installed", engine }))
      .catch((err) => deps.broadcast("install", { stage: "error", error: String(err?.message ?? err) }));
    json(res, 202, { started: true });
  }),

  route("POST", "/api/engine/activate", async ({ req, res }) => {
    const body = await readBody(req);
    try {
      core.setActiveEngine(body.tag);
      json(res, 200, { ok: true, activeTag: body.tag });
    } catch (e) {
      json(res, 400, { error: (e as Error).message });
    }
  }),

  route("DELETE", "/api/engine/:tag", ({ res, url }) => {
    const tag = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    core.removeEngine(tag);
    json(res, 200, { ok: true });
  }),

  // --- tools / commands -----------------------------------------------------

  route("GET", "/api/tools", ({ res }) => json(res, 200, { tools: core.allTools() })),

  route("POST", "/api/command/preview", async ({ req, res }) => {
    const body = await readBody(req);
    try {
      const spec = core.toolSpec(body.tool);
      const argv = core.buildArgv(body.tool, body.values ?? {});
      json(res, 200, { binary: spec.binary, argv, command: core.renderCommand(spec.binary, argv) });
    } catch (e) {
      json(res, 400, { error: (e as Error).message });
    }
  }),
];
