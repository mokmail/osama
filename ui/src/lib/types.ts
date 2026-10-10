// Shared types mirroring @osama/core's public shapes (kept UI-side so the
// desktop bundle has no dependency on the node-only core package).

export interface GpuProbe {
  vendor: string;
  name: string;
  acceleration: string;
  discrete: boolean;
}

export interface SystemInfo {
  os: "macos" | "linux" | "windows";
  arch: "arm64" | "x64" | "unknown";
  platform: string;
  release: string;
  hostname: string;
  cpus: number;
  cpuModel: string;
  totalMemBytes: number;
  freeMemBytes: number;
  gpu: string;
}

export interface SystemResponse {
  system: SystemInfo;
  gpu: GpuProbe;
  accelerations: string[];
  recommendedAcceleration: string;
  paths: Record<string, string>;
}

export interface ModelCard {
  architecture?: string;
  name?: string;
  contextLength?: number;
  embeddingLength?: number;
  parameterCount?: number;
  quantization?: string;
  fileType?: number;
  tokenizerModel?: string;
  chatTemplate?: boolean;
}

export interface LocalModel {
  id: string;
  name: string;
  file: string;
  sizeBytes: number;
  repo?: string;
  card?: ModelCard;
  addedAt: string;
  external?: boolean;
  missing?: boolean;
  /** true when the GGUF is a speculative-decoding draft head and must not be served as a main model */
  draftOnly?: boolean;
}

export interface InstalledEngine {
  tag: string;
  os: string;
  arch: string;
  acceleration: string;
  dir: string;
  installedAt: string;
  tools: Record<string, string>;
}

export interface ReleaseAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

export interface ReleaseInfo {
  tag: string;
  name: string;
  publishedAt: string;
  htmlUrl: string;
  assets: ReleaseAsset[];
}

export interface EnginePlan {
  tag: string;
  publishedAt: string;
  os: string;
  arch: string;
  variants: Array<{ acceleration: string; asset: string; size: number; available: boolean }>;
}

export interface ParamSpec {
  key: string;
  flag: string;
  aliases?: string[];
  type: "bool" | "string" | "number" | "enum" | "path" | "model";
  label: string;
  help?: string;
  group: string;
  default?: string | number | boolean;
  /** Sample value shown as the placeholder. Never changes what runs. */
  example?: string;
  enum?: string[];
  /** Per-option explanation for enum pickers, keyed by option value. */
  enumHelp?: Record<string, string>;
  positional?: boolean;
  order?: number;
  unit?: string;
  advanced?: boolean;
  /** the tool cannot run without it */
  required?: boolean;
}

export interface ToolSpec {
  id: string;
  binary: string;
  title: string;
  summary: string;
  /** How the tool works — what the inputs are for. Rendered above the form. */
  notes?: string[];
  group: string;
  mode: "process" | "oneshot";
  params: ParamSpec[];
}

export interface HubModel {
  id: string;
  /** which hub this came from ("huggingface" legacy rows may omit it) */
  source?: "huggingface" | "modelscope" | "civitai" | "ollama" | "url";
  author?: string;
  downloads?: number;
  likes?: number;
  lastModified?: string;
  tags: string[];
  pipelineTag?: string;
  gated?: boolean | string;
  instruct: boolean;
  url: string;
}

export interface HubFile {
  path: string;
  size: number;
  isMain: boolean;
  quant?: string;
  isMmproj: boolean;
}

export interface HubRepo {
  id: string;
  /** the hub the repo belongs to */
  source?: "huggingface" | "modelscope" | "civitai" | "ollama" | "url";
  /** the source-native ref (== id for HF; the file path for direct URLs) */
  ref?: string;
  downloads?: number;
  likes?: number;
  gated?: boolean | string;
  tags: string[];
  files: HubFile[];
  totalSize: number;
  hasGguf: boolean;
}

