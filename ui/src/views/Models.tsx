import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Boxes, FolderPlus, HardDrive, MessagesSquare, RefreshCw, Server as ServerIcon, Square, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import type { LocalModel, ManagedProcess } from "../lib/types";
import { Badge, Button, Card, CardHead, Empty, Field, Spinner, usePoll, useToast } from "../components/ui";
import { ModelLoading, useServerReady, useLoadFailure, FailedLoad } from "../components/ModelLoading";
import { bytes, fileBase, shortPath, timeAgo } from "../lib/format";
import type { EventBus } from "../App";
import type { ViewId } from "../App";

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
  const [pending, setPending] = useState<string | null>(null);

  const load = () => {
    api.models().then((r) => setModels(r.models)).catch(() => {});
    api.processes().then((r) => setProcs(r.processes)).catch(() => {});
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

  const servers = procs.filter((p) => p.tool.includes("llama-server") && (p.status === "running" || p.status === "starting"));
  const runningServer = servers.find((p) => p.status === "running");
  const healthReady = useServerReady(runningServer?.url);
  const loading = !!runningServer && !healthReady;
  const busy = pending !== null || loading;
  const failure = useLoadFailure(procs);
  const [dismissedFailure, setDismissedFailure] = useState<number | null>(null);
  const showFailure = !!failure && !loading && dismissedFailure !== failure.since;

  /** Which library entry the running server was started from (by file path). */
  const serving = useMemo(() => {
    if (!runningServer) return null;
    const i = runningServer.argv.findIndex((a) => a === "-m" || a === "--model");
    const served = i >= 0 ? runningServer.argv[i + 1] : undefined;
    if (!served) return null;
    const norm = (p: string) => p.replace(/\/+$/, "");
    return models.find((m) => norm(m.file) === norm(served)) ?? null;
  }, [runningServer, models]);

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
      // Wait for the model to actually finish loading before showing Chat —
      // a 30B takes a while and a premature chat box looks broken.
      const ready = await api.waitForServer(url);
      toast.push(ready ? "ok" : "warn", ready ? `Serving ${m.name} on ${url}` : `${m.name} is still loading — give it a moment.`);
      load();
      onNavigate("chat");
    } catch (e) {
      toast.push("err", `Could not start the server: ${(e as Error).message}`);
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
          </div>

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

          {runningServer && (
            <div className="row wrap" style={{ gap: 10, marginBottom: 14 }}>
              <Badge kind="ok"><span className="dot" /> serving</Badge>
              <span className="mono small">{serving?.name ?? "another model"}</span>
              <span className="faint small">on {runningServer.url ?? "—"} · starting another model replaces it</span>
              <div className="spacer" style={{ flex: 1 }} />
              <Button size="sm" variant="danger" onClick={stopServer} disabled={busy}>
                {busy ? <Spinner /> : <Square size={13} />} Stop server
              </Button>
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
              action={<Button variant="primary" onClick={() => onNavigate("hub")}>Discover models</Button>}
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
