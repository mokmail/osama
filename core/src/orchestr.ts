import { runAgent, type AgentEvent, type AgentTransport, type ApprovalPolicy, type AgentMessage } from "./agent.js";
import { createMeter, type ChatMessage } from "./context.js";

/**
 * Orchestration: the parts of the harness that coordinate LOOPS rather than
 * execute tools.
 *
 * Hermes splits this into three ideas this module ports for Osama:
 *
 * 1. Delegation — a subtask goes to a fresh agent loop with its own bounded
 *    context; only the final summary returns to the caller. One level deep
 *    (a delegatee cannot delegate), so runs are finite and attributable.
 * 2. Steering — a running loop can receive user notes mid-turn; they are
 *    drained between steps and injected as marked user messages.
 * 3. Concurrency discipline — independent read-only tool calls from one model
 *    turn execute concurrently (Promise.all); mutating ones stay sequential,
 *    gated, and ordered.
 *
 * Everything here is transport-injected, so it is testable without a model.
 */

/** Bounded steering mailbox for one running agent turn. */
export interface SteerQueue {
  push(text: string): void;
  drain(): string[];
  get size(): number;
}

export function createSteerQueue(): SteerQueue {
  const buf: string[] = [];
  return {
    push(text: string) { const t = text.trim(); if (t) buf.push(t.slice(0, 4000)); },
    drain() { return buf.splice(0, buf.length); },
    get size() { return buf.length; },
  };
}

export interface DelegateOptions {
  task: string;
  transport: AgentTransport;
  model: string;
  workspace: string;
  /** Approval policy the SUBAGENT uses for its own mutating calls. */
  approval: ApprovalPolicy;
  /** Context the caller shares: skills/memory/scheduler blocks for the system prompt. */
  system?: string;
  meter?: import("./context.js").Meter;
  sessionId?: string;
  web?: import("./tools.js").WebAccess;
  maxSteps?: number;
  signal?: AbortSignal;
}

export interface DelegateResult {
  ok: boolean;
  text: string;
  steps: number;
  error?: string;
}

const DELEGATE_MAX_STEPS = 6;
const MAX_DELEGATE_CONCURRENCY = 2;

/**
 * Run one subagent on a task. The child sees ONLY its task + the injected
 * system blocks — nothing about the caller's conversation. Its tool calls are
 * real (same tools), its transcript is discarded, and only the final text is
 * handed back — exactly the isolation Hermes' delegate_task provides.
 */
export async function delegateSubagent(o: DelegateOptions): Promise<DelegateResult> {
  const history: AgentMessage[] = [{ role: "user", content: o.task }];
  let final = "";
  let steps = 0;
  let error: string | undefined;
  try {
    for await (const ev of runAgent({
      transport: o.transport,
      model: o.model,
      history,
      system: o.system ??
        "You are a focused subagent. Complete exactly the task you were given, using tools when they help, "
        + "then give a compact final report. Do not ask the user anything — decide and act.",
      workspace: o.workspace,
      approval: o.approval,
      meter: o.meter,
      maxSteps: o.maxSteps ?? DELEGATE_MAX_STEPS,
      sessionId: o.sessionId,
      web: o.web,
      injectMemory: true,
      injectSkills: true,
    })) {
      if (ev.type === "final") { final = ev.text; steps = ev.steps; }
      if (ev.type === "error") error = ev.message;
    }
  } catch (e) {
    error = (e as Error).message;
  }
  if (error && !final) return { ok: false, text: "", steps, error };
  return { ok: true, text: final || "(subagent produced no text)", steps, error };
}

/**
 * Run a batch of delegate calls concurrently (bounded), preserving result order.
 * Used when one model turn asks for several delegations at once.
 */
export async function delegateConcurrent(tasks: string[], o: Omit<DelegateOptions, "task">, onDone?: (i: number, r: DelegateResult) => void): Promise<DelegateResult[]> {
  const out: DelegateResult[] = new Array(tasks.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= tasks.length) return;
      const r = await delegateSubagent({ ...o, task: tasks[i]! });
      out[i] = r;
      onDone?.(i, r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_DELEGATE_CONCURRENCY, tasks.length) }, worker));
  return out;
}

/**
 * The discipline block Hermes puts in every agent system prompt, ported.
 * Injected ONLY when tools are in play — plain chat does not need it.
 */
export function orchestrationBlock(): string {
  return [
    "Working rules:",
    "- Orient with tree/glob/grep before acting; check file_info on large files before reading them.",
    "- Batch independent tool calls in one turn instead of round-tripping serially (reads first, writes after).",
    "- Tool results are authoritative: if a result contradicts your plan, adapt — never claim a step succeeded without a tool result showing it.",
    "- Before declaring a task done, re-check it against every stated requirement; if a verification step is cheap (reading back a file you wrote, recomputing a number), do it.",
    "- If a tool fails, adjust the approach rather than repeating the exact same call.",
    "- Hand self-contained subtasks to a subagent with delegate_task; give it the full context it needs and return only its report.",
    "- Write real files into the workspace with write_file, and prefer write_script for anything more than a one-line command.",
  ].join("\n");
}