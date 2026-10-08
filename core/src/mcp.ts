import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { osamaHome } from "./paths.js";
import type { AgentToolSpec, ToolResult } from "./tools.js";

/**
 * Model Context Protocol (MCP) client.
 *
 * Osama connects to MCP servers the user configures and exposes their tools to
 * the agent. Everything here is dependency-free Node: JSON-RPC 2.0 is framed by
 * hand over stdio (newline-delimited) or HTTP (streamable transport). Servers
 * are persisted as JSON under the Osama home so the setup is portable and
 * inspectable, exactly like the workspace and skill stores.
 *
 * Security posture: an MCP tool executes on the user's machine just like a
 * built-in one, so every MCP tool is marked `mutating` and therefore gated by
 * the same approval policy — unless the user explicitly marks a server trusted,
 * in which case its tools run without a prompt.
 */

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_TOOL_PREFIX = "mcp__";

/** How a server is reached. */
export type McpTransport = "stdio" | "http";

export interface McpServerConfig {
  /** Stable slug, unique across servers; used in tool names. */
  id: string;
  name: string;
  transport: McpTransport;
  /** stdio: the command to spawn. */
  command?: string;
  /** stdio: arguments passed to the command. */
  args?: string[];
  /** stdio: extra environment variables (merged over process.env). */
  env?: Record<string, string>;
  /** stdio: working directory for the spawned process. */
  cwd?: string;
  /** http: the endpoint URL. */
  url?: string;
  /** http: extra headers (e.g. Authorization). */
  headers?: Record<string, string>;
  enabled: boolean;
  /** Trusted servers' tools skip the approval gate. Off by default. */
  trusted: boolean;
}

/** A tool advertised by a connected MCP server. */
export interface McpToolDef {
  serverId: string;
  serverName: string;
  /** The tool name as the server calls it (without the namespace prefix). */
  name: string;
  /** The namespaced name the model sees, e.g. `mcp__files__read_text_file`. */
  qualifiedName: string;
  description: string;
  /** JSON Schema for the arguments. */
  inputSchema: Record<string, unknown>;
  /** True when the owning server is trusted (no approval prompt). */
  trusted: boolean;
}

export interface McpServerStatus {
  config: McpServerConfig;
  connected: boolean;
  toolCount: number;
  error?: string;
}

/* ---------------------------------------------------------------- persistence */

function stateFile(): string {
  return path.join(osamaHome(), "mcp.json");
}

/** Turn a display name into a stable, filename- and tool-safe slug. */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "server";
}

export function listMcpServers(): McpServerConfig[] {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), "utf8")) as { servers?: McpServerConfig[] };
    if (Array.isArray(raw.servers)) return raw.servers.filter((s) => s && typeof s.id === "string");
  } catch {
    /* no config yet */
  }
  return [];
}

function writeServers(servers: McpServerConfig[]): void {
  try {
    fs.mkdirSync(osamaHome(), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify({ servers }, null, 2), "utf8");
  } catch {
    /* the caller reports a failure on the next read */
  }
}

export interface UpsertResult {
  ok: boolean;
  server?: McpServerConfig;
  error?: string;
}

/**
 * Add or update a server. The id is derived from the name unless supplied, and
 * kept stable on update so existing connection state is not orphaned.
 */
