import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Bot, Check as CheckIcon, ChevronDown, Copy, FileText, Folder, FolderOpen, GitBranch, Image as ImageIcon,
  Paperclip, Pencil, Play, RefreshCw, RotateCcw, Send, Sparkles, StopCircle, Trash2, User, X, AlertTriangle, Plus,
} from "lucide-react";
import { api, streamChat, streamAgent, agentApi, type AgentMessagePayload } from "../lib/api";
import type { AgentQuestion, AgentStep, AgentTool, ContextBreakdown, LocalModel, ManagedProcess, SkillMeta, SystemResponse, TodoItem, WorkspaceFile } from "../lib/types";
import { Badge, Button, Empty, Spinner, useToast } from "../components/ui";
import { AgentTrace, ApprovalPrompt, QuestionPrompt } from "../components/AgentTrace";
import { ChatInsights, type FocusSignal } from "../components/ChatInsights";
import { RichContent } from "../components/rich";
import { ModelLoading, useServerReady, useLoadFailure, FailedLoad } from "../components/ModelLoading";
import { bytes, fileBase } from "../lib/format";
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
 * Turn a stored message into what the server should receive. Text files are
 * inlined as fenced blocks; images become OpenAI content parts only when the
 * model actually accepts images — a text-only model 500s on image parts, so
 * there they are recorded as a text reference instead.
 */
function buildContent(m: Message, vision: boolean): string | Array<Record<string, unknown>> {
  const attachments = m.attachments ?? [];
  const images = attachments.filter((a) => a.kind === "image");
  let text = m.content;

  for (const a of attachments) {
    if (a.kind === "text" && a.text !== undefined) {
      text += `\n\n--- ${a.name} ---\n\`\`\`${fenceLang(a.name)}\n${a.text}\n\`\`\``;
    }
  }

  if (images.length === 0) return text;

  if (!vision) {
    // No vision encoder: describe what was attached rather than sending bytes
    // the server cannot decode.
    const note = images.map((a) => `[image attached: ${a.name} (${a.mime}, ${bytes(a.size)})]`).join("\n");
    return text ? `${text}\n\n${note}` : note;
  }

  return [
    { type: "text", text },
    ...images.map((a) => ({ type: "image_url", image_url: { url: a.dataUrl } })),
  ];
}

