import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, Brain, CalendarClock, FileCode2, FolderOpen, History, Plug, Ruler, Settings2,
  Sparkles, Wrench, Plus, Trash2, X, Play, Square,
} from "lucide-react";
import { agentApi, api, type AgentMessagePayload } from "../lib/api";
import type {
  AgentTool, BrowseResponse, ContextBreakdown, ContextRequestMessage,
  MemoryEntry, MemoryStats, PromptSection, RemoteSkill, SkillMeta, TodoItem, WorkspacesResponse, WorkspaceCandidate,
} from "../lib/types";
import { fileBase } from "../lib/format";
import type { StoredChat } from "../lib/chatStore";
import { Modal } from "./ui";
import { MemoryModal, SoulModal } from "./IdentityPanels";
import { ArtifactsModal } from "./ArtifactBrowser";
import { McpPanel } from "./McpPanel";

/**
 * The chat insights, rendered INTO the app's left sidebar (portal slot).
 *
 * Layout discipline: the two LIVE panels — chat history and the context
 * window — stay inline because they update continuously. Everything else is a
 * button in the quick-grid; clicking it opens a modal with the full detail
 * (memory, skills + store, artifacts, workspace browser, scheduler, agent
 * tools, settings). The sidebar stays readable; the depth lives in the modal.
 */

export interface FocusSignal {
  panel: string;
  n: number;
}

export type QuickPanelId = "soul" | "memory" | "skills" | "artifacts" | "workspace" | "scheduler" | "tools" | "mcp" | "settings";

const QUICK_PANEL_IDS: QuickPanelId[] = ["soul", "memory", "skills", "artifacts", "workspace", "scheduler", "tools", "mcp", "settings"];

