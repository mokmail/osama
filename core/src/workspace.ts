import fs from "node:fs";
import path from "node:path";
import { osamaHome, REPO_ROOT } from "./paths.js";

/**
 * The agent workspace: the directory the agent works *inside*.
 *
 * Agentic mode executes real tools, so which directory they act on is a
 * decision the user has to make rather than something the app silently picks.
 * The choice is persisted, and it widens the path jail: the workspace is added
 * to both the readable roots and the writable roots, so a user-chosen folder is
 * usable without opening up anything else.
 */

const STATE = () => path.join(osamaHome(), "workspace.json");

/** The default: a scratch dir Osama owns, so the app is useful with no setup. */
export function defaultWorkspace(): string {
  return path.join(osamaHome(), "workspace");
}

let cached: string | null = null;

/** The active workspace path (created on demand). */
export function getWorkspace(): string {
  if (cached) return cached;
  const fromEnv = process.env.OSAMA_WORKSPACE?.trim();
  if (fromEnv) return (cached = path.resolve(fromEnv));
  try {
    const saved = JSON.parse(fs.readFileSync(STATE(), "utf8")) as { path?: string };
    if (saved.path && typeof saved.path === "string") return (cached = path.resolve(saved.path));
  } catch {
    /* no saved choice yet — fall through to the default */
  }
  return (cached = defaultWorkspace());
}

/** True when the user has actually chosen somewhere (rather than the default). */
export function workspaceChosen(): boolean {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE(), "utf8")) as { path?: string };
    return Boolean(saved.path);
  } catch {
    return false;
  }
}

export interface WorkspaceResult {
  ok: boolean;
  path?: string;
  created?: boolean;
  error?: string;
}

/**
 * Point the agent at a directory. A path that does not exist yet is created, so
 * "new folder here" works; anything else must be an existing directory.
 */
export function setWorkspace(dir: string, opts: { create?: boolean } = {}): WorkspaceResult {
  const raw = dir?.trim();
  if (!raw) return { ok: false, error: "a path is required" };
  if (raw.includes("\0")) return { ok: false, error: "invalid path" };

  const resolved = path.resolve(raw.startsWith("~") ? raw.replace(/^~/, process.env.HOME ?? "") : raw);
  let created = false;

  try {
    if (fs.existsSync(resolved)) {
      if (!fs.statSync(resolved).isDirectory()) return { ok: false, error: `${resolved} is a file, not a directory` };
    } else if (opts.create !== false) {
      fs.mkdirSync(resolved, { recursive: true });
      created = true;
    } else {
      return { ok: false, error: `${resolved} does not exist` };
    }
  } catch (e) {
    return { ok: false, error: `cannot use ${resolved}: ${(e as Error).message}` };
  }

  try {
    fs.mkdirSync(osamaHome(), { recursive: true });
    fs.writeFileSync(STATE(), JSON.stringify({ path: resolved, at: new Date().toISOString() }, null, 2), "utf8");
  } catch (e) {
    return { ok: false, error: `chosen, but could not be saved: ${(e as Error).message}` };
  }

  cached = resolved;
  // Deliberately not written to process.env: that would outlive the choice and
  // make `workspaceChosen()` report a choice the user had cleared. The env var
  // exists only as a boot-time override, and the agent's tools receive the
  // workspace explicitly rather than reading the environment.
  return { ok: true, path: resolved, created };
}

/**
 * Places worth offering before the user types anything. These are only
 * suggestions — the picker accepts any path.
 */
