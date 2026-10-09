import { useEffect, useState } from "react";
import {
  AlertTriangle, Check, ChevronDown, CheckCircle2, Terminal, XCircle, ShieldQuestion,
} from "lucide-react";
import type { AgentStep } from "../lib/types";
import { duration } from "../lib/format";
import { Button } from "./ui";

/**
 * What a tool call is doing, in the user's words rather than the model's.
 *
 * The tool name alone ("read_file") says what KIND of thing is happening but not
 * what it is happening TO; the arguments alone say the opposite. Pairing a verb
 * with the one argument that identifies the subject is what makes the live line
 * legible at a glance while the agent works — `read_file {path: "a/b.md"}`
 * becomes "reading a/b.md".
 */
const TOOL_VERBS: Record<string, string> = {
  read_file: "reading",
  write_file: "writing",
  edit_file: "editing",
  write_script: "writing script",
  list_dir: "listing",
  glob: "finding files",
  grep: "searching",
  tree: "mapping tree",
  file_info: "inspecting",
  manage_file: "managing file",
  replace_in_files: "replacing in files",
  run_command: "running command",
  write_todo: "updating todos",
  load_skill: "loading skill",
  list_skills: "listing skills",
  create_skill: "creating skill",
  save_memory: "saving memory",
  update_memory: "updating memory",
  recall_memory: "recalling memory",
  forget_memory: "forgetting memory",
  update_soul: "updating soul",
  ask_user_question: "asking you",
  web_search: "searching the web",
  web_fetch: "fetching",
  web_crawl: "crawling",
  web_download: "downloading",
  http_request: "http request",
  session_search: "searching sessions",
  session_events: "reading session",
  context_status: "measuring context",
  list_jobs: "listing jobs",
  create_job: "creating job",
  delete_job: "deleting job",
  set_job: "updating job",
  job_history: "reading job history",
  delegate_task: "delegating",
};

/** The one argument that identifies what the call is acting on. */
const TARGET_KEYS = ["path", "file", "command", "pattern", "url", "query", "question", "task", "name", "id", "text"];

/** A verb and its object for one tool call, e.g. {label:"reading", target:"src/app.ts"}. */
export function describeTool(name: string, args?: Record<string, unknown>): { label: string; target?: string } {
  // An MCP tool is namespaced `mcp__server__tool`. Naming the server is the
  // useful half: the tool names are the server's own and say nothing about
  // where the call is going.
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return { label: `mcp · ${parts[1] ?? "server"}`, target: parts.slice(2).join("__") || undefined };
  }
  const label = TOOL_VERBS[name] ?? name.replace(/_/g, " ");
  let target: string | undefined;
  for (const k of TARGET_KEYS) {
    const v = args?.[k];
    if (typeof v === "string" && v) { target = v; break; }
  }
  if (!target && args) {
    const first = Object.values(args).find((v) => typeof v === "string" && v);
    if (typeof first === "string") target = first;
  }
  return { label, target };
}

/**
 * Every call still executing.
 *
 * Read-only tool calls are dispatched CONCURRENTLY on the server, so naming
 * just the most recent `call` would claim a tool is running that may already
 * have finished. A call is in flight exactly when its id has no result yet —
 * that test is order-independent, which is what makes it correct under parallel
 * dispatch. (A finished call is replaced by its result, so it cannot match.)
 */
export function inflightCalls(steps?: AgentStep[]): AgentStep[] {
  if (!steps?.length) return [];
  const done = new Set<string>();
  for (const s of steps) if (s.kind === "result" || s.kind === "denied") done.add(s.id);
  return steps.filter((s) => s.kind === "call" && !done.has(s.id));
}

/** The single call the live line follows (the most recently dispatched one). */
function inflightCall(steps?: AgentStep[]): AgentStep | undefined {
  const pending = inflightCalls(steps);
  return pending[pending.length - 1];
}

/**
 * Time since the tool in flight started, counted locally.
 *
 * The server emits `tool_call` BEFORE executing, so the moment the UI receives
 * it is the tool's real start; the store is not written per tick, so a running
 * tool does not re-render the whole transcript. The authoritative duration is
 * the `durationMs` on the result, which replaces this once the tool returns.
 */
