import fs from "node:fs";
import path from "node:path";
import { osamaHome, REPO_ROOT } from "./paths.js";

/**
 * Skills: folders of instructions the agent loads on demand.
 *
 * Mirrors `dsh-skill-filesystem` + `dsh-tool-skill`: author a skill as a
 * directory bundle containing `SKILL.md`, or a flat `<name>.md`, under a
 * scanned root; the frontmatter supplies the name and description that appear
 * in the catalog. The catalog is cheap and always visible to the model — the
 * body is only pulled in when a `load_skill` call asks for it.
 *
 * The same SKILL.md convention the rest of the user's tooling uses, so skills
 * authored for other agents work here unchanged.
 */

export interface SkillMeta {
  /** Directory name (or file stem) — the stable id used by load_skill. */
  id: string;
  name: string;
  description: string;
  /** Absolute path of the SKILL.md (or the flat .md file). */
  file: string;
  root: string;
  /** Frontmatter worth surfacing in the catalog. */
  tags?: string[];
  version?: string;
}

export interface LoadedSkill extends SkillMeta {
  body: string;
  /** Supporting files shipped beside the skill (references/, scripts/, ...). */
  files: string[];
}

/** Roots scanned for skills, most specific first. */
export function skillRoots(extra: string[] = []): string[] {
  const roots = [
    ...extra,
    ...(process.env.OSAMA_SKILL_ROOTS ? process.env.OSAMA_SKILL_ROOTS.split(path.delimiter) : []),
    path.join(osamaHome(), "skills"),
    path.join(REPO_ROOT, "skills"),
    REPO_ROOT,
  ];
  return [...new Set(roots.filter(Boolean).map((r) => path.resolve(r.trim())))]
    // A skill root must exist and not be the repo root itself unless it has skills.
    .filter((r) => {
      try {
        return fs.statSync(r).isDirectory();
      } catch {
        return false;
      }
    });
}

const MAX_SKILL_BYTES = 256 * 1024;
const MAX_SCAN_DEPTH = 3;

/** Minimal YAML frontmatter reader: flat keys plus `- item` lists. */
export function parseFrontmatter(text: string): { meta: Record<string, unknown>; body: string } {
  if (!text.startsWith("---")) return { meta: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { meta: {}, body: text };
  const raw = text.slice(3, end);
  const body = text.slice(end + 4).replace(/^\r?\n/, "");
  const meta: Record<string, unknown> = {};
  let listKey: string | null = null;
  for (const line of raw.split("\n")) {
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && listKey) {
      const arr = (meta[listKey] as unknown[]) ?? [];
      arr.push(listItem[1]!.trim());
      meta[listKey] = arr;
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    const value = (kv[2] ?? "").trim().replace(/^["']|["']$/g, "");
    if (value === "") {
      listKey = key;
      meta[key] = [];
    } else if (value.startsWith("[") && value.endsWith("]")) {
      meta[key] = value.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      listKey = null;
    } else {
      meta[key] = value;
      listKey = null;
    }
  }
  return { meta, body };
}

function readSkill(file: string, root: string, idHint: string): SkillMeta | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_SKILL_BYTES) return null;
    const text = fs.readFileSync(file, "utf8");
    const { meta } = parseFrontmatter(text);
    const name = String(meta.name ?? idHint);
    const description = String(meta.description ?? "");
    return {
      id: idHint,
      name,
      description,
      file,
      root,
      tags: Array.isArray(meta.tags) ? (meta.tags as string[]) : undefined,
      version: meta.version ? String(meta.version) : undefined,
    };
  } catch {
    return null;
  }
}

/** True when the file opens with a `---` frontmatter block that has content. */
function hasFrontmatter(file: string): boolean {
  try {
    const head = fs.readFileSync(file, "utf8").slice(0, 2048);
    if (!head.startsWith("---")) return false;
    const end = head.indexOf("\n---", 3);
    return end > 3;
  } catch {
    return false;
  }
}

/** Directories that never hold authored skills, skipped to keep scans cheap. */
const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", "target", "vendor",
  "coverage", "tmp", "temp", "logs",
]);

/**
 * Discover every skill under the given roots.
 *
 * Recognises both layouts: `<dir>/SKILL.md` and `<dir>/<name>.md`. A directory
 * named `skills` is descended into one extra level so a shared root works.
 */
export function discoverSkills(roots: string[] = skillRoots()): SkillMeta[] {
  const found = new Map<string, SkillMeta>();

  const scan = (dir: string, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const skillFile = path.join(full, "SKILL.md");
        const meta = fs.existsSync(skillFile) ? readSkill(skillFile, dir, e.name) : null;
        if (meta) {
          if (!found.has(meta.id)) found.set(meta.id, meta);
          continue; // a skill bundle does not contain nested skills
        }
        scan(full, depth + 1);
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".md") && e.name.toLowerCase() !== "readme.md") {
        // A flat markdown file only counts as a skill when it is actually
        // authored as one — i.e. it carries frontmatter. Without this, every
        // stray doc in a scanned root (overview.md, notes.md) would appear in
        // the catalog and crowd out the real skills.
        const id = e.name.replace(/\.md$/i, "");
        const meta = readSkill(full, dir, id);
        if (meta && (meta.description || hasFrontmatter(full)) && !found.has(meta.id)) found.set(meta.id, meta);
      }
    }
  };

  for (const root of roots) scan(root, 0);
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Load one skill's full instructions plus its supporting-file listing. */
export function loadSkill(id: string, roots: string[] = skillRoots()): LoadedSkill | null {
  const meta = discoverSkills(roots).find((s) => s.id === id || s.name === id);
  if (!meta) return null;
  let body = "";
  try {
    const text = fs.readFileSync(meta.file, "utf8");
    body = parseFrontmatter(text).body;
  } catch {
    return null;
  }
  const dir = path.dirname(meta.file);
  const files: string[] = [];
  const walk = (d: string, prefix: string, depth: number): void => {
    if (depth > 2 || files.length >= 40) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), rel, depth + 1);
      else if (!(prefix === "" && e.name === path.basename(meta.file))) files.push(rel);
    }
  };
  walk(dir, "", 0);
  return { ...meta, body, files: files.sort() };
}

/** The always-visible catalog: id + description, one line each. */
export function skillCatalog(skills: SkillMeta[]): string {
  if (!skills.length) return "(no skills installed)";
  return skills
    .map((s) => {
      const desc = s.description.length > 160 ? `${s.description.slice(0, 160)}…` : s.description;
      return `- ${s.id}: ${desc || s.name}`;
    })
    .join("\n");
}