export function workspaceCandidates(): Array<{ path: string; label: string; exists: boolean; note?: string }> {
  const home = process.env.HOME ?? "";
  const picks: Array<{ path: string; label: string; note?: string }> = [
    { path: defaultWorkspace(), label: "Agent scratch space", note: "a folder Osama owns — safe default" },
    { path: REPO_ROOT, label: "This repo", note: "the Osama source tree" },
    { path: path.join(home, "Documents"), label: "Documents" },
    { path: process.cwd(), label: "Working directory" },
  ];
  const seen = new Set<string>();
  return picks
    .filter((p) => {
      const k = path.resolve(p.path);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((p) => ({
      ...p,
      path: path.resolve(p.path),
      exists: (() => {
        try {
          return fs.statSync(path.resolve(p.path)).isDirectory();
        } catch {
          return false;
        }
      })(),
    }));
}

export interface BrowseEntry {
  name: string;
  path: string;
  hidden: boolean;
}

export interface BrowseResult {
  ok: boolean;
  path?: string;
  parent?: string | null;
  home?: string | null;
  entries?: BrowseEntry[];
  error?: string;
}

/**
 * List the subdirectories of a directory — the workspace browser's one call.
 * Directories only (the workspace must be one), hidden entries included but
 * sorted last, symlinked dirs resolved so they behave like the real thing.
 */
export function browseDirectories(dir: string): BrowseResult {
  const raw = dir?.trim();
  if (!raw) return { ok: false, error: "a path is required" };
  const resolved = path.resolve(raw.startsWith("~") ? raw.replace(/^~/, process.env.HOME ?? "") : raw);

  try {
    if (!fs.statSync(resolved).isDirectory()) return { ok: false, error: `${resolved} is not a directory` };
  } catch {
    return { ok: false, error: `${resolved} does not exist` };
  }

  try {
    const entries = fs
      .readdirSync(resolved, { withFileTypes: true })
      .filter((e) => {
        if (e.isDirectory()) return true;
        if (!e.isSymbolicLink()) return false;
        try {
          return fs.statSync(path.join(resolved, e.name)).isDirectory();
        } catch {
          return false; // broken link
        }
      })
      .map((e) => ({ name: e.name, path: path.join(resolved, e.name), hidden: e.name.startsWith(".") }))
      .sort((a, b) => (a.hidden === b.hidden ? a.name.localeCompare(b.name) : a.hidden ? 1 : -1));

    const parent = path.dirname(resolved);
    return { ok: true, path: resolved, parent: parent === resolved ? null : parent, home: process.env.HOME ?? null, entries };
  } catch (e) {
    return { ok: false, error: `cannot list ${resolved}: ${(e as Error).message}` };
  }
}

/**
 * A compact, plain-text summary of the workspace's top-level layout — the path
 * plus immediate children (with a depth-1 hint). Goes into the agent's system
 * prompt so it knows where it is without spending a round-trip on list_dir.
 *
 * Bounded by `maxChars` so a workspace with thousands of files does not blow
 * up the context window.
 */
export function workspaceSnapshot(maxChars = 600): string {
  const ws = getWorkspace();
  let out = `path: ${ws}\n`;
  try {
    const entries = fs.readdirSync(ws, { withFileTypes: true });
    const visible = entries
      .filter((e) => !e.name.startsWith("."))
      .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    if (visible.length === 0) {
      out += "(empty)\n";
    } else {
      for (const e of visible.slice(0, 40)) {
        const rel = e.name + (e.isDirectory() ? "/" : "");
        out += `- ${rel}\n`;
        if (out.length > maxChars) {
          out += "…(more)\n";
          break;
        }
      }
    }
  } catch (e) {
    out += `(unreadable: ${(e as Error).message})\n`;
  }
  return out.trimEnd();
}

/**
 * The files inside the workspace, for the composer's `@`-mention picker.
 *
 * Walks the workspace (bounded depth + result cap so a huge tree cannot hang
 * the request), skipping heavy/irrelevant directories, and returns
 * workspace-relative paths. Directories are returned too — the picker lets the
 * user drill into them — with a trailing slash so the UI can style them.
 */
export interface WorkspaceFile {
  /** Path relative to the workspace root, using forward slashes. */
  rel: string;
  name: string;
  dir: boolean;
  size: number;
}

const MENTION_SKIP = new Set([
  "node_modules", "dist", "build", "out", "target", "vendor",
  "coverage", ".git", "__pycache__", ".venv", "venv",
]);

export function listWorkspaceFiles(max = 2000, maxDepth = 6): { path: string; files: WorkspaceFile[]; truncated: boolean } {
  const ws = getWorkspace();
  const files: WorkspaceFile[] = [];
  let truncated = false;

  const walk = (dir: string, depth: number): void => {
    if (truncated || depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable folder — skip silently
    }
    for (const e of entries) {
      if (files.length >= max) { truncated = true; return; }
      const abs = path.join(dir, e.name);
      const rel = path.relative(ws, abs).split(path.sep).join("/");
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) {
        try { isDir = fs.statSync(abs).isDirectory(); } catch { /* broken link */ }
      }
      if (isDir) {
        if (MENTION_SKIP.has(e.name)) continue; // never offer these
        files.push({ rel: rel + "/", name: e.name, dir: true, size: 0 });
        walk(abs, depth + 1);
      } else {
        let size = 0;
        try { size = fs.statSync(abs).size; } catch { /* ignore */ }
        // hidden files are offered last (they are rarely what one means)
        files.push({ rel, name: e.name, dir: false, size });
      }
    }
  };

  walk(ws, 0);
  files.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    return a.rel.localeCompare(b.rel);
  });
  return { path: ws, files, truncated };
}

