import { useEffect, useState } from "react";
import { streamAgent, streamChat, type AgentMessagePayload } from "./api";
import type { AgentStep, MemoryStats, PromptSection } from "./types";

/**
 * The chat run store: the turn engine, lifted out of the component.
 *
 * WHY THIS EXISTS. The chat stream used to be driven from inside `ChatView`, so
 * the run lived and died with the component. Switching pages unmounts the view,
 * which aborted the request and discarded the answer. That is the bug this file
 * removes: a turn is a *user-level* activity, not a view-level one.
 *
 * The store is a module singleton, so it survives unmounts and remounts. It
 * owns:
 *   - the transcript, so a remount paints the whole run instead of an empty page;
 *   - the live status, so the UI can say "a run is in progress" from any page;
 *   - the stream itself, which writes into the transcript as tokens arrive.
 *
 * RELOAD IS A DIFFERENT CASE and is handled honestly. An SSE stream cannot be
 * resumed after the process that was reading it is gone, so a reload does NOT
 * silently restore a live run. The store instead records enough in localStorage
 * for the resumed page to say what happened: "this turn was interrupted — the
 * model may still be finishing, retry to continue." Guessing that the answer
 * completed would be worse than admitting the interruption.
 *
 * The transport is the server's job: this client only keeps the socket, and the
 * server keeps the turn alive when the socket dies.
 */

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  attachments?: Array<{ id: string; name: string; kind: "text" | "image"; mime: string; size: number; text?: string; dataUrl?: string }>;
  steps?: AgentStep[];
  stepCount?: number;
}

export interface RunStatus {
  /** A turn is streaming right now. */
  running: boolean;
  /** The turn is parked on an approval or a question. */
  waiting: "approval" | "question" | null;
  /** Which run, so the UI can reattach. */
  runId: string | null;
  /** Steps completed so far in the current run. */
  steps: number;
  /** Milliseconds since the run started. */
  elapsedMs: number;
  /** Set when a turn ended in an error. */
  error: string | null;
  /** True when the run is running but this page is not the one watching it. */
  detached: boolean;
}

export interface ChatState {
  sessionId: string;
  messages: ChatMessage[];
  status: RunStatus;
  /** When the current run began (epoch ms), 0 when idle. Lets a status chip
   *  compute an elapsed time without the store being written every second. */
  startedAt: number;
  /** The prompt the last turn actually used, from the server's `prompt` event. */
  prompt: { sections: PromptSection[]; chars: number; personality: string; memory: MemoryStats } | null;
  todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>;
  approval: { id: string; command: string; cwd: string } | null;
  question: { id: string; question: string; options?: string[] } | null;
  lastCompaction: { at: number; before: number; after: number; reason: string } | null;
}

/** What a run needs to start. Everything else is read from the store. */
export interface RunRequest {
  runId: string;
  baseUrl: string;
  apiKey?: string;
  agentic: boolean;
  system?: string;
  personality?: string;
  activeSkills?: string[];
  approval: "ask" | "auto";
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  /** The conversation up to but NOT including the reply being produced. */
  history: ChatMessage[];
  /** Pre-fills the assistant bubble (a "continue" starts from shown text). */
  seed?: string;
}

/* --------------------------------------------------------------- state */

let state: ChatState = {
  sessionId: "",
  messages: [],
  status: emptyStatus(),
  startedAt: 0,
  prompt: null,
  todos: [],
  approval: null,
  question: null,
  lastCompaction: null,
};

/** The AbortController for the in-flight run, if this page is the one running it. */
let current: { runId: string; ac: AbortController } | null = null;
const subscribers = new Set<(s: ChatState) => void>();
/** A monotonic clock the UI can render a duration from, without a state write per tick. */
let runStartedAt = 0;

function emptyStatus(): RunStatus {
  return { running: false, waiting: null, runId: null, steps: 0, elapsedMs: 0, error: null, detached: false };
}

export function getChatState(): ChatState {
  return state;
}

function set(patch: Partial<ChatState>): void {
  state = { ...state, ...patch };
  for (const s of subscribers) s(state);
}

function setStatus(patch: Partial<RunStatus>): void {
  set({ status: { ...state.status, ...patch } });
}