export function upsertMcpServer(input: Partial<McpServerConfig> & { name: string }): UpsertResult {
  const name = String(input.name ?? "").trim();
  if (!name) return { ok: false, error: "a name is required" };
  const transport: McpTransport = input.transport === "http" ? "http" : "stdio";
  if (transport === "stdio" && !String(input.command ?? "").trim()) {
    return { ok: false, error: "a command is required for a stdio server" };
  }
  if (transport === "http" && !/^https?:\/\//i.test(String(input.url ?? ""))) {
    return { ok: false, error: "a valid http(s) URL is required for an http server" };
  }

  const servers = listMcpServers();
  const existing = input.id ? servers.find((s) => s.id === input.id) : undefined;
  const id = existing?.id ?? uniqueId(servers, input.id || slugify(name));

  const next: McpServerConfig = {
    id,
    name,
    transport,
    command: transport === "stdio" ? String(input.command ?? "").trim() : undefined,
    args: transport === "stdio" ? (Array.isArray(input.args) ? input.args.map(String) : []) : undefined,
    env: input.env && typeof input.env === "object" ? Object.fromEntries(Object.entries(input.env).map(([k, v]) => [k, String(v)])) : undefined,
    cwd: transport === "stdio" && input.cwd ? String(input.cwd) : undefined,
    url: transport === "http" ? String(input.url ?? "").trim() : undefined,
    headers: transport === "http" && input.headers && typeof input.headers === "object"
      ? Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k, String(v)]))
      : undefined,
    enabled: input.enabled !== false,
    trusted: input.trusted === true,
  };

  const idx = servers.findIndex((s) => s.id === id);
  if (idx >= 0) servers[idx] = next;
  else servers.push(next);
  writeServers(servers);
  return { ok: true, server: next };
}

export function removeMcpServer(id: string): boolean {
  const servers = listMcpServers();
  const next = servers.filter((s) => s.id !== id);
  if (next.length === servers.length) return false;
  writeServers(next);
  void disconnect(id);
  return true;
}

function uniqueId(servers: McpServerConfig[], base: string): string {
  let id = base;
  let n = 2;
  while (servers.some((s) => s.id === id)) id = `${base}-${n++}`;
  return id;
}

/* --------------------------------------------------------------- json-rpc core */

interface RpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/**
 * Newline-delimited JSON-RPC over a child process's stdio.
 *
 * Partial lines are buffered across chunks (the important detail the generic
 * process manager does not provide), because a JSON message can be split
 * arbitrarily by the pipe.
 */
class StdioClient {
  private child: ChildProcess;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private closed = false;
  onClose?: (err?: Error) => void;

  constructor(cfg: McpServerConfig) {
    const env = { ...process.env, ...(cfg.env ?? {}) };
    this.child = spawn(cfg.command!, cfg.args ?? [], {
      cwd: cfg.cwd || process.env.HOME || process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout?.on("data", (d) => this.onData(String(d)));
    // stderr is diagnostic only; swallow it so a chatty server cannot spam logs.
    this.child.stderr?.on("data", () => { /* ignore */ });
    this.child.on("error", (e) => this.failAll(e));
    this.child.on("exit", () => this.failAll(new Error("MCP server process exited")));
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: RpcResponse;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // not a JSON-RPC frame
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || `MCP error ${msg.error.code}`));
        else p.resolve(msg.result);
      }
      // Server-initiated requests/notifications are ignored: Osama advertises
      // no capabilities that would invite them.
    }
  }

  private failAll(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.onClose?.(err);
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed || !this.child.stdin?.writable) return Promise.reject(new Error("MCP server is not connected"));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin!.write(`${payload}\n`);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closed || !this.child.stdin?.writable) return;
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    } catch {
      /* the process is going away */
    }
  }

  close(): void {
    this.closed = true;
    try { this.child.kill("SIGTERM"); } catch { /* already gone */ }
    setTimeout(() => { try { this.child.kill("SIGKILL"); } catch { /* */ } }, 1500).unref?.();
  }
}

/**
 * JSON-RPC over the MCP "streamable HTTP" transport.
 *
 * A single request is POSTed; the reply is either one JSON object or an SSE
 * stream whose data frames contain the response. A session id returned on the
 * first call is echoed on every later one.
 */
