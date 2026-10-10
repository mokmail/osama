import { useEffect, useState } from "react";
import { Copy, Eye, EyeOff, Play, RefreshCw, Square } from "lucide-react";
import { api } from "../lib/api";
import type { LocalModel, ManagedProcess, ToolSpec } from "../lib/types";
import { Badge, Button, Card, CardHead, Console, Field, Spinner, StatusDot, usePoll, useToast } from "../components/ui";
import { ModelLoading, useServerReady, useLoadFailure, FailedLoad } from "../components/ModelLoading";
import { bytes } from "../lib/format";
import type { EventBus } from "../App";
import type { ViewId } from "../App";

export function ServerView({ bus, onNavigate }: { bus: EventBus; onNavigate: (v: ViewId) => void }) {
  const toast = useToast();
  const [models, setModels] = useState<LocalModel[]>([]);
  const [spec, setSpec] = useState<ToolSpec | null>(null);
  const [procs, setProcs] = useState<ManagedProcess[]>([]);
  const [model, setModel] = useState("");
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState(8080);
  const [ctx, setCtx] = useState<number | "">("");
  const [gpuLayers, setGpuLayers] = useState<number | "">(999);
  const [parallel, setParallel] = useState<number | "">(4);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [jinja, setJinja] = useState(true);
  const [metrics, setMetrics] = useState(true);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState("");
  const [health, setHealth] = useState<{ ok: boolean; status?: number; body?: string; error?: string } | null>(null);
  const [props, setProps] = useState<any>(null);

  const load = () => api.processes().then((r) => setProcs(r.processes)).catch(() => {});
  usePoll(load, 4000);

  useEffect(() => {
    api.models().then((r) => {
      setModels(r.models);
      setModel((m) => m || r.models[0]?.file || "");
    });
    api.tools().then((r) => setSpec(r.tools.find((t) => t.id === "server") ?? null));
  }, []);

  const valueMap = () => ({
    model,
    host,
    port,
    ctx: ctx === "" ? undefined : ctx,
    gpuLayers: gpuLayers === "" ? undefined : gpuLayers,
    parallel: parallel === "" ? undefined : parallel,
    apiKey: apiKey || undefined,
    jinja: jinja || undefined,
    metrics: metrics || undefined,
  });

  useEffect(() => {
    if (!spec) return;
    const t = setTimeout(() => {
      api.preview("server", valueMap()).then((r) => setPreview(r.command)).catch(() => {});
    }, 150);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, model, host, port, ctx, gpuLayers, parallel, apiKey, jinja, metrics]);

  const servers = procs.filter((p) => p.tool.includes("llama-server"));
  const running = servers.find((p) => p.status === "running");
  const healthReady = useServerReady(running?.url);
  const loading = !!running && !healthReady;
  const failure = useLoadFailure(procs);
  const [dismissedFailure, setDismissedFailure] = useState<number | null>(null);
  const showFailure = !!failure && !loading && dismissedFailure !== failure.since;
  const baseUrl = running?.url ?? `http://${host}:${port}`;

  useEffect(() => {
    const t = setInterval(() => {
      if (running) {
        api.serverHealth(baseUrl).then(setHealth).catch(() => setHealth({ ok: false, error: "unreachable" }));
        api.serverProps(baseUrl).then((r) => setProps(r.ok ? r.props : null)).catch(() => setProps(null));
      }
    }, 4000);
    if (running) api.serverHealth(baseUrl).then(setHealth);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running?.id, baseUrl]);

  async function start() {
    if (!model) {
      toast.push("err", "Choose a model first.");
      return;
    }
    setBusy(true);
    try {
      const r = await api.startProcess({ tool: "server", values: valueMap() });
      toast.push("ok", `llama-server started on ${host}:${port}`);
      setPreview(r.command);
      load();
    } catch (e) {
      toast.push("err", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function stop(id: string) {
    await api.stopProcess(id);
    toast.push("info", "Server stopped.");
    load();
  }

  const logLines = bus.events
    .filter((e) => e.type === "process" && e.data?.line && servers.some((s) => s.id === e.data.id))
    .slice(-300)
    .map((e) => e.data.line as string);

  return (
    <div className="stack">
      {showFailure && failure && (
        <FailedLoad proc={failure.proc} onDismiss={() => setDismissedFailure(failure.since)} />
      )}

      {loading && running && (
        <ModelLoading
          processId={running.id}
          url={running.url}
          modelName={models.find((m) => m.file === model)?.name ?? running.label.split(" · ").pop()}
          startedAt={running.startedAt}
          onReady={load}
          onError={(m: string) => toast.push("err", `llama-server failed to load the model: ${m.slice(0, 160)}`)}
        />
      )}

      <Card className="card-pad">
        <CardHead
          title="llama-server"
          sub="OpenAI- and Anthropic-compatible HTTP API with the built-in web UI."
          right={
            <div className="row" style={{ gap: 8 }}>
              {running ? (loading ? <Badge kind="info"><span className="dot" /> loading on {running.url}</Badge> : <Badge kind="ok"><span className="dot" /> running on {running.url}</Badge>) : <Badge>stopped</Badge>}
            </div>
          }
        />

        <div className="grid-2">
          <Field label="Model">
            <select className="select" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">— choose a model —</option>
              {models.filter((m) => !m.draftOnly).map((m) => (
                <option key={m.id} value={m.file}>
                  {m.name} · {m.card?.quantization ?? "?"} · {bytes(m.sizeBytes)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Context size" help="0 = use the model's trained context.">
            <input className="input" type="number" value={ctx} onChange={(e) => setCtx(e.target.value === "" ? "" : Number(e.target.value))} placeholder="model default" />
          </Field>
          <Field label="GPU layers (-ngl)" help="999 offloads every layer to the GPU. Metal/CUDA accelerate aggressively.">
            <input className="input" type="number" value={gpuLayers} onChange={(e) => setGpuLayers(e.target.value === "" ? "" : Number(e.target.value))} />
          </Field>
          <Field label="Parallel slots" help="Concurrent requests the server can handle.">
            <input className="input" type="number" value={parallel} onChange={(e) => setParallel(e.target.value === "" ? "" : Number(e.target.value))} />
          </Field>
          <Field label="Host" help="0.0.0.0 exposes the server on your LAN.">
            <input className="input" value={host} onChange={(e) => setHost(e.target.value)} />
          </Field>
          <Field label="Port">
            <input className="input" type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
          </Field>
          <Field label="API key" help="Optional — when set, clients must send this as a bearer token.">
            <div className="row" style={{ gap: 6 }}>
              <input className="input" type={showKey ? "text" : "password"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="(none)" />
              <Button size="sm" variant="ghost" onClick={() => setShowKey((v) => !v)} title={showKey ? "Hide" : "Show"}>
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </Button>
            </div>
          </Field>
          <div className="row wrap" style={{ gap: 16, alignItems: "flex-end" }}>
            <label className="check"><input type="checkbox" checked={jinja} onChange={(e) => setJinja(e.target.checked)} /> Jinja chat template</label>
            <label className="check"><input type="checkbox" checked={metrics} onChange={(e) => setMetrics(e.target.checked)} /> Prometheus /metrics</label>
          </div>
        </div>

        <div className="hr" />
        <div className="small muted" style={{ fontWeight: 600, marginBottom: 6 }}>Command</div>
        <div className="console" style={{ maxHeight: 110, minHeight: 0 }}>{preview || "…"}</div>

        <div className="row wrap" style={{ marginTop: 14 }}>
          {running ? (
            <Button variant="danger" onClick={() => stop(running.id)}><Square size={14} /> Stop server</Button>
          ) : (
            <Button variant="primary" onClick={start} disabled={busy || !model}>
              {busy ? <Spinner /> : <Play size={15} />} Start server
            </Button>
          )}
          <Button variant="ghost" onClick={() => navigator.clipboard.writeText(`${baseUrl}/v1`)}>
            <Copy size={14} /> Copy base URL
          </Button>
        </div>
      </Card>

      {running && (
        <div className="grid-2">
          <Card className="card-pad">
            <CardHead
              title="Endpoint"
              right={<Button size="sm" variant="ghost" onClick={() => api.serverHealth(baseUrl).then(setHealth)}><RefreshCw size={13} /> check</Button>}
            />
            <dl className="kv">
              <dt>Base URL</dt><dd className="mono small">{baseUrl}/v1</dd>
              <dt>Chat</dt><dd className="mono small">POST {baseUrl}/v1/chat/completions</dd>
              <dt>Embeddings</dt><dd className="mono small">POST {baseUrl}/v1/embeddings</dd>
              <dt>Models</dt><dd className="mono small">GET {baseUrl}/v1/models</dd>
              <dt>Health</dt><dd>{health ? (health.ok ? <Badge kind="ok">ok ({health.status})</Badge> : <Badge kind="danger">{health.error ?? health.status}</Badge>) : "…"}</dd>
              <dt>Loaded model</dt><dd className="small">{props?.model_path ? String(props.model_path).split("/").pop() : "—"}</dd>
              <dt>Context</dt><dd className="small">{props?.default_generation_settings?.n_ctx ?? props?.n_ctx ?? "—"}</dd>
            </dl>
          </Card>
          <Card className="card-pad">
            <CardHead title="Connect an agent" sub="Point any OpenAI-compatible client here." />
            <div className="console" style={{ maxHeight: 180 }}>
              {`# curl\ncurl ${baseUrl}/v1/chat/completions \\\n  -H "Content-Type: application/json" \\\n${apiKey ? `  -H "Authorization: Bearer ${apiKey}" \\\n` : ""}  -d '{"messages":[{"role":"user","content":"hello"}]}'\n\n# Open WebUI / LangChain / Hermes\nbase_url: ${baseUrl}/v1\nmodel: ${model.split("/").pop() ?? "local-model"}${apiKey ? `\napi_key: ${apiKey.replace(/./g, "•")}` : ""}`}
            </div>
          </Card>
        </div>
      )}

      <Card className="card-pad">
        <CardHead title="Server log" right={<Button size="sm" variant="ghost" onClick={() => onNavigate("processes")}>All processes</Button>} />
        <Console lines={logLines.length ? logLines : (running ? ["waiting for output…"] : ["no server running"])} />
      </Card>
    </div>
  );
}
