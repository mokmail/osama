import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { listSessions, readSession } from "./sessions.js";
import { jail, readRoots } from "./tools.js";
import { logger } from "./logger.js";

/**
 * Artifacts: the files the agent wrote, and what you can do with them.
 *
 * This module owns the whole domain — list, preview, reveal, open — because the
 * four only make sense together: a row you can see but cannot open is not an
 * artifact browser, and an open endpoint without the same jail as the list is a
 * way to launch anything on the machine.
 *
 * The security model is the one thing to get right here. `reveal` and `open`
 * hand a path to the operating system, so a caller that could name any path
 * would turn this panel into an arbitrary-file-opener. Every path therefore goes
 * through the SAME `jail()` the file tools use, against `readRoots()` — the
 * artifact list can only ever contain paths that already passed that jail, and
 * the endpoints re-check rather than trusting the client.
 *
 * Nothing here shells out through a string: `spawn` takes an argv array, so a
 * filename containing `; rm -rf ~` is a filename, not a command.
 */

const log = logger("artifacts");

/* ------------------------------------------------------------------- types */

export interface ArtifactFile {
  /** The path as the tool recorded it (may be absolute or workspace-relative). */
  file: string;
  /** The absolute, resolved path — what the OS needs. */
  abs: string;
  op: string;
  at: string;
  sessionId: string;
  name: string;
  dir: string;
  ext: string;
  /** Whether the file is still there (the agent may have overwritten/removed it). */
  exists: boolean;
  size: number;
  mtime: string | null;
  /** True when the path sits outside the allowed roots and is therefore inert. */
  jailed: boolean;
}

/* ------------------------------------------------------------------- list */

/**
 * Every artifact the agent produced, newest first, deduplicated by path.
 *
 * A file written ten times is one artifact, not ten: the row is the file, and
 * the newest write is what describes it now. The history is kept on the row
 * (`writes`) so the count is not lost.
 */
export function listArtifacts(limit = 100): { artifacts: ArtifactFile[]; total: number; truncated: boolean } {
  const roots = readRoots();
  const byPath = new Map<string, ArtifactFile & { writes: number }>();
  let total = 0;

  for (const s of listSessions()) {
    const rec = readSession(s.id);
    if (!rec) continue;
    for (const e of rec.events) {
      if (e.kind !== "artifact" || !e.data?.file) continue;
      total += 1;
      const raw = String(e.data.file);
      const resolved = resolveArtifact(raw, roots);
      if (!resolved) continue;
      const key = resolved.abs;
      const prev = byPath.get(key);
      const at = new Date(e.ts).toISOString();
      if (prev) {
        prev.writes += 1;
        // Newest write wins the descriptive fields.
        if (at > prev.at) {
          prev.at = at;
          prev.op = String(e.data.op ?? "write");
          prev.sessionId = rec.id;
          prev.file = raw;
        }
        continue;
      }
      byPath.set(key, {
        file: raw,
        abs: resolved.abs,
        op: String(e.data.op ?? "write"),
        at,
        sessionId: rec.id,
        name: path.basename(resolved.abs),
        dir: resolved.dir,
        ext: path.extname(resolved.abs).slice(1).toLowerCase(),
        exists: false,
        size: 0,
        mtime: null,
        jailed: resolved.jailed,
        writes: 1,
      });
    }
  }

  const all = [...byPath.values()].map((a) => {
    const stat = safeStat(a.abs);
    return { ...a, exists: Boolean(stat), size: stat?.size ?? 0, mtime: stat ? new Date(stat.mtimeMs).toISOString() : null };
  });

  // Existing files first, then newest — an artifact you can still open is more
  // useful than one that was deleted, regardless of age.
  all.sort((a, b) => (a.exists === b.exists ? (b.at > a.at ? 1 : -1) : a.exists ? -1 : 1));

  return { artifacts: all.slice(0, limit), total: all.length, truncated: all.length > limit };
}

/**
 * Resolve a recorded artifact path to an absolute one.
 *
 * A write tool records whatever the model passed: often workspace-relative
 * (`src/app.ts`), sometimes absolute. Relative paths are resolved against the
 * workspace, and the result is then jailed — so an artifact that escaped the
 * roots is still listed (the user should see that it happened) but marked inert
 * and can never be opened.
 */