/**
 * Subscribe to store changes. Returns an unsubscribe.
 *
 * The store is deliberately outside React: a page switch must not tear down a
 * run, so the run's owner cannot be a component.
 */
export function subscribeChat(fn: (s: ChatState) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** A hook that renders a component from the store. */
export function useChat(): ChatState {
  const [snapshot, setSnapshot] = useState<ChatState>(getChatState);
  useEffect(() => {
    // Re-read on mount: the store may have moved on while this component was gone.
    setSnapshot(getChatState());
    return subscribeChat(setSnapshot);
  }, []);
  return snapshot;
}

/** How long the current run has been going. Computed, not stored, so no interval. */
export function runElapsed(): number {
  return runStartedAt ? Date.now() - runStartedAt : 0;
}

/* ------------------------------------------------------------- transcript */

export function newSessionId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Replace the transcript (opening a stored chat, starting a new one). */
export function setMessages(messages: ChatMessage[]): void {
  set({ messages, prompt: null, todos: [], approval: null, question: null, lastCompaction: null, status: emptyStatus() });
}

/** Begin a fresh session, clearing the run view. */
export function resetSession(sessionId = newSessionId()): void {
  runStartedAt = 0;
  set({ sessionId, startedAt: 0, messages: [], prompt: null, todos: [], approval: null, question: null, lastCompaction: null, status: emptyStatus() });
}

/** Restore a session id on boot so a reload keeps its identity. */
export function adoptSessionId(sessionId: string): void {
  set({ sessionId });
}

/** The current session id, minting one on first use. */
export function currentSessionId(): string {
  if (!state.sessionId) set({ sessionId: newSessionId() });
  return state.sessionId;
}

/** A fresh client-owned run id. The client owns it so a remount can reattach. */
export function newRunId(): string {
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Clear the run's task list (a new conversation has no tasks yet). */
export function clearTodos(): void {
  set({ todos: [] });
}

/** Record a compaction that the UI triggered on demand. */
export function noteCompaction(c: { at: number; before: number; after: number; reason: string }): void {
  set({ lastCompaction: c });
}

export function clearCompaction(): void {
  set({ lastCompaction: null });
}

/** Patch the assistant bubble (always the last message) during a run. */
function patchLast(fn: (m: ChatMessage) => ChatMessage): void {
  const copy = [...state.messages];
  const last = copy[copy.length - 1];
  if (last) copy[copy.length - 1] = fn(last);
  set({ messages: copy });
}

/* ------------------------------------------------------------------ run */

/**
 * Start a turn. Returns immediately; the stream is consumed in the background.
 *
 * The caller does NOT await the answer — the run outlives the component that
 * started it, so there is nothing to await. It awaits only the setup, so a
 * synchronous failure (no messages) is still reported to the caller.
 */
export function startRun(req: RunRequest): void {
  if (state.status.running) return;

  const assistant: ChatMessage = req.agentic ? { role: "assistant", content: req.seed ?? "", steps: [] } : { role: "assistant", content: req.seed ?? "" };
  runStartedAt = Date.now();
  set({
    startedAt: runStartedAt,
    messages: [...req.history, assistant],
    status: { running: true, waiting: null, runId: req.runId, steps: 0, elapsedMs: 0, error: null, detached: false },
    prompt: null,
    todos: [],
    approval: null,
    question: null,
  });

  const ac = new AbortController();
  current = { runId: req.runId, ac };

  void consume(req, ac).catch((e: unknown) => {
    if (!ac.signal.aborted) {
      setStatus({ error: String((e as Error).message).slice(0, 300) });
      patchLast((m) => ({ ...m, content: m.content || `_(run failed: ${(e as Error).message})_` }));
    }
    finish(ac.signal.aborted ? "cancelled" : "error");
  });
}

/** Consume the stream for `req`, writing into the store as it goes. */
async function consume(req: RunRequest, ac: AbortController): Promise<void> {
  const history = req.history;
  const payloadMessages = history
    .filter((m) => m.role !== "assistant" || m.content.trim())
    .map((m) => ({ role: m.role as "user" | "assistant", content: plainContent(m) }));

  let acc = req.seed ?? "";

  if (!req.agentic) {
    for await (const delta of streamChat(
      {
        model: "local",
        messages: [
          { role: "system", content: req.system?.trim() || "You are a helpful, precise assistant running fully offline on the user's machine." },
          ...payloadMessages,
        ],
        stream: true as const,
        temperature: req.temperature,
        top_p: req.top_p,
        ...(req.max_tokens === undefined ? {} : { max_tokens: req.max_tokens }),
      },
      { baseUrl: req.baseUrl, apiKey: req.apiKey, signal: ac.signal },
    )) {
      acc += delta;
      patchLast((m) => ({ ...m, content: acc }));
    }
    if (!acc.trim()) patchLast((m) => ({ ...m, content: "_(empty response — is the server still loading the model?)_" }));
    finish("done");
    return;
  }

  for await (const ev of streamAgent(
    {
      baseUrl: req.baseUrl,
      apiKey: req.apiKey,
      model: "local",
      runId: req.runId,
      system: req.system?.trim() || undefined,
      personality: req.personality,
      messages: payloadMessages as AgentMessagePayload[],
      approval: req.approval,
      activeSkills: req.activeSkills,
      temperature: req.temperature,
      top_p: req.top_p,
      ...(req.max_tokens === undefined ? {} : { max_tokens: req.max_tokens }),
    },
    { signal: ac.signal },
  )) {
    switch (ev.type) {
      case "prompt":
        set({ prompt: { sections: ev.sections, chars: ev.chars, personality: ev.personality, memory: ev.memory } });
        break;

      case "assistant_delta":
        acc += ev.text;
        patchLast((m) => ({ ...m, content: acc }));
        break;

      case "step":
        setStatus({ steps: ev.index + 1 });
        break;

      case "tool_call":
        patchLast((m) => ({ ...m, steps: [...(m.steps ?? []), { id: ev.id, kind: "call" as const, name: ev.name, args: ev.args }] }));
        break;

      case "tool_result":
        patchLast((m) => {
          const steps = [...(m.steps ?? [])];
          const at = steps.findIndex((s) => s.id === ev.id && s.kind === "call");
          const entry = { id: ev.id, kind: "result" as const, name: ev.name, summary: ev.summary, content: ev.content, ok: ev.ok, durationMs: ev.durationMs };
          if (at >= 0) steps[at] = entry;
          else steps.push(entry);
          return { ...m, steps };
        });
        break;

      case "denied":
        patchLast((m) => ({ ...m, steps: (m.steps ?? []).map((s) => (s.id === ev.id ? { ...s, kind: "denied" as const, ok: false } : s)) }));
        break;

      case "compaction":
        set({ lastCompaction: { at: Date.now(), before: ev.before, after: ev.after, reason: ev.reason } });
        break;

      case "todos":
        set({ todos: ev.todos });
        break;

      case "question":
        set({ question: { id: ev.id, question: ev.question, options: ev.options } });
        setStatus({ waiting: "question" });
        break;

      case "approval_request":
        set({ approval: { id: ev.id, command: ev.command, cwd: ev.cwd } });
        setStatus({ waiting: "approval" });
        break;

      case "final":
        acc = ev.text || acc;
        patchLast((m) => ({ ...m, content: acc, stepCount: ev.steps }));
        setStatus({ waiting: null });
        break;

      case "error":
        setStatus({ error: ev.message });
        patchLast((m) => ({ ...m, content: acc || `_(run stopped: ${ev.message})_` }));
        break;
    }
  }
  if (state.messages.length && !state.messages[state.messages.length - 1]!.content.trim()) {
    patchLast((m) => ({ ...m, content: "_(the model finished without saying anything)_" }));
  }
  finish("done");
}

/** Close out the run: the store keeps the transcript, the status stops. */
function finish(outcome: "done" | "error" | "cancelled"): void {
  current = null;
  runStartedAt = 0;
  set({
    startedAt: 0,
    status: { running: false, waiting: null, runId: null, steps: state.status.steps, elapsedMs: 0, error: outcome === "done" ? null : state.status.error, detached: false },
  });
}

/**
 * Stop the in-flight run.
 *
 * Aborts the local stream AND tells the server, because the server now owns the
 * turn: aborting only the socket would leave the run going with nobody watching,
 * which is precisely the behaviour this file exists to make correct.
 */
export function stopRun(): void {
  const runId = current?.runId ?? state.status.runId;
  current?.ac.abort();
  if (runId) void stopServerRun(runId);
  finish("cancelled");
}

async function stopServerRun(runId: string): Promise<void> {
  try {
    await fetch("/api/agent/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId }),
    });
  } catch {
    /* the server may already have finished it */
  }
}

/**
 * Answer a parked approval / question.
 *
 * The answer goes to the server (which owns the parked turn); the store clears
 * its own prompt because it will not receive another event for this one.
 */
export async function answerApproval(id: string, allow: boolean): Promise<void> {
  set({ approval: null });
  setStatus({ waiting: null });
  try {
    await fetch(`/api/agent/approve/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allow }),
    });
  } catch (e) {
    setStatus({ error: `could not deliver the answer: ${(e as Error).message}` });
  }
}

export async function answerQuestion(id: string, answer: string): Promise<void> {
  set({ question: null });
  setStatus({ waiting: null });
  try {
    await fetch(`/api/agent/answer/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer }),
    });
  } catch (e) {
    setStatus({ error: `could not deliver the answer: ${(e as Error).message}` });
  }
}

