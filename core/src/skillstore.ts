import fs from "node:fs";
import path from "node:path";
import { osamaHome } from "./paths.js";
import { parseFrontmatter, skillRoots, discoverSkills } from "./skills.js";

/**
 * Installing skills from the outside world.
 *
 * The agent-skills ecosystem (skills.sh, vercel-labs/skills et al.) ships
 * skills as directories containing a SKILL.md with YAML frontmatter, hosted in
 * GitHub repositories. This module resolves a repo (or a skills.sh link) to the
 * skills inside it, and copies one — SKILL.md plus supporting files — into
 * `.osama/skills/<id>/`, which `skills.ts` already scans.
 *
 * Network layout: GitHub's REST API is rate-limited (60/h unauthenticated), so
 * it is used exactly twice per browse (default branch + one recursive tree).
 * File contents come from raw.githubusercontent.com, which is not rate-limited.
 * Set GITHUB_TOKEN to lift the API limit for private repos / heavy use.
 */

export interface SkillSource {
  owner: string;
  repo: string;
  ref?: string;
  /** Restrict to skills under this repo subpath (or matching this name). */
  subpath?: string;
}

export interface RemoteSkill {
  /** Directory of the skill inside the repo ("" when the repo root is the skill). */
  path: string;
  /** Last path segment — the id it will install as. */
  name: string;
  description: string;
  /** Files that will be downloaded. */
  files: number;
  bytes: number;
}

export interface InstalledSkill {
  id: string;
  path: string;
  name: string;
  description: string;
  files: string[];
}

const MAX_SKILLS_LISTED = 60;
const MAX_DESCRIPTIONS = 40;
const MAX_FILES_PER_SKILL = 120;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SKILL_BYTES = 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

/** Parse anything a user may paste into owner/repo (+ optional ref/subpath). */
export function parseSkillSource(input: string): SkillSource {
  const raw = input?.trim();
  if (!raw) throw new Error("a source is required — try owner/repo or a skills.sh link");

  let s = raw.replace(/\.git$/i, "");

  // git@github.com:owner/repo
  const ssh = /^git@github\.com:([^/]+)\/(.+)$/i.exec(s);
  if (ssh) s = `${ssh[1]}/${ssh[2]}`;

  // https://github.com/owner/repo[/tree/<ref>/<subpath>]
  const gh = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)(?:\/(.+))?)?/i.exec(s);
  if (gh) {
    return {
      owner: gh[1]!,
      repo: gh[2]!,
      ref: gh[3] || undefined,
      subpath: gh[4] ? gh[4].replace(/\/+$/, "") : undefined,
    };
  }

  // https://skills.sh/<owner>/<repo>[/<skill>]
  const sh = /^https?:\/\/(?:www\.)?skills\.sh\/([^/]+)\/([^/]+)(?:\/(.+))?/i.exec(s);
  if (sh) {
    if (sh[1] === "p") {
      throw new Error("pack links aren't supported yet — open the pack and install a skill from its page, or paste owner/repo");
    }
    return { owner: sh[1]!, repo: sh[2]!, subpath: sh[3] ? sh[3].replace(/\/+$/, "") : undefined };
  }

  // owner/repo
  const short = /^([^/\s]+)\/([^/\s]+)$/.exec(s);
  if (short) return { owner: short[1]!, repo: short[2]! };

  throw new Error(`could not read "${raw}" — use owner/repo or a https://skills.sh / github.com link`);
}

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "osama-llama-studio",
  };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

async function fetchText(url: string, headers?: Record<string, string>): Promise<string> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    if (res.status === 403 && !process.env.GITHUB_TOKEN) {
      throw new Error("GitHub rate limit reached — set GITHUB_TOKEN and retry, or try again later");
    }
    if (res.status === 404) throw new Error("not found — check the owner/repo spelling (private repos need GITHUB_TOKEN)");
    throw new Error(`fetch failed: HTTP ${res.status}`);
  }
  return res.text();
}

interface TreeBlob {
  path: string;
  size: number;
}

/**
 * The recursive tree is the expensive call (1 API request, and browsing a repo
 * then installing from it otherwise spends it twice). A short-lived cache
 * makes browse→install cost one request instead of two, which matters under
 * GitHub's 60/h unauthenticated limit.
 */
const TREE_TTL_MS = 10 * 60_000;
const TREE_CACHE_MAX = 16;
const treeCache = new Map<string, { at: number; ref: string; blobs: TreeBlob[] }>();