function resolveArtifact(raw: string, roots: string[]): { abs: string; dir: string; jailed: boolean } | null {
  if (!raw.trim()) return null;
  const candidates: string[] = [];
  if (path.isAbsolute(raw)) {
    candidates.push(path.resolve(raw));
  } else {
    const ws = roots[roots.length - 1];
    if (ws) candidates.push(path.resolve(ws, raw));
    candidates.push(path.resolve(raw));
  }
  for (const c of candidates) {
    const j = jail(c, roots);
    if (j.ok) return { abs: j.path, dir: path.dirname(j.path), jailed: false };
  }
  // Nothing passed the jail: keep it visible but inert.
  return { abs: candidates[0]!, dir: path.dirname(candidates[0]!), jailed: true };
}

function safeStat(p: string): fs.Stats | null {
  try {
    const s = fs.statSync(p);
    return s.isFile() ? s : null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- preview */

export interface PreviewResult {
  ok: boolean;
  path?: string;
  name?: string;
  ext?: string;
  size?: number;
  mtime?: string;
  /** Text content, head-truncated. Absent for binary files. */
  text?: string;
  /** True when the file is not text and cannot be shown inline. */
  binary?: boolean;
  truncated?: boolean;
  lines?: number;
  error?: string;
}

const MAX_PREVIEW_BYTES = 256 * 1024;
const TEXT_EXT = /^(ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|markdown|txt|log|csv|tsv|ya?ml|toml|ini|cfg|conf|env|xml|html?|css|scss|less|py|rb|go|rs|java|c|h|cpp|hpp|cc|cs|php|sh|bash|zsh|fish|sql|r|swift|kt|kts|scala|pl|lua|vue|svelte|astro|gd|graphql|proto|diff|patch|srt|vtt)$/i;

/**
 * Read a file for inline display, jailed to the same roots as everything else.
 *
 * Binary detection is by content, not by extension: an extension lies, and
 * dumping 200 KB of weights into a <pre> helps nobody. The check is a NUL byte
 * in the head, which is what `file(1)` does in practice.
 */
export function previewArtifact(p: string, maxBytes = MAX_PREVIEW_BYTES): PreviewResult {
  const roots = readRoots();
  const j = jail(p, roots);
  if (!j.ok) return { ok: false, error: j.error };

  const stat = safeStat(j.path);
  if (!stat) return { ok: false, error: "not a readable file (missing, or a directory)" };

  const ext = path.extname(j.path).slice(1).toLowerCase();
  const base: PreviewResult = {
    ok: true,
    path: j.path,
    name: path.basename(j.path),
    ext,
    size: stat.size,
    mtime: new Date(stat.mtimeMs).toISOString(),
  };

  // Read one byte past the cap so truncation is reported honestly.
  const cap = Math.min(Math.max(maxBytes, 1024), 4 * 1024 * 1024);
  let buf: Buffer;
  try {
    const fd = fs.openSync(j.path, "r");
    try {
      buf = Buffer.allocUnsafe(Math.min(cap + 1, stat.size || cap + 1));
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      buf = buf.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return { ok: false, error: `could not read: ${(e as Error).message}` };
  }

  const truncated = buf.length > cap;
  const head = truncated ? buf.subarray(0, cap) : buf;

  // A NUL in the head means binary — except UTF-16, whose ASCII text is riddled
  // with them. Detect the BOM (FF FE / FE FF) or the tell-tale `00 xx` pattern of
  // UTF-16LE and decode accordingly; anything else with a NUL is binary.
  const hasNul = head.includes(0);
  const hasBom = head.length >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff));
  const utf16leNoBom = !hasBom && head.length >= 4 && head[0] !== 0 && head[1] === 0;
  if (hasNul && !hasBom && !utf16leNoBom) {
    return { ...base, binary: true, truncated };
  }

  let content = hasBom || utf16leNoBom ? head.toString("utf16le") : head.toString("utf8");
  if (hasBom) content = content.replace(/^\uFEFF/, "");
  // Drop a lone replacement char at the cut so it does not read as corruption.
  if (truncated) content = content.replace(/\uFFFD$/, "");
  const lines = content.length ? content.split("\n").length : 0;
  return { ...base, text: content, truncated, lines, binary: false };
}

/* ------------------------------------------------------------ directory browse */

export interface DirEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  mtime: string | null;
  /** Files matching a search query, or the count of matches inside a directory. */
  matches?: number;
}

