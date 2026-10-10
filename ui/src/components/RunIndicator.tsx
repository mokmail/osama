import { useEffect, useState } from "react";
import { Loader2, HelpCircle, ShieldQuestion, Check, AlertTriangle } from "lucide-react";
import { stopRun, useChat } from "../lib/runStore";
import { describeTool, inflightCalls } from "./AgentTrace";

/**
 * The live run indicator, shown in the app shell so it is visible from EVERY
 * page — not just the chat.
 *
 * This is half the point of lifting the run into a store. The other half is that
 * the run survives the page switch; this makes that fact legible. Without it the
 * user leaves the chat, the turn keeps going, and nothing on screen says so.
 *
 * It renders nothing when no run is active, so it costs no attention in the
 * common case. When a run is going it names the tool in flight — so "what is it
 * doing?" is answerable from any page — and shows the elapsed time (ticking
 * locally, not from the store, so the store is not written once a second). When
 * the turn is parked on the user it says so and offers the way back.
 */
export function RunIndicator({ onOpenChat }: { onOpenChat: () => void }) {
  const run = useChat();
  const [now, setNow] = useState(() => Date.now());

  // Tick only while something is running: an idle app should not re-render.
  useEffect(() => {
    if (!run.status.running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [run.status.running]);

  if (!run.status.running) return null;

  const startedAt = run.startedAt ?? now;
  const secs = Math.max(0, Math.round((now - startedAt) / 1000));
  const elapsed = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
  const waiting = run.status.waiting;
  const tone = waiting ? "wait" : run.status.error ? "err" : "live";

  // The calls in flight, from the last assistant message's trace. Ids with no
  // result yet are the ones executing — the same test the chat's live line uses.
  const pending = inflightCalls(run.messages[run.messages.length - 1]?.steps);
  const head = pending[pending.length - 1];
  const doing = head ? describeTool(head.name, head.args) : null;
  const extra = pending.length - 1;

  const label = waiting === "approval" ? "needs approval"
    : waiting === "question" ? "needs an answer"
    : run.status.error ? "run failed"
    : doing ? `${doing.label}${doing.target ? ` ${doing.target}` : ""}${extra > 0 ? ` +${extra}` : ""}`
    // While the harness is pushing a narrating model back to work, say so —
    // otherwise the turn looks stuck (no tool in flight, no output yet).
    : run.status.notice ? run.status.notice
    : "running";

  return (
    <button className={`runchip ${tone}`} onClick={onOpenChat} title={doing?.target ?? "A turn is in progress — open the chat"}>
      <span className="runchip-icon">
        {waiting === "approval" ? <ShieldQuestion size={13} /> : waiting === "question" ? <HelpCircle size={13} /> : run.status.error ? <AlertTriangle size={13} /> : <Loader2 size={13} className="runchip-spin" />}
      </span>
      <span className="runchip-label">{label}</span>
      <span className="runchip-time">{elapsed}</span>
      {run.status.steps > 0 && <span className="runchip-steps">{run.status.steps} step{run.status.steps === 1 ? "" : "s"}</span>}
      {waiting && <Check size={12} className="runchip-go" />}
    </button>
  );
}
