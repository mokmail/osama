import { executeTool, executeSchedulerTool, toolSchemas, toolByName, isSchedulerTool, type ToolResult, executeContextTool, isContextTool, QUESTION_TIMEOUT_MS, type TodoItem } from "./tools.js";
import { appendEvents } from "./sessions.js";
import { applyCompaction, planCompaction, summarizationPrompt } from "./compact.js";
import { type ChatMessage, type Meter, measureContext } from "./context.js";
import { createSteerQueue, delegateSubagent, type SteerQueue } from "./orchestr.js";
import { buildPrompt, type BuiltPrompt } from "./prompt.js";

/**
 * The agentic loop.
 *
 * A "step" is one model request plus the tools it calls; a "turn" ends when the
 * model answers without asking for a tool. Deliberately transport-agnostic: the
 * server adapts llama-server's SSE into `ModelChunk`s, so this file stays pure
 * and testable without a running model.
 */

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

/** One streaming delta from the model. */
export interface ModelChunk {
  content?: string;
  toolCalls?: Array<{ index: number; id?: string; name?: string; argumentsDelta?: string }>;
  finishReason?: string;
}

export interface AgentTransport {
  (payload: {
    model: string;
    messages: AgentMessage[];
    tools: Array<Record<string, unknown>>;
    stream: true;
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    signal?: AbortSignal;
  }): AsyncGenerator<ModelChunk, void, unknown>;
}

export type AgentEvent =
  | { type: "assistant_delta"; text: string }
  | { type: "step"; index: number }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown>; raw: string }
  | { type: "tool_result"; id: string; name: string; ok: boolean; summary: string; content: string; durationMs: number }
  | { type: "denied"; id: string; name: string; reason: string }
  | { type: "compaction"; reason: string; before: number; after: number; kept: number }
  | { type: "steer_applied"; text: string; step: number }
  | { type: "delegate_call"; id: string; task: string }
  | { type: "delegate_result"; id: string; ok: boolean; text: string; steps: number; durationMs: number }
  | { type: "final"; text: string; steps: number }
  | { type: "error"; message: string };

/**
 * Emitted once, before the first model call, with the assembled system prompt's
 * section breakdown. Lets the UI show the user exactly what the model was told,
 * and in what order, without re-deriving the prompt.
 */
export interface AgentPromptEvent {
  type: "prompt";
  personality: string;
  sections: Array<{ name: string; chars: number; tokens: number | null }>;
  chars: number;
  memory: import("./memory.js").MemoryStats;
}

/** Asked before a mutating command runs. The server implements the UI side. */
export interface ApprovalPolicy {
  approve(req: { command: string; cwd: string }): Promise<boolean>;
}

export interface RunAgentOptions {
  transport: AgentTransport;
  model: string;
  /** Prior conversation, already shaped as agent messages. */
  history: AgentMessage[];
  system?: string;
  workspace: string;
  /** Hard ceiling on model/tool round-trips, so a confused model cannot spin. */
  maxSteps?: number;
  approval: ApprovalPolicy;
  signal?: AbortSignal;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  /** Tokenizer + window for the context tools. Omitted when no model is running. */
  meter?: import("./context.js").Meter;
  /** Inject the memory block and the skill catalog into the system prompt. */
  injectMemory?: boolean;
  injectSkills?: boolean;
  /**
   * Include the identity section (SOUL.md + caller text) as slot #1. On by
   * default; a caller doing a raw, identity-free completion turns it off.
   */
  injectIdentity?: boolean;
  /** Session personality overlay id (see soul.ts). */
  personality?: string;
  /**
   * Called once, before the first model call, with the assembled prompt and its
   * section breakdown. Lets the caller surface exactly what the model was told
   * without re-deriving the prompt.
   */
  onPrompt?: (built: BuiltPrompt) => void;
  /**
   * Skills the user explicitly activated in the composer. Their full bodies are
   * injected into the system prompt up front, so the model is already following
   * them — no load_skill round-trip. Several may be active at once.
   */
  activeSkills?: string[];
  /** The live task list, shared with the caller so the UI can render it. */
  todos?: TodoItem[];
  /** Durable session id: events are appended and session-query reads them. */
  sessionId?: string;
  /** ask_user_question hook; without it that tool reports unavailable. */
  askUser?: import("./tools.js").ToolContext["askUser"];
  /** web hooks for web_search / web_fetch. */
  web?: import("./tools.js").WebAccess;
  /**
   * Compaction policy. 'auto' compacts when the request would overflow the
   * window, 'off' skips it (and the upstream may reject). An approval hook
   * applies to 'ask' — the UI shows a "compact N messages?" prompt.
   */
  compaction?: "off" | "ask" | "auto";
  /** Called before an auto/ask compaction runs. Default = always allow. */
  compactApprove?: (info: { messages: number; older: number; reason: string }) => Promise<boolean>;
  /**
   * Orchestration: a steering mailbox the caller can push notes into while the
   * loop runs; drained between steps and injected as marked user messages.
   */
  steer?: SteerQueue;
  /** Allow delegate_task (isolated subagents). Default false — off in plain chat. */
  allowDelegate?: boolean;
  /** Max concurrent subagents one turn may spawn. */
  maxDelegateConcurrency?: number;
  /**
   * Extra tools for this run, on top of the built-ins — currently MCP tools.
   * Scoped per-run so a scheduled job and an interactive chat can expose
   * different connected servers.
   */
  extraTools?: import("./tools.js").AgentToolSpec[];
  /**
   * Executes an MCP tool call by its namespaced name. Supplied by the caller
   * (the server), so core stays free of transport details. When absent, an MCP
   * tool call reports "unavailable".
   */
  callMcp?: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
}

