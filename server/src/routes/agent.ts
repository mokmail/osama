import fs from "node:fs";
import http from "node:http";
import * as core from "@osama/core";
import { fail, json, q, readBody, route, sseOpen, sseSend, type RouteModule } from "../http.js";

/**
 * Agentic mode: the loop, approvals, questions, and the scheduler runtime.
 *
 * `POST /api/agent` runs one turn: it proxies to llama-server, executes the
 * tool calls the model asks for, and streams every step as SSE. A mutating
 * command parks the loop on a promise until the user answers on
 * `POST /api/agent/approve/:id`, so approval is enforced server-side and a
 * client that never answers simply times out into a denial.
 *
 * The loop itself lives in `@osama/core`'s `runAgent`; this module owns only
 * the HTTP/SSE adaptation and the parked-request bookkeeping.
 */

/**
 * Ceiling on sampling temperature for an agent turn.
 *
 * Tool-calling is a structured-output problem, and small local models get
 * materially worse at it as temperature rises — invented arguments, a tool call
 * on a turn that needs none, the same failing call repeated. The chat slider
 * exists for prose style, so the agent path clamps whatever it is handed
 * instead of letting a setting meant for wording change tool behaviour.
 */
const AGENT_TEMP_CEILING = 0.3;

const TOOL_TIMEOUT_MS = 120_000;
const APPROVAL_TIMEOUT_MS = 120_000;

interface PendingApproval {
  resolve: (allow: boolean) => void;
  timer: NodeJS.Timeout;
}

interface PendingQuestion extends core.PendingQuestion {
  resolve: (text: string | null) => void;
  timer: NodeJS.Timeout;
  res: http.ServerResponse;
}

/** Live turns that accept steering notes (mid-run course correction). */
export const activeSteers = new Map<string, core.SteerQueue>();

/**
 * A turn that is currently running.
 *
 * Keyed by the `runId` the CLIENT generates and sends. The client owns the id
 * on purpose: it is what lets the UI reattach to a run it started before it was
 * unmounted, and what stops a reload from attaching to a different turn.
 *
 * `events` is the replay buffer. Every event is kept, so a client that attaches
 * late — after a page switch unmounted the chat — receives the whole turn so
 * far in order, then continues live. That ordering is why `attachTurn` sends the
 * buffer and subscribes to `listeners` in the same synchronous block.
 */
interface LiveTurn {
  runId: string;
  sessionId: string;
  startedAt: number;
  status: "running" | "awaiting_approval" | "awaiting_answer" | "done" | "error" | "cancelled";
  events: unknown[];
  /** The responses currently attached. Held as responses (not callbacks) so the
   *  turn can END them when it finishes — otherwise every run leaks an open
   *  HTTP connection until the client goes away. */
  listeners: Set<http.ServerResponse>;
  abort: AbortController;
  /** The parked prompt, if the turn is waiting on the user right now. */
  pending: { kind: "approval"; id: string; command: string; cwd: string } | { kind: "question"; id: string; question: string; options?: string[] } | null;
  /**
   * When the user picks "allow all", the turn stops parking on approvals: every
   * later mutating call is auto-approved for the rest of this turn, exactly as
   * if it had started in 'auto'. Flipped by the approve route; read live by
   * every subsequent requestApproval so it takes effect mid-turn.
   */
  autoApprove?: boolean;
}

/** Live runs by runId. */
export const liveTurns = new Map<string, LiveTurn>();
/**
 * Which runId owns which parked approval / question, so a reattaching client can
 * be told "this turn is waiting on you" without re-running the loop.
 */
export const turnOfApproval = new Map<string, string>();
export const turnOfQuestion = new Map<string, string>();

/** Drop a finished turn after a grace period, so a late reattach still sees it. */
const TURN_GRACE_MS = 60_000;

function endTurn(t: LiveTurn, status: LiveTurn["status"]): void {
  t.status = status;
  t.pending = null;
  // Close every attached response: the turn is over, and an SSE stream that is
  // never ended holds the connection open for the life of the server.
  for (const res of t.listeners) {
    try {
      res.end();
    } catch {
      /* already gone */
    }
  }
  t.listeners.clear();
  // Keep the buffer briefly: a client that unmounted mid-turn and remounts
  // within the grace window must still be able to replay the ending.
  setTimeout(() => {
    const cur = liveTurns.get(t.runId);
    if (cur === t && cur.status !== "running") liveTurns.delete(t.runId);
  }, TURN_GRACE_MS).unref?.();
}

/**
 * Subscribe a client to a running turn: replay, then live.
 *
 * Returns a detach function. The replay and the subscription happen in one
 * synchronous block so no event can slip between them; `attachTurn` is
 * synchronous for exactly that reason and must stay that way.
 *
 * STALE PROMPTS ARE FILTERED OUT OF THE REPLAY. The buffer keeps every event
 * forever (so a late client can replay the whole turn), which means it also
 * holds `approval_request` and `question` events that were ALREADY ANSWERED.
 * Replaying those re-arms a dead prompt whose server-side approval has been
 * deleted — the user clicks Allow and nothing happens (a silent 404). The
 * current live prompt is instead sent explicitly by the caller from `t.pending`,
 * so a reattaching client always sees exactly the prompt that is still open.
 */
export function attachTurn(runId: string, res: http.ServerResponse): (() => void) | null {
  const t = liveTurns.get(runId);
  if (!t) return null;
  for (const ev of t.events) {
    const kind = (ev as { type?: string } | null)?.type;
    if (kind === "approval_request" || kind === "question") continue;
    sseSend(res, ev);
  }
  t.listeners.add(res);
  return () => t.listeners.delete(res);
}