/** One recursive tree listing + the default branch. Two API calls, at most. */
async function repoTree(source: SkillSource): Promise<{ ref: string; blobs: TreeBlob[] }> {
  const cacheKey = `${source.owner}/${source.repo}@${source.ref ?? ""}`;
  const hit = treeCache.get(cacheKey);
  if (hit && Date.now() - hit.at < TREE_TTL_MS) return { ref: hit.ref, blobs: hit.blobs };

  const base = `https://api.github.com/repos/${source.owner}/${source.repo}`;
  const defaultBranch = async (): Promise<string> => {
    const meta = JSON.parse(await fetchText(base, ghHeaders())) as { default_branch?: string };
    return meta.default_branch || "main";
  };

  const ref = source.ref ?? (await defaultBranch());
  let treeRaw: string;
  try {
    treeRaw = await fetchText(`${base}/git/trees/${encodeURIComponent(ref)}?recursive=1`, ghHeaders());
  } catch (e) {
    // A GitHub URL says /tree/main/... regardless of the default branch. When
    // the named ref doesn't exist, fall back to the repo's default — the
    // subpath still constrains what is shown and installed.
    if (source.ref && /not found/i.test((e as Error).message)) {
      const fallback = await defaultBranch().catch(() => "");
      if (!fallback || fallback === ref) throw e;
      treeRaw = await fetchText(`${base}/git/trees/${encodeURIComponent(fallback)}?recursive=1`, ghHeaders());
      return remember(cacheKey, finish(treeRaw, fallback));
    }
    throw e;
  }
  return remember(cacheKey, finish(treeRaw, ref));

  function remember(key: string, val: { ref: string; blobs: TreeBlob[] }): { ref: string; blobs: TreeBlob[] } {
    if (treeCache.size >= TREE_CACHE_MAX) treeCache.delete(treeCache.keys().next().value!);
    treeCache.set(key, { at: Date.now(), ...val });
    return val;
  }

  function finish(raw: string, ref: string): { ref: string; blobs: TreeBlob[] } {
    const tree = JSON.parse(raw) as { truncated?: boolean; tree?: Array<{ path: string; type: string; size?: number }> };
    if (tree.truncated) throw new Error("this repository is too large to browse");
    const blobs = (tree.tree ?? [])
      .filter((e) => e.type === "blob")
      .map((e) => ({ path: e.path, size: e.size ?? 0 }));
    return { ref, blobs };
  }
}

/** Every skill (a SKILL.md and its directory) in the repo, filtered by subpath. */
function findSkills(blobs: TreeBlob[], subpath?: string): TreeBlob[][] {
  const groups = new Map<string, TreeBlob[]>();
  for (const b of blobs) {
    if (!b.path.endsWith("SKILL.md")) continue;
    const dir = b.path.slice(0, -"SKILL.md".length).replace(/\/$/, "");
    groups.set(dir, []);
  }
  for (const b of blobs) {
    for (const dir of groups.keys()) {
      if (dir === "" || b.path === dir || b.path.startsWith(`${dir}/`)) groups.get(dir)!.push(b);
    }
  }

  let dirs = [...groups.keys()];
  if (subpath) {
    const want = subpath.replace(/^\/+|\/+$/g, "");
    const exact = dirs.filter((d) => d === want || d.endsWith(`/${want}`) || d.split("/").pop() === want);
    if (exact.length) dirs = exact;
    else {
      const under = dirs.filter((d) => d.startsWith(`${want}/`) || d === want);
      if (under.length) dirs = under;
      // otherwise: no match — fall through and let the caller show everything
    }
  }
  return dirs.sort((a, b) => a.localeCompare(b)).slice(0, MAX_SKILLS_LISTED).map((d) => groups.get(d)!);
}

function skillName(blob: TreeBlob[]): string {
  const skillMd = blob.find((b) => b.path.endsWith("SKILL.md"))!;
  const dir = skillMd.path.slice(0, -"SKILL.md".length).replace(/\/$/, "");
  return dir.split("/").pop() || "skill";
}

/** Browse: resolve a source and describe the skills inside it. */
export async function listRemoteSkills(source: SkillSource): Promise<RemoteSkill[]> {
  const { ref, blobs } = await repoTree(source);
  const groups = findSkills(blobs, source.subpath);

  const describe = async (group: TreeBlob[]): Promise<RemoteSkill> => {
    const skillMd = group.find((b) => b.path.endsWith("SKILL.md"))!;
    const dir = skillMd.path.slice(0, -"SKILL.md".length).replace(/\/$/, "");
    let description = "";
    try {
      const text = await fetchText(
        `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${encodeURIComponent(ref)}/${skillMd.path}`,
      );
      description = String(parseFrontmatter(text).meta.description ?? "").trim();
    } catch {
      /* description is cosmetic; the install still works */
    }
    return {
      path: dir,
      name: skillName(group),
      description: description.length > 220 ? `${description.slice(0, 220)}…` : description,
      files: group.length,
      bytes: group.reduce((n, b) => n + b.size, 0),
    };
  };

  const out: RemoteSkill[] = [];
  for (const g of groups) {
    out.push(out.length < MAX_DESCRIPTIONS ? await describe(g) : bare(g));
  }
  return out;

  function bare(group: TreeBlob[]): RemoteSkill {
    const skillMd = group.find((b) => b.path.endsWith("SKILL.md"))!;
    const dir = skillMd.path.slice(0, -"SKILL.md".length).replace(/\/$/, "");
    return { path: dir, name: skillName(group), description: "", files: group.length, bytes: group.reduce((n, b) => n + b.size, 0) };
  }
}

