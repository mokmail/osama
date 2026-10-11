import fs from "node:fs";
import { promises as fsp } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { crawl, downloadTo, httpRequest, type CrawlPage } from "../web.js";
import { osamaHome } from "../paths.js";
import { delegateConcurrent } from "../orchestr.js";
import { discoverSkills, loadSkill, skillCatalog } from "../skills.js";
import { writeSoul } from "../soul.js";
import { clip, globToRegExp, humanBytes, jail, looksBinary, readRoots, walk, writableRoots } from "./jail.js";
import type { ExecOptions, ToolResult } from "./spec.js";
import type { ToolDispatchContext } from "./dispatch.js";

/**
 * The network family: search, fetch, crawl, download, and the skill author.
 *
 * Same provenance as the filesystem cases — sliced out of the single switch, kept
 * verbatim, and given the same `resolve`/`opts` it had there.
 */
export async function executeNetTool(
  name: string,
  args: Record<string, unknown>,
  opts: ExecOptions,
  ctx: ToolDispatchContext,
): Promise<ToolResult> {
  const { resolve, spec } = ctx;
  switch (name) {
      case "web_search": {
        if (!opts.web) return { ok: false, content: "web access is not available in this run", summary: "unavailable" };
        const query = String(args.query ?? "").trim();
        if (!query) return { ok: false, content: "query is required", summary: "empty query" };
        const results = await opts.web.search(query);
        if (!results.length) return { ok: true, content: `(no results for "${query}")`, summary: "0 results" };
        return {
          ok: true,
          content: results
            .slice(0, 8)
            .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet.slice(0, 200)}` : ""}`)
            .join("\n"),
          summary: `${results.length} result(s)`,
        };
      }
      case "web_fetch": {
        if (!opts.web) return { ok: false, content: "web access is not available in this run", summary: "unavailable" };
        const raw = String(args.url ?? "").trim();
        let parsed: URL;
        try {
          parsed = new URL(raw);
        } catch {
          return { ok: false, content: `not a valid URL: ${raw.slice(0, 100)}`, summary: "bad url" };
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return { ok: false, content: "only http(s) URLs can be fetched", summary: "bad scheme" };
        }
        const page = await opts.web.fetch(parsed.toString());
        return {
          ok: true,
          content: `${page.title ? `${page.title}\n\n` : ""}${page.content.slice(0, 12_000)}`,
          summary: `${page.content.length} chars from ${parsed.host}`,
        };
      }
      case "http_request": {
        const raw = String(args.url ?? "").trim();
        const method = String(args.method ?? "GET");
        const headers = (args.headers && typeof args.headers === "object")
          ? Object.fromEntries(Object.entries(args.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
          : undefined;
        const body = args.body !== undefined ? String(args.body) : undefined;
        const r = await httpRequest(raw, { method, headers, body });
        if (!r.ok && r.error) return { ok: false, content: r.error, summary: "request failed" };
        const headerList = r.headers
          ? Object.entries(r.headers).filter(([k]) => /^(content-type|location|x-|link|set-cookie|etag|cache-control)/i.test(k))
              .map(([k, v]) => `${k}: ${v}`).join("\n")
          : "";
        const head = `HTTP ${r.status}${r.contentType ? ` · ${r.contentType}` : ""}${r.truncated ? " · body truncated" : ""}`;
        return {
          ok: r.ok === true,
          content: [head, headerList ? `\n[headers]\n${headerList}` : "", `\n${r.body ?? ""}`].join(""),
          summary: `HTTP ${r.status} · ${(r.body ?? "").length} chars`,
        };
      }
      case "web_crawl": {
        const raw = String(args.url ?? "").trim();
        if (!raw) return { ok: false, content: "url is required", summary: "empty url" };
        const limit = Number(args.limit ?? 6) || 6;
        const sameHost = args.sameHost === undefined ? true : args.sameHost === true;
        const include = args.include ? String(args.include) : undefined;
        const r = await crawl(raw, { limit, sameHost, include });
        if (!r.ok) return { ok: false, content: r.error ?? "crawl failed", summary: "crawl failed" };
        const body = r.pages
          .map((p: CrawlPage, i: number) => `\n===== [${i + 1}] ${p.title ?? p.url}\n${p.url}\n\n${clip(p.text, 6_000)}`)
          .join("\n");
        return {
          ok: true,
          content: `crawled ${r.pages.length} page(s) (visited ${r.visited}, skipped ${r.skipped})${body}`,
          summary: `${r.pages.length} page(s)`,
        };
      }
      case "web_download": {
        const raw = String(args.url ?? "").trim();
        if (!raw) return { ok: false, content: "url is required", summary: "empty url" };
        // Downloads land in the workspace; resolve the target dir through the jail.
        const dirRaw = args.dir ? String(args.dir) : ".";
        const wsRoot = path.resolve(opts.workspace);
        const targetDir = path.resolve(wsRoot, dirRaw);
        if (targetDir !== wsRoot && !targetDir.startsWith(wsRoot + path.sep)) {
          return { ok: false, content: `download directory must be inside the workspace`, summary: "blocked (path)" };
        }
        if (spec.mutating && opts.onCommand) {
          const allowed = await opts.onCommand(`download ${raw}`, targetDir);
          if (!allowed) return { ok: false, content: "the user denied this download", summary: "denied by user" };
        }
        const r = await downloadTo(raw, targetDir, args.name ? String(args.name) : undefined);
        if (!r.ok || !r.file) return { ok: false, content: r.error ?? "download failed", summary: "download failed" };
        const rel = path.relative(wsRoot, r.file);
        return {
          ok: true,
          content: `downloaded ${r.bytes} bytes to ${r.file} (workspace-relative: ${rel})${r.contentType ? `\ncontent-type: ${r.contentType}` : ""}`,
          summary: `${path.basename(r.file)} · ${Math.round((r.bytes ?? 0) / 1024)} KB`,
        };
      }
      case "create_skill": {
        const idRaw = String(args.name ?? "").trim();
        const description = String(args.description ?? "").trim();
        const instructions = String(args.instructions ?? "").trim();
        if (!idRaw || !description || !instructions) {
          return { ok: false, content: "name, description and instructions are all required", summary: "missing fields" };
        }
        const id = idRaw.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
        if (!id) return { ok: false, content: `"${idRaw}" is not a usable skill name`, summary: "bad name" };
        const tags = Array.isArray(args.tags) ? args.tags.map(String) : [];
        // Always the app-owned skills dir — never a scanned root that happens
        // to sort first (that once meant the repo root itself).
        const skillsHome = path.join(osamaHome(), "skills");
        try { fs.mkdirSync(skillsHome, { recursive: true }); } catch { /* exists */ }
        const dir = path.join(skillsHome, id);
        if (spec.mutating && opts.onCommand) {
          const allowed = await opts.onCommand(`create skill ${id}`, dir);
          if (!allowed) return { ok: false, content: "the user denied creating this skill", summary: "denied by user" };
        }
        try {
          fs.mkdirSync(dir, { recursive: true });
          const frontmatter = [
            "---",
            `name: ${id}`,
            `description: ${description.replace(/\n/g, " ")}`,
            ...(tags.length ? [`tags: [${tags.join(", ")}]`] : []),
            `version: 1.0.0`,
            "---",
            "",
          ].join("\n");
          fs.writeFileSync(path.join(dir, "SKILL.md"), `${frontmatter}${instructions}\n`, "utf8");
          return {
            ok: true,
            content: `created skill "${id}" at ${path.join(dir, "SKILL.md")} — it is now in the catalog and loadable with load_skill("${id}"). Add reference files under ${dir}/ (references/, scripts/).`,
            summary: `created ${id}`,
          };
        } catch (e) {
          return { ok: false, content: `could not write the skill: ${(e as Error).message}`, summary: "write failed" };
        }
      }
    default:
      return { ok: false, content: `tool ${name} is declared but not implemented`, summary: "not implemented" };
  }
}