const DEFAULT_MAX_STEPS = 20;

/**
 * Parse the model's JSON arguments; a truncated or slightly malformed blob must
 * not crash the loop.
 *
 * Small local models routinely wrap arguments in markdown fences, append a
 * trailing comma, use single quotes, or emit prose around the object. A strict
 * `JSON.parse` turns all of those into "{}", and the tool then fails with a
 * confusing "path is required" the model cannot recover from. These repairs are
 * conservative: each one is only applied when it makes invalid JSON valid, and
 * the original string is always used as a last resort parse.
 */
export function parseArgs(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  const asObject = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

  // 1. The happy path.
  try {
    const v = asObject(JSON.parse(raw));
    if (v) return v;
  } catch {
    /* fall through to repairs */
  }

  let s = raw.trim();

  // 2. Strip a ```json … ``` (or bare ```) fence around the payload.
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  if (fence) s = fence[1]!.trim();

  // 3. If there is prose around the object, take the outermost {...}.
  if (!s.startsWith("{")) {
    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    if (first >= 0 && last > first) s = s.slice(first, last + 1);
  }

  // 4. Remove trailing commas before } or ] (a common model slip).
  const deComma = s.replace(/,\s*([}\]])/g, "$1");

  for (const candidate of [s, deComma]) {
    try {
      const v = asObject(JSON.parse(candidate));
      if (v) return v;
    } catch {
      /* try the next repair */
    }
  }

  // 5. Single-quoted keys/values: convert to double quotes when unambiguous.
  const single = deComma.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_m, inner) => `"${String(inner).replace(/"/g, '\\"')}"`);
  try {
    const v = asObject(JSON.parse(single));
    if (v) return v;
  } catch {
    /* give up quietly */
  }

  return {};
}

/**
 * Check the model's arguments against the tool's declared `required` fields.
 * Returns the first missing key, or null when the call is complete. This lets
 * the loop answer with a precise "missing required argument: path" the model
 * can correct, instead of a tool-specific error it has to guess at.
 */
export function missingRequiredArg(name: string, args: Record<string, unknown>, extra?: import("./tools.js").AgentToolSpec[]): string | null {
  const spec = toolByName(name, extra);
  const params = spec?.parameters as { required?: unknown } | undefined;
  const required = Array.isArray(params?.required) ? (params!.required as unknown[]) : [];
  for (const key of required) {
    const k = String(key);
    const v = args[k];
    if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) return k;
  }
  return null;
}

/**
 * Repair argument values against the tool's schema before dispatch.
 *
 * A small model serialises structured arguments as JSON *strings* — observed:
 * `ask_user_question` called with `options: "['4', '5']"` where the schema wants
 * an array, and `read_file` called with `offset: "1"` where it wants an integer.
 * The tool then sees the wrong type and fails on a call the model got logically
 * right, so the fix belongs here rather than in each tool.
 *
 * Conversion is deliberately conservative: only the shapes the schemas actually
 * declare (array, integer, number, boolean, object), only when the string parses
 * cleanly, and anything left unparsed passes through untouched so the tool's own
 * error stays honest.
 */
