import type {
  MlxModel,
  MlxServedInfo,
  MlxStatus,
  AgentEvent,
  AgentStats,
  AgentToolsResponse,
  ArtifactPreview,
  ArtifactsResponse,
  BrowseResponse,
  BuiltPrompt,
  ContextBreakdown,
  ContextRequestMessage,
  DirListing,
  DownloadRecord,
  FindGgufResponse,
  EnginePlan,
  GgufInspectResponse,
  HubModel,
  HubRepo,
  InstalledEngine,
  LocalModel,
  LoraInspection,
  ManagedProcess,
  McpPreset,
  McpServerConfig,
  McpServerStatus,
  McpToolDef,
  MemoryEntry,
  MemoryOp,
  MemoryResponse,
  MemoryStats,
  MetadataEdit,
  ModelCard,
  OllamaModel,
  OllamaStatus,
  ReleaseInfo,
  SeriesSample,
  ServerMetrics,
  SessionMeta,
  SkillMeta,
  SkillStoreResponse,
  SoulReport,
  StatsSnapshot,
  SystemResponse,
  TodoItem,
  ToolSpec,
  WorkspacesResponse,
  WorkspaceFile,
} from "./types";

/** In the browser the Vite dev server proxies /api; inside Tauri the shell
 *  serves the same origin, so an absolute /api path works everywhere. */