function useLiveElapsed(id: string | undefined): number {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    if (!id) { setMs(0); return; }
    const t0 = Date.now();
    setMs(0);
    const t = setInterval(() => setMs(Date.now() - t0), 200);
    return () => clearInterval(t);
  }, [id]);
  return ms;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * The live "which tool is running, and on what" line.
 *
 * Rendered above the trace while a turn streams, so the answer to "what is it
 * doing?" never requires expanding anything. Between tool calls there is
 * nothing in flight — that gap is the model thinking, and it says so rather
 * than leaving a stale tool name on screen.
 */
export function ActivityLine({
  steps, running, waiting, step,
}: {
  steps?: AgentStep[];
  running?: boolean;
  /** The turn is parked on the user, so "thinking" would be a lie. */
  waiting?: "approval" | "question" | null;
  step?: number;
}) {
  const pending = running ? inflightCalls(steps) : [];
  const head = pending[pending.length - 1];
  const elapsed = useLiveElapsed(head?.id);
  if (!running) return null;

  const d = head ? describeTool(head.name, head.args) : null;
  const others = pending.length - 1;
  const verb = waiting === "approval" ? "waiting for your approval"
    : waiting === "question" ? "waiting for your answer"
    : d?.label ?? "thinking";

  return (
    <div className="arun" role="status" aria-live="polite">
      <span className={`arun-dot ${pending.length ? "tool" : waiting ? "hold" : ""}`} aria-hidden="true" />
      <span className="arun-verb">{verb}</span>
      {d?.target && <span className="arun-target" title={d.target}>{clip(d.target, 72)}</span>}
      {others > 0 && (
        <span className="arun-more" title={pending.map((s) => describeTool(s.name, s.args).target ?? s.name).join("\n")}>
          +{others} more
        </span>
      )}
      {!pending.length && !waiting && <span className="arun-note">no tool in flight — the model is deciding</span>}
      <span className="arun-spacer" />
      {step ? <span className="arun-step">step {step}</span> : null}
      {head && elapsed >= 1000 && <span className="arun-time">{duration(elapsed)}</span>}
    </div>
  );
}

/**
 * The agent's visible working: which tool ran, with what arguments, and what
 * came back.
 *
 * While the turn is live this opens itself and marks the call in flight, so the
 * user watches the agent work without having to click. Once it finishes it
 * collapses back to a one-line summary — a long trace should not bury the
 * answer it produced.
 */
