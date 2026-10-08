import { useEffect, useMemo, useState } from "react";
import {
  Activity, Boxes, Cpu, Download, FileCog, FileCode2, Gauge, HardDrive, Layers, LayoutDashboard, Menu,
  MessagesSquare, Plug, Server as ServerIcon, ShieldCheck, Terminal, Wrench,
} from "lucide-react";
import { api, subscribeEvents } from "./lib/api";
import type { OsamaEvent, SystemResponse } from "./lib/types";
import { ToastProvider, useToast } from "./components/ui";
import { Dashboard } from "./views/Dashboard";
import { EngineView } from "./views/Engine";
import { ModelsView } from "./views/Models";
import { HubView } from "./views/Hub";
import { ToolView } from "./views/ToolView";
import { ServerView } from "./views/Server";
import { ChatView } from "./views/Chat";
import { ProcessesView } from "./views/Processes";
import { CreateView } from "./views/Create";
import { ArtifactsView } from "./views/Artifacts";
import { McpView } from "./views/Mcp";
import { RunIndicator } from "./components/RunIndicator";

export type ViewId =
  | "dashboard"
  | "chat"
  | "models"
  | "hub"
  | "engine"
  | "server"
  | "run"
  | "create"
  | "quantize"
  | "edit"
  | "lora"
  | "evaluate"
  | "inspect"
  | "processes"
  | "artifacts"
  | "mcp";

/** Every view id, for validating a hash or a stored choice before trusting it. */
const VIEW_IDS: ViewId[] = [
  "dashboard", "chat", "models", "hub", "engine", "server", "run",
  "create", "quantize", "edit", "lora", "evaluate", "inspect", "processes", "artifacts", "mcp",
];

