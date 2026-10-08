import * as core from "@osama/core";
import { fail, json, readBody, route, type RouteModule } from "../http.js";

/**
 * MCP servers: the user's configured Model Context Protocol connections.
 *
 * Osama does not ship MCP servers — the user registers their own (a stdio
 * command or an HTTP endpoint), and Osama connects, discovers the tools, and
 * exposes them to the agent. All state is the persisted registry in core/mcp;
 * this module is only the HTTP surface plus connect/disconnect lifecycle.
 */
export const mcpRoutes: RouteModule = (deps) => [
  /** Every configured server, with live connection status and tool counts. */
  route("GET", "/api/mcp/servers", ({ res }) => {
    json(res, 200, { servers: core.mcpStatuses() });
  }),

  /** Add or update a server. Connecting happens separately (or on demand). */
  route("POST", "/api/mcp/servers", async ({ req, res }) => {
    const body = await readBody(req);
    const r = core.upsertMcpServer({
      id: typeof body.id === "string" ? body.id : undefined,
      name: String(body.name ?? ""),
      transport: body.transport === "http" ? "http" : "stdio",
      command: body.command,
      args: Array.isArray(body.args) ? body.args : undefined,
      env: body.env && typeof body.env === "object" ? body.env : undefined,
      cwd: body.cwd,
      url: body.url,
      headers: body.headers && typeof body.headers === "object" ? body.headers : undefined,
      enabled: body.enabled !== false,
      trusted: body.trusted === true,
    });
    if (!r.ok || !r.server) return fail(res, 400, new Error(r.error ?? "could not save the server"));
    deps.broadcast("mcp", { stage: "saved", server: r.server });
    json(res, 200, { ok: true, server: r.server, servers: core.mcpStatuses() });
  }),

  route("DELETE", "/api/mcp/servers/:id", ({ res, url }) => {
    const id = decodeURIComponent(url.pathname.split("/")[4] ?? "");
    const okRemoved = core.removeMcpServer(id);
    if (!okRemoved) return fail(res, 404, new Error("no such MCP server"));
    deps.broadcast("mcp", { stage: "removed", id });
    json(res, 200, { ok: true, servers: core.mcpStatuses() });
  }),

  /** Connect one server and discover its tools. */
  route("POST", "/api/mcp/servers/:id/connect", async ({ res, url }) => {
    const id = decodeURIComponent(url.pathname.split("/")[4] ?? "");
    const status = await core.connect(id);
    if (!status) return fail(res, 404, new Error("no such MCP server"));
    deps.broadcast("mcp", { stage: "connected", id, connected: status.connected, tools: status.toolCount, error: status.error });
    json(res, 200, status);
  }),

  /** Disconnect one server (keeps its config). */
  route("POST", "/api/mcp/servers/:id/disconnect", async ({ res, url }) => {
    const id = decodeURIComponent(url.pathname.split("/")[4] ?? "");
    await core.disconnect(id);
    deps.broadcast("mcp", { stage: "disconnected", id });
    json(res, 200, { ok: true, servers: core.mcpStatuses() });
  }),

  /** Connect every enabled server at once. */
  route("POST", "/api/mcp/connect-all", async ({ res }) => {
    await core.connectAll();
    json(res, 200, { ok: true, servers: core.mcpStatuses() });
  }),

  /** The live tools across all connected servers, as the agent sees them. */
  route("GET", "/api/mcp/tools", ({ res }) => {
    json(res, 200, { tools: core.mcpTools() });
  }),

  // --- preset catalogue -----------------------------------------------------
  /**
   * A small set of well-known MCP servers to one-click add. Kept server-side so
   * the list can be updated without a UI release; the user still edits the
   * command before saving.
   */
  route("GET", "/api/mcp/presets", ({ res }) => {
    json(res, 200, { presets: MCP_PRESETS });
  }),
];

interface McpPreset {
  name: string;
  description: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  envKeys?: string[];
}

/** Popular MCP servers. Commands assume Node/npx or uvx on PATH. */
const MCP_PRESETS: McpPreset[] = [
  {
    name: "Filesystem",
    description: "Read and write files within directories you allow (official reference server).",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
  },
  {
    name: "Git",
    description: "Inspect and operate on a local git repository (official reference server).",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-git", "--repository", "/path/to/repo"],
  },
  {
    name: "Fetch",
    description: "Fetch a URL and convert its HTML to markdown (official reference server).",
    transport: "stdio",
    command: "uvx",
    args: ["mcp-server-fetch"],
  },
  {
    name: "Memory",
    description: "A knowledge-graph memory store (official reference server).",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
  },
  {
    name: "Everything (test server)",
    description: "A reference server exposing many tool shapes — useful to test the connection.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-everything"],
  },
];
