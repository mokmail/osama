import type { ChatMessage, Meter } from "../context.js";

/** How long ask_user_question waits before telling the model to carry on. */
export const QUESTION_TIMEOUT_MS = 120_000;

/**
 * The agentic tool registry — the contract, and the declarations the model is handed.
 *
 * These are the tools the *model* calls while running in agentic mode — a
 * different thing from `commands/`, which builds argv for llama.cpp binaries
 * that the user runs directly. Everything here executes on the user's machine,
 * so `jail.ts` is the security boundary for the whole subsystem.
 *
 * Tools that need outside state (`memory`, `skills`, `context`, `todo`) are
 * declared here but executed by `state.ts`; the scheduler tools by `scheduler.ts`.
 * The filesystem and network families live in `fs.ts` and `net.ts`, and `dispatch.ts`
 * decides between them. This file is data and types: no tool body belongs here.
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
