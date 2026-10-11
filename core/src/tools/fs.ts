import fs from "node:fs";
import { promises as fsp } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { crawl, downloadTo, httpRequest, type CrawlPage } from "../web.js";
import { extractPdfFile } from "../pdf.js";
import {
  MAX_ENTRIES, MAX_GREP_HITS, MAX_READ_BYTES, MAX_READ_LINES, MAX_WRITE_BYTES,
  SKIP_DIRS, globToRegExp, humanBytes, jail, looksBinary, readRoots, walk, writableRoots,
} from "./jail.js";
import { LARGE_FILE_BYTES, countLines, shortHash, clip } from "./jail.js";
import type { ExecOptions, ToolResult } from "./spec.js";
import type { ToolDispatchContext } from "./dispatch.js";

/**
 * The filesystem and process families.
 *
 * Moved out of the one `executeTool` switch it used to be: the cases below are
 * byte-identical to that switch, which is why they still read as one long dispatch.
 * What they share is the jail (`resolve`) and the run options, both handed in.
 */
export async function executeFsTool(
  name: string,
  args: Record<string, unknown>,
  opts: ExecOptions,
  ctx: ToolDispatchContext,
): Promise<ToolResult> {
  const { resolve, spec } = ctx;
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
          return executeFsTool("read_file", args, opts, ctx);
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
    default:
      return { ok: false, content: `tool ${name} is declared but not implemented`, summary: "not implemented" };
  }
}