export interface ManagedProcess {
  id: string;
  label: string;
  tool: string;
  argv: string[];
  cwd: string;
  pid?: number;
  status: "starting" | "running" | "exited" | "failed" | "stopped";
  exitCode?: number | null;
  signal?: string | null;
  startedAt: number;
  endedAt?: number;
  url?: string;
  logPath: string;
}

export interface DownloadRecord {
  id: string;
  repo: string;
  file: string;
  dest: string;
  received: number;
  total: number | null;
  status: "downloading" | "done" | "error" | "cancelled";
  error?: string;
  startedAt: number;
}

export interface RunResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface OsamaEvent {
  type: string;
  data: any;
  ts: number;
}

/* ---------------------------------------------------------------- dashboard */

export interface DiskUsage {
  bytes: number;
  files: number;
}

export interface DiskBreakdown {
  models: DiskUsage;
  engines: DiskUsage;
  downloads: DiskUsage;
  logs: DiskUsage;
  partialBytes: number;
  partialFiles: number;
  totalBytes: number;
  volume: { totalBytes: number; freeBytes: number; usedPct: number } | null;
}

export interface ActivityEntry {
  type: string;
  count: number;
  lastTs: number | null;
}

export interface HealthCheck {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export interface StatsSnapshot {
  generatedAt: string;
  uptimeMs: number;
  engine: {
    installed: boolean;
    tag?: string;
    acceleration?: string;
    installedAt?: string;
    dir?: string;
    tools: number;
    toolNames: string[];
    knownTools: number;
    /** KNOWN_TOOLS entries this build does not ship. */
    missingTools: string[];
    /** Command-catalogue front-ends that resolved, out of frontEndsTotal. */
    frontEndsPresent: number;
    frontEndsTotal: number;
    enginesInstalled: number;
    sizeBytes: number;
  };
  library: {
    count: number;
    servable: number;
    drafts: number;
    external: number;
    missing: number;
    totalBytes: number;
    avgBytes: number;
    maxBytes: number;
    contextMax: number | null;
    contextTotal: number | null;
    architectures: Array<{ name: string; count: number; bytes: number }>;
    quantizations: Array<{ name: string; count: number; bytes: number }>;
    recent: Array<{
      id: string;
      name: string;
      quantization?: string;
      architecture?: string;
      sizeBytes: number;
      addedAt: string;
    }>;
  };
  disk: DiskBreakdown;
  processes: {
    total: number;
    running: number;
    exited: number;
    failed: number;
    stopped: number;
    byTool: Array<{ tool: string; count: number }>;
    runningNow: Array<{ id: string; label: string; tool: string; pid?: number; url?: string; uptimeMs: number }>;
    oldestUptimeMs: number | null;
  };
  downloads: {
    active: number;
    done: number;
    error: number;
    cancelled: number;
    records: Array<{ id: string; file: string; repo: string; received: number; total: number | null; status: string }>;
  };
  system: {
    hostname: string;
    os: string;
    arch: string;
    release: string;
    cpuModel: string;
    cpus: number;
    totalMemBytes: number;
    freeMemBytes: number;
    usedMemBytes: number;
    memUsedPct: number;
    loadavg: number[];
    loadPct: number;
  };
  activity: ActivityEntry[];
  health: { score: number; checks: HealthCheck[] };
}

export interface SeriesSample {
  ts: number;
  memFreeBytes: number;
  memUsedPct: number;
  loadPct: number;
  runningProcesses: number;
  activeDownloads: number;
  libraryBytes: number;
}

/** llama-server runtime metrics scraped from its /metrics endpoint. */
export interface ServerMetrics {
  up: boolean;
  url?: string;
  model?: string;
  ftype?: string;
  build?: string;
  slots?: number;
  nCtx?: number;
  promptTokensTotal?: number;
  tokensPredictedTotal?: number;
  promptTps?: number;
  predictedTps?: number;
  requestsProcessing?: number;
  requestsDeferred?: number;
  cacheReusePct?: number | null;
  nDecodeTotal?: number;
  nTokensMax?: number;
  error?: string;
}

/* ---------------------------------------------------------------- ollama provider */

/** One model served by the user's local Ollama daemon. */
export interface OllamaModel {
  /** API name, e.g. `qwen3:8b`. */
  name: string;
  size: number;
  modifiedAt: string;
  family?: string;
  families?: string[];
  parameterSize?: string;
  quantization?: string;
  contextLength?: number;
  /** Ollama capability tags, e.g. ["tools", "vision", "thinking"]. */
  capabilities?: string[];
  digest?: string;
}

export interface OllamaStatus {
  reachable: boolean;
  url: string;
  version?: string;
  models: OllamaModel[];
  error?: string;
  hasModels: boolean;
}

/* ------------------------------------------------------------------ mcp */

export type McpTransport = "stdio" | "http";

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  /** Trusted servers' tools skip the approval gate. */
  trusted: boolean;
}

