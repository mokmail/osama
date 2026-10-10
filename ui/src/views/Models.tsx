import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Boxes, Download as DownloadIc, FolderOpen, FolderPlus, HardDrive, MessagesSquare, RefreshCw, Search as SearchIcon, Server as ServerIcon, Sparkles, Square, Trash2 } from "lucide-react";
import { api, mlxApi } from "../lib/api";
import type { LocalModel, ManagedProcess } from "../lib/types";
import { Badge, Button, Card, CardHead, Console, Empty, Field, Spinner, usePoll, useToast } from "../components/ui";
import { ModelLoading, useServerReady, useLoadFailure, FailedLoad } from "../components/ModelLoading";
import { GgufPicker } from "../components/GgufPicker";
import { DiscoverPanel } from "./Hub";
import { bytes, fileBase, shortPath, timeAgo } from "../lib/format";
import type { EventBus } from "../App";
import type { ViewId } from "../App";
import { isModelServer, servedModelPath } from "../lib/procs";
import type { MlxModel, MlxRepoPlan, MlxSearchHit, MlxSource, MlxStatus } from "../lib/types";

/**
 * One llama-server at a time — starting a model replaces whatever is serving.
 *
 * `ctxPresets` are quick-select values shown next to the Library's "Chat with
 * this model" button. They let the user pick a context size at load time
 * without going through the Server view — important because the chat panel
 * shows the served window and a too-small window breaks long sessions.
 */
const SERVER_DEFAULTS = { host: "127.0.0.1", port: 8080, gpuLayers: 999, parallel: 4, jinja: true, metrics: true, ctx: 0 as number };
/** Friendly presets — the actual -c value sent is what the user picks. */
const CTX_PRESETS: Array<{ label: string; tokens: number; note: string }> = [
  { label: "auto",  tokens: 0,    note: "from the model" },
  { label: "4k",    tokens: 4096, note: "small chats" },
  { label: "8k",    tokens: 8192, note: "everyday" },
  { label: "16k",   tokens: 16384, note: "long documents" },
  { label: "32k",   tokens: 32768, note: "long sessions" },
  { label: "64k",   tokens: 65536, note: "deep dives" },
  { label: "128k",  tokens: 131072, note: "very long" },
];

/** Lets the detail panel start a server + navigate without prop-drilling. */
const NavContext = createContext<(v: ViewId) => void>(() => {});
const useNav = () => useContext(NavContext);

