import fs from "node:fs";
import { promises as fsp } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { osamaHome, REPO_ROOT } from "../paths.js";
import { getWorkspace } from "../workspace.js";

/**
 * Directories the agent may read. Writes are narrowed further, to `writableRoots`.
 * REPO_ROOT is always allowed so the app can inspect itself, and the chosen
 * workspace is added so the user's own folder is usable.
 */
export function readRoots(): string[] {
  const roots = [osamaHome(), REPO_ROOT, process.cwd()];
  try {
    roots.push(getWorkspace());
  } catch {
    /* workspace module not wired — the defaults still hold */
  }
  if (process.env.OSAMA_AGENT_ROOTS) {
    for (const r of process.env.OSAMA_AGENT_ROOTS.split(path.delimiter)) {
      if (r.trim()) roots.push(path.resolve(r.trim()));
    }
  }
  return dedupe(roots.map((r) => path.resolve(r)));
}

/**
 * Directories the agent may write to: the scratch area it owns, plus the
 * workspace the user chose. The workspace is dropped if it CONTAINS Osama's
 * source tree — an agent working inside the repo root must not be able to
 * rewrite the app implementing it.
 */
export function writableRoots(): string[] {
  const home = osamaHome();
  const roots = [path.join(home, "workspace"), path.join(home, "agent")];
  try {
    const ws = getWorkspace();
    // Guard: never add a root that would grant write access to Osama itself.
    // A source tree inside the workspace gets a nested jail instead.
    const sourceProtected = [REPO_ROOT, home];
    const wouldCoverSource = sourceProtected.some((src) => ws === src || src.startsWith(ws + path.sep));
    if (!wouldCoverSource) roots.push(ws);
  } catch {
    /* defaults only */
  }
  return dedupe(roots.map((r) => path.resolve(r)));
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}

/**
 * Resolve `p` and prove it stays inside one of `roots`.
 *
 * This is the security boundary: a symlink, a `..` walk or an absolute path
 * that escapes the roots is rejected here rather than being left to each tool.
 * The check runs against the *real* path (symlinks resolved) so a link inside a
 * root cannot be used to reach outside it.
 */
export function jail(p: string, roots: string[]): { ok: true; path: string } | { ok: false; error: string } {
  if (!p || typeof p !== "string") return { ok: false, error: "path is required" };
  const resolved = path.resolve(p);
  const real = realpathish(resolved);
  for (const root of roots) {
    const rootReal = realpathish(path.resolve(root));
    if (real === rootReal || real.startsWith(rootReal + path.sep)) return { ok: true, path: resolved };
  }
  return {
    ok: false,
    error: `path is outside the allowed roots (${roots.join(", ")})`,
  };
}

/** realpath that tolerates a path that does not exist yet (for create/write). */
function realpathish(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    const parent = path.dirname(p);
    if (parent === p) return p;
    try {
      return path.join(fs.realpathSync(parent), path.basename(p));
    } catch {
      return p;
    }
  }
}

export const MAX_READ_BYTES = 512 * 1024;
export const MAX_WRITE_BYTES = 1024 * 1024;
export const MAX_GREP_HITS = 200;
export const MAX_ENTRIES = 500;
/** Default cap on how many lines read_file will return in one call. */
export const MAX_READ_LINES = 4000;
/** Files larger than this are summarized rather than dumped. */
export const LARGE_FILE_BYTES = 1024 * 1024;

/**
 * Directories that never hold useful files, skipped to keep scans cheap.
 * Kept as one set so every walker (grep/glob/tree) skips the same things.
 */
export const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", "target", "vendor",
  "coverage", "tmp", "temp", "logs", ".git",
]);

/** Binary-looking extensions we never read as text. */
const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tiff", "avif", "heic",
  "mp3", "wav", "flac", "ogg", "m4a", "aac",
  "mp4", "mov", "avi", "mkv", "webm",
  "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "woff", "woff2", "ttf", "otf", "eot",
  "so", "dylib", "dll", "exe", "bin", "o", "a", "node", "wasm",
  "gguf", "ggml", "safetensors", "pt", "onnx", "pkl", "npy", "npz",
  "db", "sqlite", "sqlite3",
]);

/**
 * A NUL byte in the first 8 KB is the cheap, reliable "this is binary" signal.
 * Combined with the extension set it avoids handing the model mojibake.
 */
export function looksBinary(buf: Buffer, name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (BINARY_EXT.has(ext)) return true;
  return buf.subarray(0, 8192).includes(0);
}

