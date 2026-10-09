import fs from "node:fs";
import { promises as fsp } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { osamaHome, REPO_ROOT } from "./paths.js";
import { getWorkspace } from "./workspace.js";
import { describeBreakdown, measureContext, type ChatMessage, type Meter } from "./context.js";
import { discoverSkills, loadSkill, skillCatalog, skillRoots } from "./skills.js";
import { applyMemoryOps, forgetMemory, inferTarget, listAll, listUser, markRecalled, memoryBlock, memoryStats, recallMemory, saveMemory } from "./memory.js";
import { writeSoul } from "./soul.js";
import { listSessions, readSession } from "./sessions.js";
import { crawl, downloadTo, httpRequest, type CrawlPage } from "./web.js";
import {
  createJob, deleteJob, getJob, jobHistoryBlock, listJobs, updateJob,
  type JobApproval, MIN_INTERVAL_MIN, type ScheduledJob,
} from "./scheduler.js";
import { delegateConcurrent } from "./orchestr.js";
import { extractPdfFile } from "./pdf.js";

/** How long ask_user_question waits before telling the model to carry on. */
export const QUESTION_TIMEOUT_MS = 120_000;

/**
 * The agentic tool registry.
 *
 * These are the tools the *model* calls while running in agentic mode — a
 * different thing from `commands.ts`, which builds argv for llama.cpp binaries
 * that the user runs directly. Everything here executes on the user's machine,
 * so the jail below is the security boundary for the whole subsystem.
 *
 * Tools that need outside state (`memory`, `skills`, `context`, `todo`) are
 * declared here but executed by the server, which owns that state. The
 * `executeTool` switch below only handles the filesystem family.
 */

export interface AgentToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments, shaped for OpenAI `tools[].function.parameters`. */
  parameters: Record<string, unknown>;
  /** Tools that mutate state are gated behind the approval policy. */
  mutating: boolean;
}

export interface ToolResult {
  ok: boolean;
  /** Text handed back to the model as the tool message. */
  content: string;
  /** Short human summary for the transcript. */
  summary: string;
}

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

const MAX_READ_BYTES = 512 * 1024;
const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_GREP_HITS = 200;
const MAX_ENTRIES = 500;
/** Default cap on how many lines read_file will return in one call. */
const MAX_READ_LINES = 4000;
/** Files larger than this are summarized rather than dumped. */
const LARGE_FILE_BYTES = 1024 * 1024;

/**
 * Directories that never hold useful files, skipped to keep scans cheap.
 * Kept as one set so every walker (grep/glob/tree) skips the same things.
 */