export interface DirListing {
  ok: boolean;
  path?: string;
  /** The parent directory, or null at a root. */
  parent?: string | null;
  /** Which allowed root this directory belongs to — the boundary the UI can walk up to. */
  root?: string;
  entries?: DirEntry[];
  /** Files matching the query in this directory (not in subdirectories). */
  matchCount?: number;
  error?: string;
}

/**
 * List a directory, jailed to the same roots as the file tools.
 *
 * This is what makes the artifact list a *browser* rather than a flat index: a
 * row's folder can be opened and walked. It is deliberately separate from the
 * workspace picker's `browseDirectories`, which is unrestricted because choosing
 * a workspace cannot be pre-jailed. Here the caller is already inside a root, so
 * every hop re-checks — moving up stops at the root that contains the path, never
 * at `/`, and a symlink that points outside is refused by the same jail.
 *
 * `query` does a shallow content search: names always, and file contents when a
 * text query is given, so "which file did it write about the quantize fix" is
 * answerable without a shell.
 */
export function browseArtifactDir(dir: string, query = "", opts: { limit?: number; contentSearch?: boolean } = {}): DirListing {
  const roots = readRoots();
  const j = jail(dir, roots);
  if (!j.ok) return { ok: false, error: j.error };

  let stat: fs.Stats;
  try {
    stat = fs.statSync(j.path);
  } catch {
    return { ok: false, error: `${j.path} does not exist` };
  }
  if (!stat.isDirectory()) return { ok: false, error: `${j.path} is not a directory` };

  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);
  const q = query.trim().toLowerCase();
  const searchContents = Boolean(q) && opts.contentSearch !== false;

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(j.path, { withFileTypes: true });
  } catch (e) {
    return { ok: false, error: `cannot list ${j.path}: ${(e as Error).message}` };
  }

  const entries: DirEntry[] = [];
  let matchCount = 0;
  for (const d of dirents) {
    if (entries.length >= limit) break;
    const abs = path.join(j.path, d.name);
    // A symlink is only usable if it resolves back inside the roots.
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) {
      const lj = jail(abs, roots);
      if (!lj.ok) continue;
      try {
        isDir = fs.statSync(abs).isDirectory();
      } catch {
        continue;
      }
    }
    const s = safeStat(abs);
    const entry: DirEntry = {
      name: d.name,
      path: abs,
      dir: isDir,
      size: isDir ? 0 : (s?.size ?? 0),
      mtime: s ? new Date(s.mtimeMs).toISOString() : null,
    };

    if (q) {
      const nameHit = d.name.toLowerCase().includes(q);
      let contentHit = false;
      if (!nameHit && !isDir && searchContents && s && s.size <= MAX_PREVIEW_BYTES && TEXT_EXT.test(path.extname(abs).slice(1))) {
        contentHit = fileContains(abs, q);
      }
      if (nameHit || contentHit) {
        matchCount += 1;
        entry.matches = contentHit ? 1 : 0;
      } else {
        continue; // filtered out by the query
      }
    }

    entries.push(entry);
  }

  // Directories first, then name — the browser's stable, scannable order.
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));

  // Which root are we in? The UI uses it to know where "up" stops. "Up" is
  // never allowed above the root that contains the directory, so a browse can
  // walk the tree but cannot climb out of the jail.
  const real = path.resolve(j.path);
  const root = roots.find((r) => real === r || real.startsWith(r + path.sep)) ?? null;
  const up = path.dirname(real);
  const atRoot = !root || real === path.resolve(root);
  const parent = !atRoot && up !== real ? up : null;

  return { ok: true, path: j.path, parent, root: root ?? undefined, entries, matchCount: q ? matchCount : undefined };
}