export function ChatInsights({
  baseUrl, agentic, todos, refreshKey, messages, onToolSupport, onWorkspaceChange,
  systemPrompt, onSystemPrompt, temperature, onTemperature, topP, onTopP, maxTokens, onMaxTokens,
  serverUrl, onServerUrl, apiKey, onApiKey, approvalMode, onApprovalMode,
  history, activeId, onNewChat, onOpenChat, onDeleteChat,
  focus, model, compactMessages, onCompactClick, compacting, lastCompaction,
  personality, onPersonality, livePrompt, contextModel,
}: {
  baseUrl: string;
  agentic: boolean;
  todos: TodoItem[];
  refreshKey: number;
  messages: ContextRequestMessage[];
  onToolSupport?: (s: "full" | "none" | "unknown") => void;
  onWorkspaceChange?: (w: { path: string; chosen: boolean }) => void;
  systemPrompt: string; onSystemPrompt: (v: string) => void;
  temperature: number; onTemperature: (v: number) => void;
  topP: number; onTopP: (v: number) => void;
  maxTokens: number | ""; onMaxTokens: (v: number | "") => void;
  serverUrl: string; onServerUrl: (v: string) => void;
  apiKey: string; onApiKey: (v: string) => void;
  approvalMode: "ask" | "auto"; onApprovalMode: (v: "ask" | "auto") => void;
  history: StoredChat[];
  activeId: string;
  onNewChat: () => void;
  onOpenChat: (id: string) => void;
  onDeleteChat: (id: string) => void;
  focus: FocusSignal | null;
  model: string;
  compactMessages: AgentMessagePayload[];
  onCompactClick?: () => void;
  compacting?: boolean;
  lastCompaction?: { at: number; before: number; after: number; reason: string } | null;
  /** The active personality overlay. Controlled: the chat owns it and sends it. */
  personality: string;
  onPersonality: (v: string) => void;
  /** The prompt the last turn actually used, as the server assembled it. */
  livePrompt: { sections: PromptSection[]; chars: number; personality: string; memory: MemoryStats } | null;
  /** Ollama model name, so the context window uses the model's real size. */
  contextModel?: string;
}) {
  const [modal, setModal] = useState<QuickPanelId | null>(null);

  // A focus request for a quick panel opens its modal (the inline ones scroll).
  useEffect(() => {
    if (focus && (QUICK_PANEL_IDS as string[]).includes(focus.panel)) {
      setModal(focus.panel as QuickPanelId);
    }
  }, [focus]);

  // badges for the quick-row buttons — only polled in Agent mode, so plain
  // chat does not quietly run the agent's state polls behind a simple UI.
  const memCount = usePollCount(() => agentApi.memory().then((m) => m.stats?.total ?? m.entries.length ?? 0), 8000, agentic);
  const skillsCount = usePollCount(() => agentApi.skills().then((r) => r.skills.length), 20000, agentic);
  const artsCount = usePollCount(async () => {
    const r = await fetch("/api/agent/artifacts");
    if (!r.ok) return 0;
    return ((await r.json()).artifacts as unknown[]).length;
  }, 8000, agentic);
  const jobsCount = usePollCount(() => agentApi.jobs().then((r) => r.jobs.length), 10000, agentic);
  const mcpConnected = usePollCount(
    () => agentApi.mcpServers().then((r) => r.servers.filter((s) => s.connected).length).catch(() => 0),
    8000,
    agentic,
  );

  const close = () => setModal(null);

  return (
    <div className="sidebar-insights">
      <div className="nav-group-label">chat</div>
      <HistoryPanel history={history} activeId={activeId} onNewChat={onNewChat} onOpenChat={onOpenChat} onDeleteChat={onDeleteChat} />
      <ContextPanel baseUrl={baseUrl} agentic={agentic} todos={todos} refreshKey={refreshKey} messages={messages} onToolSupport={onToolSupport} focus={focus} model={model} compactMessages={compactMessages} onCompactClick={onCompactClick} compacting={compacting} lastCompaction={lastCompaction} contextModel={contextModel} />

      {/* The agent panels are Agent-mode surface. Plain chat keeps the settings
          it actually uses (system prompt, sampling, endpoint) and drops
          everything that only means something to a tool-calling loop. */}
      <div className="nav-group-label">{agentic ? "agent" : "chat settings"}</div>
      <div className="qgrid">
        {agentic && (
          <>
            <QuickBtn id="soul" icon={<Sparkles size={14} />} label="Soul" onClick={setModal} />
            <QuickBtn id="memory" icon={<Brain size={14} />} label="Memory" badge={memCount > 0 ? String(memCount) : undefined} onClick={setModal} />
            <QuickBtn id="skills" icon={<Wrench size={14} />} label="Skills" badge={skillsCount > 0 ? String(skillsCount) : undefined} onClick={setModal} />
            <QuickBtn id="artifacts" icon={<FileCode2 size={14} />} label="Artifacts" badge={artsCount > 0 ? String(artsCount) : undefined} onClick={setModal} />
            <QuickBtn id="workspace" icon={<FolderOpen size={14} />} label="Workspace" onClick={setModal} />
            <QuickBtn id="scheduler" icon={<CalendarClock size={14} />} label="Scheduler" badge={jobsCount > 0 ? String(jobsCount) : undefined} onClick={setModal} />
            <QuickBtn id="mcp" icon={<Plug size={14} />} label="MCP" badge={mcpConnected > 0 ? String(mcpConnected) : undefined} onClick={setModal} />
            <QuickBtn id="tools" icon={<Ruler size={14} />} label="Tools" onClick={setModal} />
          </>
        )}
        <QuickBtn id="settings" icon={<Settings2 size={14} />} label="Settings" onClick={setModal} />
      </div>

      {modal && (
        <Modal title={MODAL_TITLES[modal]} onClose={close}>
          {modal === "soul" && <SoulModal personality={personality} onPersonality={onPersonality} livePrompt={livePrompt} />}
          {modal === "memory" && <MemoryModal />}
          {modal === "skills" && <SkillsModal />}
          {modal === "artifacts" && <ArtifactsModal />}
          {modal === "workspace" && <WorkspaceModal onWorkspaceChange={onWorkspaceChange} />}
          {modal === "scheduler" && <SchedulerModal />}
          {modal === "mcp" && <McpPanel compact />}
          {modal === "tools" && <ToolsModal agentic={agentic} />}
          {modal === "settings" && (
            <SettingsModal
              systemPrompt={systemPrompt} onSystemPrompt={onSystemPrompt}
              temperature={temperature} onTemperature={onTemperature}
              topP={topP} onTopP={onTopP}
              maxTokens={maxTokens} onMaxTokens={onMaxTokens}
              serverUrl={serverUrl} onServerUrl={onServerUrl}
              apiKey={apiKey} onApiKey={onApiKey}
              approvalMode={approvalMode} onApprovalMode={onApprovalMode}
            />
          )}
        </Modal>
      )}
    </div>
  );
}