const SKIP_DIRS = new Set([
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
function looksBinary(buf: Buffer, name: string): boolean {
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
interface WalkOptions {
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

async function walk(opts: WalkOptions): Promise<{ visited: number; capped: boolean }> {
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
function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Count lines in a buffer without materializing an array of every line. */
function countLines(buf: Buffer): number {
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
  return buf.length && buf[buf.length - 1] !== 10 ? n + 1 : n;
}

/** A short content hash, so an agent can tell whether a file changed. */
function shortHash(buf: Buffer | string): string {
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

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated, ${text.length - max} more characters]`;
}

export const AGENT_TOOLS: AgentToolSpec[] = [
  {
    name: "read_file",
    description: "Read a UTF-8 text file. Returns numbered lines. Use offset/limit for large files.",
    mutating: false,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path, or relative to the workspace." },
        offset: { type: "integer", description: "1-based first line to return." },
        limit: { type: "integer", description: "Maximum number of lines to return." },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file with the given content. Parent directories are created.",
    mutating: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path, or relative to the workspace." },
        content: { type: "string", description: "Full file content." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "read_document",
    description:
      "Extract the text of a PDF (or a plain text file) inside the workspace, page by page. "
      + "Use this — not read_file — to read a PDF. The result is marked '--- page N ---' so you can answer about a specific page; "
      + "pass page to read just one page (page 1 is the first page).",
    mutating: false,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the PDF, absolute or relative to the workspace." },
        page: { type: "integer", description: "Read only this page (1-based). Omit to read all pages." },
      },
      required: ["path"],
    },
  },
  {
    name: "list_dir",
    description: "List the entries of a directory (names, sizes, whether each is a directory).",
    mutating: false,
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Directory to list. Defaults to the workspace." } },
      required: [],
    },
  },
  {
    name: "grep",
    description:
      "Search file contents for a regular expression under a directory. Returns matching lines with file:line prefixes. "
      + "Use it to find where something is defined or used before you edit it.",
    mutating: false,
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression, without slashes." },
        path: { type: "string", description: "Directory to search. Defaults to the workspace." },
        glob: { type: "string", description: "Filter files: a suffix ('.ts') or a glob ('*.ts', 'src/**/*.json')." },
        caseSensitive: { type: "boolean", description: "Match case-sensitively. Defaults to false (case-insensitive)." },
        context: { type: "integer", description: "Lines of context around each match (0-5, default 0)." },
        hidden: { type: "boolean", description: "Include dotfiles. Defaults to false." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "run_command",
    description: "Run a shell command and return its stdout/stderr and exit code. Requires approval.",
    mutating: true,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command line executed with the system shell." },
        cwd: { type: "string", description: "Working directory. Defaults to the workspace." },
      },
      required: ["command"],
    },
  },
  {
    name: "write_todo",
    description:
      "Record and update a task list to plan multi-step work and show progress; skip it for trivial single-step tasks. "
      + "Send the complete list each time — it replaces the previous one. Add one todo per concrete step before you start, "
      + "keep exactly one `in_progress` while work remains, and mark each `completed` as soon as it is done.",
    mutating: true,
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The whole list, in order.",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "What the step is." },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
  },
  {
    name: "load_skill",
    description:
      "Load the full instructions for a skill. Call it before acting on a task that names or clearly matches a skill in the session skill catalog.",
    mutating: false,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The skill id from the catalog." },
      },
      required: ["name"],
    },
  },
  {
    name: "list_skills",
    description: "List the skills available on this machine, with the one-line description of each.",
    mutating: false,
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "save_memory",
    description:
      "Save a durable fact to remember across sessions — a stable preference, a decision, a constraint, an environment fact. "
      + "Use it when something will still matter later, not for task progress. "
      + "target 'user' is for facts about the person (their preferences, style, expectations); 'memory' is for your own notes "
      + "(environment, conventions, lessons). When a store is full the write is refused with the current entries so you can consolidate.",
    mutating: true,
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The fact, written as a short declarative sentence." },
        target: { type: "string", enum: ["memory", "user"], description: "Which store. Defaults to 'memory'." },
        scope: { type: "string", enum: ["global", "workspace"], description: "For the memory store; the user profile is always global." },
        tags: { type: "array", items: { type: "string" }, description: "Optional keywords for recall." },
      },
      required: ["text"],
    },
  },
  {
    name: "update_memory",
    description:
      "Change several memories at once, atomically: add, replace and remove in one call. "
      + "Use this to consolidate a nearly-full store — the removals and the additions land together, or nothing does, "
      + "so you can never lose a fact to a half-applied edit. "
      + "For replace/remove, old_text is a unique substring of the entry to change.",
    mutating: true,
    parameters: {
      type: "object",
      properties: {
        operations: {
          type: "array",
          description: "The ops, applied in order.",
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["add", "replace", "remove"] },
              target: { type: "string", enum: ["memory", "user"], description: "Default 'memory'." },
              scope: { type: "string", enum: ["global", "workspace"] },
              content: { type: "string", description: "add/replace: the new text." },
              old_text: { type: "string", description: "replace/remove: a unique substring of the target entry." },
              tags: { type: "array", items: { type: "string" } },
            },
            required: ["action"],
          },
        },
      },
      required: ["operations"],
    },
  },
  {
    name: "update_soul",
    description:
      "Rewrite your own identity — the SOUL.md that occupies slot #1 of your system prompt and defines who you are and how you speak. "
      + "Use it when the user asks you to change your personality, voice or default manner, and only then: this is durable identity, not a "
      + "per-task instruction (that belongs in the chat's system prompt or a skill). It persists across every future session.",
    mutating: true,
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The complete new soul. Markdown. Focus on identity, tone and style — not project instructions." },
      },
      required: ["text"],
    },
  },
  {
    name: "recall_memory",
    description: "Search saved memories and the user profile by keyword. With no query, returns everything, most-used first.",
    mutating: false,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords to look for." },
        target: { type: "string", enum: ["memory", "user"], description: "Restrict to one store." },
      },
      required: [],
    },
  },
  {
    name: "forget_memory",
    description: "Delete a saved memory by id or by matching text. Pass 'all' to clear a store.",
    mutating: true,
    parameters: {
      type: "object",
      properties: {
        selector: { type: "string", description: "An entry id, a substring of its text, or 'all'." },
        target: { type: "string", enum: ["memory", "user"], description: "Restrict to one store." },
        scope: { type: "string", enum: ["global", "workspace"] },
      },
      required: ["selector"],
    },
  },
  {
    name: "edit_file",
    description:
      "Apply a targeted edit to an existing file: replace one exact string, or insert text next to an anchor. "
      + "Fails loudly if the text is not found or is not unique — nothing is partially written.",
    mutating: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file to edit." },
        oldText: { type: "string", description: "Exact text to replace. Must match once." },
        newText: { type: "string", description: "The replacement." },
        insertAfter: { type: "string", description: "Instead of replacing: insert after this anchor line." },
      },
      required: ["path"],
    },
  },
  {
    name: "glob",
    description:
      "Find files by pattern under a directory, e.g. '**/*.ts' or 'src/**/*.json'. Returns paths relative to the searched root.",
    mutating: false,
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern. ** crosses directories." },
        path: { type: "string", description: "Root to search. Defaults to the workspace." },
        hidden: { type: "boolean", description: "Include dotfiles and dot-directories. Defaults to false." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "tree",
    description:
      "Show the directory structure as an indented tree, optionally filtered by depth and a glob. "
      + "Use it to get oriented in a workspace you have not seen before — cheaper and clearer than several list_dir calls.",
    mutating: false,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Root to display. Defaults to the workspace." },
        depth: { type: "integer", description: "Maximum depth to descend (1-8, default 3)." },
        glob: { type: "string", description: "Only include files matching this glob (e.g. '*.ts'). Directories still show." },
        hidden: { type: "boolean", description: "Include dotfiles. Defaults to false." },
      },
      required: [],
    },
  },
  {
    name: "file_info",
    description:
      "Report facts about a file: size, line count, kind (text/binary), a short content hash, and a preview of the first lines. "
      + "Use it to decide how to read a file (offset/limit) before reading it, or to check whether a file changed.",
    mutating: false,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file to inspect." },
      },
      required: ["path"],
    },
  },
  {
    name: "write_script",
    description:
      "Create an executable script in the workspace and return exactly how to run it. "
      + "Use this whenever a task needs a repeatable helper — a build step, a data transform, a batch rename, a parser — "
      + "rather than retyping a long one-off command. The script is written with a shebang and chmod +x so run_command can execute it directly. "
      + "Prefer a real script over a giant inline shell command: it is reviewable, re-runnable and easy to edit later.",
    mutating: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Where to write it, e.g. 'scripts/convert.sh' or 'tools/parse.py'. Relative to the workspace." },
        content: { type: "string", description: "The full script body. Include a shebang line (#!/usr/bin/env bash, python3, node…)." },
        language: { type: "string", description: "Optional: bash | python | node | sh. Used only if content has no shebang." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "manage_file",
    description:
      "Filesystem housekeeping: copy, move/rename, delete, or make a directory. Each op is confined to the workspace and, for deletes, "
      + "refuses to remove a directory recursively unless recursive is explicitly true.",
    mutating: true,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["copy", "move", "delete", "mkdir"], description: "The operation." },
        path: { type: "string", description: "The source path (or the directory to create for mkdir)." },
        to: { type: "string", description: "The destination path — required for copy and move." },
        recursive: { type: "boolean", description: "For delete: allow removing a directory and its contents. Defaults to false." },
      },
      required: ["action", "path"],
    },
  },
  {
    name: "replace_in_files",
    description:
      "Find and replace a literal string across many files at once, optionally filtered by glob, with a dry-run first. "
      + "Use it for a rename or a mechanical edit that touches many files — one call instead of dozens of edit_file calls. "
      + "Returns the list of files changed and the number of replacements; nothing is written when dryRun is true.",
    mutating: true,
    parameters: {
      type: "object",
      properties: {
        find: { type: "string", description: "The exact text to find (plain string, not a regex)." },
        replace: { type: "string", description: "The replacement text." },
        path: { type: "string", description: "Root to search. Defaults to the workspace." },
        glob: { type: "string", description: "Only touch files matching this glob, e.g. '*.ts' or 'src/**/*.css'." },
        dryRun: { type: "boolean", description: "Report what would change without writing. Defaults to false." },
        maxFiles: { type: "integer", description: "Safety cap on files to modify (default 100)." },
      },
      required: ["find", "replace"],
    },
  },
  {
    name: "ask_user_question",
    description:
      "Ask the user a question and wait for the answer: a confirmation, a choice between options, or missing information. "
      + "Use it whenever proceeding without the answer would be a guess.",
    mutating: false,
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "What to ask." },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Optional choices. Offered as clickable answers; omit for free text.",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "web_search",
    description:
      "Search the web for current information. Returns ranked results with title, URL and snippet — follow up with web_fetch to read a page.",
    mutating: false,
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "The search query." } },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description: "Retrieve the readable text of a web page by URL. HTML is stripped to text; the result is capped.",
    mutating: false,
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "An http(s) URL." } },
      required: ["url"],
    },
  },
  {
    name: "http_request",
    description:
      "Make a raw HTTP request — any method, custom headers, JSON body — and return status, headers and the response body. "
      + "Use this for APIs (JSON endpoints, form posts) where web_fetch's readable-text view is not enough.",
    mutating: false,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "An http(s) URL." },
        method: { type: "string", description: "HTTP method. Defaults to GET." },
        headers: { type: "object", description: "Extra request headers as a flat object." },
        body: { type: "string", description: "Request body (sent for non-GET methods)." },
      },
      required: ["url"],
    },
  },
  {
    name: "web_crawl",
    description:
      "Crawl a site from a starting URL: reads the page, follows its links (same host by default), and returns up to N pages of text. "
      + "Use it to gather several related pages in one step instead of fetching them one by one.",
    mutating: false,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The starting page." },
        limit: { type: "number", description: "Maximum pages to collect (1-25, default 6)." },
        sameHost: { type: "boolean", description: "Stay on the starting host. Defaults to true." },
        include: { type: "string", description: "Only follow links whose URL contains this substring." },
      },
      required: ["url"],
    },
  },
  {
    name: "web_download",
    description:
      "Download a file from a URL straight into the workspace (binary-safe: images, PDFs, archives, datasets). "
      + "Returns the saved path; use read_file for text, or attach it in the UI.",
    mutating: true,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The file URL." },
        name: { type: "string", description: "Optional filename to save as (defaults to the URL's last segment)." },
        dir: { type: "string", description: "Subdirectory of the workspace. Defaults to the workspace root." },
      },
      required: ["url"],
    },
  },
  {
    name: "create_skill",
    description:
      "Author a new skill (a SKILL.md with frontmatter) and save it under .osama/skills so it is available to load_skill in "
      + "future turns — including on other tasks. Write concrete, reusable instructions: what the skill does, when to use it, "
      + "the exact steps or commands, and pitfalls. Add reference files with write_file inside the skill's folder if useful.",
    mutating: true,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill id (lowercase, hyphens). Also the folder name." },
        description: { type: "string", description: "One line: what the skill does and when to use it." },
        instructions: { type: "string", description: "The SKILL.md body: steps, commands, pitfalls, examples." },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags." },
      },
      required: ["name", "description", "instructions"],
    },
  },
  {
    name: "session_search",
    description:
      "Search earlier conversations: find which session discussed something and read the matching events. Read-only, and it cannot see the current turn.",
    mutating: false,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords to match against message and tool text." },
        limit: { type: "integer", description: "Maximum matches to return." },
      },
      required: ["query"],
    },
  },
  {
    name: "session_events",
    description:
      "Read the events of an earlier session in order — its messages, tool calls and results. Read-only.",
    mutating: false,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "A session id, as reported by session_search." },
        kind: { type: "string", description: "Only events of this kind: message, tool_call, tool_result, todo, summary." },
        limit: { type: "integer", description: "Maximum events to return." },
      },
      required: ["id"],
    },
  },
  {
    name: "context_status",
    description:
      "Report how full the context window is: tokens used, what is taking the space, and how much is left. "
      + "Call it before a long task, or when you need to know whether history will fit.",
    mutating: false,
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_jobs",
    description:
      "List scheduled jobs the user has configured — the recurring prompts that fire automatically. "
      + "Each job shows its cadence, when it will run next, and the result of its last fire.",
    mutating: false,
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "create_job",
    description:
      "Schedule a recurring prompt to run on a cadence. The prompt is sent to the model exactly as the user "
      + "would write it; the job runs with the current agentic setup (same tools, memory, skills). Use the "
      + "approval policy 'auto' for unattended runs, 'ask' if the user should be asked before each mutating tool, "
      + "or 'deny' to forbid mutating tools entirely. The shortest cadence is 5 minutes.",
    mutating: true,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short human name for the job." },
        prompt: { type: "string", description: "The prompt text to send each run." },
        intervalMin: { type: "number", description: "Minutes between runs. Minimum 5." },
        approval: { type: "string", enum: ["ask", "auto", "deny"], description: "Approval policy for mutating tools during the run." },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["name", "prompt", "intervalMin"],
    },
  },
  {
    name: "delete_job",
    description: "Remove a scheduled job by id. Use list_jobs to find the id.",
    mutating: true,
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "The job id (from list_jobs)." } },
      required: ["id"],
    },
  },
  {
    name: "set_job",
    description:
      "Update an existing job: rename, change the prompt, change the cadence, toggle enabled, or change "
      + "the approval policy. Pass only the fields you want to change.",
    mutating: true,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The job id (from list_jobs)." },
        name: { type: "string" },
        prompt: { type: "string" },
        intervalMin: { type: "number" },
        approval: { type: "string", enum: ["ask", "auto", "deny"] },
        enabled: { type: "boolean" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["id"],
    },
  },
  {
    name: "job_history",
    description:
      "Read the recent run history of a scheduled job — what it produced and when. Use list_jobs to find the id.",
    mutating: false,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The job id (from list_jobs)." },
        limit: { type: "number", description: "Maximum runs to return (default 10)." },
      },
      required: ["id"],
    },
  },
  {
    name: "delegate_task",
    description:
      "Hand a self-contained subtask to a fresh subagent that runs in isolation and returns only its final report. "
      + "Give it every file path, constraint and requirement it needs — it cannot see this conversation. "
      + "Use for independent parallel work or heavy sub-reasoning; NOT for quick single tool calls.",
    mutating: false,
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: { type: "string" },
          description: "One entry spawns one subagent; several run concurrently (max 4).",
        },
      },
      required: ["tasks"],
    },
  },
];

/**
 * Extra tools for the current run — currently MCP tools injected by the caller.
 *
 * Deliberately a per-call argument rather than a module global: two turns can
 * run at once (a chat and a scheduled job) with different MCP servers connected,
 * so the tool set must be scoped to the run, not to the process.
 */
export type ToolOverlay = AgentToolSpec[] | undefined;

export function toolByName(name: string, extra?: ToolOverlay): AgentToolSpec | undefined {
  return AGENT_TOOLS.find((t) => t.name === name) ?? extra?.find((t) => t.name === name);
}

/** OpenAI-shaped tool declarations, as the model expects them. */
export function toolSchemas(extra?: ToolOverlay): Array<Record<string, unknown>> {
  const all = extra?.length ? [...AGENT_TOOLS, ...extra] : AGENT_TOOLS;
  return all.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export interface ExecOptions {
  /** Root the tool resolves relative paths against. */
  workspace: string;
  /** Called before a mutating command runs; false aborts it. */
  onCommand?: (command: string, cwd: string) => Promise<boolean>;
  /** Hard ceiling for one command. */
  commandTimeoutMs?: number;
  /** Outbound web hooks for web_search / web_fetch. */
  web?: WebAccess;
  /** Aborted when the user stops the turn — long walks check it between dirs. */
  signal?: AbortSignal;
}

/* ------------------------------------------------------------------ stateful */

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/** A question the model asked the user, waiting on an answer. */
export interface PendingQuestion {
  id: string;
  question: string;
  options?: string[];
}

/** Per-turn state the context tools need; supplied by whoever owns the session. */
export interface ToolContext {
  /** The running model's tokenizer/window, when one is available. */
  meter?: Meter;
  /** The request as it will actually be sent, for an honest measurement. */
  messages?: ChatMessage[];
  tools?: Array<Record<string, unknown>>;
  /** The live task list, replaced wholesale by write_todo. */
  todos?: TodoItem[];
  /** The durable session this turn belongs to, for the session-query tools. */
  sessionId?: string;
  /** Delivers ask_user_question to the UI; returns the answer text, or null on timeout. */
  askUser?: (q: PendingQuestion, timeoutMs: number) => Promise<string | null>;
  /** Outbound web access for web_search/web_fetch. Null when the OS has no network. */
  web?: WebAccess;
  /** Spawns a real subagent; supplied by the agent layer. Without it delegate_task reports unavailable. */
  delegate?: (tasks: string[]) => Promise<Array<{ ok: boolean; text: string; steps: number; error?: string }>>;
}

/** The web hooks the host provides; the tool layer stays protocol-free. */
export interface WebAccess {
  search(query: string): Promise<Array<{ title: string; url: string; snippet?: string }>>;
  fetch(url: string): Promise<{ title?: string; content: string; url: string }>;
}

const TOOL_CONTEXT_TOOLS = new Set([
  "write_todo", "load_skill", "list_skills",
  "save_memory", "update_memory", "update_soul", "recall_memory", "forget_memory", "context_status",
  "ask_user_question", "session_search", "session_events",
  "delegate_task",
  // scheduler tools live in their own dispatcher (executeSchedulerTool)
  // because they each carry their own approval policy.
]);

export function isContextTool(name: string): boolean {
  return TOOL_CONTEXT_TOOLS.has(name);
}

/** Tools the scheduler dispatcher handles — kept separate so each carries its own approval. */
export function isSchedulerTool(name: string): boolean {
  return name === "list_jobs" || name === "create_job" || name === "delete_job" || name === "set_job" || name === "job_history";
}

/** Execute a tool that depends on session state rather than the filesystem. */
export async function executeContextTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "write_todo": {
        const raw = Array.isArray(args.todos) ? args.todos : [];
        const todos: TodoItem[] = [];
        for (const t of raw) {
          const content = String((t as any)?.content ?? "").trim();
          const status = String((t as any)?.status ?? "pending");
          if (!content) continue;
          if (status !== "pending" && status !== "in_progress" && status !== "completed") continue;
          todos.push({ content, status });
        }
        if (!todos.length) return { ok: false, content: "todos must be a non-empty list of {content, status}", summary: "empty list" };
        const active = todos.filter((t) => t.status === "in_progress").length;
        if (ctx.todos) {
          ctx.todos.length = 0;
          ctx.todos.push(...todos);
        }
        const done = todos.filter((t) => t.status === "completed").length;
        return {
          ok: true,
          content: todos.map((t) => `[${t.status === "completed" ? "x" : t.status === "in_progress" ? ">" : " "}] ${t.content}`).join("\n"),
          summary: `${done}/${todos.length} done${active > 1 ? `, ${active} in progress` : ""}`,
        };
      }

      case "list_skills": {
        const skills = discoverSkills();
        return {
          ok: true,
          content: skills.length
            ? skills.map((s) => `${s.id}: ${s.description || s.name}`).join("\n")
            : "(no skills installed)",
          summary: `${skills.length} skill(s)`,
        };
      }

      case "load_skill": {
        const id = String(args.name ?? "").trim();
        if (!id) return { ok: false, content: "name is required", summary: "no name" };
        const skill = loadSkill(id);
        if (!skill) {
          const available = discoverSkills().map((s) => s.id);
          return {
            ok: false,
            content: `no skill named "${id}". Available: ${available.join(", ") || "none"}`,
            summary: "unknown skill",
          };
        }
        const files = skill.files.length ? `\n\nSupporting files: ${skill.files.join(", ")}` : "";
        return {
          ok: true,
          content: `${skill.body.trim()}${files}`,
          summary: `loaded ${skill.id} (${skill.body.length} chars)`,
        };
      }

      case "save_memory": {
        // Workspace facts default to the workspace scope (they describe where
        // the agent is working); an explicit scope always wins. Facts about the
        // *person* belong in the profile, not in the agent's own notes.
        const text = String(args.text ?? "");
        const explicitTarget = args.target === "user" ? "user" : args.target === "memory" ? "memory" : undefined;
        const target = explicitTarget ?? inferTarget(text);
        const wantsWorkspace =
          args.scope === "workspace" ||
          (!args.scope && /\b(here|this (workspace|project|repo|folder|directory)|current (workspace|project))\b/i.test(text));
        const scope = wantsWorkspace ? "workspace" : "global";
        const tags = Array.isArray(args.tags) ? (args.tags as unknown[]).map(String) : [];
        const r = saveMemory(text, scope, tags, target);
        if (!r.ok) {
          // Report the fill so the model can consolidate in the same turn
          // rather than retrying blindly against a store that cannot fit it.
          const stats = memoryStats();
          const store = target === "user" ? stats.user : { chars: stats.chars[scope] ?? 0, budget: stats.budget[scope] ?? 0, entries: stats.byScope[scope] ?? 0, pressure: 0 };
          const current = listAll(target, scope).map((e) => e.text);
          return {
            ok: false,
            content: `${r.error}\n\nCurrent entries:\n${current.map((t) => `- ${t}`).join("\n") || "(none)"}\n\nFree room in this same turn with update_memory (remove/replace + add together), then the new fact will fit.`,
            summary: `refused — ${store.chars ?? 0}/${store.budget ?? 0} chars used`,
          };
        }
        return {
          ok: true,
          content: `saved to ${target === "user" ? "the user profile" : `${scope} memory`} (${r.used}/${r.budget} chars used there)`,
          summary: `remembered: ${String(args.text ?? "").slice(0, 60)}`,
        };
      }

      case "update_memory": {
        const ops = Array.isArray(args.operations) ? (args.operations as Record<string, unknown>[]) : [];
        if (!ops.length) return { ok: false, content: "operations must be a non-empty list", summary: "empty ops" };
        const r = applyMemoryOps(
          ops.map((o) => ({
            action: String(o.action ?? "add") as "add" | "replace" | "remove",
            target: o.target === "user" ? "user" : o.target === "memory" ? "memory" : undefined,
            scope: o.scope === "workspace" ? "workspace" : o.scope === "global" ? "global" : undefined,
            content: o.content === undefined ? undefined : String(o.content),
            old_text: o.old_text === undefined ? undefined : String(o.old_text),
            tags: Array.isArray(o.tags) ? (o.tags as unknown[]).map(String) : undefined,
          })),
        );
        if (!r.ok) {
          return {
            ok: false,
            content: `${r.error}\n\n${r.applied.length ? `Applied before the failure (nothing was written):\n${r.applied.join("\n")}` : "Nothing was written."}`,
            summary: "batch refused",
          };
        }
        const stats = memoryStats();
        return {
          ok: true,
          content:
            `${r.applied.join("\n")}\n\nNow: memory ${stats.chars.global ?? 0}/${stats.budget.global ?? 0}, ` +
            `workspace ${stats.chars.workspace ?? 0}/${stats.budget.workspace ?? 0}, user ${stats.user.chars}/${stats.user.budget} chars.`,
          summary: `${r.applied.length} op(s) applied`,
        };
      }

      case "update_soul": {
        const text = String(args.text ?? "").trim();
        if (!text) return { ok: false, content: "text is required", summary: "empty soul" };
        const r = writeSoul(text);
        if (!r.ok) return { ok: false, content: r.error ?? "could not write the soul", summary: "refused" };
        const warn = r.flagged
          ? `\n\nNote: the text matched prompt-injection heuristic(s): ${r.findings?.join(", ")}. It was saved — review it if you did not intend that phrasing.`
          : "";
        return {
          ok: true,
          content: `your identity was updated (${r.chars} chars). It takes effect from the next turn — the running conversation keeps the soul it started with, because the system prompt is captured once per session.${warn}`,
          summary: `soul updated (${r.chars} chars)`,
        };
      }

      case "recall_memory": {
        const query = String(args.query ?? "");
        const target = args.target === "user" ? "user" : args.target === "memory" ? "memory" : undefined;
        const hits = recallMemory(query).filter((h) => !target || (target === "user" ? listUser().some((u) => u.id === h.id) : !listUser().some((u) => u.id === h.id)));
        if (!hits.length) {
          return { ok: true, content: query ? `(nothing matched "${query}")` : "(memory is empty)", summary: "0 hits" };
        }
        markRecalled(hits.map((h) => h.id));
        const isUser = new Set(listUser().map((u) => u.id));
        return {
          ok: true,
          content: hits
            .map((h) => `${h.id}${isUser.has(h.id) ? " [user]" : h.scope === "workspace" ? " [workspace]" : ""}: ${h.text}`)
            .join("\n"),
          summary: `${hits.length} hit(s)`,
        };
      }

      case "forget_memory": {
        const scope = args.scope === "workspace" ? "workspace" : args.scope === "global" ? "global" : undefined;
        const target = args.target === "user" ? "user" : args.target === "memory" ? "memory" : undefined;
        const r = forgetMemory(String(args.selector ?? ""), scope, target);
        return { ok: r.ok, content: r.ok ? `removed ${r.removed} entr(y/ies)` : (r.error ?? "nothing removed"), summary: r.ok ? `${r.removed} removed` : "no match" };
      }

      case "context_status": {
        if (!ctx.meter) return { ok: false, content: "no running model to measure against", summary: "unavailable" };
        const b = await measureContext(ctx.meter, ctx.messages ?? [], ctx.tools ?? []);
        const s = memoryStats();
        return {
          ok: true,
          content: `${describeBreakdown(b)}\n\nmemory: ${s.total} fact(s) — ${s.byScope.global} global (${s.chars.global}/${s.budget.global} chars), ${s.byScope.workspace} workspace (${s.chars.workspace}/${s.budget.workspace} chars)\n${memoryBlock() || "(the memory block is empty)"}`,
          summary: `${b.used}/${b.window} tokens (${(b.pressure * 100).toFixed(1)}%) · ${s.total} memory fact(s)`,
        };
      }

      case "ask_user_question": {
        const question = String(args.question ?? "").trim();
        if (!question) return { ok: false, content: "question is required", summary: "empty question" };
        if (!ctx.askUser) return { ok: false, content: "no user is attached to this run", summary: "unavailable" };
        const options = Array.isArray(args.options) ? (args.options as unknown[]).map(String).filter(Boolean) : undefined;
        const answer = await ctx.askUser({ id: `q_${Date.now().toString(36)}`, question, options }, QUESTION_TIMEOUT_MS);
        if (answer === null) {
          return {
            ok: false,
            content: "no answer arrived in time — continue with your best judgement and say what you assumed",
            summary: "timed out",
          };
        }
        return { ok: true, content: `the user answered: ${answer}`, summary: `answered: ${answer.slice(0, 50)}` };
      }

      case "session_search": {
        const query = String(args.query ?? "").trim().toLowerCase();
        if (!query) return { ok: false, content: "query is required", summary: "empty query" };
        const terms = query.split(/\s+/);
        const limit = Math.min(50, Math.max(1, Number(args.limit ?? 10) || 10));
        const hits: string[] = [];
        for (const s of listSessions()) {
          if (s.id === ctx.sessionId) continue; // never matches itself
          const rec = readSession(s.id);
          if (!rec) continue;
          for (const e of rec.events) {
            const text = JSON.stringify(e.data).toLowerCase();
            if (terms.every((t) => text.includes(t))) {
              const role = e.data.role ? `${e.data.role}: ` : "";
              hits.push(`${s.id} seq=${e.seq} ${e.kind} ${role}${JSON.stringify(e.data).slice(0, 160)}`);
              if (hits.length >= limit) break;
            }
          }
          if (hits.length >= limit) break;
        }
        return {
          ok: true,
          content: hits.join("\n") || `(no earlier session matched "${query}")`,
          summary: hits.length ? `${hits.length} match(es)` : "0 matches",
        };
      }

      case "session_events": {
        const id = String(args.id ?? "").trim();
        const rec = id ? readSession(id) : null;
        if (!rec) return { ok: false, content: `no session with id "${id}" — use session_search to find one`, summary: "unknown session" };
        if (rec.id === ctx.sessionId) {
          return { ok: false, content: "that is the current session — its events are already in front of you", summary: "self" };
        }
        const kind = String(args.kind ?? "").trim();
        const limit = Math.min(200, Math.max(1, Number(args.limit ?? 50) || 50));
        const rows = rec.events
          .filter((e) => !kind || e.kind === kind)
          .slice(0, limit)
          .map((e) => `${String(e.seq).padStart(4, " ")} ${e.kind.padEnd(11)} ${JSON.stringify(e.data).slice(0, 220)}`);
        return {
          ok: true,
          content: `session ${rec.id} — ${rec.title || "untitled"} · ${rec.events.length} events` + (rows.length ? `\n${rows.join("\n")}` : " (no events of that kind)"),
          summary: `${rec.events.length} events`,
        };
      }

      case "delegate_task": {
        if (!ctx.delegate) {
          return { ok: false, content: "delegation is not available in this run (plain chat has no subagents)", summary: "unavailable" };
        }
        const tasks = (Array.isArray(args.tasks) ? args.tasks : [args.tasks])
          .map((x) => String(x ?? "").trim()).filter((x) => x.length > 0).slice(0, 4);
        if (!tasks.length) return { ok: false, content: "tasks must be a non-empty list of self-contained task strings", summary: "empty tasks" };
        const results = await ctx.delegate(tasks);
        const body = results
          .map((r, i) => [
            `--- subagent ${i + 1} ${r.ok ? "(ok)" : "(failed)"} ---`,
            r.error ? `error: ${r.error}` : "",
            r.text.slice(0, 3000),
          ].filter(Boolean).join("\n"))
          .join("\n\n");
        const oks = results.filter((r) => r.ok).length;
        return { ok: oks === results.length, content: body || "(all subagents produced no text)", summary: `${oks}/${results.length} subagent(s) completed` };
      }

      default:
        return { ok: false, content: `context tool ${name} is not implemented`, summary: "not implemented" };
    }
  } catch (e) {
    return { ok: false, content: `${name} failed: ${(e as Error).message}`, summary: "error" };
  }
}

/** The skills catalog block, injected so `load_skill` is discoverable. */
export function skillsBlock(): string {
  return skillCatalog(discoverSkills());
}

export { skillRoots };

/** Execute one tool call. Never throws — failures come back as `ok: false`. */
export async function executeTool(name: string, args: Record<string, unknown>, opts: ExecOptions, extra: { sessionId?: string; askUser?: ToolContext["askUser"] } = {}): Promise<ToolResult> {
  const spec = toolByName(name);
  if (!spec) return { ok: false, content: `unknown tool: ${name}`, summary: `unknown tool ${name}` };

  const resolve = (raw: unknown, roots: string[]): { ok: true; path: string } | { ok: false; error: string } => {
    const s = typeof raw === "string" && raw.trim() ? raw : opts.workspace;
    const abs = path.isAbsolute(s) ? s : path.join(opts.workspace, s);
    return jail(abs, roots);
  };

  try {
    switch (name) {
      case "read_document": {
        // Reading a PDF is not reading a text file: it needs extraction, and it
        // needs to reach the model as text because a text-only model cannot take
        // the bytes. This closes the gap where no tool could read a document at
        // all, while the prompt inspector showed the extractor existed.
        const r = resolve(args.path, readRoots());
        if (!r.ok) return { ok: false, content: r.error, summary: "blocked (path)" };
        let st: fs.Stats;
        try { st = fs.statSync(r.path); } catch { return { ok: false, content: `${r.path} does not exist`, summary: "no file" }; }
        if (st.isDirectory()) return { ok: false, content: `${r.path} is a directory — use list_dir to find the document`, summary: "not a file" };
        const head = await fsp.readFile(r.path).then((b) => b.subarray(0, 5).toString("latin1")).catch(() => "");
        const isPdf = head.startsWith("%PDF-") || r.path.toLowerCase().endsWith(".pdf");
        if (!isPdf) {
          // Not a PDF — plain text is already readable, so point at the right tool
          // instead of duplicating read_file's behaviour.
          return executeTool("read_file", args, opts);
        }
        const page = Number(args.page) > 0 ? Number(args.page) : undefined;
        const out = await extractPdfFile(r.path, page ? { page } : {});
        if (!out.ok) return { ok: false, content: out.error ?? "could not read the PDF", summary: "read failed" };
        const what = page ? `page ${page}` : `${out.pages ?? "?"} page${out.pages === 1 ? "" : "s"}`;
        const note = out.scanned ? " (no text layer — likely scanned)" : out.truncated ? " (truncated)" : "";
        return { ok: true, content: out.text ?? "", summary: `${what} of ${path.basename(r.path)}${note}` };
      }
      case "read_file": {
        const r = resolve(args.path, readRoots());
        if (!r.ok) return { ok: false, content: r.error, summary: "blocked (path)" };
        let st: fs.Stats;
        try { st = fs.statSync(r.path); } catch { return { ok: false, content: `${r.path} does not exist`, summary: "no file" }; }
        if (st.isDirectory()) return { ok: false, content: `${r.path} is a directory — use list_dir or tree`, summary: "not a file" };

        const offset = Math.max(1, Number(args.offset ?? 1) || 1);
        const limit = Math.min(MAX_READ_LINES, Math.max(1, Number(args.limit ?? 2000) || 2000));

        // Large files: read only the byte window we need rather than loading
        // the whole thing into memory. If the caller did not supply an offset
        // and the file is big, read the head and tell the model how to page.
        let buf: Buffer;
        if (st.size > LARGE_FILE_BYTES) {
          const fd = fs.openSync(r.path, "r");
          try {
            const readCap = Math.min(st.size, MAX_READ_BYTES * 2);
            buf = Buffer.alloc(readCap);
            fs.readSync(fd, buf, 0, readCap, 0);
          } finally {
            fs.closeSync(fd);
          }
          if (looksBinary(buf, r.path)) {
            return { ok: false, content: `${path.basename(r.path)} is ${humanBytes(st.size)} and looks binary — use file_info or reference it as a path`, summary: "binary" };
          }
          const raw = buf.toString("utf8");
          const lines = raw.split("\n");
          const slice = lines.slice(offset - 1, offset - 1 + limit);
          const numbered = slice.map((l, i) => `${offset + i}|${l}`).join("\n");
          const lastShown = offset - 1 + slice.length;
          // We only read the head of the file, so more lines always exist.
          const more = " (more lines exist — pass offset to page further)";
          return {
            ok: true,
            content: `[${path.basename(r.path)}: ${humanBytes(st.size)}, showing lines ${offset}-${lastShown}${more}]\n${clip(numbered, MAX_READ_BYTES)}`,
            summary: `${path.basename(r.path)} · ${slice.length} lines (large file, ${humanBytes(st.size)})`,
          };
        }

        let raw: string;
        try { raw = fs.readFileSync(r.path, "utf8"); } catch (e) { return { ok: false, content: `cannot read ${r.path}: ${(e as Error).message}`, summary: "read failed" }; }
        if (looksBinary(Buffer.from(raw.slice(0, 8192)), r.path)) {
          return { ok: false, content: `${path.basename(r.path)} looks binary — use file_info or reference it as a path`, summary: "binary" };
        }
        const lines = raw.split("\n");
        const slice = lines.slice(offset - 1, offset - 1 + limit);
        const numbered = slice.map((l, i) => `${offset + i}|${l}`).join("\n");
        const shown = offset - 1 + slice.length;
        const note = shown < lines.length ? `\n… ${lines.length - shown} more line(s); call read_file with offset=${shown + 1}` : "";
        return {
          ok: true,
          content: clip(numbered + note, MAX_READ_BYTES),
          summary: `${path.basename(r.path)} · ${slice.length} of ${lines.length} lines`,
        };
      }

      case "write_file": {
        const r = resolve(args.path, writableRoots());
        if (!r.ok) return { ok: false, content: `write refused: ${r.error}`, summary: "blocked (path)" };
        const content = String(args.content ?? "");
        if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
          return { ok: false, content: `content exceeds the ${MAX_WRITE_BYTES} byte limit`, summary: "too large" };
        }
        fs.mkdirSync(path.dirname(r.path), { recursive: true });
        fs.writeFileSync(r.path, content, "utf8");
        return { ok: true, content: `wrote ${Buffer.byteLength(content, "utf8")} bytes to ${r.path}`, summary: `wrote ${path.basename(r.path)}` };
      }

      case "list_dir": {
        const r = resolve(args.path, readRoots());
        if (!r.ok) return { ok: false, content: r.error, summary: "blocked (path)" };
        const entries = fs.readdirSync(r.path, { withFileTypes: true }).slice(0, MAX_ENTRIES);
        const rows = entries.map((e) => {
          if (e.isDirectory()) return `${e.name}/`;
          try {
            return `${e.name}  ${fs.statSync(path.join(r.path, e.name)).size}`;
          } catch {
            return e.name;
          }
        });
        return { ok: true, content: rows.join("\n") || "(empty)", summary: `${entries.length} entries in ${path.basename(r.path)}` };
      }

      case "grep": {
        const r = resolve(args.path, readRoots());
        if (!r.ok) return { ok: false, content: r.error, summary: "blocked (path)" };
        const pattern = String(args.pattern ?? "");
        if (!pattern) return { ok: false, content: "pattern is required", summary: "empty pattern" };
        const suffix = typeof args.glob === "string" ? args.glob : "";
        const ignoreCase = args.caseSensitive !== true;
        const contextLines = Math.min(5, Math.max(0, Number(args.context ?? 0) || 0));
        let re: RegExp;
        try {
          re = new RegExp(pattern, ignoreCase ? "i" : "");
        } catch (e) {
          return { ok: false, content: `bad regular expression: ${(e as Error).message}`, summary: "bad pattern" };
        }
        const hits: string[] = [];
        const fileCounts = new Map<string, number>();
        await walk({
          root: r.path,
          hidden: args.hidden === true,
          signal: opts.signal,
          onFile: (abs, rel) => {
            if (suffix) {
              // `glob` accepts a suffix ('.ts'), a glob ('*.ts') or a dir glob.
              const okSuffix = suffix.includes("*") ? globToRegExp(suffix).test(path.basename(rel)) : rel.endsWith(suffix);
              if (!okSuffix) return;
            }
            let text: string;
            try {
              const st = fs.statSync(abs);
              if (st.size > MAX_READ_BYTES) return; // skip huge files in a search
              const buf = fs.readFileSync(abs);
              if (looksBinary(buf, abs)) return;
              text = buf.toString("utf8");
            } catch {
              return;
            }
            const lines = text.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (!re.test(lines[i]!)) continue;
              if (contextLines > 0) {
                const from = Math.max(0, i - contextLines);
                const to = Math.min(lines.length - 1, i + contextLines);
                for (let j = from; j <= to; j++) {
                  const marker = j === i ? ":" : "-";
                  hits.push(`${rel}${marker}${j + 1}${marker} ${lines[j]!.trim().slice(0, 200)}`);
                }
              } else {
                hits.push(`${rel}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
              }
              fileCounts.set(rel, (fileCounts.get(rel) ?? 0) + 1);
              if (hits.length >= MAX_GREP_HITS) return true;
            }
          },
        });
        const capped = hits.length >= MAX_GREP_HITS;
        return {
          ok: true,
          content: (hits.join("\n") || "(no matches)") + (capped ? `\n… more matches exist (capped at ${MAX_GREP_HITS}); narrow the pattern or path` : ""),
          summary: `${hits.length} match(es) in ${fileCounts.size} file(s)`,
        };
      }

      case "edit_file": {
        const r = resolve(args.path, writableRoots());
        if (!r.ok) return { ok: false, content: `edit refused: ${r.error}`, summary: "blocked (path)" };
        const oldText = typeof args.oldText === "string" ? args.oldText : "";
        const newText = typeof args.newText === "string" ? args.newText : "";
        const anchor = typeof args.insertAfter === "string" ? args.insertAfter : "";
        if (!oldText && !anchor) return { ok: false, content: "oldText or insertAfter is required", summary: "nothing to do" };

        const st = fs.existsSync(r.path) ? fs.statSync(r.path) : null;
        if (!st || !st.isFile()) return { ok: false, content: `${r.path} does not exist — create it with write_file first`, summary: "no file" };
        if (st.size > MAX_WRITE_BYTES) return { ok: false, content: `file is larger than the ${MAX_WRITE_BYTES} edit limit`, summary: "too large" };

        const src = fs.readFileSync(r.path, "utf8");
        let next: string;

        if (anchor) {
          const idx = src.indexOf(anchor);
          if (idx < 0) return { ok: false, content: `anchor not found: ${anchor.slice(0, 80)}`, summary: "no anchor" };
          if (src.indexOf(anchor, idx + 1) >= 0) return { ok: false, content: "anchor matches more than once — be more specific", summary: "ambiguous" };
          const at = idx + anchor.length;
          next = src.slice(0, at) + (src[at] === "\n" ? "" : "\n") + newText + src.slice(at);
        } else {
          const first = src.indexOf(oldText);
          if (first < 0) return { ok: false, content: `oldText not found (it may have changed): ${oldText.slice(0, 80)}`, summary: "no match" };
          if (src.indexOf(oldText, first + 1) >= 0) return { ok: false, content: "oldText matches more than once — include more context to make it unique", summary: "ambiguous" };
          next = src.slice(0, first) + newText + src.slice(first + oldText.length);
        }

        fs.writeFileSync(r.path, next, "utf8");
        return { ok: true, content: `edited ${r.path} (${Buffer.byteLength(next, "utf8")} bytes now)`, summary: `edited ${path.basename(r.path)}` };
      }

      case "glob": {
        const r = resolve(args.path, readRoots());
        if (!r.ok) return { ok: false, content: r.error, summary: "blocked (path)" };
        const pattern = String(args.pattern ?? "").trim();
        if (!pattern) return { ok: false, content: "pattern is required", summary: "empty pattern" };
        let re: RegExp;
        try {
          re = globToRegExp(pattern);
        } catch (e) {
          return { ok: false, content: `bad glob pattern: ${(e as Error).message}`, summary: "bad pattern" };
        }
        const hits: string[] = [];
        await walk({
          root: r.path,
          hidden: args.hidden === true,
          signal: opts.signal,
          onFile: (_abs, rel) => {
            if (re.test(rel)) hits.push(rel);
            if (hits.length >= MAX_GREP_HITS) return true;
          },
        });
        return {
          ok: true,
          content: (hits.sort().join("\n") || "(no match)") + (hits.length >= MAX_GREP_HITS ? `\n… capped at ${MAX_GREP_HITS} files` : ""),
          summary: `${hits.length} file(s)`,
        };
      }

      case "tree": {
        const r = resolve(args.path, readRoots());
        if (!r.ok) return { ok: false, content: r.error, summary: "blocked (path)" };
        const maxDepth = Math.min(8, Math.max(1, Number(args.depth ?? 3) || 3));
        const fileGlob = typeof args.glob === "string" && args.glob.trim() ? globToRegExp(args.glob.trim()) : null;
        const lines: string[] = [];
        let dirs = 0;
        let files = 0;
        const render = async (dir: string, prefix: string, depth: number): Promise<void> => {
          if (depth > maxDepth) return;
          let entries: fs.Dirent[];
          try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
          const visible = entries
            .filter((e) => (args.hidden === true || !e.name.startsWith(".")) && !SKIP_DIRS.has(e.name))
            .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
          for (let i = 0; i < visible.length; i++) {
            const e = visible[i]!;
            const last = i === visible.length - 1;
            const branch = last ? "└─ " : "├─ ";
            if (e.isDirectory()) {
              dirs++;
              lines.push(`${prefix}${branch}${e.name}/`);
              if (lines.length > 1500) return;
              await render(path.join(dir, e.name), prefix + (last ? "   " : "│  "), depth + 1);
            } else {
              if (fileGlob && !fileGlob.test(e.name)) continue;
              files++;
              lines.push(`${prefix}${branch}${e.name}`);
              if (lines.length > 1500) return;
            }
          }
        };
        lines.push(`${path.basename(r.path)}/`);
        await render(r.path, "", 1);
        return {
          ok: true,
          content: lines.join("\n"),
          summary: `${dirs} dir(s), ${files} file(s)`,
        };
      }

      case "file_info": {
        const r = resolve(args.path, readRoots());
        if (!r.ok) return { ok: false, content: r.error, summary: "blocked (path)" };
        let st: fs.Stats;
        try { st = fs.statSync(r.path); } catch { return { ok: false, content: `${r.path} does not exist`, summary: "no file" }; }
        if (st.isDirectory()) return { ok: false, content: `${r.path} is a directory`, summary: "not a file" };
        const fd = fs.openSync(r.path, "r");
        let head: Buffer;
        try {
          head = Buffer.alloc(Math.min(st.size, 16 * 1024));
          fs.readSync(fd, head, 0, head.length, 0);
        } finally {
          fs.closeSync(fd);
        }
        const info: string[] = [
          `path: ${r.path}`,
          `size: ${humanBytes(st.size)} (${st.size} bytes)`,
          `modified: ${new Date(st.mtimeMs).toISOString()}`,
        ];
        if (st.size > 0) info.push(`sha1: ${shortHash(head)}${st.size > head.length ? " (head 16 KB)" : ""}`);
        const binary = looksBinary(head, r.path);
        info.push(`kind: ${binary ? "binary" : "text"}`);
        if (!binary) {
          // Line count needs the whole file; only do it for reasonably sized ones.
          if (st.size <= 8 * 1024 * 1024) {
            const full = fs.readFileSync(r.path);
            info.push(`lines: ${countLines(full)}`);
          }
          const preview = head.toString("utf8").split("\n").slice(0, 15).join("\n");
          info.push(`--- first lines ---\n${preview}`);
        }
        return { ok: true, content: info.join("\n"), summary: `${path.basename(r.path)} · ${humanBytes(st.size)} · ${binary ? "binary" : "text"}` };
      }

      case "write_script": {
        const r = resolve(args.path, writableRoots());
        if (!r.ok) return { ok: false, content: `write refused: ${r.error}`, summary: "blocked (path)" };
        let content = String(args.content ?? "");
        if (!content.trim()) return { ok: false, content: "content is required", summary: "empty script" };
        // Ensure a shebang so the script is directly executable.
        if (!content.startsWith("#!")) {
          const lang = String(args.language ?? "").toLowerCase();
          const ext = r.path.split(".").pop()?.toLowerCase() ?? "";
          // Default shell scripts to bash, not /bin/sh: authors commonly use
          // bashisms, and `/bin/sh` is dash on Debian/Ubuntu where they break.
          const shebang =
            lang === "python" || lang === "py" || ext === "py" ? "#!/usr/bin/env python3" :
            lang === "node" || lang === "js" || ext === "js" || ext === "mjs" ? "#!/usr/bin/env node" :
            "#!/usr/bin/env bash";
          content = `${shebang}\n${content}`;
        }
        if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
          return { ok: false, content: `content exceeds the ${MAX_WRITE_BYTES} byte limit`, summary: "too large" };
        }
        if (spec.mutating && opts.onCommand) {
          const allowed = await opts.onCommand(`write script ${path.basename(r.path)}`, path.dirname(r.path));
          if (!allowed) return { ok: false, content: "the user denied creating this script", summary: "denied by user" };
        }
        fs.mkdirSync(path.dirname(r.path), { recursive: true });
        fs.writeFileSync(r.path, content, "utf8");
        try { fs.chmodSync(r.path, 0o755); } catch { /* filesystem may not support modes */ }
        const rel = path.relative(opts.workspace, r.path).split(path.sep).join("/");
        return {
          ok: true,
          content: `wrote ${humanBytes(Buffer.byteLength(content, "utf8"))} to ${r.path} and made it executable.\nRun it with run_command: "${rel.startsWith("..") ? r.path : `./${rel}`}"`,
          summary: `wrote ${path.basename(r.path)} (+x)`,
        };
      }

      case "manage_file": {
        const action = String(args.action ?? "").toLowerCase();
        const src = resolve(args.path, action === "copy" || action === "move" ? readRoots() : writableRoots());
        if (!src.ok) return { ok: false, content: src.error, summary: "blocked (path)" };
        const destRaw = args.to !== undefined ? String(args.to) : "";
        const dest = destRaw ? resolve(destRaw, writableRoots()) : null;

        if (action === "mkdir") {
          if (spec.mutating && opts.onCommand) {
            const ok = await opts.onCommand(`create directory ${path.basename(src.path)}`, path.dirname(src.path));
            if (!ok) return { ok: false, content: "the user denied creating this directory", summary: "denied by user" };
          }
          try { fs.mkdirSync(src.path, { recursive: true }); } catch (e) { return { ok: false, content: `mkdir failed: ${(e as Error).message}`, summary: "mkdir failed" }; }
          return { ok: true, content: `created directory ${src.path}`, summary: `mkdir ${path.basename(src.path)}` };
        }
        if (action === "copy" || action === "move") {
          if (!dest) return { ok: false, content: "`to` is required for copy and move", summary: "missing destination" };
          if (!dest.ok) return { ok: false, content: `destination refused: ${dest.error}`, summary: "blocked (dest)" };
          if (!fs.existsSync(src.path)) return { ok: false, content: `${src.path} does not exist`, summary: "no source" };
          if (spec.mutating && opts.onCommand) {
            const ok = await opts.onCommand(`${action} ${path.basename(src.path)} → ${path.basename(dest.path)}`, path.dirname(dest.path));
            if (!ok) return { ok: false, content: `the user denied the ${action}`, summary: "denied by user" };
          }
          try {
            fs.mkdirSync(path.dirname(dest.path), { recursive: true });
            if (action === "copy") fs.copyFileSync(src.path, dest.path);
            else fs.renameSync(src.path, dest.path);
          } catch (e) {
            return { ok: false, content: `${action} failed: ${(e as Error).message}`, summary: `${action} failed` };
          }
          return { ok: true, content: `${action === "copy" ? "copied" : "moved"} ${src.path} → ${dest.path}`, summary: `${action} ${path.basename(src.path)}` };
        }
        if (action === "delete") {
          const st = fs.existsSync(src.path) ? fs.statSync(src.path) : null;
          if (!st) return { ok: false, content: `${src.path} does not exist`, summary: "no target" };
          const recursive = args.recursive === true;
          if (st.isDirectory() && !recursive) {
            return { ok: false, content: `${src.path} is a directory — pass recursive: true to remove it and its contents`, summary: "needs recursive" };
          }
          if (spec.mutating && opts.onCommand) {
            const ok = await opts.onCommand(`delete ${src.path}${recursive ? " (recursive)" : ""}`, path.dirname(src.path));
            if (!ok) return { ok: false, content: "the user denied the delete", summary: "denied by user" };
          }
          try {
            fs.rmSync(src.path, { recursive, force: false });
          } catch (e) {
            return { ok: false, content: `delete failed: ${(e as Error).message}`, summary: "delete failed" };
          }
          return { ok: true, content: `deleted ${src.path}`, summary: `deleted ${path.basename(src.path)}` };
        }
        return { ok: false, content: `unknown action "${action}" — use copy, move, delete or mkdir`, summary: "bad action" };
      }

      case "replace_in_files": {
        const find = typeof args.find === "string" ? args.find : "";
        const replace = typeof args.replace === "string" ? args.replace : "";
        if (!find) return { ok: false, content: "find is required (a literal string)", summary: "empty find" };
        const r = resolve(args.path, readRoots());
        if (!r.ok) return { ok: false, content: r.error, summary: "blocked (path)" };
        const filePattern = typeof args.glob === "string" && args.glob.trim() ? globToRegExp(args.glob.trim()) : null;
        const dryRun = args.dryRun === true;
        const maxFiles = Math.min(500, Math.max(1, Number(args.maxFiles ?? 100) || 100));
        const writable = writableRoots();
        const changed: Array<{ rel: string; count: number }> = [];
        const skipped: string[] = [];
        await walk({
          root: r.path,
          hidden: args.hidden === true,
          signal: opts.signal,
          onFile: (abs, rel) => {
            if (filePattern && !filePattern.test(path.basename(rel)) && !filePattern.test(rel)) return;
            if (changed.length >= maxFiles) { skipped.push("file cap reached"); return true; }
            // Only touch files inside a writable root.
            const j = jail(abs, writable);
            if (!j.ok) return;
            let text: string;
            try {
              const buf = fs.readFileSync(abs);
              if (looksBinary(buf, abs)) return;
              text = buf.toString("utf8");
            } catch {
              return;
            }
            if (!text.includes(find)) return;
            const count = text.split(find).length - 1;
            if (count === 0) return;
            if (!dryRun) {
              try { fs.writeFileSync(abs, text.split(find).join(replace), "utf8"); }
              catch { return; }
            }
            changed.push({ rel, count });
          },
        });
        if (skipped.length) changed.push({ rel: `… ${skipped.join(", ")}`, count: 0 });
        const total = changed.reduce((n, c) => n + c.count, 0);
        const body = changed.length
          ? changed.map((c) => `  ${c.rel} (${c.count})`).join("\n")
          : "  (no files contained the text)";
        return {
          ok: true,
          content: `${dryRun ? "would change" : "changed"} ${total} occurrence(s) across ${changed.filter((c) => c.count > 0).length} file(s):\n${body}`,
          summary: `${dryRun ? "dry-run: " : ""}${total} replacement(s) in ${changed.filter((c) => c.count > 0).length} file(s)`,
        };
      }

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

      case "run_command": {
        const command = String(args.command ?? "").trim();
        if (!command) return { ok: false, content: "command is required", summary: "empty command" };
        const cwdRes = resolve(args.cwd, readRoots());
        if (!cwdRes.ok) return { ok: false, content: cwdRes.error, summary: "blocked (cwd)" };

        if (spec.mutating && opts.onCommand) {
          const allowed = await opts.onCommand(command, cwdRes.path);
          if (!allowed) return { ok: false, content: "the user denied this command", summary: "denied by user" };
        }

        const { spawn } = await import("node:child_process");
        const timeoutMs = opts.commandTimeoutMs ?? 120_000;
        return await new Promise<ToolResult>((resolvePromise) => {
          const child = spawn(command, {
            cwd: cwdRes.path,
            shell: true,
            env: { ...process.env, OSAMA_AGENT: "1" },
          });
          let stdout = "";
          let stderr = "";
          let done = false;
          const finish = (result: ToolResult): void => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolvePromise(result);
          };
          const timer = setTimeout(() => {
            try { child.kill("SIGKILL"); } catch { /* already gone */ }
            finish({ ok: false, content: `command timed out after ${timeoutMs}ms`, summary: "timed out" });
          }, timeoutMs);
          child.stdout?.on("data", (d) => { stdout += String(d); });
          child.stderr?.on("data", (d) => { stderr += String(d); });
          child.on("error", (e) => finish({ ok: false, content: `spawn failed: ${e.message}`, summary: "spawn failed" }));
          child.on("close", (code) => {
            const body = clip(
              [stdout.trim(), stderr.trim() ? `[stderr]\n${stderr.trim()}` : "", `[exit ${code}]`].filter(Boolean).join("\n"),
              16 * 1024,
            );
            finish({ ok: code === 0, content: body, summary: `exit ${code}` });
          });
        });
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
  } catch (e) {
    return { ok: false, content: `${name} failed: ${(e as Error).message}`, summary: "error" };
  }
}

