import { useEffect, useMemo, useState } from "react";
import { Play, Settings2, Terminal, Zap } from "lucide-react";
import { api } from "../lib/api";
import type { LocalModel, ManagedProcess, ParamSpec, ToolSpec } from "../lib/types";
import { Badge, Button, Card, CardHead, Console, Empty, Field, Spinner, useToast } from "../components/ui";
import { bytes } from "../lib/format";
import type { EventBus } from "../App";

type Values = Record<string, string | number | boolean | undefined>;

const GROUP_ORDER = ["Model", "Performance", "Prompt", "Sampling", "Constraints", "Display", "Quantize", "Benchmark", "Batched", "Perplexity", "IMatrix", "Split", "Tokenize", "Embedding", "Hash", "Fit", "TTS", "LoRA", "RPC", "Multimodal", "Serving", "Network"];

export function ToolView({ group, bus }: { group: string; bus: EventBus }) {
  const [tools, setTools] = useState<ToolSpec[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    api.tools().then((r) => {
      const list = r.tools.filter((t) => t.group === group);
      setTools(list);
      setActiveId((cur) => cur ?? list[0]?.id ?? null);
    });
  }, [group]);

  const active = tools.find((t) => t.id === activeId) ?? null;

  return (
    <div className="stack">
      <div className="tabs">
        {tools.map((t) => (
          <button key={t.id} className={`tab ${activeId === t.id ? "active" : ""}`} onClick={() => setActiveId(t.id)}>
            {t.title}
          </button>
        ))}
      </div>
      {active ? <ToolRunner spec={active} bus={bus} /> : <Empty title="No tools in this group" />}
    </div>
  );
}