const MODAL_TITLES: Record<QuickPanelId, string> = {
  soul: "soul & personality",
  memory: "memory",
  skills: "skills",
  artifacts: "artifacts",
  workspace: "workspace",
  scheduler: "scheduler",
  tools: "agent tools",
  mcp: "mcp servers",
  settings: "chat settings",
};

/* ------------------------------------------------------------- modal shell */

function QuickBtn({ id, icon, label, badge, onClick }: {
  id: QuickPanelId;
  icon: React.ReactNode;
  label: string;
  badge?: string;
  onClick: (id: QuickPanelId) => void;
}) {
  return (
    <button className="qbtn" id={`qbtn-${id}`} onClick={() => onClick(id)}>
      <span className="qbtn-icon">{icon}</span>
      <span className="qbtn-label">{label}</span>
      {badge && <span className="qbtn-badge">{badge}</span>}
    </button>
  );
}

/**
 * Poll `fn` on a timer, but only while `enabled`.
 *
 * The agent's state (memory, skills, jobs, MCP) is fetched for its badges; in
 * plain chat there is no badge to show, so passing `enabled=false` stops the
 * request entirely instead of polling for numbers nothing renders.
 */
function usePollCount(fn: () => Promise<number>, ms: number, enabled = true): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const pull = () => fn().then((v) => { if (alive) setN(v); }).catch(() => {});
    pull();
    const t = setInterval(pull, ms);
    return () => { alive = false; clearInterval(t); };
    // `fn` is a fresh closure every render by design — the timer keys off the
    // cadence and the enable flag, not the function identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ms]);
  return n;
}

/* ----------------------------------------------------------- history */

function HistoryPanel({ history, activeId, onNewChat, onOpenChat, onDeleteChat }: {
  history: StoredChat[];
  activeId: string;
  onNewChat: () => void;
  onOpenChat: (id: string) => void;
  onDeleteChat: (id: string) => void;
}) {
  return (
    <Panel icon={<History size={13} />} title="history" id="history"
      badge={history.length > 0 ? <span className="rpill">{history.length}</span> : undefined}>
      <button className="btn ghost sm" style={{ width: "100%", marginBottom: 6 }} onClick={onNewChat}>
        <Plus size={13} /> New chat
      </button>
      {history.length === 0 ? (
        <Empty text="past conversations land here when you start a new one" />
      ) : (
        history.map((c) => (
          <div className="rpchat" key={c.id}>
            <button
              className={`rpchat-open ${c.id === activeId ? "active" : ""}`}
              onClick={() => onOpenChat(c.id)}
              title={c.title}
            >
              <span className="rpchat-title">{c.title}</span>
              <span className="rpchat-meta">{relTime(c.at)} · {c.messages.length} msg</span>
            </button>
            <button className="rpchat-x" onClick={() => onDeleteChat(c.id)} title="Delete this conversation">
              <Trash2 size={11} />
            </button>
          </div>
        ))
      )}
    </Panel>
  );
}