export function coerceArgs(
  name: string,
  args: Record<string, unknown>,
  extra?: import("./tools.js").AgentToolSpec[],
): Record<string, unknown> {
  const spec = toolByName(name, extra);
  const props = (spec?.parameters as { properties?: Record<string, { type?: string }> } | undefined)?.properties;
  if (!props) return args;
  const out: Record<string, unknown> = { ...args };
  for (const [key, raw] of Object.entries(out)) {
    const want = props[key]?.type;
    if (!want || typeof raw !== "string") continue;
    const s = raw.trim();
    if (!s) continue;
    const parsed = (): unknown => {
      try {
        return JSON.parse(s);
      } catch {
        return undefined;
      }
    };
    if (want === "array" || want === "object") {
      // Two-step on purpose: a small model writes structured args as JSON, but
      // very often with Python-style single quotes (`options: "['4', '5']"`),
      // which is not valid JSON. Try the strict parse, then the same text with
      // quotes normalised. Only for array/object fields, so a genuine apostrophe
      // in a plain string argument is never touched.
      const v = parsed() ?? (() => {
        try {
          return JSON.parse(s.replace(/'/g, '"'));
        } catch {
          return undefined;
        }
      })();
      if (v && typeof v === "object" && (want === "array") === Array.isArray(v)) out[key] = v;
    } else if (want === "integer" || want === "number") {
      const n = Number(s);
      if (Number.isFinite(n)) out[key] = want === "integer" ? Math.trunc(n) : n;
    } else if (want === "boolean") {
      const v = parsed();
      if (typeof v === "boolean") out[key] = v;
      else if (/^(true|yes|1)$/i.test(s)) out[key] = true;
      else if (/^(false|no|0)$/i.test(s)) out[key] = false;
    }
  }
  return out;
}

/** A compact one-line preview of tool arguments, for an approval prompt. */
export function summarizeArgs(args: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(args);
    return s.length > 240 ? `${s.slice(0, 240)}…` : s;
  } catch {
    return "(arguments)";
  }
}

/** Fold streamed tool-call fragments into complete calls, keyed by their index. */
export function accumulateToolCalls(
  pending: Map<number, { id?: string; name?: string; args: string }>,
  deltas: ModelChunk["toolCalls"],
): void {
  for (const d of deltas ?? []) {
    const slot = pending.get(d.index) ?? { args: "" };
    if (d.id) slot.id = d.id;
    if (d.name) slot.name = (slot.name ?? "") + d.name;
    if (d.argumentsDelta) slot.args += d.argumentsDelta;
    pending.set(d.index, slot);
  }
}

export async function* runAgent(opts: RunAgentOptions): AsyncGenerator<AgentEvent, void, unknown> {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;

  // Assemble the system prompt through the shared builder, so the agent, a
  // subagent and the UI's prompt inspector all see the same stack in the same
  // order. Identity (the soul) is slot #1 and REPLACES the default identity —
  // that is what makes it load-bearing rather than decorative.
  const lastUser = [...opts.history].reverse().find((m) => m.role === "user");
  const query = typeof lastUser?.content === "string" ? lastUser.content : undefined;
  const built = buildPrompt({
    system: opts.system,
    personality: opts.personality,
    identity: opts.injectIdentity !== false,
    toolRules: true,
    // The caller can turn memory off (a raw completion), but when it is on the
    // block is anchored on the current message so recall follows the ask.
    memory: opts.injectMemory !== false,
    skills: opts.injectSkills !== false,
    activeSkills: opts.activeSkills,
    workspace: true,
    scheduler: true,
  });

  const systemFull = built.prompt;
  // The context tools and the UI want the exact bytes that went in, and the
  // section breakdown, rather than re-deriving the prompt a second time.
  opts.onPrompt?.(built);

  const messages: AgentMessage[] = [
    ...(systemFull ? [{ role: "system" as const, content: systemFull }] : []),
    ...opts.history,
  ];
  void query;
  let finalText = "";

  /** The tool schemas are fixed for the run; build them once (built-ins + MCP). */
  const extraTools = opts.extraTools ?? [];
  const tools = toolSchemas(extraTools);
  /** True when a name belongs to an injected (MCP) tool rather than a built-in. */
  const isExtraTool = (name: string): boolean => extraTools.some((t) => t.name === name);

  /**
   * Compact when the request would not fit. Runs once before the first model
   * call if `opts.compaction` is `auto` or `ask`. The plan keeps at least the
   * most recent exchange verbatim and never splits a tool result from its
   * call — the split point is on the assistant turn, never the tool reply.
   */
  /** Compaction policy for this turn ('auto' by default). */
  const compaction = opts.compaction ?? "auto";
  const approveCompact = opts.compactApprove ?? (async () => true);
  if (compaction !== "off" && opts.meter) {
    const compacted = await maybeCompact({ messages, tools, meter: opts.meter, model: opts.model, transport: opts.transport, signal: opts.signal, policy: compaction, approve: approveCompact });
    if (compacted.did) {
      // Replace the in-memory list with the compacted one. The agent loop then
      // continues against a smaller request; the originals stay in the session
      // log via appendEvents below, so replay still sees them.
      yield { type: "compaction", reason: compacted.reason, before: compacted.before, after: compacted.after, kept: compacted.kept };
      appendEvents(opts.sessionId ?? "", opts.workspace, [
        { kind: "summary", data: { kind: "compaction", before: compacted.before, after: compacted.after, reason: compacted.reason } },
      ]);
      // Splice the compacted list back in.
      const [sys, ...rest] = messages;
      const [newSys, ...newRest] = compacted.messages;
      messages.length = 0;
      messages.push(...(newSys ? [newSys, ...newRest] : (sys ? [sys, ...newRest] : [...newRest])));
    }
  }

  /**
   * Fan one delegate_task call out to real subagents. Run-scoped (no module
   * globals — a nested runAgent MUST NOT see or clobber the parent's),
   * bounded to 2 concurrent children, preserving result order.
   */
  async function delegateBatch(
    tasks: string[],
  ): Promise<Array<{ ok: boolean; text: string; steps: number; error?: string }>> {
    const outs: Array<{ ok: boolean; text: string; steps: number; error?: string }> = new Array(tasks.length);
    let cursor = 0;
    const MAXC = 2;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = cursor++;
        if (i >= tasks.length) return;
        delegateSeq += 1;
        const id = `d${delegateSeq}`;
        const started = Date.now();
        const r = await delegateSubagent({
          task: tasks[i]!,
          transport: opts.transport,
          model: opts.model,
          workspace: opts.workspace,
          approval: opts.approval,
          meter: opts.meter,
          maxSteps: 6,
          signal: opts.signal,
        });
        outs[i] = r;
        delegateEvents.push({ type: "delegate_result", id, ok: r.ok, text: r.text, steps: r.steps, durationMs: Date.now() - started });
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAXC, tasks.length) }, worker));
    return outs;
  }
  let delegateSeq = 0;
  const delegateEvents: AgentEvent[] = [];
  /** Guards the one empty-answer retry per turn (see the empty-final branch). */
  let retriedEmpty = false;
  /** Set for the retry so it is deterministic rather than another sample. */
  let temperatureOverride: number | undefined;

  for (let step = 0; step < maxSteps; step++) {
    yield { type: "step", index: step };

    // Mid-turn steering: notes pushed while the previous step ran are drained
    // here and become a marked user message, so the model adapts course
    // without the user stopping the turn.
    const notes = opts.steer?.drain() ?? [];
    if (notes.length) {
      const text = `<user-steering>\n${notes.join("\n")}\n</user-steering>`;
      messages.push({ role: "user", content: text });
      for (const n of notes) yield { type: "steer_applied", text: n, step };
      appendEvents(opts.sessionId ?? "", opts.workspace, [
        { kind: "message", data: { role: "user", steering: true, preview: notes.join(" | ").slice(0, 600) } },
      ]);
    }

    let text = "";
    const pending = new Map<number, { id?: string; name?: string; args: string }>();
    let finishReason: string | undefined;
    /** Set once an empty answer is retried; the rest of the turn stays deterministic. */
    const temperature = temperatureOverride ?? opts.temperature;

    try {
      for await (const chunk of opts.transport({
        model: opts.model,
        messages,
        tools,
        stream: true,
        temperature,
        top_p: opts.top_p,
        max_tokens: opts.max_tokens,
        signal: opts.signal,
      })) {
        if (chunk.content) {
          text += chunk.content;
          yield { type: "assistant_delta", text: chunk.content };
        }
        if (chunk.toolCalls) accumulateToolCalls(pending, chunk.toolCalls);
        if (chunk.finishReason) finishReason = chunk.finishReason;
      }
    } catch (e) {
      yield { type: "error", message: (e as Error).message };
      return;
    }

    const calls: ToolCall[] = [...pending.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({
        id: v.id || `call_${Math.random().toString(36).slice(2, 10)}`,
        type: "function" as const,
        function: { name: v.name ?? "", arguments: v.args || "{}" },
      }));

    // Record the assistant turn exactly as it arrived, so the next request has
    // the tool_calls the model is answering for.
    messages.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });

    if (calls.length === 0) {
      finalText = text;
      // A model that stops with no content at all has not answered — it has
      // silently ended the turn. Observed with a small local model on a tool
      // task: no call, no text, and the user saw "the model finished without
      // saying anything". Rather than hand that back, re-prompt once, at
      // temperature 0 so the retry is not another sample of the same lottery;
      // if the model still says nothing, let the normal empty-final path
      // report it instead of looping.
      if (!finalText.trim() && !retriedEmpty && step + 1 < maxSteps) {
        retriedEmpty = true;
        temperatureOverride = 0;
        messages.push({
          role: "user",
          content:
            "Your previous reply was empty. Answer now in plain text — a tool call only if you genuinely need one.",
        });
        yield { type: "step", index: step };
        continue;
      }
      appendEvents(opts.sessionId ?? "", opts.workspace, [
        { kind: "message", data: { role: "assistant", preview: finalText.slice(0, 2000), steps: step + 1 } },
      ]);
      yield { type: "final", text: finalText, steps: step + 1 };
      return;
    }

    // Concurrency discipline (Hermes rule): independent read-only calls from
    // one turn run concurrently; mutating calls stay sequential and gated so
    // approvals and filesystem writes cannot interleave.
    const mutatingCalls = calls.filter((c) => (toolByName(c.function.name, extraTools)?.mutating ?? false));
    const readOnlyCalls = calls.filter((c) => !mutatingCalls.includes(c));
    /**
     * Announce EVERY call before dispatching any of them.
     *
     * A generator cannot yield while it is awaiting a tool, so the call event
     * has to leave here first or the client only learns about a tool once it has
     * already finished — which made a 30-second crawl indistinguishable from an
     * instant directory listing, and left the UI with nothing to show while the
     * agent worked. Announcing up front also matches what actually happens:
     * read-only calls are dispatched in parallel, so several ARE in flight at
     * once, and the client can now say so.
     *
     * `runOneTool` therefore does NOT emit `tool_call`; it records the call in
     * the session log and returns only its result.
     */
    for (const call of [...readOnlyCalls, ...mutatingCalls]) {
      yield {
        type: "tool_call",
        id: call.id,
        name: call.function.name,
        args: parseArgs(call.function.arguments),
        raw: call.function.arguments,
      };
    }

    // Emit results in dispatch order. Reads in parallel => their results are
    // grouped; mutation events interleave exactly as they complete. The
    // transcript (`messages`) is mutated inside runOneTool in completion order,
    // which keeps each tool reply adjacent to its request either way.
    if (readOnlyCalls.length > 1) {
      const settled = await Promise.all(readOnlyCalls.map((call) => runOneTool(call, "parallel")));
      for (const evs of settled) for (const e of evs) yield e;
    } else {
      for (const call of readOnlyCalls) {
        const evs = await runOneTool(call, "sequential");
        for (const e of evs) yield e;
      }
    }
    for (const call of mutatingCalls) {
      const evs = await runOneTool(call, "sequential");
      for (const e of evs) yield e;
    }
    // delegation results produced during Promise.all
    while (delegateEvents.length) {
      const e = delegateEvents.shift()!;
      yield e;
    }

    /**
     * Execute one tool call: mutates `messages` (the transcript), returns the
     * events the caller should yield, in order. Pure orchestration — no
     * yields of its own, so it works for concurrent and sequential dispatch.
     *
     * It does NOT emit `tool_call`: the caller announces every call before
     * dispatching (see above), because a generator cannot yield while awaiting
     * and the call must reach the client BEFORE the work starts. Here the call
     * only goes to the session log.
     */
    async function runOneTool(call: ToolCall, mode: "parallel" | "sequential"): Promise<AgentEvent[]> {
      const evs: AgentEvent[] = [];
      const emit = (e: AgentEvent) => evs.push(e);
      const name = call.function.name;
      // Repair JSON-as-string arguments before anything type-sensitive looks at
      // them, so a logically-correct call is not rejected on its serialisation.
      const args = coerceArgs(name, parseArgs(call.function.arguments), extraTools);
      appendEvents(opts.sessionId ?? "", opts.workspace, [
        { kind: "tool_call", data: { id: call.id, name, args, step } },
      ]);

      const spec = toolByName(name, extraTools);
      if (!spec) {
        const content = `unknown tool: ${name}`;
        messages.push({ role: "tool", tool_call_id: call.id, name, content });
        emit({ type: "tool_result", id: call.id, name, ok: false, summary: "unknown tool", content, durationMs: 0 });
        return evs;
      }

      // A precise, recoverable error beats a tool-internal guess. The model
      // sees exactly which argument is missing and can re-issue the call.
      const missing = missingRequiredArg(name, args, extraTools);
      if (missing) {
        const content = `missing required argument "${missing}" for ${name}. Re-call ${name} with all required fields.`;
        messages.push({ role: "tool", tool_call_id: call.id, name, content });
        emit({ type: "tool_result", id: call.id, name, ok: false, summary: `missing arg: ${missing}`, content, durationMs: 0 });
        return evs;
      }

      const started = Date.now();
      let result: ToolResult;
      try {
        if (isExtraTool(name)) {
          // An injected (MCP) tool: gated by the approval policy when the spec
          // is mutating (an untrusted server), then handed to the caller's MCP
          // executor. When no executor is wired, report it honestly.
          if (spec.mutating) {
            const approved = await opts.approval.approve({ command: `MCP: ${name} ${summarizeArgs(args)}`, cwd: opts.workspace }).catch(() => false);
            if (!approved) {
              result = { ok: false, content: "the user denied this MCP tool call", summary: "denied by user" };
              messages.push({ role: "tool", tool_call_id: call.id, name, content: result.content });
              emit({ type: "denied", id: call.id, name, reason: "user denied" });
              emit({ type: "tool_result", id: call.id, name, ok: false, summary: "denied by user", content: result.content, durationMs: Date.now() - started });
              return evs;
            }
          }
          if (!opts.callMcp) {
            result = { ok: false, content: `MCP tool ${name} is not available in this run`, summary: "mcp unavailable" };
          } else {
            result = await opts.callMcp(name, args);
          }
        } else if (isSchedulerTool(name)) {
          result = await executeSchedulerTool(
            name,
            args,
            // Per-job approval: a job created with `ask` prompts the user here,
            // `deny` is a no-op, `auto` is implicit (ask never called).
            opts.askUser
              ? async (q) => {
                  const ans = await opts.askUser!({ id: `j_${Date.now().toString(36)}`, question: q.command, options: ["Allow", "Deny"] }, QUESTION_TIMEOUT_MS);
                  return ans ? /^y|^allow|^yes/i.test(ans) : false;
                }
              : undefined,
          );
        } else if (isContextTool(name)) {
          result = await executeContextTool(name, args, {
            meter: opts.meter,
            // Measure the request as it actually stands right now, tool
            // schemas included, so the number the model sees is the real one.
            messages: [...messages, { role: "user", content: null }] as import("./context.js").ChatMessage[],
            tools,
            todos: opts.todos,
            sessionId: opts.sessionId,
            askUser: opts.askUser,
            web: opts.web,
            delegate: opts.allowDelegate ? delegateBatch : undefined,
          });
        } else {
          result = await executeTool(name, args, {
            workspace: opts.workspace,
            web: opts.web,
            signal: opts.signal,
            onCommand: spec.mutating
              ? async (command, cwd) => {
                  try {
                    return await opts.approval.approve({ command, cwd });
                  } catch {
                    return false;
                  }
                }
              : undefined,
          });
        }
      } catch (e) {
        result = { ok: false, content: `${name} threw: ${(e as Error).message}`, summary: "error" };
      }
      const durationMs = Date.now() - started;

      if (!result.ok && result.summary === "denied by user") {
        const content = "the user denied this command — do not retry it; ask how to proceed or try another approach";
        messages.push({ role: "tool", tool_call_id: call.id, name, content });
        emit({ type: "denied", id: call.id, name, reason: "user denied" });
        emit({ type: "tool_result", id: call.id, name, ok: false, summary: "denied by user", content, durationMs });
        return evs;
      }

      messages.push({ role: "tool", tool_call_id: call.id, name, content: result.content });
      appendEvents(opts.sessionId ?? "", opts.workspace, [
        { kind: "tool_result", data: { id: call.id, name, ok: result.ok, summary: result.summary, content: result.content.slice(0, 2000), durationMs } },
      ]);
      // A successful write becomes a named artifact the UI can list.
      if (result.ok && (name === "write_file" || name === "edit_file" || name === "write_script" || name === "manage_file" || name === "replace_in_files")) {
        const file = name === "manage_file" ? String(args.to ?? args.path ?? "") : String(args.path ?? "");
        appendEvents(opts.sessionId ?? "", opts.workspace, [
          { kind: "artifact", data: { file, op: name, summary: result.summary } },
        ]);
      }
      emit({ type: "tool_result", id: call.id, name, ok: result.ok, summary: result.summary, content: result.content, durationMs });
      return evs;
    }
  }

  yield {
    type: "error",
    message: `stopped after ${maxSteps} steps without a final answer — the model kept calling tools`,
  };
}