/**
 * Read a workspace file chosen from the `@` picker, as a text attachment.
 * The path is confined to the workspace; anything else is refused. Returns a
 * plain shape (not an fs error) so the route can answer 400 with a reason.
 */
export function readWorkspaceFile(
  rel: string,
  maxBytes = 512 * 1024,
): { ok: true; name: string; rel: string; size: number; mime: string; text: string } | { ok: false; error: string } {
  const ws = getWorkspace();
  if (!rel || typeof rel !== "string") return { ok: false, error: "a path is required" };
  const abs = path.resolve(ws, rel);
  const wsReal = (() => { try { return fs.realpathSync(ws); } catch { return ws; } })();
  const absReal = (() => {
    try { return fs.realpathSync(abs); } catch {
      try { return path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)); } catch { return abs; }
    }
  })();
  if (absReal !== wsReal && !absReal.startsWith(wsReal + path.sep)) {
    return { ok: false, error: "that file is outside the workspace" };
  }
  let st: fs.Stats;
  try { st = fs.statSync(absReal); } catch { return { ok: false, error: `${rel} does not exist` }; }
  if (st.isDirectory()) return { ok: false, error: `${rel} is a directory` };
  if (st.size > maxBytes) return { ok: false, error: `${rel} is too large to inline (${st.size} bytes > ${maxBytes})` };
  let buf: Buffer;
  try { buf = fs.readFileSync(absReal); } catch (e) { return { ok: false, error: `cannot read ${rel}: ${(e as Error).message}` }; }
  // binary sniff: a NUL byte in the first 8 KB means "not text"
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) return { ok: false, error: `${rel} looks binary — reference it as a path instead` };
  const name = path.basename(absReal);
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const MIME: Record<string, string> = {
    ts: "text/typescript", tsx: "text/typescript", js: "text/javascript", jsx: "text/javascript",
    py: "text/x-python", rb: "text/x-ruby", rs: "text/x-rust", go: "text/x-go",
    md: "text/markdown", txt: "text/plain", json: "application/json", csv: "text/csv",
    yml: "text/yaml", yaml: "text/yaml", toml: "text/plain", html: "text/html", css: "text/css",
    sh: "text/x-shellscript", sql: "text/x-sql", log: "text/plain",
  };
  return { ok: true, name, rel: path.relative(ws, absReal).split(path.sep).join("/"), size: st.size, mime: MIME[ext] ?? "text/plain", text: buf.toString("utf8") };
}