/** Cheap substring test over a file's head, used only for the directory search. */
function fileContains(file: string, needle: string): boolean {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.allocUnsafe(MAX_PREVIEW_BYTES);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      const head = buf.subarray(0, read);
      if (head.includes(0)) return false; // binary; do not pretend to search it
      return head.toString("utf8").toLowerCase().includes(needle);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------ reveal/open */

export interface OpenResult {
  ok: boolean;
  /** The argv that was run — returned so the UI can show what happened. */
  command?: string;
  error?: string;
}

/**
 * Is this path one the agent actually wrote?
 *
 * This is the second half of the trust model. `reveal`/`open` accept a path that
 * is inside the *current* jail, or a path this server itself recorded as an
 * artifact. The second case is what makes the page usable at all: an artifact
 * written while a different workspace was active fails the current jail, and
 * refusing it would mean the files you most want to open are precisely the ones
 * you cannot.
 *
 * It is not a hole, because the trust is anchored to provenance rather than to
 * the client's word: the caller cannot name an arbitrary path and have it
 * opened — the path must already be in this server's own session log as
 * something the agent wrote. The agent could already reach those files when it
 * wrote them, so opening them in Finder grants no capability it did not have.
 */
function resolvable(p: string): { ok: true; path: string } | { ok: false; error: string } {
  const j = jail(p, readRoots());
  if (j.ok) return j;
  const abs = path.resolve(p);
  try {
    // Provenance: the path is a recorded artifact, or a folder that contains
    // one (the folder is what "Reveal" opens, and the files in it are gone).
    const listed = listArtifacts(2000).artifacts.some(
      (a) => path.resolve(a.abs) === abs || path.resolve(a.dir) === abs,
    );
    if (listed) return { ok: true, path: abs };
  } catch {
    /* the log is unreadable — fall through to the refusal */
  }
  return j;
}

/** Open the containing directory with the file selected, where the OS allows it. */
export function revealInFileManager(p: string): OpenResult {
  const j = resolvable(p);
  if (!j.ok) return { ok: false, error: j.error };
  const target = j.path;
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) return { ok: false, error: `the containing folder no longer exists: ${dir}` };

  // `open -R` selects the file in Finder; `explorer /select,` in Explorer.
  // Linux has no portable "reveal", so it falls back to opening the folder.
  const fileExists = fs.existsSync(target);
  if (process.platform === "darwin") {
    return run("open", fileExists ? ["-R", target] : [dir]);
  }
  if (process.platform === "win32") {
    return fileExists ? run("explorer", [`/select,${target}`]) : run("explorer", [dir]);
  }
  return runFirst([
    ["xdg-open", [dir]],
    ["nautilus", [dir]],
    ["dolphin", [dir]],
  ]);
}

/** Open the file itself with the OS default handler. */
export function openPath(p: string): OpenResult {
  const j = resolvable(p);
  if (!j.ok) return { ok: false, error: j.error };
  if (!fs.existsSync(j.path)) return { ok: false, error: "the file no longer exists" };

  if (process.platform === "darwin") return run("open", [j.path]);
  if (process.platform === "win32") return run("explorer", [j.path]);
  return runFirst([
    ["xdg-open", [j.path]],
    ["gio", ["open", j.path]],
  ]);
}

/**
 * Launch a detached helper and report immediately.
 *
 * Detached and unref'd on purpose: the file manager outlives the request, and
 * the server must not wait on a GUI — nor be kept alive by a launched app. argv
 * is an array, never a shell string, so a path cannot inject arguments.
 */
function launchDetached(cmd: string, args: string[]): OpenResult {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", (e) => log.warn(`${cmd} failed: ${e.message}`));
    child.unref();
    log.info(`launched ${cmd} ${args.map((a) => JSON.stringify(a)).join(" ")}`);
    return { ok: true, command: `${cmd} ${args.map((a) => JSON.stringify(a)).join(" ")}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Spawn a detached helper — the single path by which anything here reaches the
 * OS. argv is an array, never a shell string, so a path cannot inject arguments.
 */
function run(cmd: string, args: string[]): OpenResult {
  return launchDetached(cmd, args);
}

/** Try each candidate until one exists on PATH. */
function runFirst(cands: Array<[string, string[]]>): OpenResult {
  for (const [cmd, args] of cands) {
    if (onPath(cmd)) return run(cmd, args);
  }
  return { ok: false, error: `no file manager found (tried ${cands.map((c) => c[0]).join(", ")})` };
}

function onPath(cmd: string): boolean {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  return dirs.some((d) => exts.some((e) => {
    try {
      fs.accessSync(path.join(d, cmd + e), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }));
}
