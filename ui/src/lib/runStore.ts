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
  /** Times this turn had to be asked to act instead of narrating. */
  nudges?: number;
  /** Whether any mutating tool succeeded in this turn. */
  changed?: boolean;
  /** A thinking model's chain-of-thought, when the provider streams one
   *  (Ollama). Shown muted, separate from the final answer. */
  reasoning?: string;
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
  /** What the harness is doing about a narrating model, while it does it. */
  notice: string | null;
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
  /** Workspace context injected into the system prompt (grounds the chat). */
  workspace?: { path: string; snapshot: string } | null;
  /**
   * Whether the served model accepts images. Images are sent as real content
   * parts only when this is true; otherwise they degrade to a filename.
   */
  vision?: boolean | null;
  /**
   * The model name to send upstream. llama.cpp ignores it ("local"), but Ollama
   * requires the real name (e.g. "qwen3:8b") to pick which model to run.
   */
  model?: string;
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
/**
 * Prompt ids the user has already answered this session.
 *
 * The server clears its `pending` synchronously when it handles the answer, but
 * there is a small window between the UI clearing the prompt locally and that
 * response landing. Without this guard a reconcile tick inside that window would
 * re-add the just-answered prompt — trading the missing-Allow-button bug for a
 * phantom-Allow-button one. Recording the id makes the reconcile one-way for
 * anything the user has already dealt with.
 */
const answeredPrompts = new Set<string>();
const subscribers = new Set<(s: ChatState) => void>();
/** A monotonic clock the UI can render a duration from, without a state write per tick. */
let runStartedAt = 0;

function emptyStatus(): RunStatus {
  return { running: false, waiting: null, runId: null, steps: 0, elapsedMs: 0, error: null, detached: false, notice: null };
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
  stopReconcile();
  set({ messages, prompt: null, todos: [], approval: null, question: null, lastCompaction: null, status: emptyStatus() });
}

/** Begin a fresh session, clearing the run view. */
export function resetSession(sessionId = newSessionId()): void {
  runStartedAt = 0;
  stopReconcile();
  answeredPrompts.clear();
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
    status: { running: true, waiting: null, runId: req.runId, steps: 0, elapsedMs: 0, error: null, detached: false, notice: null },
    prompt: null,
    todos: [],
    approval: null,
    question: null,
  });

  const ac = new AbortController();
  current = { runId: req.runId, ac };

  // Safety net: poll the server's authoritative status so a parked approval is
  // never missed if its live SSE frame is dropped.
  startReconcile(req.runId);

  void consume(req, ac).catch((e: unknown) => {
    if (!ac.signal.aborted) {
      setStatus({ error: String((e as Error).message).slice(0, 300) });
      patchLast((m) => ({ ...m, content: m.content || `_(run failed: ${(e as Error).message})_` }));
    }
    finish(ac.signal.aborted ? "cancelled" : "error");
  });
}

/**
 * A message as the model receives it.
 *
 * Attachments are inlined here, not by the caller, because an image has to
 * become an OpenAI content-part array rather than a string — a text-only
 * rendering would reduce a screenshot the model can see to a filename. When the
 * message has no images the content stays a plain string, so the common path is
 * byte-for-byte what it was.
 */
function toModelMessage(m: ChatMessage, supportsVision: boolean): AgentMessagePayload {
  const attachments = m.attachments ?? [];
  const textParts: string[] = [];
  const images: NonNullable<ChatMessage["attachments"]> = [];

  for (const a of attachments) {
    if (a.kind === "text" && a.text) textParts.push(`--- ${a.name} ---\n${a.text}`);
    else if (a.kind === "image" && a.dataUrl) images.push(a);
  }

  if (images.length === 0) {
    const parts = [...textParts];
    if (m.content) parts.push(m.content);
    return { role: m.role as "user" | "assistant", content: parts.join("\n\n") };
  }

  // A model with no vision encoder cannot decode an image part; a filename is
  // still more honest than a base64 blob the server will reject.
  if (!supportsVision) {
    for (const a of images) textParts.push(`[image attached: ${a.name}]`);
    const parts = [...textParts];
    if (m.content) parts.push(m.content);
    return { role: m.role as "user" | "assistant", content: parts.join("\n\n") };
  }

  const content: Array<Record<string, unknown>> = [];
  const text = [...textParts, ...(m.content ? [m.content] : [])].join("\n\n");
  if (text) content.push({ type: "text", text });
  for (const a of images) content.push({ type: "image_url", image_url: { url: a.dataUrl } });
  return { role: m.role as "user" | "assistant", content: content as never };
}

