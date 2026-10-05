import { useState } from "react";
import {
  AlertTriangle, Check, ChevronDown, CheckCircle2, Terminal, XCircle, ShieldQuestion,
} from "lucide-react";
import type { AgentStep } from "../lib/types";
import { Button } from "./ui";

/**
 * The agent's visible working: which tool ran, with what arguments, and what
 * came back. Collapsed by default so a long trace does not bury the answer.
 */
export function AgentTrace({
  steps, steps_count, running,
}: {
  steps: AgentStep[];
  steps_count?: number;
  running?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!steps.length) return null;

  // Count invocations, not "call" entries: a finished call is replaced by its
  // result, so counting only kind === "call" reported 0 once the tool returned.
  const calls = steps.filter((s) => s.kind === "call" || s.kind === "result").length;
  const failed = steps.some((s) => s.kind === "result" && s.ok === false);
  return (
    <div className={`atrace ${open ? "open" : ""}`}>
      <button className="atrace-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Terminal size={13} />
        <span className="atrace-title">
          {running ? "working" : "worked"}
          {" · "}
          {calls} tool call(s)
          {steps_count ? `, ${steps_count} step(s)` : ""}
        </span>
        {failed && <AlertTriangle size={12} className="atrace-warn" />}
        <ChevronDown size={13} className="atrace-chev" />
      </button>

      {open && (
        <div className="atrace-body">
          {steps.map((s, i) => (
            <div key={`${s.id}-${s.kind}-${i}`} className={`astep ${s.kind} ${s.ok === false ? "bad" : ""}`}>
              <div className="astep-line">
                {s.kind === "call" ? <Terminal size={12} />
                  : s.kind === "denied" ? <ShieldQuestion size={12} />
                  : s.ok ? <CheckCircle2 size={12} />
                  : <XCircle size={12} />}
                <span className="astep-name">{s.name}</span>
                <span className="astep-sum">
                  {s.kind === "call" ? summarizeArgs(s.args)
                    : s.kind === "denied" ? s.summary ?? "denied"
                    : s.summary}
                </span>
                {typeof s.durationMs === "number" && s.durationMs > 0 && (
                  <span className="astep-ms">{s.durationMs}ms</span>
                )}
              </div>
              {s.kind === "call" && s.args && Object.keys(s.args).length > 0 && (
                <pre className="astep-pre">{JSON.stringify(s.args, null, 2)}</pre>
              )}
              {s.kind !== "call" && s.content && (
                <pre className="astep-pre">{clip(s.content, 1200)}</pre>
              )}
            </div>
          ))}
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

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… [${text.length - max} more characters]`;
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
  command, cwd, onAnswer, busy,
}: {
  command: string;
  cwd: string;
  onAnswer: (allow: boolean) => void;
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
      </div>
    </div>
  );
}