/**
 * The attachment text a message contributes to the request, kept identical to
 * `buildContent`'s inlining so the measured size matches what is really sent.
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
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM);
  const [temperature, setTemperature] = useState(0.7);
  const [topP, setTopP] = useState(0.95);
  const [maxTokens, setMaxTokens] = useState<number | "">(-1);
  const [streaming, setStreaming] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [vision, setVision] = useState<boolean | null>(null);
  const [switching, setSwitching] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  /** Agentic mode: the model may call tools while this is on. */
  const [agentic, setAgentic] = useState(false);
  const [agentTools, setAgentTools] = useState<AgentTool[]>([]);
  const [approvalMode, setApprovalMode] = useState<"ask" | "auto">("ask");
  const [approval, setApproval] = useState<{ id: string; command: string; cwd: string } | null>(null);
  const [question, setQuestion] = useState<AgentQuestion | null>(null);
  const [agentStepCount, setAgentStepCount] = useState(0);
  const [todos, setTodos] = useState<TodoItem[]>([]);
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
  const [lastCompaction, setLastCompaction] = useState<{ at: number; before: number; after: number; reason: string } | null>(null);
  /** Inline context readout under the composer (polled from the same meter). */
  const [inlineCtx, setInlineCtx] = useState<ContextBreakdown | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
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
      const s = r.processes.find((p) => p.tool.includes("llama-server") && p.status === "running");
      if (s?.url) setBaseUrl(s.url);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    api.models().then((r) => setModels(r.models)).catch(() => {});
    load();
    focusInput();
    // Restore the conversation that was on screen before the refresh, so a
    // reload lands exactly where the user left.
    const saved = loadActive();
    if (saved) {
      if (Array.isArray(saved.messages) && saved.messages.length) setMessages(saved.messages as Message[]);
      if (typeof saved.agentic === "boolean") setAgentic(saved.agentic);
      if (saved.approvalMode === "ask" || saved.approvalMode === "auto") setApprovalMode(saved.approvalMode);
      if (typeof saved.systemPrompt === "string") setSystemPrompt(saved.systemPrompt);
      if (typeof saved.temperature === "number") setTemperature(saved.temperature);
      if (typeof saved.topP === "number") setTopP(saved.topP);
      if (typeof saved.maxTokens === "number" || saved.maxTokens === "") setMaxTokens(saved.maxTokens);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the active conversation on every meaningful change. Cheap: a JSON
  // write of a transcript that is already in memory, debounced by React's
  // render cadence during streaming (tokens coalesce into renders).
  useEffect(() => {
    saveActive({ messages, agentic, approvalMode, systemPrompt, temperature, topP, maxTokens });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, agentic, approvalMode, systemPrompt, temperature, topP, maxTokens]);

  useEffect(() => {
    if (!agentic || agentTools.length) return;
    agentApi.tools().then((r) => setAgentTools(r.tools)).catch(() => {});
  }, [agentic, agentTools.length]);

  // The agent needs to know where it is working before it can change anything.
  useEffect(() => {
    agentApi
      .workspaces()
      .then((w) => setWorkspace({ path: w.current, chosen: w.chosen }))
      .catch(() => {});
  }, [agentic]);

  // A server process appears instantly but the model may still be loading, so
  // readiness comes from its own /health and the poll keeps running until then.
  const healthReady = useServerReady(procs.some((p) => p.tool.includes("llama-server")) ? baseUrl : undefined);
  const serverProcess = procs.find((p) => p.tool.includes("llama-server") && p.status === "running");
  const loading = !!serverProcess && !healthReady;
  const failure = useLoadFailure(procs);
  const [dismissedFailure, setDismissedFailure] = useState<number | null>(null);
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

  const runningServer = healthReady ? serverProcess : undefined;
  const startingServer = loading ? serverProcess : undefined;
  const busy = streaming || loading;

  // Which model the running server actually has in memory, and whether it can
  // take images — read from the server itself, not from what we asked for.
  const servedFile = serverProcess ? serverProcess.argv[serverProcess.argv.findIndex((a) => a === "-m" || a === "--model") + 1] : undefined;
  const serving = useMemo(() => (servedFile ? models.find((m) => m.file === servedFile) ?? null : null), [servedFile, models]);
  const servable = useMemo(() => models.filter((m) => !m.draftOnly && !m.missing), [models]);

  useEffect(() => {
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
  }, [healthReady, serverProcess?.id, baseUrl]);

  /** Archive the current conversation into history and start a blank one. */
  function newChat() {
    if (messages.length > 0) {
      const archived: StoredChat = { id: chatId, title: chatTitle(messages), at: Date.now(), messages };
      const next = [archived, ...history.filter((c) => c.id !== chatId)].slice(0, 40);
      setHistory(next);
      saveHistory(next);
    }
    setChatId(newChatId());
    setMessages([]);
    setApproval(null);
    setQuestion(null);
    setAgentStepCount(0);
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
    setApproval(null);
    setQuestion(null);
    setAgentStepCount(0);
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

  function setTodoSupportReset() {
    setTodos([]);
    setToolSupport("unknown");
  }

  async function switchModel(file: string) {
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
      toast.push("ok", `Attached ${r.name} from the workspace.`);
    } catch (e) {
      toast.push("err", (e as Error).message);
    }
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
  async function runTurn(opts: {
    base: Message[];
    seed?: string;
    placeholder?: Message;
    label?: string;
  }) {
    if (busy) return;
    const { base, seed = "", placeholder } = opts;
    const history = placeholder ? [...base, placeholder] : base;
    const assistant: Message = agentic
      ? { role: "assistant", content: seed, steps: [] }
      : { role: "assistant", content: seed };
    setMessages([...history, assistant]);
    setStreaming(true);
    if (agentic) setAgentStepCount(0);
    const ac = new AbortController();
    abortRef.current = ac;

    /** Patch the assistant bubble we just appended (always the last one). */
    const patch = (fn: (m: Message) => Message): void => {
      setMessages((m) => {
        const copy = [...m];
        const last = copy[copy.length - 1];
        if (last) copy[copy.length - 1] = fn(last);
        return copy;
      });
    };

    try {
      const payloadMessages = history
        .filter((m) => m.role !== "assistant" || m.content.trim())
        .map((m) => ({ role: m.role as "user" | "assistant", content: buildContent(m, vision === true) as string }));

      if (!agentic) {
        // Plain chat: the model gets the whole conversation with the system
        // prompt (or its default) and streams text back.
        let acc = seed;
        for await (const delta of streamChat(
          {
            model: "local",
            messages: [
              { role: "system", content: systemPrompt.trim() || DEFAULT_SYSTEM },
              ...payloadMessages,
            ],
            stream: true as const,
            temperature,
            top_p: topP,
            ...(maxTokens === "" ? {} : { max_tokens: maxTokens }),
          },
          { baseUrl, apiKey: apiKey || undefined, signal: ac.signal },
        )) {
          acc += delta;
          patch((m) => ({ ...m, content: acc }));
        }
        if (!acc.trim()) {
          patch((m) => ({ ...m, content: "_(empty response — is the server still loading the model?)_" }));
        }
        return;
      }

      // Agentic: the server owns the loop; events arrive as the turn runs.
      let acc = seed;
      for await (const ev of streamAgent(
        {
          baseUrl,
          apiKey: apiKey || undefined,
          model: "local",
          system: systemPrompt.trim() || undefined,
          messages: payloadMessages as never,
          approval: approvalMode,
          activeSkills,
          temperature,
          top_p: topP,
          ...(maxTokens === "" ? {} : { max_tokens: maxTokens as number }),
        },
        { signal: ac.signal },
      )) {
        switch (ev.type) {
          case "assistant_delta":
            acc += ev.text;
            patch((m) => ({ ...m, content: acc }));
            break;

          case "step":
            setAgentStepCount(ev.index + 1);
            break;

          case "tool_call":
            patch((m) => ({
              ...m,
              steps: [...(m.steps ?? []), { id: ev.id, kind: "call" as const, name: ev.name, args: ev.args }],
            }));
            break;

          case "tool_result":
            patch((m) => {
              const steps = [...(m.steps ?? [])];
              const at = steps.findIndex((s) => s.id === ev.id && s.kind === "call");
              const entry = {
                id: ev.id, kind: "result" as const, name: ev.name,
                summary: ev.summary, content: ev.content, ok: ev.ok, durationMs: ev.durationMs,
              };
              if (at >= 0) steps[at] = entry;
              else steps.push(entry);
              return { ...m, steps };
            });
            break;

          case "denied":
            patch((m) => ({
              ...m,
              steps: (m.steps ?? []).map((s) => (s.id === ev.id ? { ...s, kind: "denied" as const, ok: false } : s)),
            }));
            break;

          case "compaction":
            setLastCompaction({ at: Date.now(), before: ev.before, after: ev.after, reason: ev.reason });
            toast.push("info", `Compacted: ${ev.before - ev.after} older turn(s) summarised (${ev.reason})`);
            break;

          case "todos":
            setTodos(ev.todos);
            break;

          case "question":
            setQuestion({ id: ev.id, question: ev.question, options: ev.options });
            break;

          case "approval_request":
            setApproval({ id: ev.id, command: ev.command, cwd: ev.cwd });
            break;

          case "final":
            acc = ev.text || acc;
            patch((m) => ({ ...m, content: acc, stepCount: ev.steps }));
            break;

          case "error":
            toast.push("err", `Agent: ${ev.message}`);
            patch((m) => ({ ...m, content: acc || `_(agent stopped: ${ev.message})_` }));
            break;
        }
      }
      if (!acc.trim()) {
        patch((m) => ({ ...m, content: "_(the model finished without saying anything)_" }));
      }
    } catch (e) {
      if (!ac.signal.aborted) {
        toast.push("err", `Chat failed: ${(e as Error).message}`);
      }
    } finally {
      setStreaming(false);
      setApproval(null);
      setQuestion(null);
      abortRef.current = null;
      focusInput();
    }
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
    setMessages((m) => m.filter((_, i) => i !== index));
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
  async function answerApproval(allow: boolean) {
    const a = approval;
    if (!a) return;
    setApproval(null);
    try {
      await agentApi.approve(a.id, allow);
    } catch (e) {
      toast.push("err", `Could not answer the approval: ${(e as Error).message}`);
    }
  }

  /** Answer a parked question; the loop resumes from it. */
  async function answerQuestion(text: string) {
    const q = question;
    if (!q) return;
    setQuestion(null);
    // Show the exchange in the transcript, as the assistant's trace.
    try {
      await agentApi.answer(q.id, text);
    } catch (e) {
      toast.push("err", `Could not deliver the answer: ${(e as Error).message}`);
    }
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

  // Inline context readout under the composer: measure the real conversation
  // against the served window (same endpoint the sidebar panel uses, so the
  // two always agree), refreshed on transcript changes + every few seconds.
  const ctxShape = `${messages.length}:${messages.reduce((n, m) => n + (m.content?.length ?? 0), 0)}`;
  useEffect(() => {
    let alive = true;
    const pull = () => agentApi.context(baseUrl, contextMessages, agentic)
      .then((c) => { if (alive) setInlineCtx(c as ContextBreakdown); })
      .catch(() => {});
    pull();
    const t = setInterval(pull, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [baseUrl, agentic, ctxShape]);

  // Gemini-style: before the first message the prompt owns the middle of the
  // page; once a conversation exists it docks to the bottom.
  const landing = messages.length === 0 && !startingServer;

  const modelPicker = (
    <ModelPicker
      models={servable}
      servedFile={servedFile}
      serving={serving}
      disabled={switching || !!loading}
      busy={switching}
      onChange={switchModel}
    />
  );

  const agentToggle = (
    <button
      type="button"
      className={`agent-toggle ${agentic ? "on" : ""}`}
      onClick={() => { setAgentic((v) => !v); focusInput(); }}
      title={
        agentic
          ? `Agentic mode is ON — the model may call ${agentTools.length || "the"} tools`
          : "Turn on agentic mode so the model can read files and run commands"
      }
      aria-pressed={agentic}
    >
      <Sparkles size={14} />
      <span>Agent</span>
      {agentic && agentTools.length > 0 && <span className="agent-count">{agentTools.length} tools</span>}
    </button>
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
        <button
          className={`composer-tool ${activeSkills.length ? "on" : ""}`}
          onClick={() => { setSkillPick((v) => !v); setSkillQuery(""); void loadSkills(); focusInput(); }}
          title="Activate skills for this conversation"
        >
          <Sparkles size={16} />
          {activeSkills.length > 0 && <span className="tool-badge">{activeSkills.length}</span>}
        </button>
        {skillPick && (
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
        {mention && (
          <div className="mention-pop" role="listbox" aria-label="Workspace files">
            <div className="mention-head">
              <span>Workspace files</span>
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
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            autoGrow(e.currentTarget);
            const d = detectMention(e.currentTarget);
            if (d) { setMention(d); setMentionIdx(0); void loadWsFiles(); }
            else if (mention) setMention(null);
          }}
          onBlur={() => { /* let mousedown on a row win before we close */ setTimeout(() => setMention(null), 120); }}
          onPaste={(e) => {
            const files = e.clipboardData?.files;
            if (files && files.length) { e.preventDefault(); attach(files); }
          }}
          onKeyDown={(e) => {
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
                ? "Message your model…  (Enter to send · Shift+Enter for newline · drop a file to attach)"
                : "Pick a model above to start…"
          }
          rows={1}
        />
        {streaming ? (
          <button className="send" onClick={() => abortRef.current?.abort()} title="Stop">
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
              {toolSupport === "none" ? " · no tool template" : ""}
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
        {modelPicker}
        {agentToggle}
        {agentic && workspacePicker}
        {runningServer ? <Badge kind="ok"><span className="dot" /> server running</Badge> : startingServer ? <Badge kind="info"><span className="dot" /> loading model…</Badge> : <Badge kind="warn">no server — pick a model</Badge>}
        {vision === true && <Badge kind="accent">vision</Badge>}
        {agentic && approvalMode === "auto" && <Badge kind="warn">auto-approve</Badge>}
        {agentic && toolSupport === "none" && (
          <Badge kind="warn"><AlertTriangle size={11} /> model can't call tools</Badge>
        )}
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

      {showFailure && failure && (
        <FailedLoad proc={failure.proc} onDismiss={() => setDismissedFailure(failure.since)} />
      )}

      {startingServer && (
        <ModelLoading
          processId={startingServer.id}
          url={startingServer.url}
          modelName={serving?.name ?? startingServer.label.split(" · ").pop()}
          startedAt={startingServer.startedAt}
          onReady={load}
          onError={(m: string) => toast.push("err", `llama-server failed to load the model: ${m.slice(0, 160)}`)}
        />
      )}

      <div
        ref={scrollRef}
        className={`chat-scroll ${landing ? "chat-landing" : ""}`}
        onClick={() => focusInput()}
      >
        {landing ? null : startingServer ? (
          <Empty
            icon={<Spinner />}
            title="Model is loading"
            sub={`Chat unlocks the moment ${(startingServer.label.split(" · ").pop() ?? "the model")} is ready — watch the progress above.`}
          />
        ) : (
          <div className="chat">
            {messages.map((m, i) => {
              const last = i === messages.length - 1;
              const who = m.role === "user" ? "You" : serving ? fileBase(serving.file) : "Assistant";
              return (
                <div key={i} className={`cm ${m.role === "user" ? "cm-user" : "cm-ai"}`}>
                  {/* OWUI shape: a quiet header row (avatar · name · meta) over the body */}
                  <div className="cm-head">
                    <span className="cm-avatar">{m.role === "user" ? <User size={13} /> : <Bot size={13} />}</span>
                    <span className="cm-name">{who}</span>
                    {m.role === "assistant" && m.stepCount ? <span className="cm-meta">{m.stepCount} step{m.stepCount === 1 ? "" : "s"}</span> : null}
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
                    {m.role === "assistant" && m.steps && m.steps.length > 0 && (
                      <AgentTrace
                        steps={m.steps}
                        steps_count={m.stepCount}
                        running={streaming && last}
                      />
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
                    {m.role === "assistant" && streaming && last && agentic && !m.content && (
                      <div className="faint small" style={{ marginTop: 4 }}>
                        thinking… {agentStepCount > 0 ? `step ${agentStepCount}` : ""}
                      </div>
                    )}
                    {m.role === "assistant" && approval && last && (
                      <ApprovalPrompt
                        command={approval.command}
                        cwd={approval.cwd}
                        onAnswer={answerApproval}
                      />
                    )}
                    {m.role === "assistant" && question && last && (
                      <QuestionPrompt
                        question={question.question}
                        options={question.options}
                        onAnswer={answerQuestion}
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
            <div className="landing-mark">{serving ? fileBase(serving.file) : "Local inference"}</div>
            <div className="landing-brand">
              {runningServer ? "What are we exploring?" : startingServer ? "Loading the model…" : "Pick a model to begin"}
            </div>
            <p className="landing-sub">
              {runningServer
                ? "Runs entirely on this machine. Attach a file with the paperclip, or just start typing."
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
        baseUrl,
        model: "local",
        messages: compactMessages,
      });
      if (r.compacted) {
        setLastCompaction({ at: Date.now(), before: r.before, after: r.after, reason: r.reason });
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
        setLastCompaction(null);
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
            baseUrl={baseUrl}
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
            model={servedFile ?? serving?.file ?? ""}
            compactMessages={compactMessages}
            onCompactClick={compactNow}
            compacting={compacting}
            lastCompaction={lastCompaction}
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