const BASE = "";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status} ${res.statusText}`);
  return body as T;
}

const get = <T>(p: string) => req<T>(p);
const post = <T>(p: string, body?: unknown) => req<T>(p, { method: "POST", body: JSON.stringify(body ?? {}) });
const del = <T>(p: string) => req<T>(p, { method: "DELETE" });

export const api = {
  health: () => get<{ ok: boolean; version: string }>("/api/health"),
  system: () => get<SystemResponse>("/api/system"),

  engine: () => get<{ engines: InstalledEngine[]; activeTag?: string; active?: InstalledEngine; knownTools: string[] }>("/api/engine"),
  releases: (limit = 8) => get<{ releases: ReleaseInfo[] }>(`/api/engine/releases?limit=${limit}`),
  enginePlan: (tag?: string) => get<EnginePlan>(`/api/engine/plan${tag ? `?tag=${encodeURIComponent(tag)}` : ""}`),
  installEngine: (body: { tag?: string; acceleration?: string }) => post<{ started: boolean }>("/api/engine/install", body),
  activateEngine: (tag: string) => post<{ ok: boolean }>("/api/engine/activate", { tag }),
  removeEngine: (tag: string) => del<{ ok: boolean }>(`/api/engine/${encodeURIComponent(tag)}`),

  tools: () => get<{ tools: ToolSpec[] }>("/api/tools"),
  preview: (tool: string, values: Record<string, unknown>) =>
    post<{ binary: string; argv: string[]; command: string }>("/api/command/preview", { tool, values }),
  run: (body: { tool: string; values: Record<string, unknown>; cwd?: string }) => post<{ runId: string; command: string }>("/api/run", body),

  processes: () => get<{ processes: ManagedProcess[] }>("/api/processes"),
  startProcess: (body: { tool: string; values: Record<string, unknown>; exclusive?: boolean }) =>
    post<{ process: ManagedProcess; command: string; stopped?: string[]; reboundFrom?: number }>("/api/processes", body),
  processLog: (id: string) => get<{ id: string; lines: string[] }>(`/api/processes/${id}/log`),
  stopProcess: (id: string) => post<{ ok: boolean }>(`/api/processes/${id}/stop`),

  /**
   * The directory browser behind the workspace and GGUF pickers.
   * Pass `files: ["gguf"]` to include files with that extension (with sizes), and
   * `@models` / `@workspace` / `@home` instead of a path to start at a shortcut.
   */
  browse: (path?: string, files?: string[]) =>
    get<BrowseResponse>(
      `/api/browse${path ? `?path=${encodeURIComponent(path)}` : ""}` +
        `${files?.length ? `${path ? "&" : "?"}files=${encodeURIComponent(files.join(","))}` : ""}`,
    ),

  models: () => get<{ models: LocalModel[] }>("/api/models"),
  /** Search a folder (bounded, recursive) for GGUF files — the model picker. */
  findGgufs: (dir: string, opts: { depth?: number; max?: number } = {}) =>
    get<FindGgufResponse>(
      `/api/models/find?dir=${encodeURIComponent(dir)}` +
        `${opts.depth !== undefined ? `&depth=${opts.depth}` : ""}${opts.max !== undefined ? `&max=${opts.max}` : ""}`,
    ),
  scanModels: () => post<{ models: LocalModel[] }>("/api/models/scan"),
  addModel: (body: { file: string; repo?: string; name?: string }) => post<{ model: LocalModel }>("/api/models/add", body),
  modelCard: (id: string) => get<{ card: ModelCard }>(`/api/models/${id}/card`),
  removeModel: (id: string, deleteFile = false) => del<{ ok: boolean }>(`/api/models/${id}?deleteFile=${deleteFile}`),

  hubSearch: (q: string, limit = 30, sort = "downloads", source?: string) =>
    get<{ models: HubModel[]; errors?: string[] }>(`/api/hub/search?q=${encodeURIComponent(q)}&limit=${limit}&sort=${sort}${source ? `&source=${encodeURIComponent(source)}` : ""}`),
  hubTrending: (limit = 24, source?: string) =>
    get<{ models: HubModel[]; errors?: string[] }>(`/api/hub/trending?limit=${limit}${source ? `&source=${encodeURIComponent(source)}` : ""}`),
  hubRepo: (repo: string, source?: string) => get<HubRepo>(`/api/hub/repo?repo=${encodeURIComponent(repo)}${source ? `&source=${encodeURIComponent(source)}` : ""}`),

  downloads: () => get<{ downloads: DownloadRecord[] }>("/api/downloads"),
  startDownload: (body: { repo: string; file: string; name?: string; source?: string }) => post<{ id: string }>("/api/downloads", body),
  cancelDownload: (id: string) => post<{ ok: boolean }>(`/api/downloads/${id}/cancel`),

  serverHealth: (baseUrl: string) => get<{ ok: boolean; status?: number; body?: string; error?: string }>(`/api/server/health?baseUrl=${encodeURIComponent(baseUrl)}`),

  /* ------------------------------------------------------------ ollama provider */

  /** Is the local Ollama daemon up, and which models does it serve? */
  ollamaStatus: (baseUrl?: string) =>
    get<OllamaStatus>(`/api/ollama/status${baseUrl ? `?baseUrl=${encodeURIComponent(baseUrl)}` : ""}`),
  ollamaModels: (baseUrl?: string) =>
    get<{ models: OllamaModel[]; url: string }>(`/api/ollama/models${baseUrl ? `?baseUrl=${encodeURIComponent(baseUrl)}` : ""}`),
  ollamaShow: (model: string, baseUrl?: string) =>
    get<{ model: string; url: string; contextLength?: number; capabilities?: string[] }>(
      `/api/ollama/show?model=${encodeURIComponent(model)}${baseUrl ? `&baseUrl=${encodeURIComponent(baseUrl)}` : ""}`,
    ),

  /**
   * Poll /health until llama-server answers, so callers can wait for a model to
   * finish loading instead of showing a chat box that is not ready yet.
   */
  waitForServer: async (baseUrl: string, timeoutMs = 120_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const h = await get<{ ok: boolean }>(`/api/server/health?baseUrl=${encodeURIComponent(baseUrl)}`);
        if (h.ok) return true;
      } catch {
        /* keep waiting */
      }
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 1000));
    }
  },
  serverProps: (baseUrl: string) => get<{ ok: boolean; props?: any; error?: string }>(`/api/server/props?baseUrl=${encodeURIComponent(baseUrl)}`),

  stats: () => get<StatsSnapshot>("/api/stats"),
  series: () => get<{ samples: SeriesSample[] }>("/api/stats/series"),
  serverMetrics: (baseUrl: string) => get<ServerMetrics>(`/api/server/metrics?baseUrl=${encodeURIComponent(baseUrl)}`),

  /** Extract a PDF's text, server-side, for chat attachments. */
  extractPdf: async (file: File | Blob): Promise<{ text: string; pages: number; scanned: boolean; truncated: boolean }> => {
    const res = await fetch("/api/extract/pdf", {
      method: "POST",
      headers: { "content-type": "application/pdf" },
      body: file,
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({} as { error?: string }));
      throw new Error(detail.error ?? `PDF extraction failed: HTTP ${res.status}`);
    }
    return res.json();
  },
};

/**
 * Chat completion streamed through the local proxy (keeps key handling server-side).
 *
 * Works for both llama.cpp and Ollama: both speak OpenAI-compatible SSE. Ollama
 * separates a thinking model's chain-of-thought into `delta.reasoning` (llama.cpp
 * has no equivalent), so that is surfaced through `opts.onReasoning` rather than
 * being folded into the answer text — the caller can show it as a muted "thinking"
 * block and keep the final answer clean.
 */
export async function* streamChat(
  payload: { model?: string; messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>; stream: true; temperature?: number; top_p?: number; max_tokens?: number },
  opts: { baseUrl: string; apiKey?: string; signal?: AbortSignal; onReasoning?: (text: string) => void },
): AsyncGenerator<string, void, unknown> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: opts.signal,
    body: JSON.stringify({ baseUrl: opts.baseUrl, apiKey: opts.apiKey, payload }),
  });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    throw new Error(t || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
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
      try {
        const parsed = JSON.parse(data);
        // llama.cpp streams {"error":{...}} with HTTP 200 when the request
        // overflows (-c too small), template fails, etc. Surfacing it beats
        // the old "(empty response)" dead end.
        if (parsed.error) {
          const m = parsed.error.message ?? JSON.stringify(parsed.error);
          throw new Error(`Model error: ${String(m).slice(0, 300)}`);
        }
        const delta = parsed.choices?.[0]?.delta;
        // A thinking model's reasoning arrives on its own channel.
        if (typeof delta?.reasoning === "string" && delta.reasoning && opts.onReasoning) {
          opts.onReasoning(delta.reasoning as string);
        }
        if (delta?.content) yield delta.content as string;
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("Model error:")) throw e;
        /* ignore keep-alives */
      }
    }
  }
}

/** Subscribe to the engine's SSE event stream. Returns an unsubscribe fn. */
export function subscribeEvents(onEvent: (e: { type: string; data: any; ts: number }) => void): () => void {
  const es = new EventSource("/api/events");
  es.onmessage = (ev) => {
    try {
      onEvent(JSON.parse(ev.data));
    } catch {
      /* ignore */
    }
  };
  es.onerror = () => {
    /* EventSource auto-reconnects */
  };
  return () => es.close();
}

/* ------------------------------------------------------------- agentic mode */

/**
 * MLX — the Apple-silicon engine beside llama.cpp (docs/mlx-macos.md).
 *
 * Separate from the llama.cpp engine calls on purpose: MLX has its own runtime,
 * its own model shape (a directory, not a GGUF) and its own install path.
 */
export const mlxApi = {
  status: () => get<MlxStatus>("/api/mlx/status"),
  install: () => post<{ started: boolean }>("/api/mlx/install", {}),
  models: () => get<{ models: MlxModel[] }>("/api/mlx/models"),
  inspect: (dir: string) => get<{ model: MlxModel }>(`/api/mlx/model?dir=${encodeURIComponent(dir)}`),
  serve: (body: Record<string, unknown>) =>
    post<{ process: ManagedProcess; command: string; stopped?: string[]; runtime: { source: string; mlxLmVersion?: string } }>("/api/mlx/serve", body),
  info: (baseUrl: string) => get<MlxServedInfo>(`/api/mlx/info?baseUrl=${encodeURIComponent(baseUrl)}`),
};

export const agentApi = {
  tools: () => get<AgentToolsResponse>("/api/agent/tools"),
  /** Harness inventory for the Dashboard: tools, skills, memory, jobs, MCP. */
  stats: () => get<AgentStats>("/api/agent/stats"),
  skills: () => get<{ skills: SkillMeta[]; roots: string[] }>("/api/agent/skills"),
  memory: () => get<MemoryResponse>("/api/agent/memory"),
  todos: () => get<{ todos: TodoItem[] }>("/api/agent/todos"),

  /* ------------------------------------------------- identity (soul) + prompt */

  soul: () => get<SoulReport>("/api/agent/soul"),
  saveSoul: (text: string) => post<{ ok: boolean; chars: number; flagged?: boolean; findings?: string[]; soul: SoulReport }>("/api/agent/soul", { text }),
  resetSoul: () => post<{ ok: boolean; soul: SoulReport }>("/api/agent/soul/reset"),
  /** Assemble the system prompt exactly as the agent would, with its breakdown. */
  prompt: (opts: { system?: string; personality?: string; memory?: boolean; skills?: boolean; tools?: boolean; clock?: boolean; activeSkills?: string[] } = {}) =>
    post<BuiltPrompt>("/api/agent/prompt", opts),

  /* ------------------------------------------------------------- memory ops */

  saveMemory: (body: { text: string; target?: "memory" | "user"; scope?: "global" | "workspace"; tags?: string[] }) =>
    post<{ ok: boolean; entry: MemoryEntry; target: string; used: number; budget: number }>("/api/agent/memory/save", body),
  replaceMemory: (body: { old_text: string; content: string; target?: "memory" | "user" }) =>
    post<{ ok: boolean; entry: MemoryEntry; used: number; budget: number }>("/api/agent/memory/replace", body),
  /** Apply several ops atomically — the consolidation path. */
  batchMemory: (operations: MemoryOp[]) =>
    post<{ ok: boolean; applied: string[]; stats: MemoryStats }>("/api/agent/memory/batch", { operations }),
  forgetMemory: (body: { selector: string; target?: "memory" | "user"; scope?: "global" | "workspace" }) =>
    post<{ ok: boolean; removed: number; error?: string }>("/api/agent/memory/forget", body),

  /* ------------------------------------------------------------- artifacts */

  artifacts: (limit = 100) => get<ArtifactsResponse>(`/api/agent/artifacts?limit=${limit}`),
  previewArtifact: (path: string, max?: number) =>
    get<ArtifactPreview>(`/api/agent/artifacts/preview?path=${encodeURIComponent(path)}${max ? `&max=${max}` : ""}`),
  /** List a directory (jailed) — the browse side of the artifact page. */
  artifactDir: (path: string, q = "", opts: { limit?: number; contents?: boolean } = {}) =>
    get<DirListing>(
      `/api/agent/artifacts/dir?path=${encodeURIComponent(path)}` +
        `${q ? `&q=${encodeURIComponent(q)}` : ""}` +
        `${opts.limit ? `&limit=${opts.limit}` : ""}` +
        `${opts.contents === false ? "&contents=0" : ""}`,
    ),
  /** Open the containing folder with the file selected, where the OS allows it. */
  revealArtifact: (path: string) => post<{ ok: boolean; command?: string }>("/api/agent/artifacts/reveal", { path }),
  openArtifact: (path: string) => post<{ ok: boolean; command?: string }>("/api/agent/artifacts/open", { path }),

  /* ------------------------------------------------ GGUF metadata editing */

  /** The metadata of a file not yet in the library, for the editor form. */
  inspectGguf: (file: string) =>
    post<GgufInspectResponse>("/api/gguf/inspect", { file }),

  /** Metadata of a library model, plus the keys worth editing. */
  modelMetadata: (id: string) =>
    get<GgufInspectResponse>(`/api/models/${encodeURIComponent(id)}/metadata`),

  /**
   * Edit metadata and resave. Returns immediately with a run id; the result —
   * including whether each edit actually landed — arrives over the event bus.
   */
  editModel: (body: { file: string; output?: string; edits: MetadataEdit[]; dryRun?: boolean; keepSplit?: boolean }) =>
    post<{ runId: string; output: string; command: string; overrides: string[] }>("/api/models/edit", body),

  /* ------------------------------------------------------------- LoRA */

  inspectLora: (file: string) =>
    get<{ inspection: LoraInspection; notes: Record<string, string> }>(
      `/api/lora/inspect?file=${encodeURIComponent(file)}`,
    ),

  mergeLora: (body: { model: string; lora: string[]; output: string; threads?: number }) =>
    post<{ runId: string; output: string; command: string }>("/api/lora/merge", body),

  /**
   * Measure the current request against the window. POST because a real
   * transcript (with attachment text) does not fit in a query string.
   */
  context: (baseUrl: string, messages: ContextRequestMessage[] = [], includeTools = true, model?: string) =>
    post<ContextBreakdown>("/api/agent/context", { baseUrl, messages, tools: includeTools, ...(model ? { model } : {}) }),

  /** Answer a parked approval request. The loop resumes either way. */
  approve: (id: string, allow: boolean) =>
    post<{ ok: boolean; allowed: boolean }>(`/api/agent/approve/${encodeURIComponent(id)}`, { allow }),

  /** Answer a parked ask_user_question. */
  answer: (id: string, answer: string) =>
    post<{ ok: boolean }>(`/api/agent/answer/${encodeURIComponent(id)}`, { answer }),

  sessions: () => get<{ sessions: SessionMeta[] }>("/api/sessions"),
  session: (id: string) => get<{ session: { id: string; title: string; events: Array<{ seq: number; kind: string; data: any }> } }>(`/api/sessions/${encodeURIComponent(id)}`),
  deleteSession: (id: string) => del<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}`),

  workspaces: () => get<WorkspacesResponse>("/api/workspaces"),
  setWorkspace: (path: string, create = true) =>
    post<{ ok: boolean; path: string; created?: boolean }>("/api/workspaces", { path, create }),

  /** Files inside the agent workspace — backs the composer's `@` picker. */
  workspaceFiles: () => get<{ path: string; files: WorkspaceFile[]; truncated: boolean }>("/api/workspace/files"),

  /** Inline one workspace file as a text attachment for the current message.
   *  PDFs are extracted server-side; large text files are truncated with a note. */
  workspaceFile: (path: string) =>
    get<{ name: string; rel: string; size: number; mime: string; text: string; truncated?: boolean; note?: string }>(
      `/api/workspace/file?path=${encodeURIComponent(path)}`,
    ),

  /** The workspace layout summary — grounds the chat to the selected directory. */
  workspaceSnapshot: (max = 600) =>
    get<{ path: string; chosen: boolean; snapshot: string }>(
      `/api/workspace/snapshot?max=${max}`,
    ),

  /** Browse a skills.sh / GitHub source for installable skills. */
  skillStore: (source: string) => get<SkillStoreResponse>(`/api/skills/store?source=${encodeURIComponent(source)}`),
  installSkill: (source: string, skill: string) =>
    post<{ ok: boolean; skill: { id: string; name: string } }>("/api/skills/install", { source, skill }),
  removeSkill: (id: string) => post<{ ok: boolean }>("/api/skills/remove", { id }),

  /** Compact a chat's message list on demand — used by the "compact now" button. */
  compact: (payload: { baseUrl: string; model: string; messages: AgentMessagePayload[] }) =>
    post<{ ok: boolean; compacted: boolean; reason: string; before: number; after: number; summary: string; messages: AgentMessagePayload[] }>(
      "/api/agent/compact",
      payload,
    ),

  /** Scheduled jobs (the agent-side cron system). */
  jobs: () => get<{ jobs: Array<{ id: string; name: string; prompt: string; intervalMin: number; approval: string; enabled: boolean; nextRunAt: string; lastRunAt: string | null; lastStatus: string | null }> }>("/api/scheduler/jobs"),
  createJob: (job: { name: string; prompt: string; intervalMin: number; approval?: "ask" | "auto" | "deny"; tags?: string[] }) =>
    post<{ job: { id: string } }>("/api/scheduler/jobs", job),
  patchJob: (id: string, patch: Record<string, unknown>) =>
    post<{ job: unknown }>(`/api/scheduler/jobs/${encodeURIComponent(id)}`, patch),
  deleteJob: (id: string) => del<{ ok: boolean }>(`/api/scheduler/jobs/${encodeURIComponent(id)}`),
  runJob: (id: string) => post<{ run: unknown }>(`/api/scheduler/jobs/${encodeURIComponent(id)}/run`, {}),
  jobHistory: (id: string) => get<{ runs: unknown[] }>(`/api/scheduler/jobs/${encodeURIComponent(id)}/history`),

  /* ------------------------------------------------------------------ mcp */

  /** Every configured MCP server, with live connection status. */
  mcpServers: () => get<{ servers: McpServerStatus[] }>("/api/mcp/servers"),
  /** Add or update an MCP server. */
  saveMcpServer: (server: Partial<McpServerConfig> & { name: string }) =>
    post<{ ok: boolean; server: McpServerConfig; servers: McpServerStatus[] }>("/api/mcp/servers", server),
  removeMcpServer: (id: string) => del<{ ok: boolean; servers: McpServerStatus[] }>(`/api/mcp/servers/${encodeURIComponent(id)}`),
  connectMcpServer: (id: string) => post<McpServerStatus>(`/api/mcp/servers/${encodeURIComponent(id)}/connect`, {}),
  disconnectMcpServer: (id: string) => post<{ ok: boolean; servers: McpServerStatus[] }>(`/api/mcp/servers/${encodeURIComponent(id)}/disconnect`, {}),
  connectAllMcp: () => post<{ ok: boolean; servers: McpServerStatus[] }>("/api/mcp/connect-all", {}),
  /** Live tools across all connected servers. */
  mcpTools: () => get<{ tools: McpToolDef[] }>("/api/mcp/tools"),
  /** One-click server templates. */
  mcpPresets: () => get<{ presets: McpPreset[] }>("/api/mcp/presets"),
};

/**
 * Run one agentic turn and yield its events as they stream in.
 *
 * The server owns the loop; this only decodes SSE. It must keep running after
 * the request body ends — an approval can park the loop for a while — so there
 * is no client-side timeout.
 */
export async function* streamAgent(
  payload: {
    baseUrl: string;
    apiKey?: string;
    model: string;
    system?: string;
    messages: AgentMessagePayload[];
    approval?: "ask" | "auto";
    /** Skills the user activated in the composer — injected into the system prompt. */
    activeSkills?: string[];
    /** Session personality overlay id (see the Soul panel). */
    personality?: string;
    /** This client's id for the run, so the UI can reattach after an unmount. */
    runId?: string;
    maxSteps?: number;
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
  },
  opts: { signal?: AbortSignal } = {},
): AsyncGenerator<AgentEvent, void, unknown> {
  const res = await fetch("/api/agent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: opts.signal,
    body: JSON.stringify(payload),
  });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    throw new Error(t || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
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
      if (!data) continue;
      try {
        yield JSON.parse(data) as AgentEvent;
      } catch {
        /* ignore keep-alives and partial frames */
      }
    }
  }
}

export type AgentMessagePayload = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
};