export const agentRoutes: RouteModule = (deps) => {
  const pendingApprovals = new Map<string, PendingApproval>();
  const pendingQuestions = new Map<string, PendingQuestion>();

  /** The scheduler's outbound settings (model + endpoint a job runs against). */
  const scheduler = {
    model: "local",
    base: "http://127.0.0.1:8080",
    apiKey: "",
  };

  /** The live task list. Sent whole, like a todo/write snapshot. */
  let agentTodos: core.TodoItem[] = [];

  /**
   * Where the agent's relative paths resolve. This is the user's chosen
   * workspace, never a bare home directory — a turn that defaulted to `$HOME`
   * could read and write anything the user owns.
   */
  function agentWorkspace(): string {
    const ws = core.getWorkspace();
    try {
      fs.mkdirSync(ws, { recursive: true });
    } catch {
      /* the tools report a missing workspace themselves */
    }
    return ws;
  }

  /**
   * Ask the user to approve a command. Parks the loop on a promise; the answer
   * arrives on `POST /api/agent/approve/:id`, or the request times out into a
   * denial so an unattended agent cannot run commands by default.
   *
   * `res` is a getter, not a response: the prompt must be written to whichever
   * client is attached at that moment. A page switch leaves the turn parked, and
   * the client that comes back is a different response object.
   */
  function requestApproval(
    areq: { command: string; cwd: string },
    mode: "ask" | "auto",
    getRes: () => http.ServerResponse,
    signal: AbortSignal,
    runId: string,
    emit: (ev: unknown) => void,
  ): Promise<boolean> {
    if (mode === "auto") return Promise.resolve(true);
    // "Allow all for this session": once the user flips it, this turn no longer
    // parks. Checked here (not at turn start) so the very next call is covered.
    const turn = liveTurns.get(runId);
    if (turn?.autoApprove) return Promise.resolve(true);

    const id = `ap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const payload = { id, command: areq.command, cwd: areq.cwd, timeoutMs: APPROVAL_TIMEOUT_MS };
    turnOfApproval.set(id, runId);
    // The live turn records the real id so a reattaching client can be told what
    // it is parked on; the bus event reaches any other open tab.
    const t = liveTurns.get(runId);
    if (t?.pending?.kind === "approval") t.pending.id = id;
    deps.broadcast("agent_approval", payload);
    emit({ type: "approval_request", ...payload });
    try {
      sseSend(getRes(), { type: "approval_request", ...payload });
    } catch {
      /* nobody attached right now — the buffer holds it for when they are */
    }

    return new Promise<boolean>((resolve) => {
      // `finish` owns the cleanup so it is identical however it is reached —
      // the route, the timeout, or an abort. The route only calls `resolve`.
      const finish = (allow: boolean): void => {
        pendingApprovals.delete(id);
        turnOfApproval.delete(id);
        clearTimeout(timer);
        // Clear the turn's parked marker too. Without this, /api/agent/status
        // keeps reporting a stale "pending approval" after the user answers —
        // which made a reattaching client re-show a prompt that was already
        // handled, and made any status-based reconciliation think the turn was
        // still waiting.
        const t = liveTurns.get(runId);
        if (t?.pending?.kind === "approval" && (t.pending.id === id || !t.pending.id)) t.pending = null;
        resolve(allow);
      };
      const timer = setTimeout(() => finish(false), APPROVAL_TIMEOUT_MS);
      pendingApprovals.set(id, { resolve: finish, timer });
      // A turn that was cancelled while parked must not wait out the timeout.
      if (signal.aborted) finish(false);
      else signal.addEventListener("abort", () => finish(false), { once: true });
    });
  }

  /**
   * ask_user_question: parks the loop the same way an approval does, pushes the
   * question over SSE and the event bus, and returns the user's answer.
   */
  function askTheUser(
    question: core.PendingQuestion,
    timeoutMs: number,
    getRes: () => http.ServerResponse,
    signal: AbortSignal,
    runId: string,
    emit: (ev: unknown) => void,
  ): Promise<string | null> {
    const finish = (owner: PendingQuestion | undefined, answer: string | null): void => {
      if (!owner) return;
      clearTimeout(owner.timer);
      pendingQuestions.delete(question.id);
      turnOfQuestion.delete(question.id);
      // Clear the turn's parked marker so /api/agent/status stops reporting a
      // question that has already been answered (see requestApproval).
      const t = liveTurns.get(runId);
      if (t?.pending?.kind === "question" && t.pending.id === question.id) t.pending = null;
      owner.resolve(answer);
    };
    const ssePayload = { id: question.id, question: question.question, options: question.options, timeoutMs };
    turnOfQuestion.set(question.id, runId);
    deps.broadcast("agent_question", ssePayload);
    emit({ type: "question", ...ssePayload });
    try {
      sseSend(getRes(), { type: "question", ...ssePayload });
    } catch {
      /* nobody attached — the buffer holds it */
    }

    return new Promise<string | null>((resolve) => {
      const owner: PendingQuestion = {
        ...question,
        resolve,
        timer: setTimeout(() => finish(owner, null), timeoutMs),
        res: getRes(),
      };
      pendingQuestions.set(question.id, owner);
      if (signal.aborted) finish(owner, null);
      else signal.addEventListener("abort", () => finish(owner, null), { once: true });
    });
  }

  /**
   * Adapt llama-server's OpenAI-compatible SSE into agent `ModelChunk`s. Keeping
   * this in the server means core/agent.ts stays free of HTTP and is testable
   * without a model.
   */
  function openaiTransport(ctx: { base: string; apiKey?: string }): core.AgentTransport {
    return async function* transport(payload) {
      // Omit max_tokens unless it is a positive cap: llama.cpp reads -1 as
      // "unlimited" but Ollama rejects any value <= 0 with an
      // invalid_request_error. An absent field is unlimited on both.
      const body: Record<string, unknown> = {
        model: payload.model,
        messages: payload.messages,
        tools: payload.tools,
        tool_choice: "auto",
        stream: true,
        temperature: payload.temperature,
        top_p: payload.top_p,
      };
      if (typeof payload.max_tokens === "number" && payload.max_tokens > 0) body.max_tokens = payload.max_tokens;

      const upstream = await fetch(`${ctx.base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(ctx.apiKey ? { authorization: `Bearer ${ctx.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: payload.signal,
      });

      if (!upstream.ok || !upstream.body) {
        const text = await upstream.text().catch(() => "");
        throw new Error(text.slice(0, 400) || `upstream HTTP ${upstream.status}`);
      }

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") return;
          let parsed: any;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          if (parsed.error) {
            // llama.cpp sends {"error":{code,message}} with HTTP 200 on context
            // overflow — converting it here means the agent loop reports the
            // real cause instead of ending with an empty answer.
            const m = parsed.error.message ?? JSON.stringify(parsed.error);
            throw new Error(`Model error: ${String(m).slice(0, 300)}`);
          }
          const choice = parsed.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta ?? {};
          const chunk: core.ModelChunk = {};
          if (typeof delta.content === "string" && delta.content) chunk.content = delta.content;
          if (Array.isArray(delta.tool_calls)) {
            chunk.toolCalls = delta.tool_calls.map((tc: any) => ({
              index: Number(tc.index ?? 0),
              id: tc.id,
              name: tc.function?.name,
              argumentsDelta: tc.function?.arguments,
            }));
          }
          if (choice.finish_reason) chunk.finishReason = String(choice.finish_reason);
          if (chunk.content || chunk.toolCalls || chunk.finishReason) yield chunk;
        }
      }
    };
  }

  // --------------------------------------------------------------- scheduler

  /** Approval policy: scheduled jobs never block on the user — auto/ask/deny per-job governs. */
  function schedulerApproval(job: core.ScheduledJob): core.ApprovalPolicy {
    if (job.approval === "auto") return { approve: async () => true };
    if (job.approval === "deny") return { approve: async () => false };
    // 'ask' falls back to deny in unattended runs (no user attached). Real-time
    // "run now" still has the UI to ask; the scheduler tick does not.
    return { approve: async () => false };
  }

  /** Fire a single job synchronously, return the record. Server-side helper. */
  async function fireJob(id: string): Promise<core.JobRun | null> {
    const job = core.getJob(id);
    if (!job) return null;
    return core.fireOne({
      jobId: id,
      transport: openaiTransport({ base: scheduler.base, apiKey: scheduler.apiKey }),
      model: scheduler.model,
      workspace: agentWorkspace(),
      approve: schedulerApproval(job),
    });
  }

  /** Jobs currently firing, so two ticks can never run the same job twice. */
  const firing = new Set<string>();

  /**
   * Periodic tick: every TICK_MS, fire any due jobs (sequentially).
   *
   * The old version "marked" a job running by rewriting its JSON file twice
   * (`enabled:false` then `true`) on every tick — a write to disk on a hot path,
   * and a window in which a crash left the job disabled. An in-memory set is
   * the right place for "is it running right now".
   */
  const schedulerTimer = setInterval(async () => {
    try {
      const jobs = core.dueJobs();
      if (!jobs.length) return;
      for (const j of jobs) {
        if (firing.has(j.id)) continue;
        firing.add(j.id);
        try {
          const run = await fireJob(j.id);
          if (run) deps.broadcast("scheduler_run", { jobId: j.id, name: j.name, run });
        } finally {
          firing.delete(j.id);
        }
      }
    } catch (e) {
      deps.broadcast("scheduler_error", { message: (e as Error).message });
    }
  }, core.TICK_MS);
  schedulerTimer.unref?.();

  /** Persist the user side of the turn so session_search can find it later. */
  function appendUserMessage(sessionId: string, workspace: string, history: Array<{ role: string; content: unknown }>, system: unknown): void {
    const last = history[history.length - 1];
    if (!last || last.role !== "user") return;
    const preview = typeof last.content === "string" ? last.content : JSON.stringify(last.content ?? "");
    core.appendEvents(sessionId, workspace, [
      { kind: "message", data: { role: "user", preview: preview.slice(0, 2000), system: Boolean(system) } },
    ]);
  }

  return [
    // --- tools the model may call -------------------------------------------
    route("GET", "/api/agent/tools", ({ res }) => {
      // Built-in tools plus any live MCP tools, so the UI's Tools panel shows
      // exactly what the model can call right now.
      const mcp = core.mcpToolSpecs();
      json(res, 200, {
        tools: [...core.AGENT_TOOLS, ...mcp],
        readRoots: core.readRoots(),
        writableRoots: core.writableRoots(),
        workspace: core.getWorkspace(),
        mcpToolCount: mcp.length,
      });
    }),

    // --- workspaces the agent may work inside -------------------------------
    route("GET", "/api/workspaces", ({ res }) => {
      json(res, 200, {
        current: core.getWorkspace(),
        chosen: core.workspaceChosen(),
        default: core.defaultWorkspace(),
        candidates: core.workspaceCandidates(),
        readRoots: core.readRoots(),
        writableRoots: core.writableRoots(),
      });
    }),

    route("POST", "/api/workspaces", async ({ req, res }) => {
      const body = await readBody(req);
      const dir = String(body.path ?? "").trim();
      if (!dir) return fail(res, 400, new Error("path is required"));
      const r = core.setWorkspace(dir, { create: body.create !== false });
      if (!r.ok) return fail(res, 400, new Error(r.error ?? "could not use that folder"));
      deps.broadcast("workspace", { path: r.path });
      json(res, 200, { ok: true, path: r.path, created: r.created, readRoots: core.readRoots(), writableRoots: core.writableRoots() });
    }),

    // The directory browser behind the workspace picker.
    route("GET", "/api/browse", ({ res, url }) => {
      const r = core.browseDirectories(q(url, "path") ?? core.getWorkspace());
      if (!r.ok) return fail(res, 400, new Error(r.error ?? "cannot list that folder"));
      json(res, 200, { path: r.path, parent: r.parent ?? null, home: r.home ?? null, entries: r.entries ?? [] });
    }),

    // --- workspace files: the composer's `@`-mention picker ------------------
    route("GET", "/api/workspace/files", ({ res, url }) => {
      const max = Number(q(url, "max") ?? 2000);
      json(res, 200, core.listWorkspaceFiles(Number.isFinite(max) ? max : 2000));
    }),

    route("GET", "/api/workspace/file", async ({ res, url }) => {
      const rel = q(url, "path");
      if (!rel) return fail(res, 400, new Error("path is required"));
      const maxBytes = Number(q(url, "max") ?? 2 * 1024 * 1024);
      const r = await core.readWorkspaceFile(rel, Number.isFinite(maxBytes) ? maxBytes : 2 * 1024 * 1024);
      if (!r.ok) return fail(res, 400, new Error(r.error));
      json(res, 200, r);
    }),

    // --- workspace snapshot: grounding info for the chat (non-agentic too) --
    route("GET", "/api/workspace/snapshot", ({ res, url }) => {
      const maxChars = Number(q(url, "max") ?? 600);
      json(res, 200, {
        path: core.getWorkspace(),
        chosen: core.workspaceChosen(),
        snapshot: core.workspaceSnapshot(Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 600),
      });
    }),

    // --- context, memory, skills introspection ------------------------------
    route("GET", "/api/agent/context", async ({ res, url }) => {
      const base = agentBase(url);
      const meter = core.createMeter(base);
      const messages = (() => {
        try {
          const raw = q(url, "messages");
          return raw ? (JSON.parse(raw) as core.ChatMessage[]) : [];
        } catch {
          return [];
        }
      })();
      // Count live MCP tools in the measurement: their schemas cost real tokens.
      const schemas = q(url, "tools") === "1" ? core.toolSchemas(core.mcpToolSpecs()) : [];
      const b = await core.measureContext(meter, messages, schemas);
      json(res, 200, { ...b, baseUrl: base, toolSupport: await toolSupportOf(base) });
    }),

    /**
     * Measure a conversation that is too long to fit in a query string. The UI
     * uses this: a real transcript with attachments blows past any URL length
     * limit, and a truncated measurement is worse than none.
     */
    route("POST", "/api/agent/context", async ({ req, res }) => {
      const body = await readBody(req);
      const base = String(body.baseUrl ?? "http://127.0.0.1:8080").replace(/\/$/, "");
      const messages = Array.isArray(body.messages) ? (body.messages as core.ChatMessage[]) : [];
      // `model` names the Ollama model so its real context window is used.
      const meter = core.createMeter(base, { model: typeof body.model === "string" ? body.model : undefined });
      const b = await core.measureContext(meter, messages, body.tools === false ? [] : core.toolSchemas(core.mcpToolSpecs()));
      json(res, 200, { ...b, baseUrl: base, toolSupport: await toolSupportOf(base, typeof body.model === "string" ? body.model : undefined) });
    }),

    route("GET", "/api/agent/skills", ({ res }) => {
      json(res, 200, { skills: core.discoverSkills(), roots: core.skillRoots() });
    }),

    route("GET", "/api/agent/memory", ({ res }) => {
      const s = core.memoryStats();
      json(res, 200, { entries: core.listMemory(), block: core.memoryBlock(), stats: s, budgets: s.budget, used: s.chars });
    }),

    route("POST", "/api/agent/memory/forget", async ({ req, res }) => {
      const body = await readBody(req);
      const r = core.forgetMemory(String(body.selector ?? ""));
      json(res, 200, { ok: r.ok, removed: r.removed });
    }),

    route("POST", "/api/agent/memory/save", async ({ req, res }) => {
      const body = await readBody(req);
      const scope = body.scope === "workspace" ? "workspace" : "global";
      const tags = Array.isArray(body.tags) ? body.tags.map(String) : [];
      const r = core.saveMemory(String(body.text ?? ""), scope, tags);
      if (!r.ok) return fail(res, 400, new Error(r.error ?? "could not save"));
      json(res, 200, { ok: true, entry: r.entry, used: r.used, budget: r.budget });
    }),

    route("GET", "/api/agent/todos", ({ res }) => json(res, 200, { todos: agentTodos })),

    // --- artifacts: files the agent produced, and what you can do with them --
    // The list, the preview and the OS hand-offs live together in core/artifacts
    // so they share one jail. The endpoints re-check every path rather than
    // trusting what the client sends back.
    route("GET", "/api/agent/artifacts", ({ res, url }) => {
      const limit = Number(q(url, "limit") ?? 100);
      json(res, 200, core.listArtifacts(Number.isFinite(limit) ? limit : 100));
    }),

    route("GET", "/api/agent/artifacts/preview", ({ res, url }) => {
      const p = q(url, "path");
      if (!p) return fail(res, 400, new Error("path is required"));
      const max = Number(q(url, "max"));
      const r = core.previewArtifact(p, Number.isFinite(max) && max > 0 ? max : undefined);
      if (!r.ok) return fail(res, 400, new Error(r.error ?? "cannot read that file"));
      json(res, 200, r);
    }),

    // List a directory, jailed to the same roots as everything else. This is
    // what makes the artifact list browsable: a row's folder can be opened and
    // walked, and `parent` stops at the root rather than at `/`.
    route("GET", "/api/agent/artifacts/dir", ({ res, url }) => {
      const p = q(url, "path");
      if (!p) return fail(res, 400, new Error("path is required"));
      const limit = Number(q(url, "limit"));
      const r = core.browseArtifactDir(p, q(url, "q") ?? "", {
        limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
        contentSearch: q(url, "contents") !== "0",
      });
      if (!r.ok) return fail(res, 400, new Error(r.error ?? "cannot list that directory"));
      json(res, 200, r);
    }),

    // Reveal and open both hand a path to the OS. They are POST because they
    // cause a side effect, and the path travels in the body so a long or
    // unusual filename cannot be truncated by a URL length limit.
    route("POST", "/api/agent/artifacts/reveal", async ({ req, res }) => {
      const body = await readBody(req);
      const r = core.revealInFileManager(String(body.path ?? ""));
      if (!r.ok) return fail(res, 400, new Error(r.error ?? "could not open the folder"));
      json(res, 200, r);
    }),

    route("POST", "/api/agent/artifacts/open", async ({ req, res }) => {
      const body = await readBody(req);
      const r = core.openPath(String(body.path ?? ""));
      if (!r.ok) return fail(res, 400, new Error(r.error ?? "could not open the file"));
      json(res, 200, r);
    }),

    // --- durable sessions ---------------------------------------------------
    route("GET", "/api/sessions", ({ res }) => json(res, 200, { sessions: core.listSessions() })),

    route("GET", "/api/sessions/:id", ({ res, url }) => {
      const id = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      const rec = core.readSession(id);
      if (!rec) return fail(res, 404, new Error("no such session"));
      json(res, 200, { session: rec });
    }),

    route("DELETE", "/api/sessions/:id", ({ res, url }) => {
      const id = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      json(res, 200, { ok: core.deleteSession(id) });
    }),

    // --- scheduler config ---------------------------------------------------
    route("GET", "/api/scheduler/config", ({ res }) => {
      json(res, 200, {
        baseUrl: scheduler.base,
        model: scheduler.model,
        // Never return the key itself — only whether one is stored.
        apiKeySet: Boolean(scheduler.apiKey),
        intervalMs: core.TICK_MS,
      });
    }),

    route("POST", "/api/scheduler/config", async ({ req, res }) => {
      const body = await readBody(req);
      if (typeof body.baseUrl === "string" && body.baseUrl.trim()) scheduler.base = body.baseUrl.trim().replace(/\/$/, "");
      if (typeof body.model === "string" && body.model.trim()) scheduler.model = body.model.trim();
      if (typeof body.apiKey === "string") scheduler.apiKey = body.apiKey;
      json(res, 200, { ok: true, baseUrl: scheduler.base, model: scheduler.model, apiKeySet: Boolean(scheduler.apiKey) });
    }),

    // --- scheduler / cronjobs -----------------------------------------------
    route("GET", "/api/scheduler/jobs", ({ res }) => json(res, 200, { jobs: core.listJobs() })),

    route("POST", "/api/scheduler/jobs", async ({ req, res }) => {
      const body = await readBody(req);
      const r = core.createJob({
        name: String(body.name ?? "").trim(),
        prompt: String(body.prompt ?? "").trim(),
        intervalMin: Math.max(core.MIN_INTERVAL_MIN, Math.floor(Number(body.intervalMin ?? 0) || 0)),
        approval: body.approval === "ask" || body.approval === "auto" || body.approval === "deny" ? body.approval : "auto",
        tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
      });
      if (!r.ok || !r.job) return fail(res, 400, new Error(r.error ?? "could not create job"));
      json(res, 201, { job: r.job });
    }),

    route("PATCH", "/api/scheduler/jobs/:id", async ({ req, res, url }) => {
      const id = decodeURIComponent(url.pathname.split("/")[4] ?? "");
      const body = await readBody(req);
      const patch: core.UpdateJobInput = {};
      if (typeof body.name === "string") patch.name = body.name;
      if (typeof body.prompt === "string") patch.prompt = body.prompt;
      if (typeof body.intervalMin === "number") patch.intervalMin = body.intervalMin;
      if (body.approval === "ask" || body.approval === "auto" || body.approval === "deny") patch.approval = body.approval;
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
      if (Array.isArray(body.tags)) patch.tags = body.tags.map(String);
      const r = core.updateJob(id, patch);
      if (!r.ok || !r.job) return fail(res, 400, new Error(r.error ?? "could not update job"));
      json(res, 200, { job: r.job });
    }),

    route("DELETE", "/api/scheduler/jobs/:id", ({ res, url }) => {
      const id = decodeURIComponent(url.pathname.split("/")[4] ?? "");
      const job = core.getJob(id);
      if (!job) return fail(res, 404, new Error("no such job"));
      json(res, 200, { ok: core.deleteJob(id) });
    }),

    route("POST", "/api/scheduler/jobs/:id/run", async ({ res, url }) => {
      const id = decodeURIComponent(url.pathname.split("/")[4] ?? "");
      const run = await fireJob(id);
      if (!run) return fail(res, 404, new Error("no such job"));
      json(res, 200, { run });
    }),

    route("GET", "/api/scheduler/jobs/:id/history", ({ res, url }) => {
      const id = decodeURIComponent(url.pathname.split("/")[4] ?? "");
      const job = core.getJob(id);
      if (!job) return fail(res, 404, new Error("no such job"));
      json(res, 200, { runs: job.history });
    }),

    // --- the agentic turn ---------------------------------------------------
    route("POST", "/api/agent/answer/:id", async ({ req, res, url }) => {
      const id = decodeURIComponent(url.pathname.split("/")[4] ?? "");
      const body = await readBody(req);
      const pending = pendingQuestions.get(id);
      if (!pending) return fail(res, 404, new Error("no pending question with that id"));
      // single cleanup site, same pattern that fixed the approval double-delete
      clearTimeout(pending.timer);
      pendingQuestions.delete(id);
      pending.resolve(String(body.answer ?? "").trim() || "(no answer given)");
      json(res, 200, { ok: true });
    }),

    route("POST", "/api/agent/approve/:id", async ({ req, res, url }) => {
      const id = decodeURIComponent(url.pathname.split("/")[4] ?? "");
      const body = await readBody(req);
      const pending = pendingApprovals.get(id);
      if (!pending) return fail(res, 404, new Error("no pending approval with that id"));
      const allowAll = body.allowAll === true;
      // "Allow all for this session": flip the running turn to auto-approve so
      // every later mutating call in it runs without parking. Set BEFORE the
      // resolve, so a call that races the answer already sees the flag.
      if (allowAll) {
        const runId = turnOfApproval.get(id);
        const turn = runId ? liveTurns.get(runId) : undefined;
        if (turn) turn.autoApprove = true;
      }
      // `pending.resolve` performs its own cleanup — deleting here as well would
      // strand the promise (the earlier bug: the map lookup came back empty).
      pending.resolve(body.allow === true || allowAll);
      json(res, 200, { ok: true, allowed: body.allow === true || allowAll, allowAll });
    }),

    route("POST", "/api/agent/steer/:id", async ({ req, res, url }) => {
      const id = decodeURIComponent(url.pathname.split("/")[4] ?? "");
      const steer = activeSteers.get(id);
      if (!steer) return fail(res, 404, new Error("no running turn with that id — it may have finished"));
      const body = await readBody(req);
      const text = String(body.text ?? "").trim();
      if (!text) return fail(res, 400, new Error("text is required"));
      steer.push(text);
      json(res, 200, { ok: true, queued: steer.size });
    }),

    route("POST", "/api/agent", async ({ req, res }) => {
      const body = await readBody(req);
      const base = String(body.baseUrl ?? "http://127.0.0.1:8080").replace(/\/$/, "");
      const model = String(body.model ?? "local");
      const apiKey = body.apiKey ? String(body.apiKey) : undefined;
      const history = Array.isArray(body.messages) ? body.messages : [];
      const approvalMode = body.approval === "auto" ? "auto" : "ask";
      const workspace = agentWorkspace();

      if (!history.length) return fail(res, 400, new Error("messages is required"));

      // The client names the run, so it can reattach after an unmount. A missing
      // runId gets one minted here, which keeps older clients working.
      const runId = typeof body.runId === "string" && body.runId.trim() ? body.runId.trim() : `r${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

      // One turn per runId: a duplicate POST for a live run attaches instead of
      // starting a second loop against the same conversation.
      const existing = liveTurns.get(runId);
      if (existing && existing.status === "running") {
        sseOpen(res);
        sseSend(res, { type: "turn", id: runId, resumed: true });
        const detach = attachTurn(runId, res);
        req.on("close", () => detach?.());
        return;
      }

      const ac = new AbortController();
      const turn: LiveTurn = {
        runId,
        sessionId: core.newSessionId(),
        startedAt: Date.now(),
        status: "running",
        events: [],
        listeners: new Set(),
        abort: ac,
        pending: null,
      };
      liveTurns.set(runId, turn);

      /** Record every event and fan it out to whoever is attached right now. */
      const emit = (ev: unknown): void => {
        turn.events.push(ev);
        for (const res of turn.listeners) sseSend(res, ev);
      };

      // The response the turn's approval/question prompts are sent to. It is
      // re-pointed at whichever client is attached, so a prompt reaches the UI
      // that is actually on screen — and reaches the replay buffer regardless.
      let promptRes = res;

      sseOpen(res);
      sseSend(res, { type: "turn", id: runId });
      const detach = attachTurn(runId, res);
      req.on("close", () => detach?.());

      /**
       * The loop does NOT listen to this request's lifetime.
       *
       * A page switch unmounts the chat and closes the SSE request; if the turn
       * aborted with it, switching pages mid-answer would kill the run — which is
       * the whole bug. The turn keeps going and buffers its events, and a client
       * that comes back replays them. Only an explicit stop cancels it.
       */
      const approval = {
        approve: (areq: { command: string; cwd: string }) => {
          turn.pending = { kind: "approval", id: "", command: areq.command, cwd: areq.cwd };
          turn.status = "awaiting_approval";
          return requestApproval(areq, approvalMode, () => promptRes, ac.signal, runId, emit);
        },
      };

      const steer = core.createSteerQueue();
      activeSteers.set(runId, steer);

      void (async () => {
        try {
          agentTodos = [];
          appendUserMessage(turn.sessionId, workspace, history, body.system);

          const personality = typeof body.personality === "string" ? body.personality : undefined;
          let announced = false;

          // MCP: make sure enabled servers are connected before the first model
          // call, so their tools are part of this run. A failure is per-server
          // and non-fatal — the chat still works with built-in tools.
          if (core.listMcpServers().some((s) => s.enabled)) {
            await core.connectAll().catch(() => {});
          }

          for await (const ev of core.runAgent({
            transport: openaiTransport({ base, apiKey }),
            model,
            history,
            system: typeof body.system === "string" ? body.system : undefined,
            personality,
            workspace,
            maxSteps: Number.isFinite(body.maxSteps) ? Number(body.maxSteps) : undefined,
            approval,
            signal: ac.signal,
            // Tool-call correctness is far more sensitive to sampling than
            // prose is: at 0.7–0.8 the local 3B invents arguments and reaches
            // for a tool on a turn that needs none. The agent path therefore
            // caps the requested temperature (still honours anything lower) so
            // the chat slider cannot silently degrade tool reliability.
            temperature: Math.min(
              Number.isFinite(body.temperature) ? Number(body.temperature) : AGENT_TEMP_CEILING,
              AGENT_TEMP_CEILING,
            ),
            top_p: typeof body.top_p === "number" ? Number(body.top_p) : undefined,
            max_tokens: typeof body.max_tokens === "number" ? Number(body.max_tokens) : undefined,
            meter: core.createMeter(base, { model }),
            injectMemory: body.memory !== false,
            injectSkills: body.skills !== false,
            activeSkills: Array.isArray(body.activeSkills) ? body.activeSkills.map(String).slice(0, 12) : undefined,
            todos: agentTodos,
            sessionId: turn.sessionId,
            extraTools: core.mcpToolSpecs(),
            callMcp: core.callMcpTool,
            askUser: (question, timeoutMs) => {
              turn.pending = { kind: "question", id: question.id, question: question.question, options: question.options };
              turn.status = "awaiting_answer";
              return askTheUser(question, timeoutMs, () => promptRes, ac.signal, runId, emit);
            },
            web: { search: webSearch, fetch: webFetch },
            steer,
            allowDelegate: body.delegate !== false && approvalMode === "auto",
            onPrompt: (built) => {
              if (announced) return;
              announced = true;
              emit({
                type: "prompt",
                personality: personality ?? "none",
                sections: built.sections,
                chars: built.prompt.length,
                memory: built.memory,
              });
            },
            compactApprove: async (info) => {
              turn.pending = { kind: "approval", id: "", command: `compact ${info.older} older message(s)`, cwd: workspace };
              turn.status = "awaiting_approval";
              return requestApproval(
                { command: `compact ${info.older} older message(s)`, cwd: workspace },
                approvalMode,
                () => promptRes,
                ac.signal,
                runId,
                emit,
              );
            },
          })) {
            emit(ev);
            if (ev.type === "tool_result" && ev.name === "write_todo") {
              core.appendEvents(turn.sessionId, workspace, [{ kind: "todo", data: { todos: agentTodos } }]);
              emit({ type: "todos", todos: agentTodos });
            }
            if (ev.type === "final" || ev.type === "error") break;
          }
          endTurn(turn, ac.signal.aborted ? "cancelled" : "done");
        } catch (e) {
          emit({ type: "error", message: String((e as Error).message) });
          endTurn(turn, "error");
        } finally {
          activeSteers.delete(runId);
        }
      })();

      // The response stays open and is fed by `emit`; it is not the owner of the
      // turn. Keeping it open means `promptRes` still has a client to write to.
      promptRes = res;
    }),

    /**
     * Attach to a running turn — the endpoint that makes a page switch harmless.
     *
     * The client POSTs the runId it is holding; if that turn is still alive it
     * gets the full event buffer, then the live stream. If it has already
     * finished, `404` with the final status tells the client to stop waiting
     * rather than to re-run anything.
     */
    route("POST", "/api/agent/attach", ({ res, url }) => {
      const runId = q(url, "runId") ?? "";
      const t = liveTurns.get(runId);
      if (!t) {
        json(res, 404, { error: "no such turn — it finished, or the engine restarted", runId });
        return;
      }
      sseOpen(res);
      sseSend(res, { type: "turn", id: runId, resumed: true, status: t.status });
      if (t.pending) sseSend(res, t.pending.kind === "approval" ? { type: "approval_request", ...t.pending, timeoutMs: APPROVAL_TIMEOUT_MS } : { type: "question", ...t.pending });
      const detach = attachTurn(runId, res);
      res.on("close", () => detach?.());
      // A turn that has already ended (still in its grace window) will never end
      // this response itself — `endTurn` already ran and cleared the listeners.
      // Replay the buffer, add a synthetic end marker, then close, so a late
      // attach gets the whole turn and the client is not left on a dead stream.
      if (t.status !== "running" && t.status !== "awaiting_approval" && t.status !== "awaiting_answer") {
        sseSend(res, { type: "done" });
        detach?.();
        try { res.end(); } catch { /* already gone */ }
      }
      void t;
    }),

    /** What the UI needs to restore on remount: is a run alive, and is it waiting on me? */
    route("GET", "/api/agent/status", ({ res }) => {
      const runs = [...liveTurns.values()].map((t) => ({
        runId: t.runId,
        sessionId: t.sessionId,
        startedAt: t.startedAt,
        status: t.status,
        events: t.events.length,
        pending: t.pending,
      }));
      json(res, 200, { runs, count: runs.length });
    }),

    /** Explicitly stop a turn. The only thing that cancels one. */
    route("POST", "/api/agent/stop", async ({ req, res }) => {
      const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
      const runId = String(body.runId ?? "");
      const t = liveTurns.get(runId);
      if (!t) return fail(res, 404, new Error("no such turn"));
      t.abort.abort();
      endTurn(t, "cancelled");
      json(res, 200, { ok: true, runId });
    }),

    /**
     * Compact a chat conversation on demand: the UI sends the current message
     * list and we summarise the older turns via a one-shot call to the model.
     */
    route("POST", "/api/agent/compact", async ({ req, res }) => {
      const body = await readBody(req);
      const base = String(body.baseUrl ?? "http://127.0.0.1:8080").replace(/\/$/, "");
      const model = String(body.model ?? "local");
      const messages = Array.isArray(body.messages) ? (body.messages as core.AgentMessage[]) : [];
      if (!messages.length) return fail(res, 400, new Error("messages required"));

      const meter = core.createMeter(base);
      const breakdown = await core.measureContext(meter, messages, []);
      const plan = core.planCompaction(messages, breakdown.used, breakdown.window);
      if (!plan.needed) {
        return json(res, 200, { ok: true, compacted: false, reason: plan.reason, used: breakdown.used, window: breakdown.window, messages });
      }
      const prompt = core.summarizationPrompt(plan.older, 768);
      const transport = openaiTransport({ base });
      let summary = "";
      try {
        for await (const chunk of transport({
          model,
          messages: [
            { role: "system", content: "You condense conversation transcripts into compact summaries. Follow the instructions in the user message exactly." },
            { role: "user", content: prompt },
          ],
          tools: [],
          stream: true,
        })) {
          if (chunk.content) summary += chunk.content;
          if (chunk.finishReason) break;
        }
      } catch (e) {
        return fail(res, 502, e as Error);
      }
      summary = summary.trim();
      if (!summary) return fail(res, 502, new Error("summarisation returned nothing"));
      const newMessages = core.applyCompaction(summary, plan.recent);
      json(res, 200, {
        ok: true,
        compacted: true,
        reason: plan.reason,
        before: messages.length,
        after: newMessages.length,
        summary: summary.slice(0, 800),
        messages: newMessages,
      });
    }),
  ];
};

/* ------------------------------------------------------------ shared helpers */

/** The running server the UI is aimed at, for measuring against. */
function agentBase(url: URL | null, fallback = "http://127.0.0.1:8080"): string {
  const fromQuery = url ? q(url, "baseUrl") : null;
  return (fromQuery ?? fallback).replace(/\/$/, "");
}

/**
 * Whether the endpoint's model can call tools.
 *
 * llama.cpp answers `/props` with the chat template, which is the ground truth.
 * Ollama has no such route, but `/api/show` reports a `tools` capability, so
 * that is used instead. Cached per (base, model): an Ollama daemon can serve
 * several models with different capabilities.
 */
const toolSupportCache = new Map<string, core.ToolSupport>();
async function toolSupportOf(base: string, model?: string): Promise<core.ToolSupport> {
  const key = `${base}|${model ?? ""}`;
  const hit = toolSupportCache.get(key);
  if (hit) return hit;
  if (core.looksLikeOllama(base)) {
    if (model) {
      const info = await core.ollamaShow(model, base);
      if (info?.capabilities) {
        const support: core.ToolSupport = info.capabilities.includes("tools") ? "full" : "none";
        toolSupportCache.set(key, support);
        return support;
      }
    }
    return "unknown";
  }
  try {
    const r = await fetch(`${base}/props`, { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const p: any = await r.json();
      const support = core.detectToolSupport(p?.chat_template);
      toolSupportCache.set(key, support);
      return support;
    }
  } catch {
    /* server absent — fall through */
  }
  return "unknown";
}

async function webSearch(query: string): Promise<Array<{ title: string; url: string; snippet?: string }>> {
  try {
    const r = await fetch(`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(10_000),
      headers: { "user-agent": "Mozilla/5.0 (Osama local agent)" },
    });
    if (!r.ok) return [];
    const html = await r.text();
    const out: Array<{ title: string; url: string; snippet?: string }> = [];
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) && out.length < 8) {
      let url = m[1]!;
      if (url.includes("uddg=")) {
        const u = /uddg=([^&]+)/.exec(url);
        if (u) url = decodeURIComponent(u[1]!);
      }
      out.push({ title: stripTags(m[2]!).slice(0, 160), url });
    }
    return out;
  } catch {
    return [];
  }
}

async function webFetch(url: string): Promise<{ title?: string; content: string; url: string }> {
  // The core implementation: markdown-ish extraction, JSON passthrough, SSRF
  // guard, graceful network errors — one code path for the tool and the UI.
  const r = await core.fetchReadable(url);
  if (!r.ok && r.error && !r.text) return { content: `(${r.error})`, url };
  return { title: r.title, content: r.text ?? "", url: r.url };
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