function relTime(at: number): string {
  const s = Math.max(0, (Date.now() - at) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/* ----------------------------------------------------------- context */

function ContextPanel({ baseUrl, agentic, todos, refreshKey, messages, onToolSupport, focus, model, compactMessages, onCompactClick, compacting, lastCompaction, contextModel }: {
  baseUrl: string;
  agentic: boolean;
  todos: TodoItem[];
  refreshKey: number;
  messages: ContextRequestMessage[];
  onToolSupport?: (s: "full" | "none" | "unknown") => void;
  focus?: FocusSignal | null;
  model: string;
  compactMessages: AgentMessagePayload[];
  onCompactClick?: () => void;
  compacting?: boolean;
  lastCompaction?: { at: number; before: number; after: number; reason: string } | null;
  contextModel?: string;
}) {
  const [ctx, setCtx] = useState<ContextBreakdown | null>(null);

  // The transcript changes on every streamed token; key the effect on shape
  // (count + total content length) so it re-measures on real changes only.
  const shape = useMemo(
    () => `${messages.length}:${messages.reduce((n, m) => n + (m.content?.length ?? 0), 0)}`,
    [messages],
  );
  const msgsRef = useRef(messages);
  msgsRef.current = messages;

  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        // Measure the conversation the user is actually having — not an empty
        // one, which is why this used to sit at a constant few percent. The
        // model name lets an Ollama model report its own context window.
        const c = await agentApi.context(baseUrl, msgsRef.current, agentic, contextModel);
        if (alive) {
          setCtx(c);
          if (c.toolSupport) onToolSupport?.(c.toolSupport);
        }
      } catch {
        /* no server yet */
      }
    };
    pull();
    const t = setInterval(pull, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [baseUrl, agentic, shape, refreshKey, contextModel]);

  const pct = ctx ? Math.round(ctx.pressure * 100) : 0;
  const tone = !ctx ? "" : pct >= 90 ? "crit" : pct >= 70 ? "warn" : "ok";

  return (
    <Panel
      id="context"
      icon={<Ruler size={13} />}
      title="context window"
      focus={focus}
      badge={<span className={`rpill ${tone}`}>{ctx ? `${pct}%` : "—"}</span>}
    >
      {ctx ? (
        <>
          <div className="rpbar">
            <span className={`rpbar-fill ${tone}`} style={{ width: `${Math.min(100, pct)}%` }} />
          </div>
          <Row label="window" value={`${ctx.window.toLocaleString()} tok`} />
          <Row label="in use" value={`${ctx.used.toLocaleString()} tok`} tone={tone} />
          <Row label="free" value={`${ctx.remaining.toLocaleString()} tok`} />
          {ctx.segments.map((s) => <Row key={s.label} label={s.label} value={s.tokens.toLocaleString()} sub />)}
          <div className="rpnote">
            {ctx.exact ? "tokenizer-exact" : "estimated"}
            {agentic && (
              <>
                {" · "}
                {ctx.toolSupport === "none" ? "this model cannot call tools" : "schemas always counted"}
              </>
            )}
          </div>
          {agentic && ctx.toolSupport === "none" && (
            <div className="rpnote faint">{model ? `${model.slice(0, 40)} has no tool template` : "this model has no tool template"}</div>
          )}
        </>
      ) : (
        <Empty text="no running server to measure" />
      )}

      {agentic && todos.length > 0 && (
        <>
          <div className="rpsection">task list</div>
          {todos.map((t, i) => <TodoRow key={`${i}-${t.content}`} todo={t} />)}
        </>
      )}

      {ctx && compactMessages.length > 0 && (
        <>
          <div className="rpsection">compact</div>
          <button
            className="rpbtn"
            onClick={() => onCompactClick?.()}
            disabled={!!compacting || pct < 70}
            title={pct < 70 ? "the window has plenty of room — nothing to compact yet" : `summarise the older ~${Math.max(1, compactMessages.length - 4)} turn(s)`}
          >
            {compacting ? "compacting…" : `compact now (${pct}%)`}
          </button>
          {lastCompaction && (
            <div className="rpnote">
              last: {lastCompaction.before - lastCompaction.after} turn(s) summarised {new Date(lastCompaction.at).toLocaleTimeString()}
            </div>
          )}
          {lastCompaction?.reason && (
            <div className="rpnote faint">{lastCompaction.reason}</div>
          )}
        </>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------ skills */

function SkillsModal() {
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [source, setSource] = useState("");
  const [found, setFound] = useState<RemoteSkill[] | null>(null);
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const reload = () => agentApi.skills().then((r) => setSkills(r.skills)).catch(() => {});
  useEffect(() => { reload(); }, []);

  async function look() {
    const s = source.trim();
    if (!s) return;
    setBusy("browse");
    setError("");
    setFound(null);
    try {
      const r = await agentApi.skillStore(s);
      setRepo(`${r.owner}/${r.repo}`);
      setFound(r.skills);
      if (r.skills.length === 0) setError("no skills found in this repo");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function install(sk: RemoteSkill) {
    setBusy(sk.path);
    setError("");
    try {
      await agentApi.installSkill(source.trim(), sk.path);
      await reload();
      setFound((f) => (f ? f.map((x) => (x.path === sk.path ? { ...x, installed: sk.path } : x)) : f));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function remove(id: string) {
    setBusy(id);
    setError("");
    try {
      await agentApi.removeSkill(id);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="stack" style={{ gap: 12 }}>
      {skills.length === 0 ? (
        <Empty text="no skills — install one below, or add a SKILL.md under .osama/skills" />
      ) : (
        <>
          <div className="rpsection">{skills.length} installed</div>
          {skills.map((s) => (
            <div className="rpskill" key={s.id} title={s.description}>
              <span className="rpskill-name">
                {s.id}
                {s.root.includes(".osama") && (
                  <button className="rpskill-x" onClick={() => remove(s.id)} disabled={busy === s.id} title="Remove this skill">×</button>
                )}
              </span>
              <span className="rpskill-desc">{s.description.slice(0, 160)}{s.description.length > 160 ? "…" : ""}</span>
            </div>
          ))}
        </>
      )}

      <div className="rpsection">install from skills.sh / github</div>
      <div className="wspick-custom">
        <input
          className="input"
          placeholder="owner/repo or skills.sh link"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); look(); } }}
          disabled={busy === "browse"}
        />
        <button className="btn ghost sm" onClick={look} disabled={busy === "browse" || !source.trim()}>
          {busy === "browse" ? "…" : "Find"}
        </button>
      </div>
      <div className="modal-note">try vercel-labs/agent-skills for the official collection</div>

      {found ? (
        <>
          <div className="rpsection">{repo} — {found.length} skill(s)</div>
          {found.map((sk) => (
            <div className="rpstore-row" key={sk.path} title={sk.description || sk.path}>
              <span className="rpstore-name">{sk.name}</span>
              <span className="rpstore-meta">{sk.files} file(s)</span>
              <button className="btn ghost sm" disabled={busy === sk.path} onClick={() => install(sk)} title={`Install ${sk.name} into .osama/skills`}>
                {busy === sk.path ? "…" : sk.installed ? "reinstall" : "install"}
              </button>
            </div>
          ))}
        </>
      ) : null}

      {error && <div className="wspick-error">{error}</div>}
    </div>
  );
}

/* ------------------------------------------------------------ workspace */

function WorkspaceModal({ onWorkspaceChange }: { onWorkspaceChange?: (w: { path: string; chosen: boolean }) => void }) {
  const [ws, setWs] = useState<WorkspacesResponse | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [browse, setBrowse] = useState<BrowseResponse | null>(null);
  const [browseErr, setBrowseErr] = useState("");

  const pull = () => agentApi.workspaces().then((w) => {
    setWs(w);
    onWorkspaceChange?.({ path: w.current, chosen: w.chosen });
  }).catch(() => {});

  useEffect(() => { pull(); }, []);

  async function choose(path: string) {
    const p = path.trim();
    if (!p) return;
    setBusy(true);
    setError("");
    try {
      await agentApi.setWorkspace(p, true);
      setTyped("");
      setBrowse(null);
      await pull();
      // Notify the chat view so it refreshes its workspace snapshot + grounding.
      window.dispatchEvent(new CustomEvent("osama:workspace-changed"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function open(at?: string) {
    setBrowseErr("");
    try {
      setBrowse(await api.browse(at));
    } catch (e) {
      setBrowseErr((e as Error).message);
    }
  }

  if (!ws) return <Empty text="loading…" />;
  const home = browse?.home ?? null;
  const short = (p: string) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p);

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="rpws-modal" title={ws.current}>{ws.current}</div>
      <div className="modal-note">{ws.chosen ? "you chose this folder" : "default — pick a folder to work inside"}. The agent may read and write inside this folder only.</div>

      {browse ? (
        <div className="rpbbody wide">
          <div className="rpb-bar">
            <button className="rpb-nav" onClick={() => open(browse.parent ?? undefined)} disabled={!browse.parent} title="Up one level">↑</button>
            <button className="rpb-nav" onClick={() => open(browse.home ?? undefined)} disabled={!browse.home} title="Home folder">~</button>
            <span className="rpb-path" title={browse.path}>{short(browse.path)}</span>
            <button className="rpb-nav" onClick={() => setBrowse(null)} title="Close the browser">×</button>
          </div>
          <div className="rpb-list">
            {browse.entries.length === 0 && <div className="rpempty">no subfolders here</div>}
            {browse.entries.map((e) => (
              <div key={e.path} className={`rpb-row ${e.hidden ? "dim" : ""}`}>
                <button className="rpb-name" onClick={() => open(e.path)} title={e.path}>
                  <FolderOpen size={12} /> {e.name}
                </button>
                <button className="rpb-pick" onClick={() => choose(e.path)} disabled={busy} title="Work inside this folder">use</button>
              </div>
            ))}
          </div>
          <button className="btn ghost sm" style={{ width: "100%", marginTop: 4 }} onClick={() => choose(browse.path)} disabled={busy}>
            {busy ? "setting…" : `work inside ${short(browse.path)}`}
          </button>
        </div>
      ) : (
        <>
          <button className="btn ghost sm" style={{ width: "100%" }} onClick={() => open(ws.current)}>
            <FolderOpen size={13} /> Browse folders…
          </button>
          {(ws.candidates ?? []).length > 0 && (
            <>
              <div className="rpsection">switch to</div>
              {ws.candidates.filter((c: WorkspaceCandidate) => c.path !== ws.current).map((c) => (
                <button key={c.path} className="rpws-cand" onClick={() => choose(c.path)} disabled={busy} title={c.path}>
                  {c.label}{c.exists ? "" : " · will be created"}
                </button>
              ))}
            </>
          )}
          <div className="rpsection">or enter a path</div>
          <div className="wspick-custom">
            <input
              className="input"
              placeholder="/path/to/your/project"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); choose(typed); } }}
              disabled={busy}
            />
            <button className="btn ghost sm" onClick={() => choose(typed)} disabled={busy || !typed.trim()}>
              {busy ? "checking…" : "Use"}
            </button>
          </div>
        </>
      )}
      {(error || browseErr) && <div className="wspick-error">{error || browseErr}</div>}
    </div>
  );
}

/* ------------------------------------------------------------ scheduler */

interface JobRun {
  at: string;
  status: "ok" | "error" | "denied";
  durationMs: number;
  summary: string | null;
  error: string | null;
}

interface ScheduledJobView {
  id: string;
  name: string;
  prompt: string;
  intervalMin: number;
  approval: "ask" | "auto" | "deny";
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  history: JobRun[];
}

function SchedulerModal() {
  const [jobs, setJobs] = useState<ScheduledJobView[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [intervalMin, setIntervalMin] = useState("");
  const [approval, setApproval] = useState<"ask" | "auto" | "deny">("auto");

  const reload = () => agentApi.jobs().then((r) => setJobs(r.jobs as ScheduledJobView[])).catch(() => {});
  useEffect(() => {
    reload();
    const t = setInterval(reload, 8000);
    return () => clearInterval(t);
  }, []);

  async function make() {
    if (!name.trim() || !prompt.trim()) return;
    setBusy("create");
    setError("");
    try {
      await agentApi.createJob({ name, prompt, intervalMin: Number(intervalMin) || 5, approval });
      setName(""); setPrompt(""); setIntervalMin("");
      setCreating(false);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function toggle(job: ScheduledJobView) {
    setBusy(job.id);
    try { await agentApi.patchJob(job.id, { enabled: !job.enabled }); await reload(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(""); }
  }

  async function runNow(job: ScheduledJobView) {
    setBusy(job.id);
    setError("");
    try { await agentApi.runJob(job.id); await reload(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(""); }
  }

  async function del(job: ScheduledJobView) {
    if (!window.confirm(`Delete job "${job.name}"?`)) return;
    setBusy(job.id);
    try { await agentApi.deleteJob(job.id); await reload(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(""); }
  }

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="modal-note">
        Scheduled jobs run the agent on a cadence — same server, tools, memory and skills as chatting,
        but unattended. Shortest interval 5 minutes; the engine ticks every 30 seconds.
      </div>

      <button className="btn ghost sm" style={{ width: "100%" }} onClick={() => setCreating((v) => !v)}>
        <Plus size={13} /> {creating ? "Cancel" : "New job"}
      </button>

      {creating && (
        <div className="stack" style={{ gap: 8 }}>
          <input className="input" placeholder="job name" value={name} onChange={(e) => setName(e.target.value)} />
          <textarea className="textarea" rows={3} placeholder="the prompt each run receives" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <div className="row wrap" style={{ gap: 8 }}>
            <input className="input" style={{ maxWidth: 150 }} type="number" min={5} placeholder="interval (minutes)" value={intervalMin} onChange={(e) => setIntervalMin(e.target.value)} />
            <select className="select" style={{ maxWidth: 190 }} value={approval} onChange={(e) => setApproval(e.target.value as "ask" | "auto" | "deny")}>
              <option value="auto">auto-approve commands</option>
              <option value="deny">no mutating tools</option>
              <option value="ask">ask (when attended)</option>
            </select>
            <button className="btn sm" onClick={make} disabled={busy === "create" || !name.trim() || !prompt.trim()}>
              {busy === "create" ? "creating…" : "create"}
            </button>
          </div>
        </div>
      )}

      {jobs.length === 0 ? (
        <Empty text="no scheduled jobs — create one above, or just ask the agent to ('schedule a job that …')" />
      ) : (
        jobs.map((j) => (
          <div key={j.id} className={`qjob ${j.enabled ? "" : "off"}`}>
            <div className="qjob-row">
              <button className="qjob-toggle" onClick={() => toggle(j)} disabled={busy === j.id} title={j.enabled ? "Disable the job" : "Enable the job"}>
                {j.enabled ? <Square size={12} /> : <Play size={12} />}
              </button>
              <div className="qjob-main">
                <div className="qjob-name">{j.name}{!j.enabled && <span className="rptag">off</span>}</div>
                <div className="qjob-meta">
                  every {j.intervalMin}m · {j.approval}
                  {j.lastRunAt ? ` · last ${relTime(new Date(j.lastRunAt).getTime())} (${j.lastStatus ?? "?"})` : " · never run"}
                  {j.lastStatus === "error" && j.lastError ? ` · ${j.lastError.slice(0, 60)}` : ""}
                </div>
              </div>
              <button className="rpb-pick" onClick={() => runNow(j)} disabled={busy === j.id} title="Run once now">run</button>
              <button className="rpmem-x" onClick={() => del(j)} title="Delete this job">×</button>
            </div>
            <div className="qjob-prompt">{j.prompt.slice(0, 140)}{j.prompt.length > 140 ? "…" : ""}</div>
            <button className="qjob-hist-btn" onClick={() => setExpanded(expanded === j.id ? null : j.id)}>
              {expanded === j.id ? "hide history" : `history (${j.history?.length ?? 0})`}
            </button>
            {expanded === j.id && (
              <div className="qjob-hist">
                {!j.history?.length ? (
                  <div className="rpempty">no runs yet</div>
                ) : j.history.slice(0, 10).map((r, i) => (
                  <div key={i} className="qjob-run">
                    <span className={`qjob-dot ${r.status}`} />
                    <span className="qjob-run-at">{new Date(r.at).toLocaleString()}</span>
                    <span className="qjob-run-ms">{(r.durationMs / 1000).toFixed(1)}s</span>
                    <span className="qjob-run-sum">{r.summary ?? r.error ?? ""}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))
      )}
      {error && <div className="wspick-error">{error}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------- tools */

function ToolsModal({ agentic }: { agentic: boolean }) {
  const [tools, setTools] = useState<AgentTool[]>([]);
  useEffect(() => {
    agentApi.tools().then((r) => setTools(r.tools)).catch(() => {});
  }, []);
  if (!agentic) {
    return <Empty text="switch the chat header to Agent mode to see the tools the model may call" />;
  }
  const mut = tools.filter((t) => t.mutating).length;
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="modal-note">{tools.length} tools — {mut} mutate state and ask first (or auto-approve, per settings); the rest are read-only. Schemas cost tokens even when unused.</div>
      <div className="rptools">
        {tools.map((t) => (
          <span className={`rtag ${t.mutating ? "mut" : ""}`} key={t.name} title={t.description}>{t.name}</span>
        ))}
      </div>
      <div className="rpsection">details</div>
      <div className="stack" style={{ gap: 6 }}>
        {tools.map((t) => (
          <div key={t.name} className="qtool-row">
            <span className={`rtag ${t.mutating ? "mut" : ""}`}>{t.name}</span>
            <span className="qtool-desc">{t.description.slice(0, 110)}{t.description.length > 110 ? "…" : ""}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- settings */

function SettingsModal(props: {
  systemPrompt: string; onSystemPrompt: (v: string) => void;
  temperature: number; onTemperature: (v: number) => void;
  topP: number; onTopP: (v: number) => void;
  maxTokens: number | ""; onMaxTokens: (v: number | "") => void;
  serverUrl: string; onServerUrl: (v: string) => void;
  apiKey: string; onApiKey: (v: string) => void;
  approvalMode: "ask" | "auto"; onApprovalMode: (v: "ask" | "auto") => void;
}) {
  return (
    <div className="stack" style={{ gap: 10 }}>
      <label className="rpfield">
        <span>system prompt</span>
        <textarea className="textarea" rows={4} value={props.systemPrompt} onChange={(e) => props.onSystemPrompt(e.target.value)} />
      </label>
      <label className="rpfield">
        <span>temperature · {props.temperature.toFixed(2)}</span>
        <input type="range" min={0} max={2} step={0.05} value={props.temperature} onChange={(e) => props.onTemperature(Number(e.target.value))} />
      </label>
      <label className="rpfield">
        <span>top-p · {props.topP.toFixed(2)}</span>
        <input type="range" min={0} max={1} step={0.01} value={props.topP} onChange={(e) => props.onTopP(Number(e.target.value))} />
      </label>
      <label className="rpfield">
        <span>max tokens</span>
        <input className="input" type="number" placeholder="-1 = unlimited" value={props.maxTokens}
               onChange={(e) => props.onMaxTokens(e.target.value === "" ? "" : Number(e.target.value))} />
      </label>
      <label className="rpfield">
        <span>server url</span>
        <input className="input" value={props.serverUrl} onChange={(e) => props.onServerUrl(e.target.value)} placeholder="http://127.0.0.1:8080" />
      </label>
      <label className="rpfield">
        <span>api key</span>
        <input className="input" type="password" value={props.apiKey} onChange={(e) => props.onApiKey(e.target.value)} placeholder="(none)" />
      </label>
      <label className="rpfield">
        <span>agent approvals</span>
        <select className="select" value={props.approvalMode} onChange={(e) => props.onApprovalMode(e.target.value as "ask" | "auto")}>
          <option value="ask">ask before every command</option>
          <option value="auto">auto-approve</option>
        </select>
      </label>
    </div>
  );
}

/* ------------------------------------------------------------- shared */

function Panel({ id, icon, title, badge, children, defaultOpen = true, focus }: {
  id?: string;
  icon: React.ReactNode;
  title: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
  focus?: FocusSignal | null;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focus && id && focus.panel === id) {
      setOpen(true);
      requestAnimationFrame(() => ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    }
  }, [focus, id]);
  return (
    <section className={`rpanel ${open ? "open" : ""}`} ref={ref}>
      <button className="rpanel-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {icon}
        <span className="rpanel-title">{title}</span>
        {badge}
      </button>
      {open && <div className="rpanel-body">{children}</div>}
    </section>
  );
}

function Row({ label, value, sub, tone }: { label: string; value: string; sub?: boolean; tone?: string }) {
  return (
    <div className={`rprow ${sub ? "sub" : ""}`}>
      <span>{label}</span>
      <b className={tone}>{value}</b>
    </div>
  );
}

function TodoRow({ todo }: { todo: TodoItem }) {
  return (
    <div className={`rptodo ${todo.status}`}>
      <span className="rptodo-ref">{todo.status === "completed" ? "x" : todo.status === "in_progress" ? ">" : " "}</span>
      <span>{todo.content}</span>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="rpempty">{text}</div>;
}