export function ModelsView({ bus, onNavigate }: { bus: EventBus; onNavigate: (v: ViewId) => void }) {
  const toast = useToast();
  const [models, setModels] = useState<LocalModel[]>([]);
  const [procs, setProcs] = useState<ManagedProcess[]>([]);
  const [selected, setSelected] = useState<LocalModel | null>(null);
  const [importPath, setImportPath] = useState("");
  const [picking, setPicking] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  /** Mirrors `loading` for the ticking effect above (which must not restart on it). */
  const loadingRef = useRef(false);
  // MLX is a second engine with its own model shape (a directory, not a GGUF),
  // so it is loaded alongside the library rather than inside it.
  const [mlxModels, setMlxModels] = useState<MlxModel[]>([]);
  const [mlxStatus, setMlxStatus] = useState<MlxStatus | null>(null);
  // The MLX catalogue: where models can be fetched from, and what is in flight.
  const [mlxSources, setMlxSources] = useState<MlxSource[]>([]);
  const [mlxSource, setMlxSource] = useState<string>(() => localStorage.getItem("osama.mlxSource") ?? "mlx");
  const [mlxQuery, setMlxQuery] = useState("");
  const [mlxHits, setMlxHits] = useState<MlxSearchHit[]>([]);
  const [mlxNote, setMlxNote] = useState<string | null>(null);
  const [mlxSearching, setMlxSearching] = useState(false);
  const [mlxPlan, setMlxPlan] = useState<MlxRepoPlan | null>(null);

  const load = () => {
    api.models().then((r) => setModels(r.models)).catch(() => {});
    api.processes().then((r) => setProcs(r.processes)).catch(() => {});
    mlxApi.status().then(setMlxStatus).catch(() => {});
    mlxApi.models().then((r) => setMlxModels(r.models)).catch(() => {});
    mlxApi.sources().then((r) => setMlxSources(r.sources)).catch(() => {});
  };
  usePoll(load, 5000);

  useEffect(() => {
    if (bus.events.some((e) => e.type === "download" && e.data?.stage === "done")) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bus.events.length]);

  async function scan() {
    const r = await api.scanModels();
    setModels(r.models);
    toast.push("ok", `Scanned models directory — ${r.models.length} model(s) in library.`);
  }

  async function add() {
    if (!importPath.trim()) return;
    try {
      await api.addModel({ file: importPath.trim() });
      setImportPath("");
      load();
      toast.push("ok", "Model added to library.");
    } catch (e) {
      toast.push("err", (e as Error).message);
    }
  }

  // A load that never finishes must not look like a load that is working: tick
  // while one is in flight so the view can say how long, and offer the way out.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!loadingRef.current) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [loadingRef.current]);

  /** The last MLX failure we told the user about, so it is said once. */
  const lastMlxError = useRef<string | null>(null);
  useEffect(() => {
    const last = bus.events.filter((e) => e.type === "mlx").slice(-1)[0];
    const msg = last?.data?.stage === "error" ? String(last.data.error ?? "") : "";
    if (msg && msg !== lastMlxError.current) {
      lastMlxError.current = msg;
      toast.push("err", msg.slice(0, 240));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bus.events.length]);

  const servers = procs.filter((p) => isModelServer(p) && (p.status === "running" || p.status === "starting"));
  const runningServer = servers.find((p) => p.status === "running");
  const healthReady = useServerReady(runningServer?.url);
  const loading = !!runningServer && !healthReady;
  const busy = pending !== null || loading;
  loadingRef.current = loading;
  const loadingSecs = runningServer ? Math.max(0, Math.round((now - runningServer.startedAt) / 1000)) : 0;
  /** Long enough that a working load would have answered /health by now. */
  const loadStuck = loading && loadingSecs > 120;
  const stopBusy = pending === "__stop__";
  const failure = useLoadFailure(procs);
  const [dismissedFailure, setDismissedFailure] = useState<number | null>(null);
  const showFailure = !!failure && !loading && dismissedFailure !== failure.since;

  /** Which library entry the running server was started from (by file path). */
  const serving = useMemo(() => {
    if (!runningServer) return null;
    const served = servedModelPath(runningServer);
    if (!served) return null;
    const norm = (p: string) => p.replace(/\/+$/, "");
    return models.find((m) => norm(m.file) === norm(served)) ?? null;
  }, [runningServer, models]);

  /** Which MLX directory the running server was started from. */
  const mlxServing = useMemo(() => {
    if (!runningServer) return null;
    const served = servedModelPath(runningServer);
    if (!served) return null;
    const norm = (p: string) => p.replace(/\/+$/, "");
    return mlxModels.find((m) => norm(m.dir) === norm(served)) ?? null;
  }, [runningServer, mlxModels]);

  /** The MLX install log, read out of the event bus (it streams line by line). */
  const mlxEvents = bus.events.filter((e) => e.type === "mlx");
  const mlxLines = mlxEvents
    .map((e) => String(e.data?.line ?? e.data?.error ?? ""))
    .filter((l) => l.length > 0)
    .slice(-30);
  const mlxStage = String(mlxEvents[mlxEvents.length - 1]?.data?.stage ?? "");
  const mlxWorking = mlxStage !== "" && !["done", "installed", "error"].includes(mlxStage);

  /** Install or refresh Osama's MLX environment; the log streams over the bus. */
  async function installMlx() {
    try {
      await mlxApi.install();
      toast.push("info", "Installing the MLX environment — progress streams below.");
    } catch (e) {
      toast.push("err", (e as Error).message);
    }
  }

  useEffect(() => { localStorage.setItem("osama.mlxSource", mlxSource); }, [mlxSource]);

  /** What the MLX card's download strip is showing: only its own downloads. */
  const mlxDownloads = bus.events
    .filter((e) => e.type === "download" && e.data?.kind === "mlx")
    .slice(-6)
    .reverse();
  const mlxFetching = mlxDownloads.some((e) => e.data?.stage === "start" || e.data?.stage === "downloading" || e.data?.stage === "file");
  // A finished fetch is the moment the new directory becomes a model.
  useEffect(() => {
    if (mlxDownloads.some((e) => e.data?.stage === "done")) {
      mlxApi.models().then((r) => setMlxModels(r.models)).catch(() => {});
      mlxApi.status().then(setMlxStatus).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mlxDownloads.length, mlxDownloads[0]?.data?.stage]);

  async function searchMlx() {
    setMlxSearching(true);
    setMlxNote(null);
    setMlxPlan(null);
    try {
      const r = await mlxApi.search(mlxQuery, mlxSource);
      setMlxHits(r.models);
      setMlxNote(r.note ?? (r.models.length ? null : `Nothing matched “${mlxQuery}” in ${mlxSource}.`));
    } catch (e) {
      setMlxHits([]);
      setMlxNote((e as Error).message);
    } finally {
      setMlxSearching(false);
    }
  }

  async function planMlx(ref: string) {
    setMlxPlan(null);
    setMlxNote(null);
    try {
      const r = await mlxApi.repo(ref, mlxSource);
      setMlxPlan(r.plan);
    } catch (e) {
      setMlxNote((e as Error).message);
    }
  }

  async function fetchMlx(plan: MlxRepoPlan) {
    try {
      await mlxApi.download(plan.ref, mlxSource);
      toast.push("info", `Fetching ${plan.ref} — progress below.`);
      setMlxPlan(null);
    } catch (e) {
      toast.push("err", (e as Error).message);
    }
  }

  /**
   * Delete a downloaded model.
   *
   * A model that is loading (or stuck loading) holds its own directory, so the
   * first attempt is refused and the second one — with `force` — stops the server
   * and then deletes. Refusing silently would leave exactly the state this is
   * meant to fix: a model you cannot get rid of.
   */
  async function removeMlx(m: MlxModel, force = false) {
    if (!force && !window.confirm(`Delete ${m.name} from ${m.dir}? The files are removed from disk.`)) return;
    try {
      const r = await mlxApi.remove(m.dir, force);
      toast.push("ok", `${r.stopped?.length ? "Stopped the server · " : ""}Removed ${m.name}.`);
      load();
    } catch (e) {
      const msg = (e as Error).message;
      if (!force && /being served|stop the MLX server/i.test(msg)) {
        if (window.confirm(`${m.name} is being served or is still loading.\n\nStop it and delete the files anyway?`)) {
          await removeMlx(m, true);
          return;
        }
      }
      toast.push("err", msg);
    }
  }

  /**
   * Serve an MLX model and open Chat.
   *
   * MLX is exclusive too: one server at a time, so starting this replaces
   * whatever llama-server was running. The route picks a free port when the
   * default is taken, and the returned process tells us the real URL.
   */
  async function mlxChatWith(m: MlxModel) {
    try {
      const r = await mlxApi.serve({ model: m.dir, host: SERVER_DEFAULTS.host, port: SERVER_DEFAULTS.port });
      const url = r.process.url ?? `http://${SERVER_DEFAULTS.host}:8082`;
      toast.push("info", `${r.stopped?.length ? "Replaced the running server · " : ""}Loading ${m.name} with MLX…`);
      // Watch in the background, releasing the UI first: the card's own loading
      // state (timed, with a Stop) is what the user watches, and holding `pending`
      // across the whole load is what left the view inert for minutes. A load that
      // dies now returns in seconds rather than at the timeout.
      void (async () => {
        const ready = await api.waitForServer(url, 180_000);
        if (ready) {
          toast.push("ok", `Serving ${m.name} on ${url} (MLX)`);
          load();
          onNavigate("chat");
        } else {
          toast.push("warn", `${m.name} did not finish loading — the Library shows what the runtime said.`);
          load();
        }
      })();
    } catch (e) {
      toast.push("err", `Could not start MLX: ${(e as Error).message}`);
      return;
    } finally {
      setPending(null);
    }
  }

  /** Context size picked in the Library picker — persists across opens. */
  const [ctxPick, setCtxPick] = useState<number>(() => {
    const saved = Number(localStorage.getItem("osama.ctxPick") ?? 0);
    return Number.isFinite(saved) ? saved : 0;
  });
  useEffect(() => { localStorage.setItem("osama.ctxPick", String(ctxPick)); }, [ctxPick]);
  const ctxTokens = (() => {
    const p = CTX_PRESETS.find((p) => p.tokens === ctxPick);
    return p ? p.tokens : ctxPick;
  })();

  const pendingName = models.find((m) => m.id === pending)?.name;

  async function chatWith(m: LocalModel) {
    if (serving?.id === m.id) {
      onNavigate("chat");
      return;
    }
    setPending(m.id);
    try {
      const r = await api.startProcess({
        tool: "server",
        exclusive: true,
        values: {
          model: m.file,
          host: SERVER_DEFAULTS.host,
          port: SERVER_DEFAULTS.port,
          gpuLayers: SERVER_DEFAULTS.gpuLayers,
          parallel: SERVER_DEFAULTS.parallel,
          jinja: SERVER_DEFAULTS.jinja,
          metrics: SERVER_DEFAULTS.metrics,
          ctx: ctxTokens > 0 ? ctxTokens : undefined,
        },
      });
      const replaced = (r.stopped?.length ?? 0) > 0;
      const url = r.process.url ?? `http://${SERVER_DEFAULTS.host}:${SERVER_DEFAULTS.port}`;
      toast.push("info", `${replaced ? "Replaced the running server · " : ""}Loading ${m.name}…`);
      // Wait for the model to finish loading before showing Chat — a 30B takes a
      // while and a premature chat box looks broken — but do it in the background
      // so the view is never left waiting on it (and stop early if the load dies).
      void (async () => {
        const ready = await api.waitForServer(url);
        if (ready) {
          toast.push("ok", `Serving ${m.name} on ${url}`);
          load();
          onNavigate("chat");
        } else {
          toast.push("warn", `${m.name} did not finish loading — see the note above the library.`);
          load();
        }
      })();
    } catch (e) {
      toast.push("err", `Could not start the server: ${(e as Error).message}`);
      return;
    } finally {
      setPending(null);
    }
  }

  async function stopServer() {
    if (!runningServer) return;
    setPending("__stop__");
    try {
      await api.stopProcess(runningServer.id);
      toast.push("info", "Server stopped.");
      load();
    } catch (e) {
      toast.push("err", (e as Error).message);
    } finally {
      setPending(null);
    }
  }

  return (
    <NavContext.Provider value={onNavigate}>
      <div className="stack">
        <Card className="card-pad">
          <CardHead
            title="Model library"
            sub="Every GGUF Osama knows about, with real metadata read from the file header."
            right={
              <div className="row" style={{ gap: 8 }}>
                <Button size="sm" onClick={scan}><RefreshCw size={14} /> Scan folder</Button>
              </div>
            }
          />

          <div className="row wrap" style={{ gap: 10, marginBottom: 14 }}>
            <div className="search" style={{ maxWidth: 520 }}>
              <FolderPlus style={{ opacity: 0.6 }} />
              <input
                className="input"
                placeholder="Import an existing .gguf by absolute path — e.g. ~/Downloads/model.gguf"
                value={importPath}
                onChange={(e) => setImportPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && add()}
              />
            </div>
            <Button onClick={add} disabled={!importPath.trim()}>Import</Button>
            <Button variant="ghost" onClick={() => setPicking(true)} title="Browse the disk for a .gguf file">
              <FolderOpen size={14} /> Browse…
            </Button>
          </div>

          {picking && (
            <GgufPicker
              models={models}
              value={importPath}
              onClose={() => setPicking(false)}
              onPick={async (path, opts) => {
                setPicking(false);
                setImportPath(path);
                if (!opts.addToLibrary) return;
                try {
                  await api.addModel({ file: path });
                  load();
                  toast.push("ok", "Model added to library.");
                } catch (e) {
                  toast.push("err", (e as Error).message);
                }
              }}
            />
          )}

          {showFailure && failure && (
            <div style={{ marginBottom: 16 }}>
              <FailedLoad proc={failure.proc} onDismiss={() => setDismissedFailure(failure.since)} />
            </div>
          )}

          {loading && runningServer && (
            <div style={{ marginBottom: 16 }}>
              <ModelLoading
                processId={runningServer.id}
                url={runningServer.url}
                modelName={models.find((m) => m.id === pending)?.name ?? serving?.name ?? runningServer.label.split(" · ").pop()}
                startedAt={runningServer.startedAt}
                onReady={load}
                onError={(m: string) => toast.push("err", `llama-server failed to load the model: ${m.slice(0, 160)}`)}
              />
            </div>
          )}

          {(runningServer || loading || servers.length > 0) && (
            <div className="row wrap" style={{ gap: 10, marginBottom: 14, alignItems: "center" }}>
              {loading ? (
                <Badge kind="info"><span className="dot" /> loading… {Math.floor(loadingSecs / 60)}m {String(loadingSecs % 60).padStart(2, "0")}s</Badge>
              ) : (
                <Badge kind="ok"><span className="dot" /> serving</Badge>
              )}
              <span className="mono small">{serving?.name ?? mlxServing?.name ?? runningServer?.label.split(" · ").pop() ?? "another model"}</span>
              <span className="faint small">on {runningServer?.url ?? "—"} · starting another model replaces it</span>
              <div className="spacer" style={{ flex: 1 }} />
              {/* Never disabled while loading: this is what gets a stuck load out. */}
              <Button
                size="sm"
                variant="danger"
                onClick={stopServer}
                disabled={stopBusy}
                title="Sends SIGTERM, then SIGKILL if the process will not go"
              >
                {stopBusy ? <Spinner /> : <Square size={13} />} {loadStuck ? "Force stop" : "Stop server"}
              </Button>
            </div>
          )}

          {loadStuck && (
            <div className="help" style={{ color: "var(--warn)", marginBottom: 12 }}>
              Still loading after {Math.floor(loadingSecs / 60)}m {String(loadingSecs % 60).padStart(2, "0")}s — this model is
              probably not going to load. Stop frees the port and the memory, and the model can be deleted afterwards.
            </div>
          )}

          <div className="ctx-picker" role="group" aria-label="Context window on load">
            <span className="ctx-picker-label">Context window</span>
            <div className="ctx-picker-presets">
              {CTX_PRESETS.map((p) => (
                <button
                  key={p.tokens}
                  className={`ctx-pill ${ctxPick === p.tokens ? "active" : ""}`}
                  onClick={() => setCtxPick(p.tokens)}
                  title={p.note}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <input
              className="input ctx-picker-custom"
              type="number"
              min={0}
              step={1024}
              value={ctxPick}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) setCtxPick(Math.max(0, Math.floor(n)));
              }}
              placeholder="tokens"
              title="Custom context size (0 = from model)"
            />
            <span className="faint small">
              applied on load
              {ctxPick > 0 && (() => {
                const trained = selected?.card?.contextLength ?? models.find((m) => m.id === serving?.id)?.card?.contextLength;
                return trained ? ` · this model was trained with ${trained.toLocaleString()} tok` : "";
              })()}
              {(() => {
                const trained = selected?.card?.contextLength;
                return trained && ctxPick > trained ? " · WARNING: above the trained length — memory use rises, quality may degrade" : "";
              })()}
            </span>
          </div>

          {models.length === 0 ? (
            <Empty
              icon={<Boxes size={28} />}
              title="No models in the library"
              sub="Download one from Discover, or import an existing GGUF file."
              action={
                <Button variant="primary" onClick={() => document.getElementById("discover")?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                  Discover models
                </Button>
              }
            />
          ) : (
            <div className="grid-3">
              {models.map((m) => (
                <div key={m.id} className={`tile ${serving?.id === m.id ? "active" : ""}`} onClick={() => setSelected(m)}>
                  <div className="title" title={m.name}>{m.name}</div>
                  <div className="sub">
                    {m.card?.quantization && <Badge kind="accent">{m.card.quantization}</Badge>}
                    {m.card?.architecture && <Badge>{m.card.architecture}</Badge>}
                    {serving?.id === m.id && <Badge kind="ok"><span className="dot" /> serving</Badge>}
                    {m.draftOnly && <Badge kind="warn">draft head</Badge>}
                    {m.missing && <Badge kind="danger">file missing</Badge>}
                  </div>
                  <div className="row faint small" style={{ justifyContent: "space-between" }}>
                    <span>{bytes(m.sizeBytes)}</span>
                    {m.card?.contextLength && <span>{Math.round(m.card.contextLength / 1024)}k ctx</span>}
                  </div>
                  {!m.missing && !m.draftOnly && (
                    <Button size="sm" variant={serving?.id === m.id ? "ghost" : "primary"} disabled={busy} onClick={(e) => { e.stopPropagation(); chatWith(m); }}>
                      {busy && (pending === m.id || serving?.id === m.id) ? <Spinner /> : <MessagesSquare size={13} />}
                      {serving?.id === m.id ? (loading ? "Loading…" : "Open chat") : "Chat with this model"}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
          {busy && pending && <div className="faint small" style={{ marginTop: 12 }}>Starting {pendingName} — stopping any other llama-server first…</div>}
        </Card>

        {mlxStatus?.support.supported && (
          <Card className="card-pad">
            <CardHead
              title="MLX models"
              sub="Apple's own runtime — safetensors directories served by mlx-lm, alongside the GGUF library"
              right={
                <div className="row" style={{ gap: 8 }}>
                  {mlxStatus.runtime.ready ? (
                    <Badge kind="ok">
                      {mlxStatus.runtime.source === "managed" ? "Osama's environment" : "system python"} · mlx-lm {mlxStatus.runtime.mlxLmVersion ?? "?"}
                    </Badge>
                  ) : (
                    <Badge kind="warn">no runtime</Badge>
                  )}
                  <Button size="sm" variant="ghost" disabled={mlxWorking} onClick={installMlx} title="Create or update Osama's own MLX environment with uv">
                    {mlxWorking ? <Spinner /> : <Sparkles size={13} />} {mlxStatus.runtime.source === "managed" ? "Update" : "Install"}
                  </Button>
                </div>
              }
            />

            <div className="small muted">{mlxStatus.runtime.detail}</div>

            {mlxLines.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <Console lines={mlxLines} max={12} />
              </div>
            )}

            {!mlxStatus.runtime.ready ? (
              <div style={{ marginTop: 12 }}>
                <Empty
                  icon={<Sparkles size={26} />}
                  title="No MLX runtime yet"
                  sub={mlxStatus.runtime.uv ? "Press Install and Osama builds its own environment with uv — a venv plus mlx-lm." : "Install uv first (brew install uv), then press Install."}
                />
              </div>
            ) : mlxModels.length === 0 ? (
              <div style={{ marginTop: 12 }}>
                <Empty
                  icon={<Boxes size={26} />}
                  title="No MLX models on this machine"
                  sub="Search the catalogue below — Osama fetches the whole repo (config, tokenizer, weights) into its models directory."
                />
              </div>
            ) : (
              <div className="grid-3" style={{ marginTop: 12 }}>
                {mlxModels.map((m) => (
                  <div key={m.dir} className={`tile ${mlxServing?.dir === m.dir ? "active" : ""}`} title={m.dir}>
                    <div className="title" title={m.name}>{m.name}</div>
                    <div className="sub">
                      {m.servable === false && <Badge kind="warn">not servable</Badge>}
                      {m.quantization?.bits ? <Badge kind="accent">{m.quantization.bits}-bit{m.quantization.groupSize ? ` g${m.quantization.groupSize}` : ""}</Badge> : null}
                      {m.architecture && <Badge>{m.architecture}</Badge>}
                      {m.hasAdapter && <Badge kind="warn">adapter</Badge>}
                      {mlxServing?.dir === m.dir && <Badge kind="ok"><span className="dot" /> serving</Badge>}
                    </div>
                    <div className="row faint small" style={{ justifyContent: "space-between" }}>
                      <span>{bytes(m.sizeBytes)}</span>
                      {m.contextLength ? <span>{Math.round(m.contextLength / 1024)}k ctx</span> : null}
                    </div>
                    <div className="row" style={{ gap: 8, alignItems: "center" }}>
                      <Button
                        size="sm"
                        variant={mlxServing?.dir === m.dir ? "ghost" : "primary"}
                        disabled={busy || m.servable === false}
                        title={m.servable === false ? m.servableNote : undefined}
                        onClick={() => mlxChatWith(m)}
                      >
                        {busy && pending === `mlx:${m.dir}` ? <Spinner /> : <MessagesSquare size={13} />}
                        {mlxServing?.dir === m.dir ? (loading ? "Loading…" : "Open chat") : "Serve with MLX"}
                      </Button>
                      {mlxServing?.dir === m.dir && runningServer && (
                        <Button size="sm" variant="danger" onClick={stopServer} disabled={stopBusy} title="Stop the MLX server">
                          {stopBusy ? <Spinner /> : <Square size={13} />} Stop
                        </Button>
                      )}
                      {m.origin === "models-dir" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Delete this model's files from disk"
                          onClick={() => void removeMlx(m)}
                        >
                          <Trash2 size={13} />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {mlxStatus.runtime.ready && (
              <div style={{ marginTop: 16 }}>
                <div className="hr" />
                <div className="row wrap" style={{ gap: 8, alignItems: "center", marginBottom: 8 }}>
                  <span className="small muted" style={{ fontWeight: 600 }}>Get models</span>
                  <select
                    className="select"
                    style={{ maxWidth: 220 }}
                    value={mlxSource}
                    onChange={(e) => { setMlxSource(e.target.value); setMlxHits([]); setMlxPlan(null); setMlxNote(null); }}
                    aria-label="MLX source"
                  >
                    {mlxSources.map((src) => (
                      <option key={src.id} value={src.id}>{src.label}</option>
                    ))}
                  </select>
                  {(mlxSources.find((x) => x.id === mlxSource)?.searchable ?? true) ? (
                    <>
                      <input
                        className="input"
                        style={{ flex: 1, minWidth: 200 }}
                        value={mlxQuery}
                        spellCheck={false}
                        placeholder="search the MLX catalogue — e.g. Qwen3, gemma, Llama-3.2"
                        onChange={(e) => setMlxQuery(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); void searchMlx(); } }}
                      />
                      <Button size="sm" disabled={mlxSearching} onClick={() => void searchMlx()}>
                        {mlxSearching ? <Spinner /> : <SearchIcon size={13} />} Search
                      </Button>
                    </>
                  ) : (
                    <>
                      <input
                        className="input"
                        style={{ flex: 1, minWidth: 220 }}
                        value={mlxQuery}
                        spellCheck={false}
                        placeholder={mlxSource === "hf-mirror" ? "owner/repo — fetched through hf-mirror.com" : "owner/repo, or a huggingface.co link"}
                        onChange={(e) => setMlxQuery(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter" && mlxQuery.trim()) { e.stopPropagation(); void planMlx(mlxQuery.trim()); } }}
                      />
                      <Button size="sm" disabled={!mlxQuery.trim()} onClick={() => void planMlx(mlxQuery.trim())}>
                        <SearchIcon size={13} /> Look up
                      </Button>
                    </>
                  )}
                </div>
                <div className="faint small" style={{ marginBottom: 8 }}>
                  {mlxSources.find((x) => x.id === mlxSource)?.note}
                </div>

                {mlxNote && <div className="help" style={{ marginBottom: 8 }}>{mlxNote}</div>}

                {mlxPlan && (
                  <div className="card card-pad" style={{ marginBottom: 10 }}>
                    <div className="row wrap" style={{ gap: 10, alignItems: "center" }}>
                      <span className="mono small" style={{ flex: 1, minWidth: 160 }}>{mlxPlan.ref}</span>
                      {mlxPlan.quantization?.bits ? <Badge kind="accent">{mlxPlan.quantization.bits}-bit{mlxPlan.quantization.groupSize ? ` g${mlxPlan.quantization.groupSize}` : ""}</Badge> : null}
                      {mlxPlan.contextLength ? <Badge>{Math.round(mlxPlan.contextLength / 1024)}k ctx</Badge> : null}
                      {mlxPlan.architecture && <Badge>{mlxPlan.architecture}</Badge>}
                      <Badge>{bytes(mlxPlan.weightsBytes)} weights</Badge>
                      <Badge>{mlxPlan.files.length} files · {bytes(mlxPlan.totalBytes)}</Badge>
                      {mlxPlan.gated && <Badge kind="warn">gated</Badge>}
                    </div>
                    {mlxPlan.warning && (
                      <div className="help" style={{ color: "var(--warn)", marginTop: 8 }}>{mlxPlan.warning}</div>
                    )}
                    <div className="row wrap" style={{ gap: 9, marginTop: 10, alignItems: "center" }}>
                      <Button size="sm" variant="primary" disabled={mlxFetching || mlxSearching} onClick={() => void fetchMlx(mlxPlan)}>
                        {mlxFetching ? <Spinner /> : <DownloadIc size={13} />} Fetch {bytes(mlxPlan.totalBytes)}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setMlxPlan(null)}>Cancel</Button>
                      <span className="faint small">
                        support files first, weights last — the model appears here only once it is whole
                      </span>
                    </div>
                  </div>
                )}

                {mlxHits.length > 0 && (
                  <div style={{ maxHeight: 280, overflowY: "auto", border: "1px solid var(--border)" }}>
                    {mlxHits.map((h) => (
                      <button
                        key={`${h.source}:${h.ref}`}
                        type="button"
                        className="dirow-main"
                        style={{ width: "100%", padding: "8px 10px", borderBottom: "1px solid var(--border)" }}
                        onClick={() => { setMlxQuery(h.ref); void planMlx(h.ref); }}
                        title="See what fetching this costs"
                      >
                        <span className="row" style={{ gap: 10, alignItems: "center", flex: 1, minWidth: 0 }}>
                          <span className="dirow-name" style={{ fontWeight: 500 }}>{h.name}</span>
                          {h.author && <span className="faint small">{h.author}</span>}
                          {h.tags.slice(0, 2).map((t) => <Badge key={t}>{t}</Badge>)}
                          <span style={{ flex: 1 }} />
                          {typeof h.downloads === "number" && <span className="faint small mono">{h.downloads.toLocaleString()} ↓</span>}
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                {mlxDownloads.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    {mlxDownloads.map((e, i) => {
                      const d = e.data ?? {};
                      const pct = d.total ? Math.round(((d.received ?? 0) / d.total) * 100) : null;
                      const label = d.stage === "error"
                        ? `${d.repo}: ${String(d.error ?? "failed").slice(0, 120)}`
                        : d.stage === "done"
                          ? `${d.repo} — fetched`
                          : `${d.repo}${d.file ? ` · ${d.file}` : ""}${d.index && d.count ? ` (${d.index}/${d.count})` : ""}`;
                      return (
                        <div key={`${d.id ?? i}-${d.file ?? d.stage}`} className="small" style={{ marginBottom: 4 }}>
                          <span className={d.stage === "error" ? "" : "faint"} style={d.stage === "error" ? { color: "var(--warn)" } : undefined}>
                            {label}
                          </span>
                          {pct !== null && d.stage === "downloading" && <span className="faint mono small"> · {pct}%</span>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </Card>
        )}

        <DiscoverPanel bus={bus} onNavigate={onNavigate} onInstalled={load} />

        {selected && <ModelDetail model={selected} onClose={() => setSelected(null)} onNavigate={onNavigate} onChanged={() => { load(); setSelected(null); }} />}
      </div>
    </NavContext.Provider>
  );
}

function ModelDetail({ model, onClose, onNavigate, onChanged }: { model: LocalModel; onClose: () => void; onNavigate: (v: ViewId) => void; onChanged: () => void }) {
  const toast = useToast();
  const nav = useNav();
  const c = model.card;
  const gb = model.sizeBytes / 1024 ** 3;
  const [starting, setStarting] = useState(false);
  /** Detail panel uses the same persisted ctx pick as the list view. */
  const ctxTokens = (() => {
    const saved = Number(localStorage.getItem("osama.ctxPick") ?? 0);
    return Number.isFinite(saved) ? saved : 0;
  })();

  /** Start a server for THIS model (replacing any other), then open Chat. */
  async function chat() {
    setStarting(true);
    try {
      const r = await api.startProcess({
        tool: "server",
        exclusive: true,
        values: {
          model: model.file,
          host: SERVER_DEFAULTS.host,
          port: SERVER_DEFAULTS.port,
          gpuLayers: SERVER_DEFAULTS.gpuLayers,
          parallel: SERVER_DEFAULTS.parallel,
          jinja: SERVER_DEFAULTS.jinja,
          metrics: SERVER_DEFAULTS.metrics,
          ctx: ctxTokens > 0 ? ctxTokens : undefined,
        },
      });
      const replaced = (r.stopped?.length ?? 0) > 0;
      const url = r.process.url ?? "the default port";
      toast.push("info", `${replaced ? "Replaced the running server · " : ""}Loading ${model.name}…`);
      const ready = await api.waitForServer(typeof url === "string" && url.startsWith("http") ? url : `http://${SERVER_DEFAULTS.host}:${SERVER_DEFAULTS.port}`);
      toast.push(ready ? "ok" : "warn", ready ? `Serving ${model.name} on ${url}` : `${model.name} is still loading — give it a moment.`);
      nav("chat");
    } catch (e) {
      toast.push("err", `Could not start the server: ${(e as Error).message}`);
    } finally {
      setStarting(false);
    }
  }

  return (
    <Card className="card-pad">
      <CardHead
        title={model.name}
        sub={model.repo ?? (model.external ? "imported file" : "downloaded")}
        right={<Button variant="ghost" size="sm" onClick={onClose}>Close</Button>}
      />

      <div className="grid-2">
        <dl className="kv">
          <dt>File</dt><dd className="mono small">{shortPath(model.file, 60)}</dd>
          <dt>Size</dt><dd>{bytes(model.sizeBytes)} <span className="faint">({gb.toFixed(2)} GB)</span></dd>
          <dt>Added</dt><dd>{timeAgo(model.addedAt)}</dd>
          <dt>Architecture</dt><dd>{c?.architecture ?? "—"}</dd>
          <dt>Quantization</dt><dd>{c?.quantization ?? "—"} {c?.fileType !== undefined && <span className="faint">(file_type {c.fileType})</span>}</dd>
          <dt>Context length</dt><dd>{c?.contextLength ? c.contextLength.toLocaleString() : "—"}</dd>
          <dt>Embedding dim</dt><dd>{c?.embeddingLength ?? "—"}</dd>
          <dt>Tokenizer</dt><dd>{c?.tokenizerModel ?? "—"}</dd>
          <dt>Chat template</dt><dd>{c?.chatTemplate ? <Badge kind="ok">present</Badge> : <Badge kind="warn">missing</Badge>}</dd>
        </dl>

        <div className="stack">
          <div className="stat">
            <span className="l">Estimated GPU layers to fit {gb.toFixed(1)} GB</span>
            <span className="n">{gb > 12 ? "partial offload" : "full offload (-ngl 999)"}</span>
          </div>
          <div className="stack" style={{ gap: 8 }}>
            <Button variant="primary" onClick={chat} disabled={starting || model.missing || model.draftOnly}>
              {starting ? <Spinner /> : <MessagesSquare size={15} />} Chat with this model
            </Button>
            <Button onClick={() => onNavigate("server")} disabled={model.draftOnly}><ServerIcon size={15} /> Serve as API</Button>
            <Button onClick={() => onNavigate("create")}><HardDrive size={15} /> Quantize / split</Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (!confirm(`Remove “${model.name}” from the library${model.external ? "" : " and delete its file"}?`)) return;
                await api.removeModel(model.id, !model.external);
                toast.push("ok", "Model removed.");
                onChanged();
              }}
            >
              <Trash2 size={15} /> Remove from library
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
