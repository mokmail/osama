import * as core from "@osama/core";
import { fail, json, q, readBody, route, type RouteModule } from "../http.js";

/**
 * The agent's identity and its memory.
 *
 * These are the read/write surfaces behind the chat sidebar: the soul editor,
 * the personality picker, and the two memory stores. They are separate from the
 * agent-turn routes because nothing here runs a model — it is all state the user
 * can see and correct directly, which is the point.
 *
 * Two design rules from the Hermes model are enforced here rather than assumed:
 *
 *  - The soul is ONE file (`SOUL.md`) read for slot #1. The API never merges it
 *    with project context, so what the user edits is what the model gets.
 *  - Memory writes can be batched atomically. A nearly-full store has to be
 *    consolidated, and doing that as separate calls can destroy a fact when the
 *    second call fails.
 */
export const identityRoutes: RouteModule = (deps) => [
  /* ------------------------------------------------------------- soul */

  route("GET", "/api/agent/soul", ({ res }) => {
    const report = core.soulReport();
    json(res, 200, {
      ...report,
      personalities: core.PERSONALITIES,
      maxChars: core.SOUL_MAX_CHARS,
    });
  }),

  route("POST", "/api/agent/soul", async ({ req, res }) => {
    const body = await readBody(req);
    const r = core.writeSoul(String(body.text ?? ""));
    if (!r.ok) return fail(res, 400, new Error(r.error ?? "could not write the soul"));
    // A soul change is worth telling every open client about — the personality
    // the agent speaks with just changed for the next turn.
    deps.broadcast("soul", { stage: "updated", chars: r.chars, flagged: r.flagged, findings: r.findings });
    json(res, 200, { ok: true, chars: core.soulReport().chars, flagged: r.flagged, findings: r.findings, soul: core.soulReport() });
  }),

  route("POST", "/api/agent/soul/reset", ({ res }) => {
    const r = core.resetSoul();
    if (!r.ok) return fail(res, 400, new Error(r.error ?? "could not reset the soul"));
    deps.broadcast("soul", { stage: "reset" });
    json(res, 200, { ok: true, soul: core.soulReport() });
  }),

  /* ------------------------------------------------------ prompt inspector */

  /**
   * Assemble the system prompt exactly as the agent would and return it with
   * its section breakdown. The prompt IS the agent's behaviour, so the user can
   * read it rather than guess at it.
   */
  route("GET", "/api/agent/prompt", ({ res, url }) => {
    const built = core.buildPrompt({
      system: q(url, "system"),
      personality: q(url, "personality"),
      toolRules: q(url, "tools") !== "0",
      memory: q(url, "memory") !== "0",
      skills: q(url, "skills") !== "0",
      workspace: true,
      scheduler: true,
      timestamp: q(url, "clock") === "1",
    });
    json(res, 200, built);
  }),

  route("POST", "/api/agent/prompt", async ({ req, res }) => {
    const body = await readBody(req);
    const built = core.buildPrompt({
      system: typeof body.system === "string" ? body.system : undefined,
      personality: typeof body.personality === "string" ? body.personality : undefined,
      toolRules: body.tools !== false,
      memory: body.memory !== false,
      skills: body.skills !== false,
      workspace: body.workspace !== false,
      scheduler: body.scheduler !== false,
      timestamp: body.clock === true,
      activeSkills: Array.isArray(body.activeSkills) ? body.activeSkills.map(String) : undefined,
    });
    json(res, 200, built);
  }),

  /* ------------------------------------------------------------- memory */

  route("GET", "/api/agent/memory", ({ res }) => {
    const s = core.memoryStats();
    json(res, 200, {
      // Both stores, plainly separated: the notes and the profile.
      entries: core.listMemory(),
      user: core.listUser(),
      block: core.memoryBlock(),
      stats: s,
      budgets: s.budget,
      used: s.chars,
      userBudget: core.USER_BUDGET,
    });
  }),

  route("POST", "/api/agent/memory/save", async ({ req, res }) => {
    const body = await readBody(req);
    const target = body.target === "user" ? "user" : body.target === "memory" ? "memory" : core.inferTarget(String(body.text ?? ""));
    const scope = body.scope === "workspace" ? "workspace" : "global";
    const tags = Array.isArray(body.tags) ? body.tags.map(String) : [];
    const r = core.saveMemory(String(body.text ?? ""), scope, tags, target);
    if (!r.ok) return fail(res, 400, new Error(r.error ?? "could not save"));
    deps.broadcast("memory", { stage: "saved", target, entry: r.entry });
    json(res, 200, { ok: true, entry: r.entry, target, used: r.used, budget: r.budget });
  }),

  route("POST", "/api/agent/memory/replace", async ({ req, res }) => {
    const body = await readBody(req);
    const target = body.target === "user" ? "user" : "memory";
    const r = core.replaceMemory(String(body.old_text ?? ""), String(body.content ?? ""), target);
    if (!r.ok) return fail(res, 400, new Error(r.error ?? "could not replace"));
    deps.broadcast("memory", { stage: "replaced", entry: r.entry });
    json(res, 200, { ok: true, entry: r.entry, used: r.used, budget: r.budget });
  }),

  /** Apply several ops atomically — the consolidation path. */
  route("POST", "/api/agent/memory/batch", async ({ req, res }) => {
    const body = await readBody(req);
    const ops = Array.isArray(body.operations) ? body.operations : [];
    const r = core.applyMemoryOps(ops as core.MemoryOp[]);
    if (!r.ok) return json(res, 400, { error: r.error ?? "could not apply", applied: r.applied });
    deps.broadcast("memory", { stage: "batch", applied: r.applied });
    const s = core.memoryStats();
    json(res, 200, { ok: true, applied: r.applied, stats: s });
  }),

  route("POST", "/api/agent/memory/forget", async ({ req, res }) => {
    const body = await readBody(req);
    const target = body.target === "user" ? "user" : body.target === "memory" ? "memory" : undefined;
    const scope = body.scope === "workspace" ? "workspace" : body.scope === "global" ? "global" : undefined;
    const r = core.forgetMemory(String(body.selector ?? ""), scope, target);
    if (r.ok) deps.broadcast("memory", { stage: "forgot", removed: r.removed });
    json(res, 200, { ok: r.ok, removed: r.removed, error: r.error });
  }),
];