export interface McpServerStatus {
  config: McpServerConfig;
  connected: boolean;
  toolCount: number;
  error?: string;
}

/** A tool advertised by a connected MCP server. */
export interface McpToolDef {
  serverId: string;
  serverName: string;
  name: string;
  qualifiedName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  trusted: boolean;
}

/** A one-click MCP server template. */
export interface McpPreset {
  name: string;
  description: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  envKeys?: string[];
}

/* ---------------------------------------------------------------- agentic mode */

/** A tool the model may call while agentic mode is on. */
export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  mutating: boolean;
}

export interface AgentToolsResponse {
  tools: AgentTool[];
  readRoots: string[];
  writableRoots: string[];
  workspace: string;
}

/**
 * The agent harness in one object, for the Dashboard's Agent section.
 *
 * Kept separate from StatsSnapshot on purpose: `engine.tools` there counts
 * llama.cpp binaries on disk, while `tools.total` here counts the JSON schemas
 * the model is handed. Two different numbers that used to look like one.
 */
export interface AgentStats {
  tools: {
    /** Built-ins in core/src/tools.ts. */
    builtIn: number;
    /** Built-ins that mutate state and are gated by the approval policy. */
    mutating: number;
    /** Built-ins that only read. */
    readOnly: number;
    /** Live tools advertised by connected MCP servers. */
    mcp: number;
    /** builtIn + mcp: what the model can actually call right now. */
    total: number;
  };
  skills: { total: number; roots: number };
  memory: { entries: number; used: number; budget: number; percent: number };
  sessions: { total: number; last: string | null };
  jobs: { total: number; enabled: number };
  mcp: { servers: number; connected: number; tools: number };
  workspace: { path: string; chosen: boolean };
}

/** Events streamed by POST /api/agent, one per line of SSE. */
export type AgentEvent =
  | { type: "assistant_delta"; text: string }
  /**
   * Sent once per turn, before the first model call: the assembled system
   * prompt's sections, in the order the model received them, plus live memory
   * fill. Lets the chat show what the agent was actually told.
   */
  | { type: "prompt"; personality: string; sections: PromptSection[]; chars: number; memory: MemoryStats }
  | { type: "step"; index: number }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown>; raw: string }
  | { type: "tool_result"; id: string; name: string; ok: boolean; summary: string; content: string; durationMs: number }
  | { type: "denied"; id: string; name: string; reason: string }
  | { type: "compaction"; reason: string; before: number; after: number; kept: number }
  | { type: "todos"; todos: TodoItem[] }
  | { type: "approval_request"; id: string; command: string; cwd: string; timeoutMs: number }
  | { type: "question"; id: string; question: string; options?: string[]; timeoutMs: number }
  /** The model narrated a step instead of calling it, so the turn continued. */
  | { type: "action_nudge"; attempt: number }
  | { type: "final"; text: string; steps: number; changed?: boolean; nudges?: number }
  | { type: "error"; message: string };

