import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check, ChevronDown, Copy, Plug, PlugZap, Plus, Power, RefreshCw, ShieldCheck, Trash2, Unplug, Wrench, X,
} from "lucide-react";
import { agentApi } from "../lib/api";
import type { McpPreset, McpServerConfig, McpServerStatus, McpToolDef } from "../lib/types";
import { Badge, Button, Spinner, useToast } from "./ui";

/**
 * The MCP server manager — shared by the dedicated MCP view and the chat
 * sidebar's modal, so there is one implementation of "connect Osama to an MCP
 * server" and the two surfaces can never drift.
 *
 * Everything the user can do lives here: add (from a preset or by hand), edit,
 * remove, connect / disconnect, mark trusted (tools run without approval),
 * enable / disable, and browse the tools each connected server exposes.
 *
 * State is owned by the server (the registry in core/mcp); this component only
 * reads status and issues commands. It polls while mounted so a server that dies
 * or a scheduled reconnect is reflected without a manual refresh.
 */
export function McpPanel({ compact = false }: { compact?: boolean }) {
  const toast = useToast();
  const [servers, setServers] = useState<McpServerStatus[]>([]);
  const [presets, setPresets] = useState<McpPreset[]>([]);
  const [liveTools, setLiveTools] = useState<McpToolDef[]>([]);
  const [busy, setBusy] = useState<string>("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null); // server id, or "new", or null
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const reload = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([agentApi.mcpServers(), agentApi.mcpTools()]);
      setServers(s.servers);
      setLiveTools(t.tools);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    agentApi.mcpPresets().then((r) => setPresets(r.presets)).catch(() => {});
    const t = setInterval(() => void reload(), 6000);
    return () => clearInterval(t);
  }, [reload]);

  const connectedCount = servers.filter((s) => s.connected).length;
  const toolsByServer = useMemo(() => {
    const m = new Map<string, McpToolDef[]>();
    for (const t of liveTools) {
      const arr = m.get(t.serverId) ?? [];
      arr.push(t);
      m.set(t.serverId, arr);
    }
    return m;
  }, [liveTools]);

  async function run(key: string, fn: () => Promise<void>, okMsg?: string) {
    setBusy(key);
    setError("");
    try {
      await fn();
      if (okMsg) toast.push("ok", okMsg);
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      toast.push("err", msg);
    } finally {
      setBusy("");
      // Let any other surface (the dedicated MCP view) refresh at once.
      window.dispatchEvent(new CustomEvent("osama:mcp-changed"));
    }
  }

  const connect = (id: string, name: string) =>
    run(`connect:${id}`, async () => {
      const st = await agentApi.connectMcpServer(id);
      await reload();
      if (!st.connected) throw new Error(st.error ?? `${name} did not connect`);
      toast.push("ok", `${name} connected · ${st.toolCount} tool(s)`);
    });

  const disconnect = (id: string, name: string) =>
    run(`disconnect:${id}`, async () => { await agentApi.disconnectMcpServer(id); await reload(); }, `${name} disconnected`);

  const remove = (id: string, name: string) =>
    run(`remove:${id}`, async () => { const r = await agentApi.removeMcpServer(id); setServers(r.servers); await reload(); }, `${name} removed`);

  const toggleTrust = (s: McpServerConfig) =>
    run(`trust:${s.id}`, async () => {
      const r = await agentApi.saveMcpServer({ ...s, trusted: !s.trusted });
      setServers(r.servers);
      // Reconnect so the new trust level applies to the live tools.
      if (s.enabled) await agentApi.connectMcpServer(s.id).catch(() => {});
      await reload();
    }, s.trusted ? `${s.name} now asks before each tool` : `${s.name} is now trusted`);

  const toggleEnabled = (s: McpServerConfig) =>
    run(`enable:${s.id}`, async () => {
      const r = await agentApi.saveMcpServer({ ...s, enabled: !s.enabled });
      setServers(r.servers);
      if (s.enabled) await agentApi.disconnectMcpServer(s.id).catch(() => {});
      await reload();
    });

  const connectAll = () =>
    run("connect-all", async () => {
      const r = await agentApi.connectAllMcp();
      setServers(r.servers);
      const ok = r.servers.filter((s) => s.connected).length;
      toast.push("ok", `${ok} server(s) connected`);
    });

  return (
    <div className={`mcp-panel ${compact ? "compact" : ""}`}>
      <div className="mcp-intro">
        <p className="small faint">
          Connect Osama to Model Context Protocol servers. Their tools become available to the agent
          in <b>agentic mode</b>, namespaced <span className="mono">mcp__server__tool</span>. Untrusted
          servers ask before each tool call; mark one <b>trusted</b> to run its tools without asking.
        </p>
      </div>

      <div className="mcp-toolbar">
        <Button size="sm" variant="primary" onClick={() => setEditing(editing === "new" ? null : "new")}>
          <Plus size={14} /> {editing === "new" ? "Cancel" : "Add server"}
        </Button>
        <Button size="sm" variant="ghost" onClick={connectAll} disabled={busy === "connect-all" || servers.length === 0}
          title="Connect every enabled server">
          <PlugZap size={14} /> {busy === "connect-all" ? "Connecting…" : "Connect all"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void reload()} disabled={loading}>
          <RefreshCw size={14} /> Refresh
        </Button>
        <div className="spacer" style={{ flex: 1 }} />
        {servers.length > 0 && (
          <Badge kind={connectedCount > 0 ? "ok" : ""}>{connectedCount}/{servers.length} connected</Badge>
        )}
      </div>

      {editing === "new" && (
        <ServerForm
          presets={presets}
          busy={busy === "save:new"}
          onCancel={() => setEditing(null)}
          onSave={async (draft) => {
            await run("save:new", async () => {
              const r = await agentApi.saveMcpServer(draft);
              setServers(r.servers);
              setEditing(null);
              // Connect immediately so the user learns whether it works.
              const st = await agentApi.connectMcpServer(r.server.id).catch(() => null);
              await reload();
              if (st?.connected) toast.push("ok", `${r.server.name} connected · ${st.toolCount} tool(s)`);
              else if (st) toast.push("warn", `${r.server.name} saved but did not connect: ${st.error ?? "unknown"}`);
            });
          }}
        />
      )}

      {loading ? (
        <div className="mcp-empty"><Spinner /> <span className="faint">loading servers…</span></div>
      ) : servers.length === 0 && editing !== "new" ? (
        <div className="mcp-empty">
          <Plug size={22} className="faint" />
          <div className="small faint" style={{ marginTop: 6 }}>
            No MCP servers yet. Add one above, or start from a preset.
          </div>
          {presets.length > 0 && (
            <div className="mcp-presets">
              {presets.map((p) => (
                <button key={p.name} className="mcp-preset-card" title={p.description}
                  onClick={() => setEditing("new")}>
                  <Plus size={13} /> {p.name}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="mcp-list">
          {servers.map((s) => {
            const tools = toolsByServer.get(s.config.id) ?? [];
            const open = expanded[s.config.id] ?? false;
            return (
              <div key={s.config.id} className={`mcp-card ${s.connected ? "on" : ""} ${s.config.enabled ? "" : "off"}`}>
                <div className="mcp-card-head">
                  <span className={`mcp-led ${s.connected ? "ok" : s.error ? "err" : ""}`} />
                  <div className="mcp-card-title">
                    <div className="row" style={{ gap: 6, alignItems: "center" }}>
                      <span className="mcp-name">{s.config.name}</span>
                      {s.config.trusted && <span className="rptag" title="Tools run without approval"><ShieldCheck size={10} /> trusted</span>}
                      {!s.config.enabled && <span className="rptag">disabled</span>}
                    </div>
                    <div className="mcp-meta">
                      <span className="mcp-transport">{s.config.transport}</span>
                      {s.connected
                        ? <span className="mcp-ok">{s.toolCount} tool{s.toolCount === 1 ? "" : "s"}</span>
                        : s.error
                          ? <span className="mcp-err" title={s.error}>{s.error.slice(0, 60)}</span>
                          : <span className="faint">not connected</span>}
                    </div>
                  </div>
                  <div className="mcp-card-actions">
                    {s.connected ? (
                      <Button size="sm" variant="ghost" onClick={() => disconnect(s.config.id, s.config.name)} disabled={!!busy} title="Disconnect">
                        {busy === `disconnect:${s.config.id}` ? <Spinner /> : <Unplug size={14} />}
                      </Button>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => connect(s.config.id, s.config.name)} disabled={!!busy || !s.config.enabled} title="Connect and discover tools">
                        {busy === `connect:${s.config.id}` ? <Spinner /> : <Plug size={14} />}
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => toggleTrust(s.config)} disabled={!!busy}
                      title={s.config.trusted ? "Stop trusting — ask before each tool" : "Trust — run tools without asking"}>
                      <ShieldCheck size={14} style={{ opacity: s.config.trusted ? 1 : 0.4 }} />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => toggleEnabled(s.config)} disabled={!!busy}
                      title={s.config.enabled ? "Disable (skip on connect-all)" : "Enable"}>
                      <Power size={14} style={{ opacity: s.config.enabled ? 1 : 0.4 }} />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(s.config.id)} disabled={!!busy} title="Edit">
                      <Wrench size={14} />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => remove(s.config.id, s.config.name)} disabled={!!busy} title="Remove">
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </div>

                <div className="mcp-cmd mono" title={s.config.transport === "http" ? s.config.url : `${s.config.command} ${(s.config.args ?? []).join(" ")}`}>
                  {s.config.transport === "http"
                    ? s.config.url
                    : `${s.config.command ?? ""} ${(s.config.args ?? []).join(" ")}`}
                  <button className="mcp-copy" title="Copy"
                    onClick={() => navigator.clipboard.writeText(s.config.transport === "http" ? (s.config.url ?? "") : `${s.config.command ?? ""} ${(s.config.args ?? []).join(" ")}`)}>
                    <Copy size={11} />
                  </button>
                </div>

                {editing === s.config.id && (
                  <ServerForm
                    initial={s.config}
                    presets={presets}
                    busy={busy === `save:${s.config.id}`}
                    onCancel={() => setEditing(null)}
                    onSave={async (draft) => {
                      await run(`save:${s.config.id}`, async () => {
                        const r = await agentApi.saveMcpServer({ ...draft, id: s.config.id });
                        setServers(r.servers);
                        setEditing(null);
                        await agentApi.connectMcpServer(s.config.id).catch(() => {});
                        await reload();
                      });
                    }}
                  />
                )}

                {s.connected && (
                  <>
                    <button className="mcp-tools-toggle" onClick={() => setExpanded((e) => ({ ...e, [s.config.id]: !open }))}>
                      <ChevronDown size={13} className={open ? "rot" : ""} />
                      {tools.length} tool{tools.length === 1 ? "" : "s"} available
                    </button>
                    {open && (
                      <div className="mcp-tools">
                        {tools.map((t) => (
                          <div key={t.qualifiedName} className="mcp-tool">
                            <span className="mcp-tool-name mono">{t.name}</span>
                            <span className="mcp-tool-desc">{t.description || "(no description)"}</span>
                            <span className={`mcp-tool-mode ${t.trusted ? "auto" : "ask"}`}>{t.trusted ? "auto" : "ask"}</span>
                          </div>
                        ))}
                        {tools.length === 0 && <div className="small faint">This server exposes no tools.</div>}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {error && <div className="mcp-error">{error}</div>}
    </div>
  );
}

/* -------------------------------------------------------------- server form */

interface Draft {
  name: string;
  transport: "stdio" | "http";
  command: string;
  argsText: string;
  url: string;
  trusted: boolean;
}

function ServerForm({
  initial, presets, busy, onCancel, onSave,
}: {
  initial?: McpServerConfig;
  presets: McpPreset[];
  busy: boolean;
  onCancel: () => void;
  onSave: (draft: Omit<McpServerConfig, "id" | "enabled">) => void;
}) {
  const [draft, setDraft] = useState<Draft>({
    name: initial?.name ?? "",
    transport: initial?.transport ?? "stdio",
    command: initial?.command ?? "",
    argsText: (initial?.args ?? []).join(" "),
    url: initial?.url ?? "",
    trusted: initial?.trusted ?? false,
  });
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  function applyPreset(p: McpPreset) {
    set({ name: p.name, transport: p.transport, command: p.command ?? "", argsText: (p.args ?? []).join(" "), url: p.url ?? "" });
  }

  /** Split a command line on whitespace, honouring single/double quotes. */
  function splitArgs(text: string): string[] {
    return text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((a) => a.replace(/^["']|["']$/g, "")) ?? [];
  }

  const valid = draft.name.trim() && (draft.transport === "stdio" ? draft.command.trim() : draft.url.trim());

  return (
    <div className="mcp-form">
      {!initial && presets.length > 0 && (
        <>
          <div className="mcp-form-label">Presets</div>
          <div className="mcp-presets">
            {presets.map((p) => (
              <button key={p.name} className="mcp-preset-card" title={p.description} onClick={() => applyPreset(p)}>
                <Plus size={12} /> {p.name}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="mcp-form-label">Name</div>
      <input className="input" placeholder="e.g. Filesystem" value={draft.name} onChange={(e) => set({ name: e.target.value })} autoFocus />

      <div className="mcp-form-label">Transport</div>
      <div className="mcp-transport-switch" role="group" aria-label="Transport">
        <button className={draft.transport === "stdio" ? "on" : ""} onClick={() => set({ transport: "stdio" })}>stdio (local command)</button>
        <button className={draft.transport === "http" ? "on" : ""} onClick={() => set({ transport: "http" })}>http (remote URL)</button>
      </div>

      {draft.transport === "stdio" ? (
        <>
          <div className="mcp-form-label">Command</div>
          <input className="input mono" placeholder="npx" value={draft.command} onChange={(e) => set({ command: e.target.value })} />
          <div className="mcp-form-label">Arguments <span className="faint">(space separated; use quotes for spaces)</span></div>
          <input className="input mono" placeholder="-y @modelcontextprotocol/server-filesystem /path" value={draft.argsText} onChange={(e) => set({ argsText: e.target.value })} />
        </>
      ) : (
        <>
          <div className="mcp-form-label">URL</div>
          <input className="input mono" placeholder="https://host/mcp" value={draft.url} onChange={(e) => set({ url: e.target.value })} />
        </>
      )}

      <label className="check mcp-trust-check">
        <input type="checkbox" checked={draft.trusted} onChange={(e) => set({ trusted: e.target.checked })} />
        <span>
          Trusted — run this server's tools without asking for approval
          <span className="help">Only enable for servers you fully trust; their tools run on your machine.</span>
        </span>
      </label>

      <div className="mcp-form-actions">
        <Button size="sm" variant="ghost" onClick={onCancel}><X size={13} /> Cancel</Button>
        <Button size="sm" variant="primary" disabled={busy || !valid}
          onClick={() => onSave({
            name: draft.name.trim(),
            transport: draft.transport,
            command: draft.transport === "stdio" ? draft.command.trim() : undefined,
            args: draft.transport === "stdio" ? splitArgs(draft.argsText) : undefined,
            url: draft.transport === "http" ? draft.url.trim() : undefined,
            trusted: draft.trusted,
          })}>
          {busy ? <Spinner /> : <Check size={13} />} Save &amp; connect
        </Button>
      </div>
    </div>
  );
}