class HttpClient {
  private sessionId: string | null = null;
  constructor(private cfg: McpServerConfig) {}

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      ...(this.cfg.headers ?? {}),
    };
  }

  async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = 1;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const res = await fetch(this.cfg.url!, {
      method: "POST",
      headers: this.headers(),
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`MCP HTTP ${res.status}: ${t.slice(0, 200)}`);
    }
    const ctype = res.headers.get("content-type") ?? "";
    const text = await res.text();
    if (ctype.includes("text/event-stream")) {
      // Find the data frame whose JSON-RPC id matches ours.
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        try {
          const msg = JSON.parse(trimmed.slice(5).trim()) as RpcResponse;
          if (msg.id === id || msg.id === String(id)) {
            if (msg.error) throw new Error(msg.error.message || `MCP error ${msg.error.code}`);
            return msg.result;
          }
        } catch (e) {
          if (e instanceof Error && /MCP error/.test(e.message)) throw e;
        }
      }
      throw new Error("MCP HTTP stream ended without a matching response");
    }
    const msg = JSON.parse(text) as RpcResponse;
    if (msg.error) throw new Error(msg.error.message || `MCP error ${msg.error.code}`);
    return msg.result;
  }

  // The streamable transport has no persistent socket; each call POSTs.
  notify(): void { /* no-op */ }
  close(): void { /* no-op */ }
}

type Client = StdioClient | HttpClient;

/* -------------------------------------------------------------- connections */

interface Connection {
  client: Client;
  tools: McpToolDef[];
  connected: boolean;
  error?: string;
}

const connections = new Map<string, Connection>();
const REQUEST_TIMEOUT_MS = 30_000;

/** The raw tool shape a server returns; wrapped with server metadata later. */
interface RawMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

async function handshake(client: Client): Promise<RawMcpTool[]> {
  await client.request(
    "initialize",
    {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "osama", version: "0.1.0" },
    },
    REQUEST_TIMEOUT_MS,
  );
  client.notify("notifications/initialized", {});
  const listed = (await client.request("tools/list", {}, REQUEST_TIMEOUT_MS)) as {
    tools?: Array<{ name?: string; description?: string; inputSchema?: Record<string, unknown> }>;
  };
  return (listed.tools ?? [])
    .filter((t) => t && typeof t.name === "string")
    .map((t) => ({
      name: t.name as string,
      description: t.description ?? "",
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    }));
}

/** Connect one server and discover its tools. Idempotent: an open server is reused. */
export async function connect(id: string): Promise<McpServerStatus | null> {
  const cfg = listMcpServers().find((s) => s.id === id);
  if (!cfg) return null;
  const existing = connections.get(id);
  if (existing?.connected) return statusOf(cfg, existing);

  // A previous connection (or half-open one) must be torn down first.
  if (existing) {
    try { existing.client.close(); } catch { /* */ }
    connections.delete(id);
  }

  const conn: Connection = { client: null as unknown as Client, tools: [], connected: false };
  try {
    const client: Client = cfg.transport === "http" ? new HttpClient(cfg) : new StdioClient(cfg);
    if (client instanceof StdioClient) client.onClose = (err) => { conn.connected = false; conn.error = err?.message; };
    conn.client = client;
    const raw = await handshake(client);
    conn.tools = raw.map((t) => ({
      serverId: cfg.id,
      serverName: cfg.name,
      name: t.name,
      qualifiedName: qualify(cfg.id, t.name),
      description: t.description || `${cfg.name} · ${t.name}`,
      inputSchema: t.inputSchema,
      trusted: cfg.trusted,
    }));
    conn.connected = true;
    connections.set(id, conn);
    return statusOf(cfg, conn);
  } catch (e) {
    conn.connected = false;
    conn.error = (e as Error).message;
    try { conn.client?.close(); } catch { /* */ }
    connections.set(id, conn);
    return statusOf(cfg, conn);
  }
}

/** Connect every enabled server. Failures are isolated per server. */
export async function connectAll(): Promise<void> {
  const servers = listMcpServers().filter((s) => s.enabled);
  await Promise.all(servers.map((s) => connect(s.id).catch(() => null)));
}

export async function disconnect(id: string): Promise<void> {
  const conn = connections.get(id);
  if (!conn) return;
  try { conn.client.close(); } catch { /* */ }
  connections.delete(id);
}

export function disconnectAll(): void {
  for (const [, conn] of connections) {
    try { conn.client.close(); } catch { /* */ }
  }
  connections.clear();
}