const NAV: Array<{ group: string; items: Array<{ id: ViewId; label: string; icon: typeof Cpu }> }> = [
  {
    group: "Start",
    items: [
      { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
      { id: "chat", label: "Chat", icon: MessagesSquare },
      { id: "artifacts", label: "Artifacts", icon: FileCode2 },
    ],
  },
  {
    group: "Models",
    items: [
      { id: "models", label: "Library", icon: Boxes },
      { id: "hub", label: "Discover", icon: Download },
    ],
  },
  {
    group: "Run",
    items: [
      { id: "server", label: "Server", icon: ServerIcon },
      { id: "processes", label: "Processes", icon: Activity },
    ],
  },
  {
    group: "Tools",
    items: [
      { id: "run", label: "Run CLI", icon: Terminal },
      { id: "quantize", label: "Quantize", icon: Wrench },
      { id: "edit", label: "Edit GGUF", icon: FileCog },
      { id: "lora", label: "Merge LoRA", icon: Layers },
      { id: "evaluate", label: "Evaluate", icon: Gauge },
      { id: "inspect", label: "Inspect", icon: ShieldCheck },
    ],
  },
  {
    group: "System",
    items: [
      { id: "engine", label: "llama.cpp", icon: HardDrive },
      { id: "mcp", label: "MCP", icon: Plug },
    ],
  },
];

export interface EventBus {
  events: OsamaEvent[];
  last: (type: string) => OsamaEvent | undefined;
}

function Shell() {
  const [view, setView] = useState<ViewId>(() => {
    // A `#view` hash wins over the stored choice, so a view can be linked to
    // (and reopened after a reload) without walking the sidebar.
    const hash = window.location.hash.replace(/^#\/?/, "");
    if (hash && VIEW_IDS.includes(hash as ViewId)) return hash as ViewId;
    const saved = localStorage.getItem("osama.view");
    return (saved as ViewId) || "dashboard";
  });
  const [system, setSystem] = useState<SystemResponse | null>(null);
  const [events, setEvents] = useState<OsamaEvent[]>([]);
  const [navOpen, setNavOpen] = useState(false);
  const [insightSlot, setInsightSlot] = useState<HTMLElement | null>(null);
  const toast = useToast();

  useEffect(() => {
    localStorage.setItem("osama.view", view);
    // Keep the hash in step so the address bar reflects where you are.
    const want = `#${view}`;
    if (window.location.hash !== want) window.history.replaceState(null, "", want);
  }, [view]);

  // Follow the hash when it changes (back/forward, or a pasted link).
  useEffect(() => {
    const onHash = () => {
      const h = window.location.hash.replace(/^#\/?/, "");
      if (h && VIEW_IDS.includes(h as ViewId)) setView(h as ViewId);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    api.system().then(setSystem).catch((e) => toast.push("err", `Could not reach Osama engine: ${e.message}`));
  }, [toast]);

  useEffect(() => {
    const unsub = subscribeEvents((e) => {
      setEvents((prev) => [...prev.slice(-400), e]);
      if (e.type === "install" && e.data?.stage === "installed") toast.push("ok", `Installed llama.cpp ${e.data.engine?.tag}`);
      if (e.type === "install" && e.data?.stage === "error") toast.push("err", `Install failed: ${e.data.error}`);
      if (e.type === "download" && e.data?.stage === "done") toast.push("ok", `Downloaded ${e.data.file}`);
      if (e.type === "download" && e.data?.stage === "error") toast.push("err", `Download failed: ${e.data.error}`);
    });
    return unsub;
  }, [toast]);

  const bus: EventBus = useMemo(
    () => ({ events, last: (t: string) => [...events].reverse().find((e) => e.type === t) }),
    [events],
  );

  const title = NAV.flatMap((g) => g.items).find((i) => i.id === view)?.label ?? "";

  return (
    <div className="app">
      <aside className={`sidebar ${navOpen ? "open" : ""}`}>
        <div className="brand">
          <img className="brand-mark brand-logo" src="/logo.png" alt="" aria-hidden="true" />
          <div>
            <div className="brand-name">Osama</div>
            <div className="brand-sub">llama.cpp studio</div>
          </div>
        </div>
        {NAV.map((group) => (
          <div key={group.group}>
            <div className="nav-group-label">{group.group}</div>
            {group.items.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  id={`nav-${item.id}`}
                  className={`nav-item ${view === item.id ? "active" : ""}`}
                  onClick={() => {
                    setView(item.id);
                    setNavOpen(false);
                  }}
                >
                  <Icon />
                  {item.label}
                </button>
              );
            })}
          </div>
        ))}
        {/* The chat view portals its insights in here when it is on screen. */}
        <div id="sidebar-insights-slot" ref={setInsightSlot} />
      </aside>

      <main className="main">
        <header className="topbar">
          <button className="btn ghost icon nav-toggle" onClick={() => setNavOpen((v) => !v)} aria-label="Menu">
            <Menu size={17} />
          </button>
          <h1>{title}</h1>
          <div className="spacer" />
          {/* A turn keeps running when you leave the chat; this says so from
              whatever page you are on, and is the way back to it. */}
          <RunIndicator onOpenChat={() => setView("chat")} />
          {system && (
            <div className="row small faint mono" style={{ gap: 14 }}>
              <span title={system.system.cpuModel}>
                {system.system.os}/{system.system.arch} · {system.system.cpus} cores
              </span>
              <span className="faint">·</span>
              <span className={system.gpu.discrete ? "" : "faint"} title={system.gpu.name}>
                {system.gpu.discrete ? system.gpu.name : "CPU only"}
              </span>
            </div>
          )}
        </header>

        <div className="content">
          <div className="content-inner">
            {view === "dashboard" && <Dashboard system={system} bus={bus} onNavigate={setView} />}
            {view === "chat" && <ChatView system={system} bus={bus} onNavigate={setView} />}
            {view === "models" && <ModelsView bus={bus} onNavigate={setView} />}
            {view === "hub" && <HubView bus={bus} onNavigate={setView} />}
            {view === "engine" && <EngineView system={system} bus={bus} />}
            {view === "server" && <ServerView bus={bus} onNavigate={setView} />}
            {view === "run" && <ToolView group="run" bus={bus} />}
            {view === "create" && <CreateView bus={bus} />}
            {view === "evaluate" && <ToolView group="evaluate" bus={bus} />}
            {view === "inspect" && <ToolView group="inspect" bus={bus} />}
            {view === "quantize" && <ToolView group="create" bus={bus} />}
            {view === "edit" && <ToolView group="edit" bus={bus} />}
            {view === "lora" && <ToolView group="edit" bus={bus} />}
            {view === "processes" && <ProcessesView bus={bus} />}
            {view === "artifacts" && <ArtifactsView bus={bus} />}
            {view === "mcp" && <McpView bus={bus} onNavigate={setView} />}
          </div>
        </div>
      </main>
    </div>
  );
}

export function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