export function ToolRunner({ spec, bus }: { spec: ToolSpec; bus: EventBus }) {
  const toast = useToast();
  const [models, setModels] = useState<LocalModel[]>([]);
  const [values, setValues] = useState<Values>({});
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [preview, setPreview] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [runResult, setRunResult] = useState<{ code: number | null; durationMs: number } | null>(null);

  useEffect(() => {
    api.models().then((r) => setModels(r.models)).catch(() => {});
  }, []);

  // seed defaults whenever the tool changes
  useEffect(() => {
    const v: Values = {};
    for (const p of spec.params) if (p.default !== undefined) v[p.key] = p.default;
    setValues(v);
    setLines([]);
    setRunResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.id]);

  // live command preview (debounced)
  useEffect(() => {
    const t = setTimeout(() => {
      api.preview(spec.id, values).then((r) => setPreview(r.command)).catch(() => setPreview(""));
    }, 120);
    return () => clearTimeout(t);
  }, [spec.id, values]);

  const groups = useMemo(() => orderedGroups(spec.params), [spec.params]);
  const advanced = useMemo(() => groups.filter((g) => spec.params.filter((p) => p.group === g).every((p) => p.advanced)), [groups, spec.params]);

  async function run() {
    setBusy(true);
    setLines([`$ ${preview}`]);
    setRunResult(null);
    try {
      await api.run({ tool: spec.id, values });
      toast.push("info", `${spec.title} started — output streams below.`);
    } catch (e) {
      toast.push("err", (e as Error).message);
      setBusy(false);
    }
  }

  // collect streamed lines for this tool
  useEffect(() => {
    const relevant = bus.events.filter((e) => e.type === "run" && e.data?.tool === spec.id);
    const last = relevant.slice(-1)[0];
    if (!last) return;
    if (last.data.line) setLines((l) => [...l.slice(-800), last.data.line]);
    if (last.data.stage === "done") {
      setBusy(false);
      setRunResult({ code: last.data.result?.code ?? 0, durationMs: last.data.result?.durationMs ?? 0 });
      if (last.data.result?.stdout) setLines((l) => [...l, ...last.data.result.stdout.split(/\r?\n/).filter(Boolean)]);
    }
    if (last.data.stage === "error") {
      setBusy(false);
      toast.push("err", last.data.error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bus.events.length, spec.id]);

  const isLongRunning = spec.mode === "process";

  return (
    <div className="stack">
      <Card className="card-pad">
        <CardHead title={spec.title} sub={spec.summary} right={<span className="badge mono">{spec.binary}</span>} />

        <div className="grid-2">
          {groups.map((g) => {
            const params = spec.params.filter((p) => p.group === g).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
            const onlyAdvanced = params.every((p) => p.advanced);
            if (onlyAdvanced && !showAdvanced) return null;
            return (
              <div key={g} className="stack" style={{ gap: 10 }}>
                {g !== spec.title && <div className="small muted" style={{ fontWeight: 600 }}>{g}</div>}
                {params.map((p) => (
                  <ParamInput key={p.key} spec={p} value={values[p.key]} models={models} onChange={(v) => setValues((s) => ({ ...s, [p.key]: v }))} />
                ))}
              </div>
            );
          })}
        </div>

        {advanced.length > 0 && (
          <div className="row" style={{ marginTop: 12 }}>
            <label className="check">
              <input type="checkbox" checked={showAdvanced} onChange={(e) => setShowAdvanced(e.target.checked)} />
              <Settings2 size={13} /> Show advanced options
            </label>
          </div>
        )}

        <div className="hr" />
        <div className="small muted" style={{ fontWeight: 600, marginBottom: 6 }}>Command</div>
        <div className="console" style={{ maxHeight: 120, minHeight: 0 }}>{preview || "…"}</div>

        <div className="row" style={{ marginTop: 14 }}>
          <Button variant="primary" onClick={run} disabled={busy}>
            {busy ? <Spinner /> : isLongRunning ? <Play size={15} /> : <Zap size={15} />}
            {isLongRunning ? "Start" : "Run"} {spec.binary}
          </Button>
          {isLongRunning && <span className="faint small">Long-running tools are started from the Server / Processes views so you can stop them.</span>}
        </div>
      </Card>

      <Card className="card-pad">
        <CardHead
          title="Output"
          right={
            <div className="row" style={{ gap: 8 }}>
              {runResult && <Badge kind={runResult.code === 0 ? "ok" : "danger"}>exit {runResult.code}</Badge>}
              {runResult && <span className="faint small">{(runResult.durationMs / 1000).toFixed(1)}s</span>}
              <Button size="sm" variant="ghost" onClick={() => setLines([])} disabled={lines.length === 0}>Clear</Button>
            </div>
          }
        />
        <Console lines={lines} />
      </Card>
    </div>
  );
}

function orderedGroups(params: ParamSpec[]): string[] {
  const set = new Set(params.map((p) => p.group));
  const ordered = GROUP_ORDER.filter((g) => set.has(g));
  for (const g of set) if (!ordered.includes(g)) ordered.push(g);
  return ordered;
}

function ParamInput({
  spec, value, models, onChange,
}: {
  spec: ParamSpec;
  value: string | number | boolean | undefined;
  models: LocalModel[];
  onChange: (v: string | number | boolean) => void;
}) {
  const label = (
    <label title={spec.help}>
      {spec.label}
      {spec.unit && <span className="faint" style={{ fontWeight: 400 }}> · {spec.unit}</span>}
    </label>
  );

  if (spec.type === "bool") {
    return (
      <label className="check" title={spec.help}>
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        {spec.label}
      </label>
    );
  }

  if (spec.type === "enum") {
    return (
      <div className="field">
        {label}
        <select className="select" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          <option value="">— default —</option>
          {spec.enum?.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>
    );
  }

  if (spec.type === "number") {
    return (
      <div className="field">
        {label}
        <input
          className="input"
          type="number"
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
          placeholder={spec.help}
        />
      </div>
    );
  }

  if (spec.type === "model") {
    return (
      <div className="field">
        {label}
        {models.length > 0 ? (
          <select
            className="select"
            value={String(value ?? "")}
            onChange={(e) => onChange(e.target.value)}
            onFocus={() => {
              /* keep the free-text option available */
            }}
          >
            <option value="">— choose a library model —</option>
            {models.map((m) => (
              <option key={m.id} value={m.file}>
                {m.name} · {m.card?.quantization ?? "?"} · {bytes(m.sizeBytes)}
              </option>
            ))}
            {value && !models.some((m) => m.file === value) && <option value={String(value)}>{String(value)}</option>}
          </select>
        ) : (
          <input className="input" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} placeholder="/path/to/model.gguf" />
        )}
      </div>
    );
  }

  return (
    <div className="field">
      {label}
      <input
        className="input"
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
        placeholder={spec.help}
      />
    </div>
  );
}

function ChatHint() {
  return (
    <Card className="card-pad">
      <CardHead title="Chat lives in the Chat view" sub="Streaming chat is a first-class view, not a form." right={<Terminal size={16} className="faint" />} />
      <div className="muted small">
        Use the <b>Chat</b> item in the sidebar for an interactive conversation, or run <span className="mono">llama-cli</span> directly from
        the Evaluate / Inspect tools. The Server view starts <span className="mono">llama-server</span> for an OpenAI-compatible API.
      </div>
    </Card>
  );
}