/* ------------------------------------------------------------- compaction */

/**
 * Compact the message list before the first model call when it would not fit.
 *
 * Split out of `runAgent` so it stays a pure function (transport is supplied
 * via the same interface the loop uses). It asks the model to summarise the
 * older turns via a one-shot non-tool transport, then splices the result back
 * in. If the request already fits, returns `did: false`.
 */
async function maybeCompact(input: {
  messages: AgentMessage[];
  tools: Array<Record<string, unknown>>;
  meter: Meter;
  model: string;
  transport: AgentTransport;
  signal?: AbortSignal;
  policy: "off" | "ask" | "auto";
  approve: (info: { messages: number; older: number; reason: string }) => Promise<boolean>;
}): Promise<{ did: boolean; messages: AgentMessage[]; reason: string; before: number; after: number; kept: number }> {
  const chatMessages: ChatMessage[] = input.messages.map((m) => ({
    role: m.role,
    content: m.content,
    tool_calls: m.tool_calls,
    tool_call_id: m.tool_call_id,
    name: m.name,
  }));
  const breakdown = await measureContext(input.meter, chatMessages, input.tools);
  const window = breakdown.window;
  if (breakdown.remaining > 256) {
    return { did: false, messages: input.messages, reason: `within budget (${breakdown.used}/${window})`, before: 0, after: 0, kept: 0 };
  }
  const plan = planCompaction(chatMessages, breakdown.used, window);
  if (!plan.needed) {
    return { did: false, messages: input.messages, reason: plan.reason, before: 0, after: 0, kept: 0 };
  }
  // 'ask' hands the choice to the UI; 'auto' just goes ahead.
  if (input.policy === "ask") {
    const ok = await input.approve({ messages: chatMessages.length, older: plan.older.length, reason: plan.reason });
    if (!ok) return { did: false, messages: input.messages, reason: "user declined compaction", before: 0, after: 0, kept: 0 };
  }

  // Build a summarising-only transport: same model, no tools, no streaming of
  // tool-calls. We just want the text reply and stop.
  const prompt = summarizationPrompt(plan.older, 768);
  let summary = "";
  for await (const chunk of input.transport({
    model: input.model,
    messages: [
      { role: "system", content: "You condense conversation transcripts into compact summaries. Follow the instructions in the user message exactly." },
      { role: "user", content: prompt },
    ],
    tools: [],
    stream: true,
    signal: input.signal,
  })) {
    if (chunk.content) summary += chunk.content;
    if (chunk.finishReason) break;
  }
  summary = summary.trim();
  if (!summary) {
    return { did: false, messages: input.messages, reason: "summarisation returned nothing", before: 0, after: 0, kept: 0 };
  }

  const newChat = applyCompaction(summary, plan.recent);
  const before = chatMessages.length;
  const after = newChat.length;
  // Convert back to AgentMessage (content may be string, not null)
  const newMessages: AgentMessage[] = newChat.map((m) => ({
    role: m.role,
    content: typeof m.content === "string" ? m.content : null,
    tool_calls: m.tool_calls as ToolCall[] | undefined,
    tool_call_id: m.tool_call_id,
    name: m.name,
  }));
  return { did: true, messages: newMessages, reason: plan.reason, before, after, kept: plan.recent.length };
}
