import * as core from "@osama/core";
import { fail, json, q, readBody, route, type RouteModule } from "../http.js";

/**
 * The skill store, and PDF extraction for chat attachments.
 *
 * Skills are SKILL.md bundles hosted in GitHub repos; the store resolves a
 * source (owner/repo or a skills.sh link) to the skills inside it and installs
 * one into `.osama/skills`, which the catalog already scans.
 *
 * PDF is binary on the wire but text inside; the UI posts the bytes and gets
 * back page-marked text it can inline like any other attachment.
 */

const MAX_PDF_BYTES = 64 * 1024 * 1024;

export const skillRoutes: RouteModule = (deps) => [
  // --- skill store: install skills from skills.sh / GitHub -------------------
  route("GET", "/api/skills/store", async ({ res, url }) => {
    const source = q(url, "source");
    if (!source) return fail(res, 400, new Error("source is required — try owner/repo or a skills.sh link"));
    try {
      const parsed = core.parseSkillSource(source);
      const skills = await core.listRemoteSkills(parsed);
      json(res, 200, { owner: parsed.owner, repo: parsed.repo, ref: parsed.ref ?? null, skills });
    } catch (e) {
      fail(res, 400, e);
    }
  }),

  route("POST", "/api/skills/install", async ({ req, res }) => {
    const body = await readBody(req);
    try {
      const parsed = core.parseSkillSource(String(body.source ?? ""));
      const skillPath = String(body.skill ?? "").trim();
      if (!skillPath && body.skill !== "") return fail(res, 400, new Error("skill path is required"));
      const installed = await core.installRemoteSkill(parsed, skillPath);
      deps.broadcast("skill", { stage: "installed", id: installed.id, name: installed.name });
      json(res, 200, { ok: true, skill: installed, skills: core.discoverSkills(core.skillRoots()) });
    } catch (e) {
      fail(res, 400, e);
    }
  }),

  route("POST", "/api/skills/remove", async ({ req, res }) => {
    const body = await readBody(req);
    const id = String(body.id ?? "").trim();
    if (!id) return fail(res, 400, new Error("id is required"));
    const r = core.removeInstalledSkill(id);
    if (!r.ok) return fail(res, 400, new Error(r.error ?? "could not remove"));
    deps.broadcast("skill", { stage: "removed", id });
    json(res, 200, { ok: true, skills: core.discoverSkills(core.skillRoots()) });
  }),

  // --- PDF text extraction for chat attachments -----------------------------
  route("POST", "/api/extract/pdf", async ({ req, res }) => {
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const c of req) {
        total += (c as Buffer).length;
        if (total > MAX_PDF_BYTES) return fail(res, 400, new Error("PDF is larger than 64 MB"));
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
  }),
];