/** Sanitize a directory name into a stable skill id. */
function toId(name: string): string {
  const id = name.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return id || "skill";
}

export function installedSkillsRoot(): string {
  return path.join(osamaHome(), "skills");
}

/**
 * Install one skill from a source. The client sends the skill's path as listed
 * by `listRemoteSkills`; the path is validated against a fresh tree listing
 * rather than trusted, so nothing outside the repo's own skill dirs is fetched.
 */
export async function installRemoteSkill(source: SkillSource, skillPath: string): Promise<InstalledSkill> {
  const { ref, blobs } = await repoTree(source);
  const groups = findSkills(blobs, source.subpath);
  const want = skillPath.replace(/^\/+|\/+$/g, "");
  const group = groups.find((g) => {
    const skillMd = g.find((b) => b.path.endsWith("SKILL.md"))!;
    return skillMd.path.slice(0, -"SKILL.md".length).replace(/\/$/, "") === want;
  });
  if (!group) throw new Error(`"${skillPath}" is not a skill in ${source.owner}/${source.repo}`);

  if (group.length > MAX_FILES_PER_SKILL) throw new Error(`this skill has ${group.length} files (limit ${MAX_FILES_PER_SKILL})`);
  const total = group.reduce((n, b) => n + b.size, 0);
  if (total > MAX_SKILL_BYTES) throw new Error("this skill is larger than 20 MB");
  const oversized = group.find((b) => b.size > MAX_FILE_BYTES);
  if (oversized) throw new Error(`${oversized.path} is larger than 2 MB`);

  const id = toId(skillName(group));
  const dest = path.join(installedSkillsRoot(), id);
  // Only ever write inside `.osama/skills`.
  if (!path.resolve(dest).startsWith(path.resolve(installedSkillsRoot()) + path.sep)) {
    throw new Error("refusing to install outside the skills directory");
  }

  const dir = group.find((b) => b.path.endsWith("SKILL.md"))!.path.slice(0, -"SKILL.md".length);
  const written: string[] = [];
  for (const blob of group) {
    const rel = blob.path.slice(dir.length);
    if (!rel || rel.includes("..") || path.isAbsolute(rel)) throw new Error(`refusing suspicious path ${blob.path}`);
    const res = await fetch(
      `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${encodeURIComponent(ref)}/${blob.path}`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!res.ok) throw new Error(`could not fetch ${blob.path}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const target = path.join(dest, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buf);
    written.push(rel);
  }

  const description = await (async () => {
    try {
      const text = fs.readFileSync(path.join(dest, "SKILL.md"), "utf8");
      return String(parseFrontmatter(text).meta.description ?? "").trim();
    } catch {
      return "";
    }
  })();

  return { id, path: dest, name: skillName(group), description, files: written.sort() };
}

/**
 * Remove an installed skill. Only skills living under `.osama/skills` are
 * removable — never a user-authored tree discovered from another root.
 */
export function removeInstalledSkill(id: string): { ok: boolean; removed?: string; error?: string } {
  const root = path.resolve(installedSkillsRoot());
  const meta = discoverSkills(skillRoots()).find((s) => s.id === id || s.name === id);
  if (!meta) return { ok: false, error: `no skill named "${id}"` };
  if (!path.resolve(meta.file).startsWith(root + path.sep)) {
    return { ok: false, error: "only skills installed under .osama/skills can be removed" };
  }
  try {
    const dir = path.dirname(meta.file);
    if (path.basename(meta.file) === "SKILL.md" && !path.resolve(dir).startsWith(root + path.sep)) {
      return { ok: false, error: "only skills installed under .osama/skills can be removed" };
    }
    if (path.basename(meta.file) === "SKILL.md") fs.rmSync(dir, { recursive: true, force: true });
    else fs.rmSync(meta.file, { force: true });
    return { ok: true, removed: meta.file };
  } catch (e) {
    return { ok: false, error: `could not remove: ${(e as Error).message}` };
  }
}