export function AgentTrace({
  steps, steps_count, running,
}: {
  steps: AgentStep[];
  steps_count?: number;
  running?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const pending = inflightCalls(steps);
  const liveIds = new Set(pending.map((s) => s.id));
  const head = pending[pending.length - 1];
  const elapsed = useLiveElapsed(running ? head?.id : undefined);

  // Open while the agent is working: the trace IS the progress display, and a
  // collapsed one during a long tool call shows nothing at all. It does not
  // auto-collapse, so what happened stays readable afterwards.
  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);

  if (!steps.length) return null;

  // Count invocations, not "call" entries: a finished call is replaced by its
  // result, so counting only kind === "call" reported 0 once the tool returned.
  const calls = steps.filter((s) => s.kind === "call" || s.kind === "result").length;
  const failed = steps.some((s) => s.kind === "result" && s.ok === false);
  const live = running && head ? describeTool(head.name, head.args) : null;

  return (
    <div className={`atrace ${open ? "open" : ""}`}>
      <button className="atrace-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Terminal size={13} />
        <span className="atrace-title">
          {live ? <>working · {live.label}{live.target ? ` ${clip(live.target, 46)}` : ""}</> : (
            <>
              {running ? "working" : "worked"}
              {" · "}
              {calls} tool call(s)
              {steps_count ? `, ${steps_count} step(s)` : ""}
            </>
          )}
        </span>
        {failed && <AlertTriangle size={12} className="atrace-warn" />}
        <ChevronDown size={13} className="atrace-chev" />
      </button>

      {open && (
        <div className="atrace-body">
          {steps.map((s, i) => {
            const isLive = running && s.kind === "call" && liveIds.has(s.id);
            const d = s.kind === "call" ? describeTool(s.name, s.args) : null;
            return (
              <div key={`${s.id}-${s.kind}-${i}`} className={`astep ${s.kind} ${s.ok === false ? "bad" : ""} ${isLive ? "live" : ""}`}>
                <div className="astep-line">
                  {isLive ? <span className="astep-live-dot" />
                    : s.kind === "call" ? <Terminal size={12} />
                    : s.kind === "denied" ? <ShieldQuestion size={12} />
                    : s.ok ? <CheckCircle2 size={12} />
                    : <XCircle size={12} />}
                  <span className="astep-name">{d ? d.label : s.name}</span>
                  <span className="astep-sum">
                    {s.kind === "call" ? d?.target ?? summarizeArgs(s.args)
                      : s.kind === "denied" ? s.summary ?? "denied"
                      : s.summary}
                  </span>
                  {isLive ? (
                    <span className="astep-ms">{elapsed >= 1000 ? duration(elapsed) : "…"}</span>
                  ) : typeof s.durationMs === "number" && s.durationMs > 0 ? (
                    <span className="astep-ms">{s.durationMs}ms</span>
                  ) : null}
                </div>
                {s.kind === "call" && s.args && Object.keys(s.args).length > 0 && (
                  <pre className="astep-pre">{JSON.stringify(s.args, null, 2)}</pre>
                )}
                {s.kind !== "call" && s.content && (
                  <pre className="astep-pre">{clip(s.content, 1200)}</pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function summarizeArgs(args?: Record<string, unknown>): string {
  if (!args) return "";
  for (const key of ["path", "command", "pattern"]) {
    const v = args[key];
    if (typeof v === "string" && v) return v.length > 90 ? `${v.slice(0, 90)}…` : v;
  }
  const first = Object.values(args)[0];
  return typeof first === "string" ? first.slice(0, 90) : "";
}

/**
 * A question the agent asked, waiting inline in the transcript. The loop is
 * parked until this is answered or it times out — same semantics as approval.
 */
export function QuestionPrompt({
  question, options, onAnswer, busy,
}: {
  question: string;
  options?: string[];
  onAnswer: (text: string) => void;
  busy?: boolean;
}) {
  const [typed, setTyped] = useState("");
  return (
    <div className="approval question">
      <div className="approval-head">
        <ShieldQuestion size={14} />
        <span>The agent asks</span>
      </div>
      <div className="approval-q">{question}</div>
      {options && options.length > 0 && (
        <div className="qopts">
          {options.map((o) => (
            <Button key={o} size="sm" variant="ghost" onClick={() => onAnswer(o)} disabled={busy}>
              {o}
            </Button>
          ))}
        </div>
      )}
      <div className="row" style={{ gap: 8, marginTop: options?.length ? 8 : 10 }}>
        <input
          className="input"
          style={{ flex: 1 }}
          placeholder="Type an answer…"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && typed.trim()) onAnswer(typed.trim()); }}
          autoFocus
        />
        <Button size="sm" variant="primary" onClick={() => typed.trim() && onAnswer(typed.trim())} disabled={busy || !typed.trim()}>
          Answer
        </Button>
      </div>
    </div>
  );
}
/**
 * A command waiting on the user. Rendered inline in the transcript; the loop
 * on the server is parked until one of these buttons is pressed, so declining
 * is a real refusal rather than a UI-only gesture.
 */
export function ApprovalPrompt({
  command, cwd, onAnswer, onAllowAll, busy,
}: {
  command: string;
  cwd: string;
  onAnswer: (allow: boolean) => void;
  /** Approve this and every later command this session without asking again. */
  onAllowAll?: () => void;
  busy?: boolean;
}) {
  return (
    <div className="approval">
      <div className="approval-head">
        <ShieldQuestion size={14} />
        <span>The agent wants to run a command</span>
      </div>
      <pre className="approval-cmd">{command}</pre>
      <div className="approval-cwd">in {cwd}</div>
      <div className="row" style={{ gap: 8, marginTop: 10 }}>
        <Button size="sm" variant="primary" onClick={() => onAnswer(true)} disabled={busy}>
          <Check size={13} /> Allow
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onAnswer(false)} disabled={busy}>
          <XCircle size={13} /> Deny
        </Button>
        {onAllowAll && (
          <Button size="sm" variant="ghost" onClick={onAllowAll} disabled={busy}
            title="Approve this and all later commands in this chat without asking again">
            <Check size={13} /> Allow all
          </Button>
        )}
      </div>
    </div>
  );
}
