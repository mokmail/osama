import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Bot, Check as CheckIcon, ChevronDown, Copy, FileText, Folder, FolderOpen, GitBranch, Image as ImageIcon,
  Paperclip, Pencil, Play, Plug, RefreshCw, RotateCcw, Send, Sparkles, StopCircle, Trash2, User, X, AlertTriangle, Plus,
} from "lucide-react";
import { api, agentApi, mlxApi, type AgentMessagePayload } from "../lib/api";
import {
  adoptSessionId, answerApproval, answerQuestion, attachToRun,
  clearCompaction, clearTodos, currentSessionId, findLiveRun, getChatState,
  newRunId, noteCompaction, resetSession, setMessages, startRun, stopRun, useChat,
} from "../lib/runStore";
import type { AgentQuestion, AgentStep, AgentTool, ContextBreakdown, LocalModel, MlxModel, MlxStatus, ManagedProcess, McpServerStatus, MemoryStats, OllamaStatus, PromptSection, SkillMeta, SystemResponse, TodoItem, WorkspaceFile } from "../lib/types";
import { Badge, Button, Empty, Spinner, useToast } from "../components/ui";
import { ActivityLine, AgentTrace, ApprovalPrompt, QuestionPrompt } from "../components/AgentTrace";
import { ChatInsights, type FocusSignal } from "../components/ChatInsights";
import { IdentityStrip } from "../components/IdentityPanels";
import { RichContent } from "../components/rich";
import { ModelLoading, useServerReady, useLoadFailure, FailedLoad } from "../components/ModelLoading";
import { bytes, fileBase } from "../lib/format";
import { isMlxServer, isModelServer, servedModelPath } from "../lib/procs";
import {
  chatTitle, clearActive, loadActive, loadHistory, newChatId, saveActive, saveHistory, type StoredChat,
} from "../lib/chatStore";
import type { EventBus } from "../App";
import type { ViewId } from "../App";

export interface Attachment {
  id: string;
  name: string;
  kind: "text" | "image";
  mime: string;
  size: number;
  /** inline contents for text files */
  text?: string;
  /** data: URL for images */
  dataUrl?: string;
}

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  attachments?: Attachment[];
  /** Present when this turn ran in agentic mode. */
  steps?: AgentStep[];
  stepCount?: number;
}

const DEFAULT_SYSTEM = "You are a helpful, precise assistant running fully offline on the user's machine.";

/** Active skills persist across reloads, like the model choice. */
const ACTIVE_SKILLS_KEY = "osama.chat.skills";
const PERSONALITY_KEY = "osama.chat.personality";

/**
 * Chat provider: Osama's own llama.cpp server, Osama's MLX runtime on Apple
 * silicon, or a local Ollama daemon the user already runs. Persisted so the
 * choice survives a reload; scoped to the chat page only, so every other view
 * keeps using Osama's llama.cpp process.
 */
type ChatProvider = "llamacpp" | "mlx" | "ollama";
const PROVIDER_KEY = "osama.chat.provider";
const OLLAMA_URL_KEY = "osama.chat.ollamaUrl";
const OLLAMA_MODEL_KEY = "osama.chat.ollamaModel";

function loadProvider(): ChatProvider {
  try {
    const saved = localStorage.getItem(PROVIDER_KEY);
    return saved === "ollama" || saved === "mlx" ? saved : "llamacpp";
  } catch {
    return "llamacpp";
  }
}
function saveProvider(p: ChatProvider): void {
  try { localStorage.setItem(PROVIDER_KEY, p); } catch { /* storage full */ }
}
function loadOllamaUrl(): string {
  try {
    return localStorage.getItem(OLLAMA_URL_KEY) || "http://127.0.0.1:11434";
  } catch {
    return "http://127.0.0.1:11434";
  }
}
function saveOllamaUrl(url: string): void {
  try { localStorage.setItem(OLLAMA_URL_KEY, url); } catch { /* storage full */ }
}
function loadOllamaModel(): string {
  try {
    return localStorage.getItem(OLLAMA_MODEL_KEY) || "";
  } catch {
    return "";
  }
}
function saveOllamaModel(name: string): void {
  try { localStorage.setItem(OLLAMA_MODEL_KEY, name); } catch { /* storage full */ }
}

/**
 * The chosen personality overlay, persisted like the active skills are: it is a
 * session-level choice, so it outlives a reload but is not part of the soul.
 */
function loadPersonality(): string {
  try {
    return localStorage.getItem(PERSONALITY_KEY) || "none";
  } catch {
    return "none";
  }
}
function savePersonality(id: string): void {
  try {
    localStorage.setItem(PERSONALITY_KEY, id);
  } catch {
    /* storage full */
  }
}
function loadActiveSkills(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(ACTIVE_SKILLS_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function saveActiveSkills(ids: string[]): void {
  try { localStorage.setItem(ACTIVE_SKILLS_KEY, JSON.stringify(ids)); } catch { /* storage full */ }
}

/** Landing suggestions, Open-WebUI style: a few concrete prompts that show what the local model can do. */
const SUGGESTIONS: Array<{ title: string; sub: string; prompt: string; icon: React.ReactNode }> = [
  { title: "Summarise a document", sub: "Attach a file and ask for the key points", prompt: "Summarise the attached document in 5 bullet points and list any action items.", icon: <FileText size={15} /> },
  { title: "Explain some code", sub: "Paste code or drop a source file", prompt: "Explain what this code does, step by step, and point out any bugs: ", icon: <Sparkles size={15} /> },
  { title: "Draft and refine", sub: "Write something, then improve it", prompt: "Draft a short, clear email declining a meeting and proposing two alternative times.", icon: <Sparkles size={15} /> },
];

/** One server at a time: switching a model replaces whatever is serving. */
const SERVER_DEFAULTS = { host: "127.0.0.1", port: 8080, gpuLayers: 999, parallel: 4, jinja: true, metrics: true };

const MAX_TEXT_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PDF_BYTES = 32 * 1024 * 1024;
/** Extracted PDF text can be much longer than a pasted file; cap generously. */
const MAX_PDF_TEXT_CHARS = 450_000;

const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|csv|tsv|ya?ml|toml|ini|log|xml|html?|css|js|jsx|ts|tsx|py|rb|go|rs|java|c|h|cpp|hpp|cs|php|sh|bash|zsh|sql|r|swift|kt|scala|pl|lua|vue|svelte|env|conf|cfg)$/i;
const PDF_MIME = "application/pdf";

function newId(): string {
  return `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Read a File into an Attachment, or throw with a human reason. */
async function readAttachment(file: File): Promise<Attachment> {
  const isPdf = file.type === PDF_MIME || /\.pdf$/i.test(file.name);
  const isImage = file.type.startsWith("image/");
  const isText = file.type.startsWith("text/") || TEXT_EXT.test(file.name) || file.type === "application/json";

  if (isPdf) {
    if (file.size > MAX_PDF_BYTES) throw new Error(`${file.name} is larger than ${bytes(MAX_PDF_BYTES)}`);
    // A PDF is text wrapped in a binary — the server unwraps it with pdf.js.
    const r = await api.extractPdf(file);
    let text = r.text;
    let note = "";
    if (r.scanned) note = "scanned PDF — no text layer found";
    else if (r.truncated) note = `extracted text truncated to ${bytes(MAX_PDF_TEXT_CHARS)}`;
    if (text.length > MAX_PDF_TEXT_CHARS) {
      text = `${text.slice(0, MAX_PDF_TEXT_CHARS)}\n… (truncated)`;
      note = note || `extracted text truncated to ${bytes(MAX_PDF_TEXT_CHARS)}`;
    }
    if (note) text = `[${note}]\n${text}`;
    return { id: newId(), name: file.name, kind: "text", mime: PDF_MIME, size: file.size, text };
  }

  if (isImage) {
    if (file.size > MAX_IMAGE_BYTES) throw new Error(`${file.name} is larger than ${bytes(MAX_IMAGE_BYTES)}`);
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error(`could not read ${file.name}`));
      r.readAsDataURL(file);
    });
    return { id: newId(), name: file.name, kind: "image", mime: file.type, size: file.size, dataUrl };
  }

  if (!isText) throw new Error(`${file.name}: only text, PDF and image files can be attached`);
  if (file.size > MAX_TEXT_BYTES) throw new Error(`${file.name} is larger than ${bytes(MAX_TEXT_BYTES)}`);

  const text = await file.text();
  return { id: newId(), name: file.name, kind: "text", mime: file.type || "text/plain", size: file.size, text };
}

function fenceLang(name: string): string {
  const ext = name.split(".").pop() ?? "";
  const map: Record<string, string> = { ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", py: "python", rb: "ruby", rs: "rust", md: "markdown", yml: "yaml", sh: "bash", zsh: "bash" };
  return map[ext] ?? ext;
}

/**
 * The attachment text a message contributes to the request, kept identical to
 * `runStore`'s inlining so the measured size matches what is really sent.
 */
function attachmentText(m: Message): string {
  const out: string[] = [];
  for (const a of m.attachments ?? []) {
    if (a.kind === "text" && a.text !== undefined) {
      out.push(`\n\n--- ${a.name} ---\n\`\`\`${fenceLang(a.name)}\n${a.text}\n\`\`\``);
    } else if (a.kind === "image") {
      // images cost tokens too; a rough stand-in keeps the estimate honest
      out.push(`\n\n[image attached: ${a.name} (${a.mime}, ${bytes(a.size)})]`);
    }
  }
  return out.join("");
}