/** Consume the stream for `req`, writing into the store as it goes. */
async function consume(req: RunRequest, ac: AbortController): Promise<void> {
  const history = req.history;
  const wantsImages = req.vision === true;
  const payloadMessages = history
    .filter((m) => m.role !== "assistant" || m.content.trim())
    .map((m) => toModelMessage(m, wantsImages));
  // `streamChat` accepts a narrower message shape than the agent payload (a
  // plain string or OpenAI content parts, never null); this is that shape.
  const chatMessages = payloadMessages as Array<{ role: string; content: string | Array<Record<string, unknown>> }>;

  let acc = req.seed ?? "";
  // Ollama thinking models stream their chain-of-thought on a separate channel;
  // capture it so the user sees progress and the answer stays clean.
  let reasoning = "";

  if (!req.agentic) {
    // Plain chat: the model gets the conversation and nothing else. No
    // workspace snapshot, no tool schemas — a chat app, not an agent. The
    // workspace is what Agent mode is FOR, so injecting it here would ground a
    // plain conversation in a directory the user never chose to involve.
    const systemContent = req.system?.trim() || "You are a helpful, precise assistant running fully offline on the user's machine.";

    for await (const delta of streamChat(
      {
        // llama.cpp ignores the name and serves its loaded model ("local");
        // Ollama picks the model by name, so pass the real one when we have it.
        model: req.model?.trim() || "local",
        messages: [
          { role: "system", content: systemContent },
          ...chatMessages,
        ],
        stream: true as const,
        temperature: req.temperature,
        top_p: req.top_p,
        // Only a positive cap is meaningful. -1/0 mean "unlimited"; llama.cpp
        // accepts that but Ollama rejects max_tokens <= 0 outright, so the
        // field is omitted for both — an absent cap is unlimited on either.
        ...(req.max_tokens && req.max_tokens > 0 ? { max_tokens: req.max_tokens } : {}),
      },
      {
        baseUrl: req.baseUrl,
        apiKey: req.apiKey,
        signal: ac.signal,
        onReasoning: (t) => {
          reasoning += t;
          patchLast((m) => ({ ...m, reasoning }));
        },
      },
    )) {
      acc += delta;
      // Once there is real answer text, keep it in `content`; reasoning stays
      // in its own field so the transcript renders them apart.
      patchLast((m) => ({ ...m, content: acc, ...(reasoning ? { reasoning } : {}) }));
    }
    // A thinking model that produced only reasoning (or one that stayed silent)
    // must not leave an empty bubble — fall back to the reasoning text.
    if (!acc.trim()) {
      const fallback = reasoning.trim()
        ? `_The model produced only reasoning, no final answer._\n\n${reasoning.trim()}`
        : "_(empty response — is the server still loading the model?)_";
      patchLast((m) => ({ ...m, content: fallback }));
    }
    finish("done");
    return;
  }

  for await (const ev of streamAgent(
    {
      baseUrl: req.baseUrl,
      apiKey: req.apiKey,
      model: req.model?.trim() || "local",
      runId: req.runId,
      system: req.system?.trim() || undefined,
      personality: req.personality,
      messages: payloadMessages as AgentMessagePayload[],
      approval: req.approval,
      activeSkills: req.activeSkills,
      temperature: req.temperature,
      top_p: req.top_p,
      // Skip non-positive caps: Ollama rejects max_tokens <= 0 (see above).
      ...(req.max_tokens && req.max_tokens > 0 ? { max_tokens: req.max_tokens } : {}),
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
        // A tool is now running, so the turn is not parked on the user any more.
        // Without this, `waiting` could still read "approval" while the command
        // was executing (the status poll said so), leaving a stale Allow button.
        if (state.status.waiting) setStatus({ waiting: null });
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

      case "action_nudge":
        setStatus({ notice: "the model described the next step instead of making it — asking it to continue" });
        break;

      case "final":
        acc = ev.text || acc;
        patchLast((m) => ({ ...m, content: acc, stepCount: ev.steps, nudges: ev.nudges, changed: ev.changed }));
        setStatus({ waiting: null, notice: null });
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
  stopReconcile();
  // A finished turn has no parked prompt. Clearing it here is what stops a
  // stale Allow / Answer button lingering after the loop ended (e.g. a timed-out
  // approval) — where clicking it would hit a deleted approval and do nothing.
  set({
    startedAt: 0,
    approval: null,
    question: null,
    status: { running: false, waiting: null, runId: null, steps: state.status.steps, elapsedMs: 0, error: outcome === "done" ? null : state.status.error, detached: false, notice: null },
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
/**
 * The outcome of answering a parked prompt, so the caller can tell the user
 * when a button did nothing (its prompt had already expired server-side).
 */
export type AnswerOutcome = { ok: true } | { ok: false; reason: string };

export async function answerApproval(id: string, allow: boolean, allowAll = false): Promise<AnswerOutcome> {
  // Record it before clearing, so a reconcile tick racing the server's response
  // cannot re-add the prompt the user just answered.
  answeredPrompts.add(id);
  set({ approval: null });
  setStatus({ waiting: null });
  try {
    const res = await fetch(`/api/agent/approve/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allow, allowAll }),
    });
    // A 404 means this approval no longer exists on the server — it was already
    // answered, timed out, or the turn ended. Not a retryable delivery failure:
    // the prompt was stale, which is exactly why the button "did nothing".
    if (res.status === 404) {
      return { ok: false, reason: "that approval had already expired — the command was resolved or the turn ended" };
    }
    if (!res.ok) return { ok: false, reason: `the server rejected the answer (HTTP ${res.status})` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `could not deliver the answer: ${(e as Error).message}` };
  }
}

export async function answerQuestion(id: string, answer: string): Promise<AnswerOutcome> {
  answeredPrompts.add(id);
  set({ question: null });
  setStatus({ waiting: null });
  try {
    const res = await fetch(`/api/agent/answer/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer }),
    });
    if (res.status === 404) return { ok: false, reason: "that question had already expired — the turn ended" };
    if (!res.ok) return { ok: false, reason: `the server rejected the answer (HTTP ${res.status})` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `could not deliver the answer: ${(e as Error).message}` };
  }
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
    // Reattaching is exactly the case where the live frame may already have
    // passed us by — reconcile from the server's buffer source.
    startReconcile(runId);

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
          } else if (ev.type === "tool_call") {
            // A reattaching client replays the buffer, so the trace must be
            // rebuilt here too — otherwise the live "which tool is running" view
            // is blank for exactly the case it is most useful in: coming back
            // to a turn that is still going.
            patchLast((m) => ({ ...m, steps: [...(m.steps ?? []), { id: ev.id, kind: "call" as const, name: ev.name, args: ev.args }] }));
          } else if (ev.type === "tool_result") {
            patchLast((m) => {
              const steps = [...(m.steps ?? [])];
              const at = steps.findIndex((s) => s.id === ev.id && s.kind === "call");
              const entry = { id: ev.id, kind: "result" as const, name: ev.name, summary: ev.summary, content: ev.content, ok: ev.ok, durationMs: ev.durationMs };
              if (at >= 0) steps[at] = entry;
              else steps.push(entry);
              return { ...m, steps };
            });
          } else if (ev.type === "step") {
            setStatus({ steps: ev.index + 1 });
          } else if (ev.type === "denied") {
            patchLast((m) => ({ ...m, steps: (m.steps ?? []).map((s) => (s.id === ev.id ? { ...s, kind: "denied" as const, ok: false } : s)) }));
          } else if (ev.type === "compaction") {
            set({ lastCompaction: { at: Date.now(), before: ev.before, after: ev.after, reason: ev.reason } });
          } else if (ev.type === "final") {
            acc = ev.text || acc;
            patchLast((m) => ({ ...m, content: acc, stepCount: ev.steps, nudges: ev.nudges, changed: ev.changed }));
            setStatus({ waiting: null });
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
          } else if (ev.type === "done") {
            // The server's explicit end marker for a turn that already finished;
            // the reader will close right after, but clearing here is immediate.
            break;
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

/* ---------------------------------------------------- parked-prompt reconcile */

interface StatusRun {
  runId: string;
  status: string;
  pending:
    | { kind: "approval"; id: string; command: string; cwd: string }
    | { kind: "question"; id: string; question: string; options?: string[] }
    | null;
}



/**
 * Reconcile the parked prompt from the server's authoritative status.
 *
 * WHY THIS EXISTS. The server buffers every turn event, so a reload replays a
 * missed `approval_request` — which is why refreshing used to "fix" the missing
 * Allow button. Relying on a single live SSE delivery is fragile: the frame can
 * be lost to a reconnect, a race with the first attach, or a listener added a
 * beat after the event was emitted. Polling `/api/agent/status` (the same source
 * the server replays from) closes that gap: whatever the stream missed, the next
 * status tick surfaces. It is idempotent — it only ever sets a prompt the store
 * is missing and clears one the server no longer reports — so it cannot fight
 * the normal event path.
 */
async function reconcileParkedPrompt(runId: string): Promise<void> {
  // Only reconcile the run we are actually watching; a stale run id must not
  // resurrect a prompt for a turn that already ended.
  if (state.status.runId !== runId) return;
  let run: StatusRun | undefined;
  try {
    const res = await fetch("/api/agent/status");
    if (!res.ok) return;
    const body = (await res.json()) as { runs?: StatusRun[] };
    run = body.runs?.find((r) => r.runId === runId);
  } catch {
    return;
  }
  if (state.status.runId !== runId) return; // changed while awaiting the fetch

  if (!run) {
    // The server no longer knows this turn — it finished between our last event
    // and now. Let the normal `finish` path own the state; do not invent a stop.
    return;
  }

  const pending = run.pending;
  if (pending?.kind === "approval") {
    // Never resurrect a prompt the user already answered (see answeredPrompts).
    if (!answeredPrompts.has(pending.id) && state.approval?.id !== pending.id) {
      set({ approval: { id: pending.id, command: pending.command, cwd: pending.cwd } });
      setStatus({ waiting: "approval" });
    }
  } else if (pending?.kind === "question") {
    if (!answeredPrompts.has(pending.id) && state.question?.id !== pending.id) {
      set({ question: { id: pending.id, question: pending.question, options: pending.options } });
      setStatus({ waiting: "question" });
    }
  } else {
    // The server reports nothing parked: clear a prompt we are still showing,
    // because it has been answered (or timed out) on the server side.
    if (state.approval || state.question) set({ approval: null, question: null });
    if (state.status.waiting) setStatus({ waiting: null });
  }
}

/** The reconcile timer, owned by the store so it survives view remounts. */
let reconcileTimer: number | undefined;

/**
 * Start polling `/api/agent/status` for a live run. Idempotent per runId: a
 * second call for the same run is a no-op, so a remount cannot start a second
 * poll. Stops itself as soon as the run is no longer running.
 */
export function startReconcile(runId: string, intervalMs = 1500): void {
  if (reconcileTimer !== undefined) return;
  const tick = async () => {
    if (!state.status.running || state.status.runId !== runId) {
      stopReconcile();
      return;
    }
    await reconcileParkedPrompt(runId);
  };
  void tick();
  reconcileTimer = window.setInterval(() => void tick(), intervalMs);
}

/** Stop the reconcile poll. Called when a run ends or is superseded. */
export function stopReconcile(): void {
  if (reconcileTimer !== undefined) {
    window.clearInterval(reconcileTimer);
    reconcileTimer = undefined;
  }
}