/** One entry of the visible agent trace attached to an assistant message. */
export interface AgentStep {
  id: string;
  kind: "call" | "result" | "denied";
  name: string;
  args?: Record<string, unknown>;
  summary?: string;
  content?: string;
  ok?: boolean;
  durationMs?: number;
}

export interface AgentApproval {
  id: string;
  command: string;
  cwd: string;
}

/** The model asked the user something; answered via /api/agent/answer/:id. */
export interface AgentQuestion {
  id: string;
  question: string;
  options?: string[];
}

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  workspace: string;
  eventCount: number;
  compacted: boolean;
}

/* ------------------------------------------------- context, memory, skills */

export interface ContextBreakdown {
  window: number;
  used: number;
  remaining: number;
  pressure: number;
  segments: Array<{ label: string; tokens: number }>;
  overflow: boolean;
  exact: boolean;
  baseUrl?: string;
  /** Whether the served model's chat template can express tool calls. */
  toolSupport?: "full" | "none" | "unknown";
}

/** What the context endpoint accepts: one entry per message actually sent. */
export interface ContextRequestMessage {
  role: string;
  content: string | null;
}

/* ------------------------------------------------------------------ workspace */

export interface WorkspaceCandidate {
  path: string;
  label: string;
  exists: boolean;
  note?: string;
}

export interface WorkspacesResponse {
  current: string;
  chosen: boolean;
  default: string;
  candidates: WorkspaceCandidate[];
  readRoots: string[];
  writableRoots: string[];
}

/** The workspace directory browser. */
export interface BrowseEntry {
  name: string;
  path: string;
  hidden: boolean;
  /** true for a file — only present when the request asked for extensions. */
  file?: boolean;
  size?: number;
}

export interface BrowseResponse {
  path: string;
  parent: string | null;
  home: string | null;
  /** shortcut roots the pickers offer */
  modelsDir: string | null;
  workspace: string | null;
  entries: BrowseEntry[];
}

/** A GGUF found on disk by the picker's search. */
export interface GgufHit {
  name: string;
  path: string;
  sizeBytes: number;
  inLibrary: boolean;
}

export interface FindGgufResponse {
  ok: boolean;
  dir?: string;
  files?: GgufHit[];
  /** the walk hit its bound — there may be more below */
  truncated?: boolean;
  error?: string;
}

/** A skill found in a remote repo, before installing. */
export interface RemoteSkill {
  path: string;
  name: string;
  description: string;
  files: number;
  bytes: number;
  /** Set after this session installs it. */
  installed?: string;
}

export interface SkillStoreResponse {
  owner: string;
  repo: string;
  ref: string | null;
  skills: RemoteSkill[];
}

export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  file: string;
  root: string;
  tags?: string[];
  version?: string;
}

export interface MemoryEntry {
  id: string;
  text: string;
  scope: "global" | "workspace";
  tags: string[];
  createdAt: string;
  updatedAt: string;
  hits: number;
}

/** One store's fill level, as the backend reports it. */
export interface MemoryFill {
  target: "memory" | "user";
  scope: "global" | "workspace";
  label: string;
  entries: number;
  chars: number;
  budget: number;
  pressure: number;
}

export interface MemoryStats {
  total: number;
  byScope: Record<string, number>;
  byTarget: Record<string, number>;
  chars: Record<string, number>;
  budget: Record<string, number>;
  user: { entries: number; chars: number; budget: number; pressure: number };
  fills: MemoryFill[];
}

export interface MemoryResponse {
  /** The agent's own notes. */
  entries: MemoryEntry[];
  /** The user profile — a separate store. */
  user: MemoryEntry[];
  block: string;
  stats: MemoryStats;
  budgets: Record<string, number>;
  used: Record<string, number>;
  userBudget: number;
}

/* --------------------------------------------------------------- artifacts */