function statusOf(cfg: McpServerConfig, conn: Connection | undefined): McpServerStatus {
  return {
    config: cfg,
    connected: !!conn?.connected,
    toolCount: conn?.tools.length ?? 0,
    error: conn?.error,
  };
}

export function mcpStatuses(): McpServerStatus[] {
  return listMcpServers().map((cfg) => statusOf(cfg, connections.get(cfg.id)));
}

/* -------------------------------------------------------------------- tools */

/** `mcp__<serverId>__<tool>` — the namespaced name the model sees. */
export function qualify(serverId: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverId}__${toolName}`;
}

export function isMcpTool(name: string): boolean {
  return typeof name === "string" && name.startsWith(MCP_TOOL_PREFIX);
}

export function parseMcpToolName(name: string): { serverId: string; toolName: string } | null {
  if (!isMcpTool(name)) return null;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep < 0) return null;
  return { serverId: rest.slice(0, sep), toolName: rest.slice(sep + 2) };
}

/** Every tool from currently-connected servers, as agent specs. */
export function mcpTools(): McpToolDef[] {
  const out: McpToolDef[] = [];
  for (const [, conn] of connections) if (conn.connected) out.push(...conn.tools);
  return out;
}

/** The connected tools as `AgentToolSpec`s for the agent loop. */
export function mcpToolSpecs(): AgentToolSpec[] {
  return mcpTools().map((t) => ({
    name: t.qualifiedName,
    description: `[MCP: ${t.serverName}] ${t.description}`.slice(0, 1024),
    // Always gated unless the server is explicitly trusted.
    mutating: !t.trusted,
    parameters: t.inputSchema,
  }));
}

/** Render an MCP tools/call result into plain text for the model. */
function renderContent(result: unknown): { text: string; isError: boolean } {
  const r = result as { content?: unknown; isError?: boolean };
  const isError = r?.isError === true;
  const parts = Array.isArray(r?.content) ? r!.content : [];
  const out: string[] = [];
  for (const part of parts) {
    const p = part as { type?: string; text?: string; mimeType?: string; resource?: unknown; uri?: string };
    if (p?.type === "text" && typeof p.text === "string") out.push(p.text);
    else if (p?.type === "image") out.push(`[image ${p.mimeType ?? ""}]`.trim());
    else if (p?.type === "resource") out.push(`[resource ${p.uri ?? JSON.stringify(p.resource ?? "")}]`);
    else out.push(JSON.stringify(part));
  }
  return { text: out.join("\n").trim() || "(the MCP server returned no content)", isError };
}

/** Call one MCP tool by its namespaced name. Never throws. */
export async function callMcpTool(qualifiedName: string, args: Record<string, unknown>): Promise<ToolResult> {
  const parsed = parseMcpToolName(qualifiedName);
  if (!parsed) return { ok: false, content: `${qualifiedName} is not an MCP tool`, summary: "bad mcp name" };
  let conn = connections.get(parsed.serverId);
  if (!conn?.connected) {
    // Lazily reconnect: a server may have died since discovery.
    const st = await connect(parsed.serverId);
    conn = connections.get(parsed.serverId);
    if (!conn?.connected) {
      return { ok: false, content: `MCP server "${parsed.serverId}" is not connected: ${st?.error ?? "unknown"}`, summary: "mcp disconnected" };
    }
  }
  const def = conn.tools.find((t) => t.name === parsed.toolName);
  if (!def) return { ok: false, content: `MCP server "${parsed.serverId}" has no tool "${parsed.toolName}"`, summary: "no such mcp tool" };

  try {
    const result = await conn.client.request("tools/call", { name: parsed.toolName, arguments: args }, REQUEST_TIMEOUT_MS);
    const { text, isError } = renderContent(result);
    return {
      ok: !isError,
      content: text.slice(0, 32_000),
      summary: `mcp ${def.serverName}/${def.name}${isError ? " (error)" : ""}`,
    };
  } catch (e) {
    return { ok: false, content: `MCP tool ${def.serverName}/${def.name} failed: ${(e as Error).message}`, summary: "mcp error" };
  }
}
