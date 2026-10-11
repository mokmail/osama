import path from "node:path";
import { toolByName } from "./spec.js";
import type { AgentToolSpec, ExecOptions, ToolContext, ToolResult } from "./spec.js";
import { executeFsTool } from "./fs.js";
import { executeNetTool } from "./net.js";
import { jail, readRoots, writableRoots } from "./jail.js";

/** What the family handlers are handed: the jail, the run options, the session bits. */
export interface ToolDispatchContext {
  /** Resolve a tool argument against the workspace and prove it stays in the jail. */
  resolve: (raw: unknown, roots: string[]) => { ok: true; path: string } | { ok: false; error: string };
  /** The declaration being executed — the bodies read `mutating` off it to gate a command. */
  spec: AgentToolSpec;
  opts: ExecOptions;
  extra: { sessionId?: string; askUser?: ToolContext["askUser"] };
}

/** The filesystem and process tools, by name. */
const FS_TOOLS = new Set([
  "read_document", "read_file", "write_file", "list_dir", "grep", "edit_file", "glob", "tree",
  "file_info", "write_script", "manage_file", "replace_in_files", "run_command",
]);

/** The network tools, by name. */
const NET_TOOLS = new Set([
  "web_search", "web_fetch", "http_request", "web_crawl", "web_download", "create_skill",
]);

/** Execute one tool call. Never throws — failures come back as `ok: false`. */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  opts: ExecOptions,
  extra: { sessionId?: string; askUser?: ToolContext["askUser"] } = {},
): Promise<ToolResult> {
  const spec = toolByName(name);
  if (!spec) return { ok: false, content: `unknown tool: ${name}`, summary: `unknown tool ${name}` };

  const resolve = (raw: unknown, roots: string[]): { ok: true; path: string } | { ok: false; error: string } => {
    const s = typeof raw === "string" && raw.trim() ? raw : opts.workspace;
    const abs = path.isAbsolute(s) ? s : path.join(opts.workspace, s);
    return jail(abs, roots);
  };

  const ctx: ToolDispatchContext = { resolve, spec, opts, extra };
  try {
    if (FS_TOOLS.has(name)) return await executeFsTool(name, args, opts, ctx);
    if (NET_TOOLS.has(name)) return await executeNetTool(name, args, opts, ctx);
    // Declared, but run by another dispatcher: the context tools need session state,
    // the scheduler tools each carry their own approval. Same sentence the single
    // switch used for this case, so nothing about the reply changed.
    return { ok: false, content: `tool ${name} is declared but not implemented`, summary: "not implemented" };
  } catch (e) {
    return { ok: false, content: `${name} failed: ${(e as Error).message}`, summary: "error" };
  }
}