/** A file the agent wrote or edited, as the artifact browser sees it. */
export interface ArtifactFile {
  /** The path as the tool recorded it. */
  file: string;
  /** The absolute, resolved path — what the OS needs to open it. */
  abs: string;
  op: string;
  at: string;
  sessionId: string;
  name: string;
  /** The containing directory. */
  dir: string;
  /** Lowercase extension, no dot. */
  ext: string;
  exists: boolean;
  size: number;
  mtime: string | null;
  /** True when the path is outside the allowed roots, so it cannot be opened. */
  jailed: boolean;
  /** How many times the agent wrote this path. */
  writes: number;
}

export interface ArtifactsResponse {
  artifacts: ArtifactFile[];
  total: number;
  truncated: boolean;
}

export interface ArtifactPreview {
  ok: boolean;
  path: string;
  name: string;
  ext: string;
  size: number;
  mtime: string;
  text?: string;
  binary?: boolean;
  truncated?: boolean;
  lines?: number;
  error?: string;
}

/** One row in the artifact page's directory browser. */
export interface DirEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  mtime: string | null;
  /** 1 when a content search matched (not just the name). */
  matches?: number;
}

export interface DirListing {
  ok: boolean;
  path?: string;
  /** The parent directory, or null at the top of the allowed root. */
  parent?: string | null;
  /** The allowed root this directory belongs to — where "up" stops. */
  root?: string;
  entries?: DirEntry[];
  matchCount?: number;
  error?: string;
}

/* ------------------------------------------------------ soul + memory (new) */

export interface Personality {
  id: string;
  label: string;
  blurb: string;
  overlay: string;
}

export interface SoulReport {
  source: "file" | "default";
  file: string;
  text: string;
  chars: number;
  flagged: boolean;
  findings: string[];
  truncated: boolean;
  personalities: Personality[];
  maxChars: number;
}

export interface PromptSection {
  name: string;
  chars: number;
  tokens: number | null;
}

/** The assembled system prompt, with its section breakdown. */
export interface BuiltPrompt {
  prompt: string;
  sections: PromptSection[];
  memory: MemoryStats;
}

export type MemoryOp =
  | { action: "add"; content: string; target?: "memory" | "user"; scope?: "global" | "workspace"; tags?: string[] }
  | { action: "replace"; content: string; old_text: string; target?: "memory" | "user" }
  | { action: "remove"; old_text: string; target?: "memory" | "user" };

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/** A file (or directory) inside the agent workspace, for the `@` picker. */
export interface WorkspaceFile {
  /** Path relative to the workspace root, forward slashes; dirs end with `/`. */
  rel: string;
  name: string;
  dir: boolean;
  size: number;
}

/* ------------------------------------------------- GGUF metadata + LoRA */

/** The override types llama-quantize's `--override-kv` accepts. */
export type OverrideType = "str" | "int" | "float" | "bool";

export interface MetadataEdit {
  key: string;
  type: OverrideType;
  value: string | number | boolean;
}

export interface EditableKey {
  key: string;
  label: string;
  type: OverrideType;
  help?: string;
}

export interface GgufInspectResponse {
  file: string;
  metadata: Record<string, string | number | boolean>;
  editable: EditableKey[];
  /** The architecture-prefixed context-length key, when the file has one. */
  contextKey?: string | null;
  suggestedOutput: string;
}

export interface LoraInspection {
  file: string;
  ok: boolean;
  sizeBytes?: number;
  baseModel?: string;
  error?: string;
}

/** A completed metadata edit, as reported over the event bus. */
export interface EditRunResult {
  id: string;
  tool: string;
  stage: "start" | "done" | "error";
  output?: string;
  before?: Record<string, string | number | boolean>;
  after?: Record<string, string | number | boolean>;
  /** Edits that exited 0 but did NOT actually land — the honest signal. */
  unapplied?: string[];
  verified?: boolean;
  error?: string;
  line?: string;
  result?: RunResult;
}