export function ChatView({ system, bus, onNavigate }: { system: SystemResponse | null; bus: EventBus; onNavigate: (v: ViewId) => void }) {
  const toast = useToast();
  const [models, setModels] = useState<LocalModel[]>([]);
  const [procs, setProcs] = useState<ManagedProcess[]>([]);
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:8080");
  const [apiKey, setApiKey] = useState("");

  /**
   * Provider choice, chat-page only. "llamacpp" is the default and unchanged
   * behaviour; "ollama" points the chat at the user's already-running daemon.
   * The rest of the app never reads this — it always speaks to Osama's
   * llama.cpp processes.
   */
  const [provider, setProvider] = useState<ChatProvider>(() => loadProvider());
  const [ollamaUrl, setOllamaUrl] = useState<string>(() => loadOllamaUrl());
  const [ollamaModel, setOllamaModel] = useState<string>(() => loadOllamaModel());
  const [ollama, setOllama] = useState<OllamaStatus | null>(null);
  const [ollamaChecking, setOllamaChecking] = useState(false);
  /** MLX: Apple's runtime, and the models it can serve (docs/mlx-macos.md). */
  const [mlx, setMlx] = useState<MlxStatus | null>(null);
  const [mlxModels, setMlxModels] = useState<MlxModel[]>([]);
  const [mlxServing, setMlxServing] = useState(false);

  /**
   * Connected MCP servers, so the composer can show that external tools are in
   * play. Read-only here — the MCP view and sidebar panel own the management.
   */
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([]);
  const [mcpOpen, setMcpOpen] = useState(false);

  /**
   * THE RUN LIVES IN THE STORE, NOT IN THIS COMPONENT.
   *
   * Everything a turn produces — the transcript, the streaming text, the step
   * count, the parked approval, the todo list — is read from `runStore`, which
   * is a module singleton. Switching pages unmounts this view; the store keeps
   * the turn. That is the whole point: a run is a user-level activity, and it
   * must not die because the user looked at another page.
   *
   * `messages` is the store's transcript, and `run` carries the live status.
   */
  const run = useChat();
  const messages = run.messages;
  const streaming = run.status.running;
  const agentStepCount = run.status.steps;
  const approval = run.approval;
  const question = run.question;
  const todos = run.todos;
  const lastCompaction = run.lastCompaction;
  const promptInfo = run.prompt;

  const [input, setInput] = useState("");
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM);
  const [temperature, setTemperature] = useState(0.7);
  const [topP, setTopP] = useState(0.95);
  const [maxTokens, setMaxTokens] = useState<number | "">(-1);
  const [dragging, setDragging] = useState(false);
  const [vision, setVision] = useState<boolean | null>(null);
  const [switching, setSwitching] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  /**
   * How this conversation answers: plain chat, or agentic (the model may call
   * tools). Chat is the default for a fresh conversation — agentic work needs a
   * chosen workspace and readable files, so it is opted into per conversation
   * rather than inherited. The choice is still persisted, so a reload lands in
   * the mode the conversation was actually using.
   */
  const [agentic, setAgentic] = useState(false);
  const [agentTools, setAgentTools] = useState<AgentTool[]>([]);
  const [approvalMode, setApprovalMode] = useState<"ask" | "auto">("ask");
  const [toolSupport, setToolSupport] = useState<"full" | "none" | "unknown">("unknown");
  /** The current conversation's identity + the saved history list. */
  const [chatId, setChatId] = useState(() => newChatId());
  const [history, setHistory] = useState<StoredChat[]>(() => loadHistory());
  /** Where the left sidebar should scroll to when a header control is clicked. */
  const [focus, setFocus] = useState<FocusSignal | null>(null);
  const focusPanel = useCallback((panel: string) => {
    setFocus((f) => ({ panel, n: (f?.n ?? 0) + 1 }));
  }, []);
  /** The left sidebar's portal target — where the chat insights mount. */
  const [insightSlot, setInsightSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setInsightSlot(document.getElementById("sidebar-insights-slot"));
  }, []);
  const [workspace, setWorkspace] = useState<{ path: string; chosen: boolean }>({ path: "", chosen: false });
  /** Brief flag used to play a gentle transition when the served model changes. */
  const [modelChanged, setModelChanged] = useState(false);
  const modelAnim = useRef<number | undefined>(undefined);
  /** Compaction state — drives the sidebar's "compact now" and its result note. */
  const [compacting, setCompacting] = useState(false);
  /** Inline context readout under the composer (polled from the same meter). */
  const [inlineCtx, setInlineCtx] = useState<ContextBreakdown | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /** Focus with the caret at the end — used after send, so typing just continues. */
  const focusInput = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    const end = el.value.length;
    try {
      el.setSelectionRange(end, end);
    } catch {
      /* not focusable yet */
    }
  }, []);

  const load = async () => {
    try {
      const r = await api.processes();
      setProcs(r.processes);
      const s = r.processes.find((p) => isModelServer(p) && p.status === "running");
      if (s?.url) setBaseUrl(s.url);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    api.models().then((r) => setModels(r.models)).catch(() => {});
    void loadMlx();
    load();
    focusInput();
    // Restore the conversation that was on screen before the refresh, so a
    // reload lands exactly where the user left.
    const saved = loadActive();
    if (saved) {
      if (Array.isArray(saved.messages) && saved.messages.length && !messages.length) setMessages(saved.messages as Message[]);
      if (typeof saved.agentic === "boolean") setAgentic(saved.agentic);
      if (saved.approvalMode === "ask" || saved.approvalMode === "auto") setApprovalMode(saved.approvalMode);
      if (typeof saved.systemPrompt === "string") setSystemPrompt(saved.systemPrompt);
      if (typeof saved.temperature === "number") setTemperature(saved.temperature);
      if (typeof saved.topP === "number") setTopP(saved.topP);
      if (typeof saved.maxTokens === "number" || saved.maxTokens === "") setMaxTokens(saved.maxTokens);
      if (saved.interrupted) setInterrupted({ runId: saved.interrupted.runId, at: saved.interrupted.at });
    }

    /**
     * Reattach to a run this page is not currently watching.
     *
     * This is what makes the status survive a page switch. The store is a
     * singleton, so on a page switch `run.status.runId` is already set and we are
     * simply the new mount for a live run — we re-subscribe and the turn replays.
     *
     * A RELOAD is different: the store is cold, so there is nothing local to
     * resume. We ask the server whether a run is alive and adopt it if so, which
     * is the honest best effort — an SSE stream cannot be resumed from a dead
     * process, so the server replays its buffer instead of us pretending we
     * still have the original socket.
     */
    const own = getChatState().status.runId;
    if (own && getChatState().status.running) {
      void attachToRun(own);
    } else {
      void findLiveRun().then((live) => {
        if (live) {
          toast.push("info", "A run is still going — reattaching.");
          void attachToRun(live.runId);
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the active conversation on every meaningful change. Cheap: a JSON
  // write of a transcript that is already in memory, debounced by React's
  // render cadence during streaming (tokens coalesce into renders).
  useEffect(() => {
    // The `interrupted` mark is written while a run is live and cleared when it
    // ends, so a reload can tell "this was mid-turn" from "this finished".
    saveActive({
      messages,
      agentic,
      approvalMode,
      systemPrompt,
      temperature,
      topP,
      maxTokens,
      interrupted: run.status.running && run.status.runId ? { runId: run.status.runId, at: Date.now(), note: "interrupted by a reload" } : null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, agentic, approvalMode, systemPrompt, temperature, topP, maxTokens, run.status.running, run.status.runId]);

  useEffect(() => {
    if (!agentic || agentTools.length) return;
    agentApi.tools().then((r) => setAgentTools(r.tools)).catch(() => {});
  }, [agentic, agentTools.length]);

  /**
   * The workspace belongs to Agent mode. In plain chat there is no directory to
   * be grounded in, so nothing is fetched at all — no picker, no grounding chip,
   * no polling. Agent mode keeps the snapshot because its tools resolve paths
   * against it.
   */
  const [wsSnapshot, setWsSnapshot] = useState<{ path: string; snapshot: string } | null>(null);
  useEffect(() => {
    if (!agentic) {
      setWsSnapshot(null);
      return;
    }
    agentApi
      .workspaces()
      .then((w) => setWorkspace({ path: w.current, chosen: w.chosen }))
      .catch(() => {});
    agentApi
      .workspaceSnapshot(600)
      .then((s) => setWsSnapshot({ path: s.path, snapshot: s.snapshot }))
      .catch(() => {});
    // Refresh the snapshot when the workspace changes (the sidebar modal does
    // the switching — the event bus carries it, or we poll on a timer).
    const t = setInterval(() => {
      agentApi.workspaceSnapshot(600)
        .then((s) => setWsSnapshot((prev) => (prev?.path === s.path ? { path: s.path, snapshot: s.snapshot } : prev)))
        .catch(() => {});
    }, 10000);
    return () => clearInterval(t);
  }, [agentic]);

  // Also refresh the workspace + snapshot right after the sidebar changes it.
  useEffect(() => {
    if (!agentic) return;
    const onWs = () => {
      agentApi.workspaces().then((w) => setWorkspace({ path: w.current, chosen: w.chosen })).catch(() => {});
      agentApi.workspaceSnapshot(600).then((s) => setWsSnapshot({ path: s.path, snapshot: s.snapshot })).catch(() => {});
    };
    window.addEventListener("osama:workspace-changed", onWs);
    return () => window.removeEventListener("osama:workspace-changed", onWs);
  }, [agentic]);

  /**
   * MLX: whether this machine can run it, which runtime Osama will use, and the
   * model directories on disk. Loaded whatever the current provider is, because
   * the switch has to know whether to offer MLX at all.
   */
  const loadMlx = useCallback(async () => {
    try {
      const [status, list] = await Promise.all([mlxApi.status(), mlxApi.models()]);
      setMlx(status);
      setMlxModels(list.models);
    } catch {
      setMlx(null);
    }
  }, []);

  // Ollama discovery: poll the daemon while the chat uses it, so a daemon that
  // starts or stops is reflected without a reload. The poll only runs for the
  // ollama provider, so the llama.cpp path is untouched.
  const loadOllama = useCallback(async (showSpinner = false) => {
    if (showSpinner) setOllamaChecking(true);
    try {
      const s = await api.ollamaStatus(ollamaUrl);
      setOllama(s);
      // If the chosen model vanished, fall back to the newest available one.
      setOllamaModel((cur) => {
        if (s.models.length && !s.models.some((m) => m.name === cur)) {
          const next = s.models[0]!.name;
          saveOllamaModel(next);
          return next;
        }
        return cur;
      });
    } catch (e) {
      // Distinguish "the Osama engine has no /api/ollama route" (a stale engine
      // built before this feature) from "the Ollama daemon itself is down".
      // Conflating them sent users to `ollama serve` when the real fix was to
      // restart Osama, so the message names the actual cause.
      const msg = (e as Error).message;
      const staleEngine = /no route for .*\/api\/ollama/i.test(msg);
      setOllama({
        reachable: false,
        url: ollamaUrl,
        models: [],
        hasModels: false,
        error: staleEngine
          ? "The running Osama engine predates the Ollama feature. Restart Osama (npm start) to load the new routes."
          : msg,
      });
    } finally {
      setOllamaChecking(false);
    }
  }, [ollamaUrl]);

  useEffect(() => {
    if (provider !== "ollama") return;
    void loadOllama();
    const t = setInterval(() => void loadOllama(), 8000);
    return () => clearInterval(t);
  }, [provider, loadOllama]);

  // MCP: keep the composer's indicator current. Polled only in Agent mode,
  // because MCP tools only reach the model there — in plain chat the indicator
  // is not rendered, so the request would exist purely to feed nothing.
  useEffect(() => {
    if (!agentic) return;
    const pull = () => agentApi.mcpServers().then((r) => setMcpServers(r.servers)).catch(() => {});
    pull();
    const t = setInterval(pull, 8000);
    window.addEventListener("osama:mcp-changed", pull);
    return () => { clearInterval(t); window.removeEventListener("osama:mcp-changed", pull); };
  }, [agentic]);

  // A server process appears instantly but the model may still be loading, so
  // readiness comes from its own /health and the poll keeps running until then.
  // For the Ollama provider there is no managed process: readiness is simply
  // "the daemon answered and a model is selected".
  // Two engines can be started by Osama, and only one runs at a time (serving is
  // exclusive), but the *provider* decides which one this view is talking to —
  // and therefore which URL is probed and sent the request.
  const mlxProcess = procs.find((p) => isMlxServer(p) && p.status === "running");
  const llamaProcess = procs.find((p) => isModelServer(p) && !isMlxServer(p) && p.status === "running");
  const providerUrl =
    provider === "ollama" ? ollamaUrl : provider === "mlx" ? mlxProcess?.url ?? "" : llamaProcess?.url ?? baseUrl;
  const healthReady = useServerReady(providerUrl || undefined);
  const serverProcess = provider === "mlx" ? mlxProcess : llamaProcess;
  const ollamaReady = !!ollama?.reachable && !!ollamaModel;
  const loading = provider !== "ollama" && !!serverProcess && !healthReady;
  // The provider's effective endpoint — what every request must be sent to.
  const effectiveBaseUrl = providerUrl;
  const failure = useLoadFailure(procs);
  const [dismissedFailure, setDismissedFailure] = useState<number | null>(null);
  /**
   * A turn that a reload cut off. Not a live run — an SSE stream cannot be
   * resumed from a dead process — so the honest thing is to say so and offer to
   * retry, rather than show a half-finished reply as if it were complete.
   */
  const [interrupted, setInterrupted] = useState<{ runId: string; at: number } | null>(null);
  const showFailure = failure && !loading && !streaming && dismissedFailure !== failure.since;

  useEffect(() => {
    if (!loading) return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  /**
   * "Ready to chat" and "a server is up", unified across providers so the rest
   * of the view never branches on the provider:
   *  - llamacpp: ready when the managed server answers /health
   *  - ollama:   ready when the daemon is reachable and a model is chosen
   */
  const runningServer = provider === "ollama" ? (ollamaReady ? true : undefined) : (healthReady ? serverProcess : undefined);
  const startingServer = provider === "ollama" ? (ollamaChecking && !ollama ? true : undefined) : (loading ? serverProcess : undefined);
  const busy = streaming || (provider === "llamacpp" && loading);

  // Which model is in play, and whether it can take images — read from the
  // provider itself, not from what we asked for.
  const servedFile = serverProcess ? serverProcess.argv[serverProcess.argv.findIndex((a) => a === "-m" || a === "--model") + 1] : undefined;
  const serving = useMemo(() => (servedFile ? models.find((m) => m.file === servedFile) ?? null : null), [servedFile, models]);
  const servable = useMemo(() => models.filter((m) => !m.draftOnly && !m.missing), [models]);

  const ollamaServing = useMemo(
    () => ollama?.models.find((m) => m.name === ollamaModel) ?? null,
    [ollama, ollamaModel],
  );

  // Vision: llama.cpp reports modalities via /props; Ollama via /api/show.
  useEffect(() => {
    if (provider === "ollama") {
      if (!ollamaModel) { setVision(null); return; }
      let cancelled = false;
      api.ollamaShow(ollamaModel, ollamaUrl)
        .then((r) => { if (!cancelled) setVision(r.capabilities ? r.capabilities.includes("vision") : null); })
        .catch(() => { if (!cancelled) setVision(null); });
      return () => { cancelled = true; };
    }
    if (!healthReady || !serverProcess) {
      setVision(null);
      return;
    }
    let cancelled = false;
    api
      .serverProps(baseUrl)
      .then((r) => !cancelled && setVision(!!r.props?.modalities?.vision))
      .catch(() => !cancelled && setVision(null));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, healthReady, serverProcess?.id, baseUrl, ollamaModel, ollamaUrl]);

  // Persist the provider choice and its settings so a reload lands where the
  // user left. Scoped keys; nothing outside the chat reads them.
  useEffect(() => { saveProvider(provider); }, [provider]);
  useEffect(() => { saveOllamaUrl(ollamaUrl); }, [ollamaUrl]);
  useEffect(() => { if (ollamaModel) saveOllamaModel(ollamaModel); }, [ollamaModel]);

  /** Switch provider. A switch never kills a running turn; it only changes
   *  which endpoint the *next* turn is sent to. */
  function switchProvider(next: ChatProvider) {
    if (next === provider) return;
    setProvider(next);
    if (next === "ollama") {
      void loadOllama(true);
      toast.push("info", "Ollama provider — using your local daemon.");
    } else if (next === "mlx") {
      void loadMlx();
      toast.push("info", "MLX provider — Apple's runtime, served from Osama's own environment.");
    } else {
      toast.push("info", "llama.cpp provider — using Osama's own server.");
    }
    focusInput();
  }

  /**
   * Serve an MLX model and chat with it.
   *
   * Same rules as the Library's tile — one server at a time, and the route picks
   * a free port when the default is taken — but from where the user is looking.
   */
  async function serveMlx(m: MlxModel) {
    setMlxServing(true);
    try {
      const r = await mlxApi.serve({ model: m.dir, host: "127.0.0.1", port: SERVER_DEFAULTS.port });
      const url = r.process.url;
      toast.push("info", `${r.stopped?.length ? "Replaced the running server · " : ""}Loading ${m.name} with MLX…`);
      if (url) await api.waitForServer(url, 180_000);
      await load();
      focusInput();
    } catch (e) {
      toast.push("err", `Could not start MLX: ${(e as Error).message}`);
    } finally {
      setMlxServing(false);
    }
  }

  /** Archive the current conversation into history and start a blank one. */
  function newChat() {
    if (messages.length > 0) {
      const archived: StoredChat = { id: chatId, title: chatTitle(messages), at: Date.now(), messages };
      const next = [archived, ...history.filter((c) => c.id !== chatId)].slice(0, 40);
      setHistory(next);
      saveHistory(next);
    }
    setChatId(newChatId());
    // A new conversation opens in the default mode: plain chat. Agent mode is
    // opted into per conversation, so it must not leak in from the last one.
    setAgentic(false);
    // The store clears the transcript, the parked prompts and the run status in
    // one step; the session id is what a reload will restore.
    resetSession();
    adoptSessionId(currentSessionId());
    setTodoSupportReset();
    clearActive();
    focusInput();
  }

  /** Reopen a conversation from history. */
  function openChat(id: string) {
    // If the user is leaving a conversation with content, keep it too.
    if (messages.length > 0 && id !== chatId) {
      const archived: StoredChat = { id: chatId, title: chatTitle(messages), at: Date.now(), messages };
      const next = [archived, ...history.filter((c) => c.id !== chatId && c.id !== id)];
      setHistory(next);
      saveHistory(next);
    }
    const c = history.find((x) => x.id === id);
    if (!c) return;
    setChatId(c.id);
    setMessages(c.messages as Message[]);
  }

  /** Delete a conversation from history (and clear the active one if it is). */
  function deleteChat(id: string) {
    const next = history.filter((c) => c.id !== id);
    setHistory(next);
    saveHistory(next);
    if (id === chatId) {
      setChatId(newChatId());
      setMessages([]);
      clearActive();
    }
  }

  /** Clear the run's task list via the store and reset tool-support detection. */
  function setTodoSupportReset() {
    clearTodos();
    setToolSupport("unknown");
  }

  async function switchModel(file: string) {
    if (provider === "ollama") return; // Ollama models are chosen by name, not file
    if (!file || file === servedFile) return;
    setSwitching(true);
    // Acknowledge the pick at once: the animation is short and the load can be
    // slow, so the two must not be coupled.
    setModelChanged(true);
    window.clearTimeout(modelAnim.current);
    modelAnim.current = window.setTimeout(() => setModelChanged(false), 900);
    try {
      const r = await api.startProcess({
        tool: "server",
        exclusive: true,
        values: { model: file, host: SERVER_DEFAULTS.host, port: SERVER_DEFAULTS.port, gpuLayers: SERVER_DEFAULTS.gpuLayers, parallel: SERVER_DEFAULTS.parallel, jinja: SERVER_DEFAULTS.jinja, metrics: SERVER_DEFAULTS.metrics },
      });
      const replaced = (r.stopped?.length ?? 0) > 0;
      const url = r.process.url ?? baseUrl;
      toast.push("info", `${replaced ? "Replaced the running server · " : ""}Loading ${file.split("/").pop()}…`);
      const ok = await api.waitForServer(url);
      load();
      toast.push(ok ? "ok" : "warn", ok ? `Ready on ${url}` : `Still loading — give it a moment.`);
    } catch (e) {
      toast.push("err", `Could not switch model: ${(e as Error).message}`);
    } finally {
      setSwitching(false);
      focusInput();
    }
  }

  // ---- @-mention: reference a file inside the workspace -------------------
  // Typing `@` at a word boundary opens a picker of the workspace's files.
  // Choosing one inlines the file as a text attachment (same path as the
  // paperclip), so it reaches the model exactly like an ordinary attachment.
  // ---- active skills: switch skills on for this conversation -----------------
  // Several may be active at once; each is injected into the system prompt by
  // the server, so the model is already following them without a load_skill hop.
  // ---- identity: which voice the agent speaks with this session ------------
  // The soul lives on the server; this is only the session's chosen overlay, so
  // it survives a reload the same way the active skills do.
  const [personality, setPersonality] = useState<string>(loadPersonality());

  // Persist the personality overlay the way the active skills are persisted.
  useEffect(() => {
    savePersonality(personality);
  }, [personality]);

  const [editing, setEditing] = useState<{ index: number; text: string } | null>(null);
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [activeSkills, setActiveSkills] = useState<string[]>(loadActiveSkills());
  const [skillPick, setSkillPick] = useState(false);
  const [skillQuery, setSkillQuery] = useState("");
  const skillLoaded = useRef(false);

  async function loadSkills() {
    if (skillLoaded.current) return;
    skillLoaded.current = true;
    try { setSkills((await agentApi.skills()).skills); } catch { /* catalog unreadable */ }
  }
  function toggleSkill(id: string) {
    setActiveSkills((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      saveActiveSkills(next);
      return next;
    });
  }
  const skillMatches = skillQuery.trim()
    ? skills.filter((s) =>
        `${s.id} ${s.name} ${s.description} ${(s.tags ?? []).join(" ")}`
          .toLowerCase().includes(skillQuery.trim().toLowerCase()))
    : skills;

  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [wsFiles, setWsFiles] = useState<WorkspaceFile[]>([]);
  const mentionLoading = useRef(false);

  async function loadWsFiles() {
    if (mentionLoading.current || wsFiles.length) return;
    // Workspace files exist for Agent mode's `@` picker only; plain chat never
    // asks the server what is on disk.
    if (!agentic) return;
    mentionLoading.current = true;
    try {
      setWsFiles((await agentApi.workspaceFiles()).files);
    } catch {
      /* workspace unreadable — the picker simply stays empty */
    } finally {
      mentionLoading.current = false;
    }
  }

  /** The `@word` the caret currently sits inside, if any. */
  function detectMention(el: HTMLTextAreaElement): { query: string; start: number } | null {
    const upto = el.value.slice(0, el.selectionStart);
    const at = upto.lastIndexOf("@");
    if (at < 0) return null;
    // `@` must start a word (start of text or preceded by whitespace)
    if (at > 0 && !/\s/.test(upto[at - 1]!)) return null;
    const query = upto.slice(at + 1);
    if (/\s/.test(query)) return null; // a space ends the token
    return { query, start: at };
  }

  const mentionMatches = mention
    ? wsFiles
        .filter((f) => f.rel.toLowerCase().includes(mention.query.toLowerCase()))
        .sort((a, b) => {
          // name-prefix matches first, then shallow paths, then alphabetical
          const ap = a.name.toLowerCase().startsWith(mention.query.toLowerCase()) ? 0 : 1;
          const bp = b.name.toLowerCase().startsWith(mention.query.toLowerCase()) ? 0 : 1;
          if (ap !== bp) return ap - bp;
          return a.rel.localeCompare(b.rel);
        })
        .slice(0, 8)
    : [];

  async function pickMention(f: WorkspaceFile) {
    if (!mention) return;
    const el = inputRef.current;
    const caret = el?.selectionStart ?? input.length;
    const before = input.slice(0, mention.start);
    const after = input.slice(caret);
    // directories keep the `@` open so the user can drill in
    if (f.dir) {
      const next = `${before}@${f.rel}`;
      setInput(next + after);
      setMention({ query: f.rel, start: mention.start });
      requestAnimationFrame(() => {
        if (el) { el.selectionStart = el.selectionEnd = next.length; el.focus(); }
      });
      return;
    }
    // a file: inline it as an attachment and drop the raw @token
    const next = (before + after).replace(/\s{2,}/g, " ").trimEnd();
    setInput(next);
    setMention(null);
    try {
      const r = await agentApi.workspaceFile(f.rel);
      const att: Attachment = {
        id: `ws:${f.rel}:${Date.now()}`,
        name: r.name,
        kind: "text",
        mime: r.mime,
        size: r.size,
        text: r.text,
      };
      setAttachments((a) => (a.some((x) => x.name === r.name) ? a : [...a, att]));
      // Surface truncation / extraction notes so the user knows what the
      // model actually received (a 4 MB PDF becomes a few hundred KB of text).
      if (r.mime === "application/pdf") {
        toast.push("ok", `Attached ${r.name} — PDF text extracted from the workspace.`);
      } else if (r.truncated && r.note) {
        toast.push("warn", `Attached ${r.name} — ${r.note}.`);
      } else {
        toast.push("ok", `Attached ${r.name} from the workspace.`);
      }
    } catch (e) {
      toast.push("err", (e as Error).message);
    }
    requestAnimationFrame(() => {
      if (el) { el.selectionStart = el.selectionEnd = next.length; el.focus(); }
    });
  }

  // ---- #-mention: activate a skill inline --------------------------------
  // Typing `#` at a word boundary opens a picker of installed skills.
  // Choosing one toggles it as an active skill for this conversation (the
  // same list the sparkles button manages), so the model follows it without
  // a load_skill hop. The #token is replaced with the skill name as text so
  // the user sees what was applied.
  const [skillMention, setSkillMention] = useState<{ query: string; start: number } | null>(null);
  const [skillMentionIdx, setSkillMentionIdx] = useState(0);

  /** The `#word` the caret currently sits inside, if any. */
  function detectSkillMention(el: HTMLTextAreaElement): { query: string; start: number } | null {
    const upto = el.value.slice(0, el.selectionStart);
    const hash = upto.lastIndexOf("#");
    if (hash < 0) return null;
    // `#` must start a word (start of text or preceded by whitespace)
    if (hash > 0 && !/\s/.test(upto[hash - 1]!)) return null;
    const query = upto.slice(hash + 1);
    if (/\s/.test(query)) return null; // a space ends the token
    // Don't trigger inside a URL fragment or a markdown heading at line start
    // followed by more text on the same logical word — keep it simple: any
    // `#word` at a word boundary is a skill mention.
    return { query, start: hash };
  }

  const skillMentionMatches = skillMention
    ? skills
        .filter((s) =>
          `${s.id} ${s.name} ${s.description} ${(s.tags ?? []).join(" ")}`
            .toLowerCase().includes(skillMention.query.toLowerCase()),
        )
        .slice(0, 8)
    : [];

  async function pickSkillMention(s: SkillMeta) {
    if (!skillMention) return;
    const el = inputRef.current;
    const caret = el?.selectionStart ?? input.length;
    const before = input.slice(0, skillMention.start);
    const after = input.slice(caret);
    // Replace the #token with a readable reference and activate the skill.
    const label = s.name || s.id;
    const next = `${before}[skill: ${label}]${after}`.replace(/\s{2,}/g, " ");
    setInput(next);
    setSkillMention(null);
    toggleSkill(s.id);
    toast.push("ok", `Activated skill “${label}” for this conversation.`);
    void loadSkills(); // make sure catalog is fresh for chips
    requestAnimationFrame(() => {
      if (el) { el.selectionStart = el.selectionEnd = next.length; el.focus(); }
    });
  }

  async function attach(files: FileList | File[] | null) {
    if (!files) return;
    const list = Array.from(files);
    const accepted: Attachment[] = [];
    for (const f of list) {
      try {
        accepted.push(await readAttachment(f));
      } catch (e) {
        toast.push("err", (e as Error).message);
      }
    }
    if (accepted.length) {
      setAttachments((a) => [...a, ...accepted]);
      const imgs = accepted.filter((a) => a.kind === "image").length;
      if (imgs > 0 && vision === false) {
        toast.push("warn", "The running model has no vision encoder — images are attached but the server will ignore them.");
      }
    }
    focusInput();
  }

  /**
   * Run one turn and stream it into the transcript.
   *
   * Every send-shaped action funnels through here — the initial send, a
   * regenerate, a continue — so they share one code path (and one abort
   * controller). `base` is the conversation up to but NOT including the reply
   * being produced; `seed` pre-fills the assistant bubble (a continue starts
   * from the text already shown); `placeholder` inserts a user message the
   * model should answer with no new input from the box.
   */
  /**
   * Run one turn.
   *
   * The actual streaming now happens in `runStore`, which is a module singleton.
   * This function's only job is to hand the store what it needs and return — it
   * deliberately does NOT await the answer, because the answer outlives this
   * component. That is what makes a page switch harmless.
   *
   * `base` is the conversation up to but NOT including the reply being produced;
   * `seed` pre-fills the assistant bubble (a "continue" starts from shown text);
   * `placeholder` inserts a user message the model answers with no new input.
   */
  function runTurn(opts: { base: Message[]; seed?: string; placeholder?: Message; label?: string }) {
    if (busy) return;
    const { base, seed = "", placeholder } = opts;
    const history = placeholder ? [...base, placeholder] : base;

    // The store keys the run by a client-owned id so a remount can reattach.
    const runId = newRunId();
    adoptSessionId(currentSessionId());

    startRun({
      runId,
      baseUrl: effectiveBaseUrl,
      apiKey: apiKey || undefined,
      agentic,
      system: systemPrompt.trim() || undefined,
      personality,
      activeSkills,
      approval: approvalMode,
      temperature,
      top_p: topP,
      ...(maxTokens === "" ? {} : { max_tokens: maxTokens as number }),
      history: history.map((m) => ({ role: m.role, content: m.content, attachments: m.attachments, steps: m.steps, stepCount: m.stepCount })),
      seed,
      workspace: wsSnapshot,
      // Whether the served model takes images — decides if an image attachment
      // is sent as a real content part or degrades to a filename.
      vision,
      // Ollama needs the real model name; llama.cpp ignores it.
      model: provider === "ollama" ? ollamaModel : "local",
    });
  }

  /** Send what is in the composer. */
  async function send() {
    const text = input.trim();
    if ((!text && attachments.length === 0) || busy) return;
    const userMsg: Message = {
      role: "user",
      content: text,
      attachments: attachments.length ? attachments : undefined,
    };
    setInput("");
    setAttachments([]);
    focusInput();
    await runTurn({ base: [...messages, userMsg] });
  }

  /**
   * Regenerate a reply: drop it (and anything after it) and ask again from the
   * user turn that prompted it. Open WebUI's per-message regenerate, applied
   * anywhere in the transcript.
   */
  async function regenerate(index: number) {
    if (busy) return;
    const target = messages[index];
    if (!target || target.role !== "assistant") return;
    await runTurn({ base: messages.slice(0, index) });
  }

  /**
   * Continue a truncated reply: keep what is shown and ask the model to carry
   * on from exactly there. The seed is what makes it a continuation rather
   * than a fresh answer, and an invisible nudge keeps the model writing.
   */
  async function continueReply(index: number) {
    if (busy) return;
    const target = messages[index];
    if (!target || target.role !== "assistant") return;
    const base = messages.slice(0, index);
    await runTurn({
      base,
      seed: target.content,
      placeholder: { role: "user", content: "Continue exactly where you left off, without repeating anything." },
    });
  }

  /** Edit a user turn and resend from that point, discarding later replies. */
  async function submitEdit(index: number, text: string) {
    if (busy) return;
    const m = messages[index];
    if (!m || m.role !== "user") return;
    setEditing(null);
    await runTurn({
      base: [...messages.slice(0, index), { ...m, content: text }],
    });
  }

  /** Delete one message from the transcript. */
  function deleteMessage(index: number) {
    setMessages(messages.filter((_, i) => i !== index));
    toast.push("ok", "Message removed.");
  }

  /**
   * Fork: branch this conversation into a new one so the current thread is kept
   * untouched. `at` (when given) copies only the messages up to that point,
   * like Open WebUI forking from a message rather than from the end.
   */
  function forkChat(at?: number) {
    const source = at === undefined ? messages : messages.slice(0, at + 1);
    if (!source.length) return;
    const forked: Message[] = source.map((m) => ({ ...m }));
    // Keep BOTH conversations: the original is archived under its own title so
    // nothing is lost, and the fork becomes the live thread (Open WebUI's
    // behaviour — forking branches, it does not move).
    const archived: StoredChat = { id: chatId, title: chatTitle(messages), at: Date.now(), messages: messages as never };
    const forkedChat: StoredChat = {
      id: newChatId(),
      title: `${chatTitle(source)} (fork)`,
      at: Date.now() + 1,
      messages: forked as never,
    };
    const next = [forkedChat, archived, ...history.filter((c) => c.id !== chatId)].slice(0, 40);
    setHistory(next);
    saveHistory(next);
    setMessages(forked);
    setChatId(forkedChat.id);
    setEditing(null);
    focusInput();
    toast.push("ok", at === undefined ? "Forked this chat — both branches are in history." : `Forked from message ${at + 1}.`);
  }

  /** Copy arbitrary text, with a toast — the shared action behind every copy. */
  function copyText(text: string, what = "Copied.") {
    navigator.clipboard.writeText(text)
      .then(() => toast.push("ok", what))
      .catch(() => toast.push("err", "Could not copy to the clipboard."));
  }

  /** Answer a parked approval; the server-side loop resumes from it. */
  async function onAnswerApproval(allow: boolean) {
    const a = approval;
    if (!a) return;
    const r = await answerApproval(a.id, allow);
    // The prompt had already expired server-side — say so instead of leaving the
    // click looking like it did nothing.
    if (!r.ok) toast.push("warn", r.reason);
  }

  /**
   * "Allow all for this session": approve this command AND stop asking for the
   * rest of the conversation. Two effects, both needed:
   *  - the server flips the running turn to auto-approve, so the rest of THIS
   *    turn's commands run without parking;
   *  - the composer's approval mode switches to 'auto' and persists, so every
   *    FUTURE turn in this session also starts without asking.
   */
  async function onAllowAllApproval() {
    const a = approval;
    if (!a) return;
    const r = await answerApproval(a.id, true, true);
    if (!r.ok) {
      toast.push("warn", r.reason);
      return;
    }
    setApprovalMode("auto");
    toast.push("warn", "Auto-approve on for this session — commands will run without asking.");
  }

  /** Answer a parked question; the loop resumes from it. */
  async function onAnswerQuestion(text: string) {
    const q = question;
    if (!q) return;
    const r = await answerQuestion(q.id, text);
    if (!r.ok) toast.push("warn", r.reason);
  }

  function autoGrow(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }

  const totalAttached = attachments.reduce((s, a) => s + a.size, 0);
  // What the next request will actually contain — the same shape the agent
  // sends, so the panel's percentage is the real one rather than the schemas'
  // share of an empty conversation.
  const contextMessages = useMemo(
    () =>
      messages
        .filter((m) => m.role !== "assistant" || m.content.trim())
        .map((m) => ({
          role: m.role as string,
          content: (m.content ? `${m.content}${attachmentText(m)}` : attachmentText(m)) || null,
        })),
    [messages, vision],
  );
  /** The same transcript in the payload shape the compact endpoint expects. */
  const compactMessages = contextMessages as never as AgentMessagePayload[];

  // The context meter must measure what the next request will actually contain.
  // Plain chat sends no tool schemas, so counting them would overstate the
  // window; only Agent mode includes them.
  const ctxShape = `${messages.length}:${messages.reduce((n, m) => n + (m.content?.length ?? 0), 0)}`;
  useEffect(() => {
    let alive = true;
    const ctxModel = provider === "ollama" ? ollamaModel : undefined;
    const pull = () => agentApi.context(effectiveBaseUrl, contextMessages, agentic, ctxModel)
      .then((c) => { if (alive) setInlineCtx(c as ContextBreakdown); })
      .catch(() => {});
    pull();
    const t = setInterval(pull, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [effectiveBaseUrl, agentic, ctxShape, provider, ollamaModel]);

  // Gemini-style: before the first message the prompt owns the middle of the
  // page; once a conversation exists it docks to the bottom.
  const landing = messages.length === 0 && !startingServer;

  const modelPicker = provider === "mlx" ? (
    <MlxPicker
      status={mlx}
      models={mlxModels}
      servedDir={mlxProcess ? servedModelPath(mlxProcess) : undefined}
      busy={mlxServing || loading}
      onServe={serveMlx}
      onRefresh={() => void loadMlx()}
    />
  ) : provider === "ollama" ? (
    <OllamaPicker
      status={ollama}
      selected={ollamaModel}
      checking={ollamaChecking}
      onSelect={(name) => { setOllamaModel(name); focusInput(); }}
      onRefresh={() => void loadOllama(true)}
    />
  ) : (
    <ModelPicker
      models={servable}
      servedFile={servedFile}
      serving={serving}
      disabled={switching || !!loading}
      busy={switching}
      onChange={switchModel}
    />
  );

  // Provider switch — chat-page only. Kept as a compact two-state control so
  // the rest of the header stays identical when llama.cpp is in use.
  const providerSwitch = (
    <div className="provswitch" role="group" aria-label="Chat provider">
      <button
        type="button"
        className={`provswitch-btn ${provider === "llamacpp" ? "on" : ""}`}
        onClick={() => switchProvider("llamacpp")}
        title="Use Osama's own llama.cpp server"
        aria-pressed={provider === "llamacpp"}
      >
        llama.cpp
      </button>
      {mlx?.support.supported && (
        <button
          type="button"
          className={`provswitch-btn ${provider === "mlx" ? "on" : ""}`}
          onClick={() => switchProvider("mlx")}
          title="Use MLX — Apple's runtime, served by Osama (Apple silicon only)"
          aria-pressed={provider === "mlx"}
        >
          MLX
        </button>
      )}
      <button
        type="button"
        className={`provswitch-btn ${provider === "ollama" ? "on" : ""}`}
        onClick={() => switchProvider("ollama")}
        title="Use the Ollama daemon installed on this machine"
        aria-pressed={provider === "ollama"}
      >
        Ollama
      </button>
    </div>
  );

  /**
   * The mode control, next to the provider switch and styled the same way.
   *
   * It used to be a toggle labelled "Agent": highlighted or not, it read the
   * same, so the default state (plain chat) was invisible — the header appeared
   * to be in agent mode whatever you had chosen. Two explicit segments make the
   * active mode the one you can see, and Chat is the state a new chat opens in.
   */
  const modeSwitch = (
    <div className="provswitch agentswitch" role="group" aria-label="Answer mode">
      <button
        type="button"
        className={`provswitch-btn ${agentic ? "" : "on"}`}
        onClick={() => { if (agentic) { setAgentic(false); focusInput(); } }}
        title="Plain chat — the model answers from the conversation alone, with no tools"
        aria-pressed={!agentic}
      >
        Chat
      </button>
      <button
        type="button"
        className={`provswitch-btn ${agentic ? "on" : ""}`}
        onClick={() => { if (!agentic) { setAgentic(true); focusInput(); } }}
        title={
          agentic
            ? `Agent mode — the model may call ${agentTools.length || "the"} tools`
            : "Agent mode — let the model read files and run commands in the workspace"
        }
        aria-pressed={agentic}
      >
        Agent{agentic && agentTools.length > 0 && <span className="agent-count">{agentTools.length}</span>}
      </button>
    </div>
  );

  const workspacePicker = (
    <button
      type="button"
      className={`wspick-btn ${workspace.chosen ? "" : "unset"}`}
      onClick={() => focusPanel("workspace")}
      title={workspace.path}
    >
      <FolderOpen size={14} />
      <span className="wspick-path">{workspace.path.split("/").slice(-2).join("/") || "workspace"}</span>
      {!workspace.chosen && <span className="wspick-unset">default</span>}
    </button>
  );

  // Workspace grounding chip: always visible so the user can see which
  // directory the chat is grounded in (agentic or not).
  const workspaceGrounding = wsSnapshot ? (
    <span title={`${wsSnapshot.path}\n\n${wsSnapshot.snapshot.slice(0, 400)}`} style={{ display: "inline-flex" }}>
      <Badge kind={workspace.chosen ? "info" : "warn"}>
        <FolderOpen size={11} />
        {workspace.chosen ? "grounded" : "default"}: {wsSnapshot.path.split("/").slice(-1)[0] || wsSnapshot.path}
      </Badge>
    </span>
  ) : null;

  const connectedMcp = mcpServers.filter((s) => s.connected);
  const mcpToolCount = connectedMcp.reduce((n, s) => n + s.toolCount, 0);

  /**
   * The composer's MCP indicator. Shows only when at least one server is
   * connected, so the composer stays uncluttered otherwise. Hovering lists the
   * servers; clicking opens the MCP manager.
   */
  const mcpIndicator = connectedMcp.length > 0 ? (
    <div className="mcp-indicator-wrap">
      <button
        type="button"
        className="mcp-indicator"
        onClick={(e) => { e.stopPropagation(); setMcpOpen((v) => !v); }}
        title="Connected MCP servers — click for details"
        aria-expanded={mcpOpen}
      >
        <span className="mcp-indicator-dot" />
        <Plug size={13} />
        <span className="mcp-indicator-label">
          {connectedMcp.length} MCP server{connectedMcp.length === 1 ? "" : "s"}
        </span>
        <span className="mcp-indicator-tools">{mcpToolCount} tool{mcpToolCount === 1 ? "" : "s"}</span>
        <ChevronDown size={12} className={`mcp-indicator-chev ${mcpOpen ? "open" : ""}`} />
      </button>
      {mcpOpen && (
        <div className="mcp-indicator-pop" role="dialog" aria-label="Connected MCP servers">
          <div className="mention-head">
            <span>MCP · {connectedMcp.length} connected</span>
            <button className="mention-x" onClick={() => setMcpOpen(false)} aria-label="Close"><X size={12} /></button>
          </div>
          {connectedMcp.map((s) => (
            <div key={s.config.id} className="mcp-indicator-row">
              <span className="mcp-indicator-dot" />
              <span className="mcp-indicator-name">{s.config.name}</span>
              {s.config.trusted && <span className="rptag">trusted</span>}
              <span className="faint small">{s.toolCount} tool{s.toolCount === 1 ? "" : "s"}</span>
            </div>
          ))}
          <div className="mcp-indicator-foot faint small">
            Tools are available to the model only in Agent mode.
          </div>
        </div>
      )}
    </div>
  ) : null;

  const composerEl = (
    <div
      className={`composer ${dragging ? "dragging" : ""} ${landing ? "composer-landing" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={(e) => { e.preventDefault(); setDragging(false); attach(e.dataTransfer.files); }}
    >
      {attachments.length > 0 && (
        <div className="attach-row" style={{ marginBottom: 8 }}>
          {attachments.map((a) => (
            <span key={a.id} className="chip" title={`${a.name} · ${bytes(a.size)}`}>
              {a.kind === "image" ? <ImageIcon size={12} /> : <FileText size={12} />}
              <span className="chip-name">{a.name}</span>
              <span className="faint">{bytes(a.size)}</span>
              <button className="chip-x" onClick={() => setAttachments((x) => x.filter((y) => y.id !== a.id))} aria-label={`Remove ${a.name}`}>
                <X size={11} />
              </button>
            </span>
          ))}
          <span className="faint small">{attachments.length} file(s) · {bytes(totalAttached)}</span>
        </div>
      )}

      {activeSkills.length > 0 && (
        <div className="skill-chips" style={{ marginBottom: 8 }}>
          {activeSkills.map((id) => {
            const s = skills.find((x) => x.id === id);
            return (
              <span key={id} className="chip skill-chip" title={`${s?.description ?? id} — click to deactivate`}>
                <Sparkles size={11} />
                <span className="chip-name" onClick={() => toggleSkill(id)}>{s?.name || id}</span>
                <button className="chip-x" onClick={() => toggleSkill(id)} aria-label={`Deactivate ${id}`}><X size={11} /></button>
              </span>
            );
          })}
          <span className="faint small">{activeSkills.length} skill(s) active</span>
        </div>
      )}

      <div className="composer-inner">
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => { attach(e.target.files); e.target.value = ""; }}
        />
        <button className="composer-tool" onClick={() => fileRef.current?.click()} title="Attach files (text or images)">
          <Paperclip size={16} />
        </button>
        {/* Skills, workspace files and MCP are Agent-mode surface. Plain chat
            keeps only the paperclip: attach something and talk about it. */}
        {agentic && (
          <button
            className={`composer-tool ${activeSkills.length ? "on" : ""}`}
            onClick={() => { setSkillPick((v) => !v); setSkillQuery(""); void loadSkills(); focusInput(); }}
            title="Activate skills for this conversation"
          >
            <Sparkles size={16} />
            {activeSkills.length > 0 && <span className="tool-badge">{activeSkills.length}</span>}
          </button>
        )}
        {agentic && skillPick && (
          <div className="skill-pop" role="dialog" aria-label="Active skills">
            <div className="mention-head">
              <span>Skills · {activeSkills.length} active</span>
              <button className="mention-x" onClick={() => setSkillPick(false)} aria-label="Close"><X size={12} /></button>
            </div>
            <div className="skill-search">
              <input
                autoFocus
                value={skillQuery}
                onChange={(e) => setSkillQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setSkillPick(false); } }}
                placeholder="Filter skills…"
              />
            </div>
            <div className="skill-list">
              {skillMatches.map((s) => {
                const on = activeSkills.includes(s.id);
                return (
                  <button
                    key={s.id}
                    className={`skill-row ${on ? "on" : ""}`}
                    onClick={() => toggleSkill(s.id)}
                  >
                    <span className={`skill-check ${on ? "on" : ""}`}>{on ? <CheckIcon size={11} /> : null}</span>
                    <span className="skill-info">
                      <span className="skill-title">{s.name || s.id}</span>
                      <span className="skill-desc">{s.description}</span>
                    </span>
                  </button>
                );
              })}
              {skillLoaded.current && skillMatches.length === 0 && (
                <div className="mention-empty">No skill matches “{skillQuery}”.</div>
              )}
              {!skills.length && <div className="mention-empty">No skills installed yet.</div>}
            </div>
            {activeSkills.length > 0 && (
              <div className="skill-foot">
                <button className="btn ghost sm" onClick={() => { setActiveSkills([]); saveActiveSkills([]); }}>
                  <X size={11} /> Clear all
                </button>
              </div>
            )}
          </div>
        )}
        {agentic && mention && (
          <div className="mention-pop" role="listbox" aria-label="Workspace files">
            <div className="mention-head">
              <span>Workspace files · @</span>
              <span className="faint small">{mentionMatches.length ? "↑↓ · Enter to pick · Esc to close" : wsFiles.length ? "no match" : "loading…"}</span>
            </div>
            {mentionMatches.map((f, i) => (
              <button
                key={f.rel}
                role="option"
                aria-selected={i === mentionIdx}
                className={`mention-row ${i === mentionIdx ? "on" : ""}`}
                onMouseEnter={() => setMentionIdx(i)}
                onMouseDown={(e) => { e.preventDefault(); void pickMention(f); }}
              >
                {f.dir ? <Folder size={13} /> : <FileText size={13} />}
                <span className="mention-name">{f.name}{f.dir ? "/" : ""}</span>
                <span className="mention-rel">{f.rel}</span>
                {!f.dir && <span className="faint small">{bytes(f.size)}</span>}
              </button>
            ))}
            {!mentionMatches.length && wsFiles.length > 0 && (
              <div className="mention-empty">No workspace file matches “{mention.query}”.</div>
            )}
          </div>
        )}
        {agentic && skillMention && (
          <div className="mention-pop skill-mention-pop" role="listbox" aria-label="Skills">
            <div className="mention-head">
              <span>Skills · #</span>
              <span className="faint small">{skillMentionMatches.length ? "↑↓ · Enter to activate · Esc to close" : skills.length ? "no match" : "loading…"}</span>
            </div>
            {skillMentionMatches.map((s, i) => {
              const on = activeSkills.includes(s.id);
              return (
                <button
                  key={s.id}
                  role="option"
                  aria-selected={i === skillMentionIdx}
                  className={`mention-row skill-mention-row ${i === skillMentionIdx ? "on" : ""} ${on ? "active" : ""}`}
                  onMouseEnter={() => setSkillMentionIdx(i)}
                  onMouseDown={(e) => { e.preventDefault(); void pickSkillMention(s); }}
                >
                  <Sparkles size={13} />
                  <span className="mention-name">{s.name || s.id}</span>
                  <span className="mention-rel">{s.description.slice(0, 80)}{s.description.length > 80 ? "…" : ""}</span>
                  {on && <span className="faint small">active</span>}
                </button>
              );
            })}
            {!skillMentionMatches.length && skills.length > 0 && (
              <div className="mention-empty">No skill matches “{skillMention.query}”.</div>
            )}
            {!skills.length && (
              <div className="mention-empty">No skills installed yet — install one from the Skills panel.</div>
            )}
          </div>
        )}
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            autoGrow(e.currentTarget);
            // `@file` and `#skill` are Agent-mode conveniences: in plain chat
            // nothing is detected, so typing an @ is just an @.
            if (!agentic) {
              if (mention) setMention(null);
              if (skillMention) setSkillMention(null);
              return;
            }
            // Detect @file mentions
            const d = detectMention(e.currentTarget);
            if (d) {
              setMention(d); setMentionIdx(0); void loadWsFiles();
              if (skillMention) setSkillMention(null);
            } else if (mention) setMention(null);
            // Detect #skill mentions
            const h = detectSkillMention(e.currentTarget);
            if (h) {
              setSkillMention(h); setSkillMentionIdx(0); void loadSkills();
              if (mention) setMention(null);
            } else if (skillMention) setSkillMention(null);
          }}
          onBlur={() => { /* let mousedown on a row win before we close */ setTimeout(() => { setMention(null); setSkillMention(null); }, 120); }}
          onPaste={(e) => {
            const files = e.clipboardData?.files;
            if (files && files.length) { e.preventDefault(); attach(files); }
          }}
          onKeyDown={(e) => {
            // Skill mention navigation
            if (skillMention && skillMentionMatches.length) {
              if (e.key === "ArrowDown") { e.preventDefault(); setSkillMentionIdx((i) => (i + 1) % skillMentionMatches.length); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setSkillMentionIdx((i) => (i - 1 + skillMentionMatches.length) % skillMentionMatches.length); return; }
              if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); void pickSkillMention(skillMentionMatches[skillMentionIdx]!); return; }
              if (e.key === "Escape") { e.preventDefault(); setSkillMention(null); return; }
            }
            // File mention navigation
            if (mention && mentionMatches.length) {
              if (e.key === "ArrowDown") { e.preventDefault(); setMentionIdx((i) => (i + 1) % mentionMatches.length); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setMentionIdx((i) => (i - 1 + mentionMatches.length) % mentionMatches.length); return; }
              if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); void pickMention(mentionMatches[mentionIdx]!); return; }
              if (e.key === "Escape") { e.preventDefault(); setMention(null); return; }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!busy) send();
            }
          }}
          placeholder={
            startingServer
              ? "Waiting for the model to finish loading…"
              : runningServer
                ? agentic
                  ? "Message your model…  (@ file · # skill · Enter to send · Shift+Enter newline)"
                  : "Message your model…  (drop or attach a file · Enter to send)"
                : "Pick a model above to start…"
          }
          rows={1}
        />
        {streaming ? (
          <button className="send" onClick={() => stopRun()} title="Stop">
            <StopCircle size={16} />
          </button>
        ) : (
          <button className="send" onClick={send} disabled={(!input.trim() && attachments.length === 0) || busy} title={startingServer ? "Model is loading" : "Send"}>
            <Send size={16} />
          </button>
        )}
      </div>
      {busy && !streaming && <div className="faint small" style={{ marginTop: 6 }}>Model is loading — you can keep typing.</div>}
      <div className="composer-ctx" aria-live="off">
        {agentic && mcpIndicator}
        {inlineCtx ? (
          <>
            <span className="composer-ctx-bar" aria-hidden="true">
              <span
                className={`composer-ctx-fill ${inlineCtx.pressure >= 0.9 ? "crit" : inlineCtx.pressure >= 0.7 ? "warn" : "ok"}`}
                style={{ width: `${Math.min(100, Math.round(inlineCtx.pressure * 100))}%` }}
              />
            </span>
            <span className="composer-ctx-pct">{Math.round(inlineCtx.pressure * 100)}%</span>
            <span className="composer-ctx-detail">
              {inlineCtx.used.toLocaleString()} / {inlineCtx.window.toLocaleString()} tok
              {agentic && toolSupport === "none" ? " · no tool template" : ""}
            </span>
            {compactMessages.length >= 4 && (
              <button className="composer-ctx-compact" onClick={compactNow} disabled={compacting || inlineCtx.pressure < 0.7}
                title="Summarise older turns to free space">
                {compacting ? "compacting…" : "compact"}
              </button>
            )}
          </>
        ) : (
          <span className="composer-ctx-detail faint">no model running</span>
        )}
      </div>
    </div>
  );

  // The chat column. The insights live in the app's left sidebar (portal).
  const mainColumn = (
    <div className={`stack chat-view ${modelChanged ? "model-changed" : ""}`}>
      <div className="row wrap" style={{ gap: 10 }}>
        {providerSwitch}
        {modelPicker}
        {modeSwitch}
        {/* Workspace belongs to Agent mode: the picker and grounding chip are
            hidden in plain chat, where there is no directory in play. */}
        {agentic && workspacePicker}
        {agentic && workspaceGrounding}
        {provider === "ollama" ? (
          runningServer
            ? <Badge kind="ok"><span className="dot" /> ollama{ollama?.version ? ` ${ollama.version}` : ""}</Badge>
            : startingServer
              ? <Badge kind="info"><span className="dot" /> checking ollama…</Badge>
              : <Badge kind="warn">ollama not reachable</Badge>
        ) : (
          runningServer ? <Badge kind="ok"><span className="dot" /> server running</Badge> : startingServer ? <Badge kind="info"><span className="dot" /> loading model…</Badge> : <Badge kind="warn">no server — pick a model</Badge>
        )}
        {vision === true && <Badge kind="accent">vision</Badge>}
        {connectedMcp.length > 0 && agentic && (
          <span title={connectedMcp.map((s) => `${s.config.name} · ${s.toolCount} tool(s)`).join("\n")} style={{ display: "inline-flex" }}>
            <Badge kind="accent"><Plug size={11} /> {mcpToolCount} MCP tool{mcpToolCount === 1 ? "" : "s"}</Badge>
          </span>
        )}
        {agentic && approvalMode === "auto" && <Badge kind="warn">auto-approve</Badge>}
        {agentic && toolSupport === "none" && (
          <Badge kind="warn"><AlertTriangle size={11} /> model can't call tools</Badge>
        )}
        {/* Identity (soul + personality) is injected into the agentic prompt
            only, so in plain chat the strip would advertise a voice that is not
            actually in play. */}
        {agentic && <IdentityStrip personality={personality} onOpen={(p) => setFocus({ panel: p, n: (focus?.n ?? 0) + 1 })} />}
        <div className="spacer" style={{ flex: 1 }} />
        <Button size="sm" variant="ghost" onClick={newChat} title="Archive this conversation and start a blank one">
          <Plus size={13} /> New chat
        </Button>
        <Button size="sm" variant="ghost" onClick={() => forkChat()} disabled={messages.length === 0}
          title="Branch this conversation into a new one, leaving this thread untouched">
          <GitBranch size={13} /> Fork
        </Button>
        <Button size="sm" variant="ghost" onClick={() => { setMessages([]); focusInput(); }} disabled={messages.length === 0}>
          <RotateCcw size={13} /> Clear
        </Button>
      </div>

      {provider !== "ollama" && showFailure && failure && (
        <FailedLoad proc={failure.proc} onDismiss={() => setDismissedFailure(failure.since)} />
      )}

      {provider !== "ollama" && startingServer && serverProcess && (
        <ModelLoading
          processId={serverProcess.id}
          url={serverProcess.url}
          modelName={
            provider === "mlx"
              ? servedModelPath(serverProcess)?.split("/").pop()
              : serving?.name ?? serverProcess.label.split(" · ").pop()
          }
          startedAt={serverProcess.startedAt}
          onReady={load}
          onError={(m: string) =>
            toast.push("err", `${provider === "mlx" ? "mlx-lm" : "llama-server"} failed to load the model: ${m.slice(0, 160)}`)
          }
        />
      )}

      {provider === "ollama" && ollama && !ollama.reachable && (
        <div className="card card-pad" style={{ borderColor: "color-mix(in srgb, var(--warn) 45%, transparent)" }}>
          <div className="row" style={{ gap: 12, alignItems: "flex-start" }}>
            <span style={{ marginTop: 1, color: "var(--warn)" }}><AlertTriangle size={17} /></span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 400, fontSize: 13.5 }}>Ollama is not reachable</div>
              <div className="faint small" style={{ marginTop: 3 }}>
                {ollama.error
                  ? <>{ollama.error}</>
                  : <>Could not reach <span className="mono">{ollama.url}</span>. Start Ollama on this machine
                    (<span className="mono">ollama serve</span>), then retry — or switch back to the llama.cpp provider.</>}
              </div>
              <div className="row" style={{ gap: 8, marginTop: 10 }}>
                <Button size="sm" onClick={() => void loadOllama(true)}>Retry</Button>
                <Button size="sm" variant="ghost" onClick={() => switchProvider("llamacpp")}>Use llama.cpp</Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {provider === "ollama" && ollama?.reachable && !ollamaModel && (
        <div className="card card-pad" style={{ borderColor: "color-mix(in srgb, var(--warn) 45%, transparent)" }}>
          <div className="faint small">
            Ollama is running{ollama.models.length ? "" : " but has no models"}.
            {ollama.models.length ? " Pick a model above to start chatting." : " Pull one with `ollama pull <model>` first."}
          </div>
        </div>
      )}

      <div
        ref={scrollRef}
        className={`chat-scroll ${landing ? "chat-landing" : ""}`}
        onClick={(e) => {
          // Clicking the transcript focuses the composer — but NOT when the
          // click landed on an interactive element inside it. Otherwise an
          // inline prompt's input (the agent's question, a message editor)
          // loses focus to the composer the moment it is clicked. This was
          // why answering an agent question kept jumping to the main input.
          const el = e.target as HTMLElement;
          if (el.closest("input, textarea, select, button, a, [contenteditable='true'], .approval, .cm-edit")) return;
          const selection = window.getSelection();
          if (selection && !selection.isCollapsed) return; // user is selecting text
          focusInput();
        }}
      >
        {interrupted && !streaming && (
          <div className="runcut" role="status">
            <AlertTriangle size={13} />
            <span>
              This reply was cut off by a page reload — the model may have finished after you left. Nothing below is
              guaranteed complete.
            </span>
            <button
              className="btn ghost sm"
              onClick={() => {
                const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
                // Drop the truncated reply and re-run the same turn.
                const base = lastAssistant ? messages.slice(0, messages.lastIndexOf(lastAssistant)) : messages;
                setInterrupted(null);
                clearActive();
                runTurn({ base, label: "retry after an interrupted turn" });
              }}
            >
              Retry this reply
            </button>
            <button
              className="btn ghost sm"
              onClick={() => {
                setInterrupted(null);
                clearActive();
                toast.push("info", "Kept the partial reply.");
              }}
            >
              Keep it
            </button>
          </div>
        )}

        {landing ? null : startingServer ? (
          <Empty
            icon={<Spinner />}
            title="Model is loading"
            sub={
              provider === "ollama"
                ? "Chat unlocks the moment your Ollama model is ready."
                : `Chat unlocks the moment ${(serverProcess?.label.split(" · ").pop() ?? "the model")} is ready — watch the progress above.`
            }
          />
        ) : (
          <div className="chat">
            {messages.map((m, i) => {
              const last = i === messages.length - 1;
              const assistantName = provider === "ollama"
                ? (ollamaModel || "Assistant")
                : serving ? fileBase(serving.file) : "Assistant";
              const who = m.role === "user" ? "You" : assistantName;
              return (
                <div key={i} className={`cm ${m.role === "user" ? "cm-user" : "cm-ai"}`}>
                  {/* OWUI shape: a quiet header row (avatar · name · meta) over the body */}
                  <div className="cm-head">
                    <span className="cm-avatar">{m.role === "user" ? <User size={13} /> : <Bot size={13} />}</span>
                    <span className="cm-name">{who}</span>
                    {m.role === "assistant" && m.stepCount ? <span className="cm-meta">{m.stepCount} step{m.stepCount === 1 ? "" : "s"}</span> : null}
                    {/*
                      Honest end-state: the turn was continued because the model
                      answered with a plan, and it still ended without any file
                      change. Without this the reply reads as if work happened.
                    */}
                    {m.role === "assistant" && m.changed === false && (m.nudges ?? 0) > 0 ? (
                      <span className="cm-meta cm-planonly" title="The model was asked to continue but answered with a description instead of a tool call. Nothing was written or run.">
                        ended as a plan — nothing changed
                      </span>
                    ) : null}
                    <span className="spacer" style={{ flex: 1 }} />
                    <div className={`cm-actions ${m.role === "user" ? "for-user" : ""}`}>
                      {m.role === "user" && !streaming && (
                        <button className="cm-act" title="Edit and resend" onClick={() => setEditing({ index: i, text: m.content })}>
                          <Pencil size={13} />
                        </button>
                      )}
                      {m.content ? (
                        <button className="cm-act" title="Copy" onClick={() => copyText(m.content)}>
                          <Copy size={13} />
                        </button>
                      ) : null}
                      {m.role === "assistant" && !streaming && m.content && (
                        <>
                          <button className="cm-act" title="Regenerate this reply" onClick={() => regenerate(i)}>
                            <RefreshCw size={13} />
                          </button>
                          <button className="cm-act" title="Continue this reply" onClick={() => continueReply(i)}>
                            <Play size={13} />
                          </button>
                        </>
                      )}
                      {!streaming && (
                        <button className="cm-act" title="Fork a new chat from here" onClick={() => forkChat(i)}>
                          <GitBranch size={13} />
                        </button>
                      )}
                      {!streaming && (
                        <button className="cm-act danger" title="Delete this message" onClick={() => deleteMessage(i)}>
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="cm-body">
                    {m.attachments && m.attachments.length > 0 && (
                      <div className="attach-row" style={{ marginBottom: m.content ? 8 : 0 }}>
                        {m.attachments.map((a) => (
                          <span key={a.id} className="chip" title={`${a.name} · ${bytes(a.size)}`}>
                            {a.kind === "image" ? <ImageIcon size={12} /> : <FileText size={12} />}
                            <span className="chip-name">{a.name}</span>
                            <span className="faint">{bytes(a.size)}</span>
                          </span>
                        ))}
                      </div>
                    )}
                    {m.role === "assistant" && streaming && last && agentic && (
                      <ActivityLine
                        steps={m.steps}
                        running={streaming}
                        waiting={approval ? "approval" : question ? "question" : null}
                        step={agentStepCount}
                      />
                    )}
                    {m.role === "assistant" && m.steps && m.steps.length > 0 && (
                      <AgentTrace
                        steps={m.steps}
                        steps_count={m.stepCount}
                        running={streaming && last}
                      />
                    )}
                    {/* A thinking model's chain-of-thought, kept separate from
                        the answer (Ollama streams it on its own channel). */}
                    {m.role === "assistant" && m.reasoning && m.reasoning.trim() && (
                      <ReasoningBlock text={m.reasoning} streaming={streaming && last && !m.content} />
                    )}
                    {m.content ? (
                      m.role === "user" && editing?.index === i ? (
                        <div className="cm-edit">
                          <textarea
                            autoFocus
                            value={editing.text}
                            onChange={(e) => setEditing({ index: i, text: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submitEdit(i, editing.text); }
                              if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
                            }}
                            rows={Math.min(10, Math.max(2, editing.text.split("\n").length))}
                          />
                          <div className="cm-edit-actions">
                            <button className="btn ghost sm" onClick={() => setEditing(null)}>Cancel</button>
                            <button className="btn sm" onClick={() => void submitEdit(i, editing.text)} disabled={!editing.text.trim()}>
                              <CheckIcon size={12} /> Save &amp; resend
                            </button>
                          </div>
                        </div>
                      ) : m.role === "user" ? (
                        <div className="cm-text" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{m.content}</div>
                      ) : (
                        <RichContent content={m.content} />
                      )
                    ) : m.attachments?.length ? null : m.steps?.length ? null : (
                      <Spinner />
                    )}
                    {/* The "thinking…" line that used to sit here is gone: the
                        ActivityLine above already says what is happening, and
                        between calls it says the model is deciding — two
                        indicators for one state only made noise. */}
                    {m.role === "assistant" && approval && last && (
                      <ApprovalPrompt
                        command={approval.command}
                        cwd={approval.cwd}
                        onAnswer={onAnswerApproval}
                        onAllowAll={onAllowAllApproval}
                      />
                    )}
                    {m.role === "assistant" && question && last && (
                      <QuestionPrompt
                        question={question.question}
                        options={question.options}
                        onAnswer={onAnswerQuestion}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {landing ? (
        <div className="composer-wrap">
          <div className="landing-center">
            <img className="landing-logo" src="/logo.png" alt="" aria-hidden="true" />
            <div className="landing-mark">
              {provider === "ollama"
                ? (ollamaModel || "Ollama")
                : serving ? fileBase(serving.file) : "Local inference"}
            </div>
            <div className="landing-brand">
              {runningServer ? "What are we exploring?" : startingServer ? "Loading the model…" : provider === "ollama" ? "Pick an Ollama model to begin" : "Pick a model to begin"}
            </div>
            <p className="landing-sub">
              {runningServer
                ? agentic
                  ? `Runs entirely on this machine${provider === "ollama" ? " through your Ollama daemon" : ""}. Type @ to reference a workspace file, # to load a skill, or drop a file to attach.`
                  : `Runs entirely on this machine${provider === "ollama" ? " through your Ollama daemon" : ""}. Type your message, or drop a file to attach it.`
                : provider === "ollama"
                  ? "Choose one of your installed Ollama models above, or switch back to llama.cpp."
                  : "Choose a model in the bar above (or serve one from the Server view)."}
            </p>
            {runningServer && (
              <div className="suggest">
                {SUGGESTIONS.map((s) => (
                  <button key={s.title} className="suggest-card" onClick={() => { setInput(s.prompt); focusInput(); }}>
                    <span className="suggest-icon">{s.icon}</span>
                    <span className="suggest-title">{s.title}</span>
                    <span className="suggest-sub">{s.sub}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {composerEl}
        </div>
      ) : (
        composerEl
      )}
    </div>
  );

  // The page: the chat column fills the content area; the insights render
  // through a portal into the app's own left sidebar, so there is ONE sidebar
  // in the product and the chat uses it like every other view.
  /**
   * Compact the conversation on demand: POSTs the transcript to the compact
   * endpoint, which summarises the older turns and returns the replacement
   * list. The messages array is rebuilt so the next send is small again.
   */
  async function compactNow() {
    if (compacting || compactMessages.length < 4) return;
    setCompacting(true);
    try {
      const r = await agentApi.compact({
        baseUrl: effectiveBaseUrl,
        model: provider === "ollama" ? ollamaModel : "local",
        messages: compactMessages,
      });
      if (r.compacted) {
        noteCompaction({ at: Date.now(), before: r.before, after: r.after, reason: r.reason });
        // Rebuild the visible messages from the compacted payload: keep the
        // attachment metadata the UI needs by re-deriving from the summary.
        const rebuilt = r.messages.map((m) => ({
          id: `c${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
          role: m.role as "user" | "assistant",
          content: typeof m.content === "string" ? m.content : "",

        }));
        setMessages(rebuilt);
        toast.push("ok", `Compacted: ${r.before} → ${r.after} messages`);
      } else {
        clearCompaction();
        toast.push("info", r.reason || "nothing to compact");
      }
    } catch (e) {
      toast.push("err", `Compact failed: ${(e as Error).message.slice(0, 140)}`);
    } finally {
      setCompacting(false);
    }
  }

  return (
    <div className="chat-page">
      {mainColumn}
      {insightSlot &&
        createPortal(
          <ChatInsights
            baseUrl={effectiveBaseUrl}
            agentic={agentic}
            todos={todos}
            refreshKey={agentStepCount}
            messages={contextMessages}
            onToolSupport={setToolSupport}
            onWorkspaceChange={setWorkspace}
            systemPrompt={systemPrompt} onSystemPrompt={setSystemPrompt}
            temperature={temperature} onTemperature={setTemperature}
            topP={topP} onTopP={setTopP}
            maxTokens={maxTokens} onMaxTokens={setMaxTokens}
            serverUrl={baseUrl} onServerUrl={setBaseUrl}
            apiKey={apiKey} onApiKey={setApiKey}
            approvalMode={approvalMode} onApprovalMode={setApprovalMode}
            history={history}
            activeId={chatId}
            onNewChat={newChat}
            onOpenChat={openChat}
            onDeleteChat={deleteChat}
            focus={focus}
            model={provider === "ollama" ? ollamaModel : (servedFile ?? serving?.file ?? "")}
            contextModel={provider === "ollama" ? ollamaModel : undefined}
            compactMessages={compactMessages}
            onCompactClick={compactNow}
            compacting={compacting}
            lastCompaction={lastCompaction}
            personality={personality}
            onPersonality={setPersonality}
            livePrompt={promptInfo}
          />,
          insightSlot,
        )}
    </div>
  );
}

/**
 * The model picker, Open WebUI-style: a lightweight "model name ▾" trigger in
 * the chat header, opening a menu that lists the library with the served model
 * ticked. A native <select> can't be styled to fit, so this is button+popover.
 */
function ModelPicker({
  models, servedFile, serving, disabled, busy, onChange,
}: {
  models: LocalModel[];
  servedFile?: string;
  serving: LocalModel | null;
  disabled: boolean;
  busy: boolean;
  onChange: (file: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const label = busy ? "switching…" : serving ? fileBase(serving.file) : models.length ? "Select a model" : "No models in library";

  return (
    <div className="mpick" ref={rootRef}>
      <button
        type="button"
        className={`mpick-btn ${open ? "open" : ""}`}
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled || models.length === 0}
        title={serving ? `Serving ${serving.name}` : "Choose the model to serve"}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {busy ? <Spinner /> : <Bot size={15} className="mpick-bot" />}
        <span className="mpick-name">{label}</span>
        <ChevronDown size={14} className="mpick-chev" />
      </button>

      {open && (
        <div className="mpick-menu" role="listbox">
          <div className="mpick-head">models</div>
          {models.map((m) => {
            const active = m.file === servedFile;
            return (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={active}
                className={`mpick-item ${active ? "active" : ""}`}
                onClick={() => {
                  setOpen(false);
                  if (!active) onChange(m.file);
                }}
              >
                <span className="mpick-tick">{active && <CheckIcon size={13} />}</span>
                <span className="mpick-item-body">
                  <span className="mpick-item-name" title={m.file}>{fileBase(m.file)}</span>
                  <span className="mpick-item-meta">
                    {m.card?.quantization ?? "?"}{m.card?.contextLength ? ` · ${Math.round(m.card.contextLength / 1024)}k ctx` : ""}
                  </span>
                </span>
                <span className="mpick-item-size">{bytes(m.sizeBytes)}</span>
              </button>
            );
          })}
          <div className="mpick-foot">Choosing a model starts it — one server at a time.</div>
        </div>
      )}
    </div>
  );
}

/**
 * The MLX model picker.
 *
 * Same popover shell as the library picker, but the list is Apple-runtime models
 * — directories, not GGUFs — and choosing one *starts* it, because mlx-lm serves
 * a single model that has to be loaded. It also says what to do when this machine
 * has no MLX runtime yet, instead of showing an empty menu.
 */
function MlxPicker({
  status, models, servedDir, busy, onServe, onRefresh,
}: {
  status: MlxStatus | null;
  models: MlxModel[];
  servedDir?: string;
  busy: boolean;
  onServe: (m: MlxModel) => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const ready = status?.runtime.ready === true;
  const label = busy
    ? "switching…"
    : servedDir
      ? fileBase(servedDir)
      : ready
        ? models.length
          ? "Choose an MLX model"
          : "No MLX models on disk"
        : "MLX runtime not installed";

  return (
    <div className="mpick" ref={rootRef}>
      <button
        type="button"
        className={`mpick-btn ${open ? "open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        disabled={busy || !ready || models.length === 0}
        title={servedDir ? `Serving ${fileBase(servedDir)} with MLX` : "Choose the MLX model to serve"}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {busy ? <Spinner /> : <Bot size={15} className="mpick-bot" />}
        <span className="mpick-name">{label}</span>
        <ChevronDown size={14} className="mpick-chev" />
      </button>

      {open && (
        <div className="mpick-menu" role="listbox">
          <div className="mpick-head">
            MLX models
            {status?.runtime.mlxLmVersion ? <span className="faint"> · mlx-lm {status.runtime.mlxLmVersion}</span> : null}
          </div>
          {models.map((m) => {
            const active = servedDir === m.dir;
            const cannotServe = m.servable === false;
            return (
              <button
                key={m.dir}
                type="button"
                role="option"
                aria-selected={active}
                disabled={cannotServe}
                title={cannotServe ? m.servableNote : m.dir}
                className={`mpick-item ${active ? "active" : ""} ${cannotServe ? "not-servable" : ""}`}
                onClick={() => {
                  setOpen(false);
                  if (!active) onServe(m);
                }}
              >
                <span className="mpick-tick">{active && <CheckIcon size={13} />}</span>
                <span className="mpick-item-body">
                  <span className="mpick-item-name" title={m.dir}>{m.name}</span>
                  <span className="mpick-item-meta">
                    {cannotServe ? (
                      "mlx-lm cannot load this"
                    ) : (
                      <>
                        {m.quantization?.bits ? `${m.quantization.bits}-bit` : "?"}
                        {m.quantization?.groupSize ? ` g${m.quantization.groupSize}` : ""}
                        {m.contextLength ? ` · ${Math.round(m.contextLength / 1024)}k ctx` : ""}
                      </>
                    )}
                  </span>
                </span>
                <span className="mpick-item-size">{bytes(m.sizeBytes)}</span>
              </button>
            );
          })}
          {!ready && (
            <div className="mpick-foot">
              No MLX runtime yet — install it from the Library's MLX card (uv builds it in seconds).
            </div>
          )}
          {ready && models.length === 0 && (
            <div className="mpick-foot">
              Nothing to serve: an MLX model is a directory with config.json and .safetensors weights.
            </div>
          )}
          {ready && models.length > 0 && (
            <div className="mpick-foot row" style={{ gap: 8 }}>
              <span style={{ flex: 1 }}>Choosing a model starts it — one server at a time.</span>
              <button type="button" className="btn ghost sm" onClick={onRefresh} title="Rescan the models directory">
                <RefreshCw size={12} /> Rescan
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The Ollama model picker. Same popover shell as `ModelPicker`, but the list is
 * the daemon's own models (by name) rather than Osama's GGUF library. Selecting
 * one does not start anything — the model is loaded by Ollama on first use.
 */
function OllamaPicker({
  status, selected, checking, onSelect, onRefresh,
}: {
  status: OllamaStatus | null;
  selected: string;
  checking: boolean;
  onSelect: (name: string) => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const models = status?.models ?? [];
  const usable = models.filter((m) => !/embed|rerank/i.test(`${m.name} ${m.family ?? ""}`));
  const label = checking && !status
    ? "checking ollama…"
    : selected
      ? selected
      : status?.reachable
        ? (usable.length ? "Select an Ollama model" : "No models in Ollama")
        : "Ollama not reachable";

  const humanBytes = (n: number): string => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  };

  return (
    <div className="mpick" ref={rootRef}>
      <button
        type="button"
        className={`mpick-btn ${open ? "open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        disabled={!status?.reachable || usable.length === 0}
        title={selected ? `Ollama model: ${selected}` : "Choose an Ollama model"}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {checking ? <Spinner /> : <Bot size={15} className="mpick-bot" />}
        <span className="mpick-name">{label}</span>
        <ChevronDown size={14} className="mpick-chev" />
      </button>

      {open && (
        <div className="mpick-menu" role="listbox">
          <div className="mpick-head row" style={{ justifyContent: "space-between" }}>
            <span>ollama models</span>
            <button className="mention-x" onClick={onRefresh} title="Re-check the daemon"><RefreshCw size={11} /></button>
          </div>
          {usable.map((m) => {
            const active = m.name === selected;
            return (
              <button
                key={m.name}
                type="button"
                role="option"
                aria-selected={active}
                className={`mpick-item ${active ? "active" : ""}`}
                onClick={() => { setOpen(false); if (!active) onSelect(m.name); }}
              >
                <span className="mpick-tick">{active && <CheckIcon size={13} />}</span>
                <span className="mpick-item-body">
                  <span className="mpick-item-name" title={m.name}>{m.name}</span>
                  <span className="mpick-item-meta">
                    {[m.parameterSize, m.quantization, m.capabilities?.includes("tools") ? "tools" : null, m.capabilities?.includes("vision") ? "vision" : null]
                      .filter(Boolean).join(" · ") || m.family || "—"}
                  </span>
                </span>
                <span className="mpick-item-size">{m.size ? humanBytes(m.size) : ""}</span>
              </button>
            );
          })}
          {!usable.length && (
            <div className="mention-empty">
              {status?.reachable ? "No chat models installed. Pull one with `ollama pull <model>`." : "Start Ollama, then retry."}
            </div>
          )}
          <div className="mpick-foot">
            {status?.version ? `Ollama ${status.version} · ` : ""}{status?.url ?? ""}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A collapsible view of a model's reasoning, shown muted above the answer so it
 * never competes with the reply. Auto-open while the model is still thinking
 * with no answer yet, so the user sees progress rather than a stalled bubble.
 */
function ReasoningBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(streaming);
  useEffect(() => {
    if (streaming) setOpen(true);
    else setOpen(false);
  }, [streaming]);
  return (
    <div className={`reasoning ${open ? "open" : ""}`}>
      <button className="reasoning-head" onClick={() => setOpen((v) => !v)}>
        <ChevronDown size={12} className="reasoning-chev" />
        <span>{streaming ? "thinking…" : "reasoning"}</span>
        <span className="faint small">{text.length.toLocaleString()} chars</span>
      </button>
      {open && <div className="reasoning-body">{text}</div>}
    </div>
  );
}