/**
 * Walk a directory tree with promise-based I/O and a global result cap.
 *
 * The old walkers were synchronous and recursive: a `grep` over a big tree
 * blocked the event loop, so the server could not answer a health check while
 * a search ran. This uses `fs.promises`, so a walk yields between directories
 * and the server stays responsive, and it stops as soon as `cap` results are
 * collected or the caller says stop.
 *
 * Subdirectories are descended with a small concurrency window so a very wide
 * tree does not open an unbounded number of descriptors at once.
 */
export interface WalkOptions {
  root: string;
  /** Called per file; return true to stop the whole walk immediately. */
  onFile?: (abs: string, rel: string) => boolean | void;
  /** Called per directory before descending. Return false to skip it. */
  onDir?: (abs: string, rel: string) => boolean | void;
  /** Hard stop once this many files have been seen. */
  cap?: number;
  maxDepth?: number;
  /** Include dotfiles and dot-directories (default false). */
  hidden?: boolean;
  /** Max subdirectories walked at once. */
  maxConcurrency?: number;
  signal?: AbortSignal;
}

export async function walk(opts: WalkOptions): Promise<{ visited: number; capped: boolean }> {
  const cap = opts.cap ?? MAX_GREP_HITS;
  const maxDepth = opts.maxDepth ?? 12;
  const maxConcurrency = Math.max(1, opts.maxConcurrency ?? 8);
  let visited = 0;
  let capped = false;
  let stopped = false;

  // A tiny FIFO semaphore: `acquire` resolves when a slot is free.
  let running = 0;
  const waiters: Array<() => void> = [];
  const acquire = (): Promise<void> => {
    if (running < maxConcurrency) { running++; return Promise.resolve(); }
    return new Promise<void>((res) => waiters.push(() => { running++; res(); }));
  };
  const release = (): void => {
    running--;
    const next = waiters.shift();
    if (next) next();
  };

  const visitDir = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (stopped || depth > maxDepth || opts.signal?.aborted) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip silently
    }

    const subdirs: Array<{ abs: string; rel: string }> = [];
    for (const e of entries) {
      if (stopped) return;
      if (!opts.hidden && e.name.startsWith(".")) continue;
      const abs = path.join(dir, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) {
        try { isDir = (await fsp.stat(abs)).isDirectory(); } catch { /* broken link */ }
      }
      if (isDir) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (opts.onDir && opts.onDir(abs, childRel) === false) continue;
        subdirs.push({ abs, rel: childRel });
      } else {
        if (visited >= cap) { capped = true; stopped = true; return; }
        visited++;
        if (opts.onFile?.(abs, childRel) === true) { stopped = true; return; }
      }
    }

    // Descend concurrently, bounded by the semaphore.
    await Promise.all(subdirs.map(async (d) => {
      if (stopped) return;
      await acquire();
      try { await visitDir(d.abs, d.rel, depth + 1); } finally { release(); }
    }));
  };

  await visitDir(opts.root, "", 1);
  return { visited, capped };
}

/** Format bytes for a human summary (1.2 MB, 340 KB, 12 B). */
export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Count lines in a buffer without materializing an array of every line. */
export function countLines(buf: Buffer): number {
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
  return buf.length && buf[buf.length - 1] !== 10 ? n + 1 : n;
}

/** A short content hash, so an agent can tell whether a file changed. */
export function shortHash(buf: Buffer | string): string {
  return crypto.createHash("sha1").update(buf).digest("hex").slice(0, 12);
}

/**
 * Compile a shell-style glob (`**`, `*`, `?`, `{a,b}`) into a RegExp.
 * `**` crosses directory separators; `*` and `?` do not.
 */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` or a trailing `**`: cross directories
        re += pattern[i + 2] === "/" ? "(?:.+/)?" : ".*";
        i += pattern[i + 2] === "/" ? 3 : 2;
        continue;
      }
      re += "[^/]*";
      i++;
      continue;
    }
    if (c === "?") { re += "[^/]"; i++; continue; }
    if (c === "{") {
      const end = pattern.indexOf("}", i);
      if (end < 0) throw new Error("unmatched {");
      re += `(?:${pattern.slice(i + 1, end).split(",").join("|")})`;
      i = end + 1;
      continue;
    }
    re += c.replace(/[.+^$|()[\]\\]/g, "\\$&");
    i++;
  }
  return new RegExp(`^${re}$`);
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated, ${text.length - max} more characters]`;
}