/* ----------------------------------------------------------- scheduler tools */

function fmtJobLine(j: ScheduledJob): string {
  const last = j.lastRunAt ? new Date(j.lastRunAt).toLocaleString() : "never";
  const next = new Date(j.nextRunAt).toLocaleString();
  const status = j.lastStatus ?? "idle";
  return `${j.id}  "${j.name}"  every ${j.intervalMin}m  next=${next}  last=${last} (${status})`;
}

/** Dispatch the scheduler tools. Pure (does not need onCommand — scheduler has its own approval). */
export async function executeSchedulerTool(
  name: string,
  args: Record<string, unknown>,
  // Approval hook — when the policy is 'ask' we block until the UI decides.
  ask?: (q: { command: string }) => Promise<boolean>,
): Promise<ToolResult> {
  switch (name) {
    case "list_jobs": {
      const jobs = listJobs();
      if (!jobs.length) return { ok: true, content: "(no scheduled jobs)", summary: "0 jobs" };
      const body = jobs.map(fmtJobLine).join("\n");
      return { ok: true, content: body, summary: `${jobs.length} job(s)` };
    }

    case "create_job": {
      const jobName = String(args.name ?? "").trim();
      const prompt = String(args.prompt ?? "").trim();
      const iv = Math.floor(Number(args.intervalMin ?? 0));
      const approval = (args.approval === "ask" || args.approval === "auto" || args.approval === "deny") ? args.approval : "auto";
      const tags = Array.isArray(args.tags) ? (args.tags as unknown[]).map(String) : [];
      if (!jobName || !prompt || !iv) {
        return { ok: false, content: "name, prompt and intervalMin are required", summary: "missing fields" };
      }
      if (iv < MIN_INTERVAL_MIN) {
        return { ok: false, content: `cadence must be at least ${MIN_INTERVAL_MIN} minutes`, summary: "too often" };
      }
      if (ask) {
        const ok = await ask({ command: `create scheduled job "${jobName}" (every ${iv}m)` });
        if (!ok) return { ok: false, content: "the user denied creating this job", summary: "denied by user" };
      }
      const r = createJob({ name: jobName, prompt, intervalMin: iv, approval, tags });
      if (!r.ok || !r.job) return { ok: false, content: r.error ?? "could not create job", summary: "refused" };
      return { ok: true, content: `created job ${r.job.id} — next fire ${r.job.nextRunAt}`, summary: `created ${r.job.name}` };
    }

    case "delete_job": {
      const id = String(args.id ?? "").trim();
      if (!id) return { ok: false, content: "id is required", summary: "no id" };
      const job = getJob(id);
      if (!job) return { ok: false, content: `no job with id "${id}"`, summary: "unknown job" };
      if (ask) {
        const ok = await ask({ command: `delete scheduled job "${job.name}"` });
        if (!ok) return { ok: false, content: "the user denied deleting this job", summary: "denied by user" };
      }
      const removed = deleteJob(id);
      return { ok: removed, content: removed ? `removed ${job.name}` : "could not remove the job file", summary: removed ? `removed ${job.name}` : "delete failed" };
    }

    case "set_job": {
      const id = String(args.id ?? "").trim();
      if (!id) return { ok: false, content: "id is required", summary: "no id" };
      const job = getJob(id);
      if (!job) return { ok: false, content: `no job with id "${id}"`, summary: "unknown job" };
      const patch: Parameters<typeof updateJob>[1] = {};
      if (typeof args.name === "string") patch.name = args.name;
      if (typeof args.prompt === "string") patch.prompt = args.prompt;
      if (typeof args.intervalMin === "number") patch.intervalMin = args.intervalMin;
      if (args.approval === "ask" || args.approval === "auto" || args.approval === "deny") patch.approval = args.approval;
      if (typeof args.enabled === "boolean") patch.enabled = args.enabled;
      if (Array.isArray(args.tags)) patch.tags = (args.tags as unknown[]).map(String);
      if (Object.keys(patch).length === 0) return { ok: false, content: "nothing to change", summary: "no-op" };
      if (ask) {
        const ok = await ask({ command: `change scheduled job "${job.name}"` });
        if (!ok) return { ok: false, content: "the user denied changing this job", summary: "denied by user" };
      }
      const r = updateJob(id, patch);
      if (!r.ok || !r.job) return { ok: false, content: r.error ?? "could not update job", summary: "refused" };
      return { ok: true, content: `updated ${r.job.name} — next fire ${r.job.nextRunAt}`, summary: `updated ${r.job.name}` };
    }

    case "job_history": {
      const id = String(args.id ?? "").trim();
      if (!id) return { ok: false, content: "id is required", summary: "no id" };
      const limit = Math.max(1, Math.min(50, Math.floor(Number(args.limit ?? 10)) || 10));
      const block = jobHistoryBlock(id, limit);
      const job = getJob(id);
      if (!job) return { ok: false, content: `no job with id "${id}"`, summary: "unknown job" };
      if (!block) return { ok: true, content: `${job.name}: no runs yet`, summary: "0 runs" };
      return { ok: true, content: `${job.name} — last ${limit} run(s):\n${block}`, summary: `${job.history.length} run(s)` };
    }

    default:
      return { ok: false, content: `scheduler tool ${name} is not implemented`, summary: "not implemented" };
  }
}