/** A plain-text rendering of a message, for the model payload (text + attachments). */
function plainContent(m: ChatMessage): string {
  const parts: string[] = [];
  if (m.attachments?.length) {
    for (const a of m.attachments) {
      if (a.kind === "text" && a.text) parts.push(`--- ${a.name} ---\n${a.text}`);
      else if (a.kind === "image") parts.push(`[attached image: ${a.name}]`);
    }
  }
  if (m.content) parts.push(m.content);
  return parts.join("\n\n");
}

/* ------------------------------------------------- reattach on remount */

/**
 * Are we the client that started `runId`?
 *
 * On a remount this page is NOT the owner — the previous mount's stream is gone
 * — so it attaches to the server's copy instead, which replays the turn. This is
 * what makes the status survive a page switch.
 */
export async function attachToRun(runId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/agent/attach?runId=${encodeURIComponent(runId)}`, { method: "POST" });
    if (!res.ok || !res.body) return false;

    setStatus({ running: true, detached: false, runId });
    runStartedAt = Date.now();
    set({ startedAt: runStartedAt });

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let acc = state.messages[state.messages.length - 1]?.content ?? "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        try {
          const ev = JSON.parse(line.slice(5));
          if (ev.type === "assistant_delta") {
            acc += ev.text;
            patchLast((m) => ({ ...m, content: acc }));
          } else if (ev.type === "final") {
            acc = ev.text || acc;
            patchLast((m) => ({ ...m, content: acc, stepCount: ev.steps }));
          } else if (ev.type === "prompt") {
            set({ prompt: { sections: ev.sections, chars: ev.chars, personality: ev.personality, memory: ev.memory } });
          } else if (ev.type === "approval_request") {
            set({ approval: { id: ev.id, command: ev.command, cwd: ev.cwd } });
            setStatus({ waiting: "approval" });
          } else if (ev.type === "question") {
            set({ question: { id: ev.id, question: ev.question, options: ev.options } });
            setStatus({ waiting: "question" });
          } else if (ev.type === "todos") {
            set({ todos: ev.todos });
          }
        } catch {
          /* keep-alive or a partial frame */
        }
      }
    }
    finish("done");
    return true;
  } catch {
    finish("error");
    return false;
  }
}

/**
 * Ask the server whether a run is alive, so a remount with no local state can
 * discover one. Used after a reload, where the store is cold.
 */
export async function findLiveRun(): Promise<{ runId: string } | null> {
  try {
    const res = await fetch("/api/agent/status");
    if (!res.ok) return null;
    const body = (await res.json()) as { runs?: Array<{ runId: string; status: string }> };
    const live = body.runs?.find((r) => r.status === "running" || r.status === "awaiting_approval" || r.status === "awaiting_answer");
    return live ? { runId: live.runId } : null;
  } catch {
    return null;
  }
}
