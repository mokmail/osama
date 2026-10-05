import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, FileCog, GitMerge, Layers, Plus, RefreshCw, Trash2, Zap } from "lucide-react";
import { agentApi, api } from "../lib/api";
import type { EditRunResult, EditableKey, LocalModel, MetadataEdit, OverrideType } from "../lib/types";
import { Badge, Button, Card, CardHead, Console, Empty, Field, Spinner, useToast } from "../components/ui";
import { bytes, fileBase, shortPath } from "../lib/format";
import type { EventBus } from "../App";

/**
 * GGUF surgery: change a model's metadata, merge LoRA adapters, or prune
 * tensors — then resave. Everything here drives `llama-quantize`'s COPY path or
 * `llama-export-lora`, the officially supported way to rewrite a GGUF.
 *
 * The honesty rule this view follows: a tool exit code is not evidence. Every
 * edit is verified by re-reading the resaved file, and an edit that "succeeded"
 * without landing is reported as a failure.
 */
export function CreateView({ bus }: { bus: EventBus }) {
  const [tab, setTab] = useState<"metadata" | "lora">("metadata");
  return (
    <div className="stack">
      <div className="tabs">
        <button className={`tab ${tab === "metadata" ? "active" : ""}`} onClick={() => setTab("metadata")}>
          <FileCog size={14} style={{ marginRight: 6 }} /> Edit metadata
        </button>
        <button className={`tab ${tab === "lora" ? "active" : ""}`} onClick={() => setTab("lora")}>
          <Layers size={14} style={{ marginRight: 6 }} /> Merge LoRA
        </button>
      </div>
      {tab === "metadata" ? <MetadataEditor bus={bus} /> : <LoraMerge bus={bus} />}
    </div>
  );
}

/* ------------------------------------------------------------- metadata */

function MetadataEditor({ bus }: { bus: EventBus }) {
  const toast = useToast();
  const [models, setModels] = useState<LocalModel[]>([]);
  const [file, setFile] = useState("");
  const [info, setInfo] = useState<{ metadata: Record<string, string | number | boolean>; editable: EditableKey[]; contextKey?: string | null; suggestedOutput: string } | null>(null);
  const [output, setOutput] = useState("");
  const [edits, setEdits] = useState<Array<MetadataEdit & { id: number }>>([]);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<EditRunResult | null>(null);

  useEffect(() => {
    api.models().then((r) => setModels(r.models)).catch(() => {});
  }, []);

  // The result of an edit streams over the event bus; pick up ours.
  useEffect(() => {
    const last = [...bus.events].reverse().find((e) => e.type === "run" && e.data?.tool === "gguf-edit");
    if (!last) return;
    const d = last.data as EditRunResult;
    setRun((cur) => (cur && cur.id === d.id && d.stage === "start" && cur.stage !== "start" ? cur : d));
    if (d.stage === "done") {
      setBusy(false);
      if (d.unapplied && d.unapplied.length) {
        toast.push("err", `${d.unapplied.length} edit(s) did not land — see the report`);
      } else if (d.verified) {
        toast.push("ok", `Saved ${fileBase(d.output ?? "")} — every edit verified`);
      } else {
        toast.push("warn", "The command finished but the edits could not be verified");
      }
    }
    if (d.stage === "error") {
      setBusy(false);
      toast.push("err", d.error ?? "The edit failed");
    }
  }, [bus.events.length]);

  async function inspect(path: string) {
    if (!path.trim()) return;
    setBusy(true);
    setRun(null);
    try {
      const id = models.find((m) => m.file === path)?.id;
      const r = id ? await agentApi.modelMetadata(id) : await agentApi.inspectGguf(path);
      setInfo({ metadata: r.metadata, editable: r.editable, contextKey: r.contextKey, suggestedOutput: r.suggestedOutput });
      setOutput(r.suggestedOutput);
      setEdits([]);
    } catch (e) {
      toast.push("err", (e as Error).message);
      setInfo(null);
    } finally {
      setBusy(false);
    }
  }

  function addEdit(key: string, type: OverrideType, value: string | number | boolean) {
    setEdits((cur) => [...cur.filter((e) => e.key !== key), { id: Date.now(), key, type, value }]);
  }

  async function apply() {
    if (!info || !edits.length) return;
    setBusy(true);
    setRun(null);
    try {
      const r = await agentApi.editModel({
        file,
        output,
        edits: edits.map(({ key, type, value }) => ({ key, type, value })),
      });
      toast.push("info", `Editing → ${fileBase(r.output)}…`);
      setRun({ id: r.runId, tool: "gguf-edit", stage: "start", line: r.command });
    } catch (e) {
      setBusy(false);
      toast.push("err", (e as Error).message);
    }
  }

  const grouped = useMemo(() => {
    const out: Array<{ prefix: string; keys: Array<[string, string | number | boolean]> }> = [];
    for (const [k, v] of Object.entries(info?.metadata ?? {})) {
      const prefix = k.split(".")[0] ?? "other";
      const g = out.find((x) => x.prefix === prefix) ?? (() => {
        const n = { prefix, keys: [] as Array<[string, string | number | boolean]> };
        out.push(n);
        return n;
      })();
      g.keys.push([k, v]);
    }
    return out;
  }, [info]);

  return (
    <div className="stack">
      <Card className="card-pad">
        <CardHead
          title="Edit GGUF metadata"
          sub="Change keys such as general.name or a chat template and save a new GGUF. Tensors are copied, never re-quantized."
          right={info && <Badge>{Object.keys(info.metadata).length} keys</Badge>}
        />
        <div className="grid-2">
          <Field label="Model" help="Any .gguf — pick one from the library, or paste a path.">
            <select className="select" value={models.some((m) => m.file === file) ? file : ""} onChange={(e) => { setFile(e.target.value); void inspect(e.target.value); }}>
              <option value="">— choose a library model —</option>
              {models.map((m) => (
                <option key={m.id} value={m.file}>
                  {m.name} · {m.card?.quantization ?? "?"} · {bytes(m.sizeBytes)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="…or an absolute path">
            <div className="row" style={{ gap: 6 }}>
              <input className="input" value={file} onChange={(e) => setFile(e.target.value)} placeholder="/path/to/model.gguf" />
              <Button variant="ghost" size="sm" onClick={() => inspect(file)} disabled={busy || !file.trim()}>
                {busy ? <Spinner /> : <RefreshCw size={13} />} Read
              </Button>
            </div>
          </Field>
          <Field label="Save as" help="A new file — the input is never overwritten.">
            <input className="input" value={output} onChange={(e) => setOutput(e.target.value)} placeholder="…edited.gguf" />
          </Field>
        </div>
      </Card>

      {info && (
        <>
          <Card className="card-pad">
            <CardHead title="Change something" sub="Pick a key, or add any key by name." />
            <EditableRows info={info} onEdit={addEdit} />

            <div className="hr" />
            <div className="small muted" style={{ fontWeight: 600, marginBottom: 6 }}>All metadata</div>
            <div className="stack" style={{ gap: 8 }}>
              {grouped.map((g) => (
                <details key={g.prefix} className="metadata-group">
                  <summary className="mono small">{g.prefix} <span className="faint">({g.keys.length})</span></summary>
                  <div className="console" style={{ maxHeight: 240, marginTop: 6 }}>
                    {g.keys.map(([k, v]) => (
                      <div key={k} className="mono small" title={`${k} = ${String(v)}`}>
                        <span className="faint">{k}</span> = {String(v).slice(0, 160)}
                      </div>
                    ))}
                  </div>
                </details>
              ))}
            </div>
          </Card>

          <Card className="card-pad">
            <CardHead
              title={`Pending edits (${edits.length})`}
              right={
                <Button variant="primary" onClick={apply} disabled={busy || !edits.length || !output.trim()}>
                  {busy ? <Spinner /> : <Zap size={14} />} Apply &amp; save
                </Button>
              }
            />
            {edits.length === 0 ? (
              <Empty icon={<FileCog size={26} />} title="No edits yet" sub="Choose a key above, or add one by name." />
            ) : (
              <div className="stack" style={{ gap: 6 }}>
                {edits.map((e) => (
                  <div key={e.id} className="tile" style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                    <span className="mono small" style={{ flex: 1 }}>{e.key}</span>
                    <Badge kind="accent">{e.type}</Badge>
                    <span className="small" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{String(e.value).slice(0, 60)}</span>
                    <Button size="sm" variant="ghost" onClick={() => setEdits((c) => c.filter((x) => x.id !== e.id))}>
                      <Trash2 size={12} />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}

      {run && <RunReport run={run} />}
    </div>
  );
}

/** The editable-by-name rows, seeded from the file's current values. */
function EditableRows({ info, onEdit }: { info: { metadata: Record<string, string | number | boolean>; editable: EditableKey[]; contextKey?: string | null }; onEdit: (key: string, type: OverrideType, value: string | number | boolean) => void }) {
  const keys: EditableKey[] = [
    ...info.editable,
    ...(info.contextKey ? [{ key: info.contextKey, label: "Context length", type: "int" as OverrideType }] : []),
  ];
  return (
    <div className="stack" style={{ gap: 10 }}>
      {keys.map((k) => (
        <EditRow key={k.key} spec={k} current={info.metadata[k.key]} onApply={(v) => onEdit(k.key, k.type, v)} />
      ))}
      <AddKeyRow onAdd={onEdit} />
    </div>
  );
}

function EditRow({ spec, current, onApply }: { spec: EditableKey; current: string | number | boolean | undefined; onApply: (v: string | number | boolean) => void }) {
  const [v, setV] = useState<string>(current === undefined ? "" : String(current));
  const dirty = current === undefined ? v !== "" : String(current) !== v;
  return (
    <div className="row wrap" style={{ gap: 8, alignItems: "flex-end" }}>
      <label className="rpfield" style={{ flex: 1, minWidth: 220 }}>
        <span>{spec.label} <span className="mono faint small">{spec.key}</span></span>
        {spec.type === "bool" ? (
          <select className="select" value={v} onChange={(e) => setV(e.target.value)}>
            <option value="">(unset)</option>
            <option value="1">true</option>
            <option value="0">false</option>
          </select>
        ) : (
          <input className="input" value={v} onChange={(e) => setV(e.target.value)} placeholder={current === undefined ? "(not present)" : String(current)} />
        )}
      </label>
      <Button size="sm" disabled={!dirty && current !== undefined} onClick={() => onApply(spec.type === "bool" ? v === "1" : spec.type === "int" || spec.type === "float" ? Number(v) : v)}>
        <Plus size={12} /> Set
      </Button>
      {spec.help && <span className="faint small" style={{ flexBasis: "100%" }}>{spec.help}</span>}
    </div>
  );
}

function AddKeyRow({ onAdd }: { onAdd: (key: string, type: OverrideType, value: string | number | boolean) => void }) {
  const [key, setKey] = useState("");
  const [type, setType] = useState<OverrideType>("str");
  const [value, setValue] = useState("");
  return (
    <div className="row wrap" style={{ gap: 8, alignItems: "flex-end", marginTop: 4 }}>
      <label className="rpfield" style={{ flex: 2, minWidth: 200 }}>
        <span>Any key</span>
        <input className="input mono" value={key} onChange={(e) => setKey(e.target.value)} placeholder="tokenizer.ggml.add_bos_token" />
      </label>
      <label className="rpfield" style={{ maxWidth: 110 }}>
        <span>Type</span>
        <select className="select" value={type} onChange={(e) => setType(e.target.value as OverrideType)}>
          <option value="str">str</option>
          <option value="int">int</option>
          <option value="float">float</option>
          <option value="bool">bool</option>
        </select>
      </label>
      <label className="rpfield" style={{ flex: 1, minWidth: 140 }}>
        <span>Value</span>
        <input className="input" value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      <Button size="sm" disabled={!key.trim()} onClick={() => { onAdd(key.trim(), type, type === "bool" ? value === "1" || value === "true" : type === "int" || type === "float" ? Number(value) : value); setKey(""); setValue(""); }}>
        <Plus size={12} /> Add
      </Button>
    </div>
  );
}

/* ----------------------------------------------------------------- LoRA */

function LoraMerge({ bus }: { bus: EventBus }) {
  const toast = useToast();
  const [models, setModels] = useState<LocalModel[]>([]);
  const [base, setBase] = useState("");
  const [adapters, setAdapters] = useState("");
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [command, setCommand] = useState("");

  useEffect(() => {
    api.models().then((r) => {
      setModels(r.models);
      setBase((b) => b || r.models[0]?.file || "");
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const last = [...bus.events].reverse().find((e) => e.type === "run" && e.data?.tool === "lora");
    if (!last) return;
    const d = last.data as { stage: string; line?: string; error?: string; result?: { code: number | null }; command?: string };
    if (d.command) setCommand(d.command);
    if (d.line) setLines((l) => [...l.slice(-400), d.line!]);
    if (d.stage === "done") { setBusy(false); toast.push(d.result?.code === 0 ? "ok" : "err", d.result?.code === 0 ? `Merged → ${fileBase(output)}` : "The merge failed — see the log"); }
    if (d.stage === "error") { setBusy(false); toast.push("err", d.error ?? "merge failed"); }
  }, [bus.events.length]);

  async function merge() {
    const list = adapters.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!base || !list.length || !output.trim()) {
      toast.push("err", "A base model, at least one adapter, and an output path are required.");
      return;
    }
    setBusy(true);
    setLines([]);
    try {
      const r = await agentApi.mergeLora({ model: base, lora: list, output });
      setCommand(r.command);
    } catch (e) {
      setBusy(false);
      toast.push("err", (e as Error).message);
    }
  }

  return (
    <div className="stack">
      <Card className="card-pad">
        <CardHead
          title="Merge LoRA adapters"
          sub="Fold one or more adapters into a base model and resave a standalone GGUF."
          right={<Badge kind="info">output is F16</Badge>}
        />
        <div className="modal-note" style={{ marginBottom: 12 }}>
          <GitMerge size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
          llama.cpp's release builds ship <b>no trainer</b>. Train an adapter with unsloth, PEFT or llama-finetune, then merge it
          here — this is the “save the finetune” side of the workflow. Quantize the result afterwards for a smaller file.
        </div>
        <div className="grid-2">
          <Field label="Base model">
            <select className="select" value={base} onChange={(e) => setBase(e.target.value)}>
              <option value="">— choose a model —</option>
              {models.filter((m) => !m.draftOnly).map((m) => (
                <option key={m.id} value={m.file}>{m.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Output GGUF">
            <input className="input" value={output} onChange={(e) => setOutput(e.target.value)} placeholder="/path/to/merged.gguf" />
          </Field>
        </div>
        <Field label="Adapters" help="One path per line. Applied in order; later adapters take precedence.">
          <textarea className="textarea" rows={3} value={adapters} onChange={(e) => setAdapters(e.target.value)} placeholder="/path/to/adapter.gguf" />
        </Field>
        <div className="row" style={{ marginTop: 12 }}>
          <Button variant="primary" onClick={merge} disabled={busy || !base || !output.trim() || !adapters.trim()}>
            {busy ? <Spinner /> : <Layers size={15} />} Merge &amp; save
          </Button>
        </div>
        {command && <><div className="hr" /><div className="console" style={{ maxHeight: 80, minHeight: 0 }}>{command}</div></>}
      </Card>

      <Card className="card-pad">
        <CardHead title="Output" />
        <Console lines={lines.length ? lines : ["no output yet"]} />
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------- report */

/** What actually happened: the command, the diff, and whether each edit stuck. */
function RunReport({ run }: { run: EditRunResult }) {
  return (
    <Card className="card-pad">
      <CardHead
        title="Result"
        sub={run.output ? shortPath(run.output, 70) : undefined}
        right={
          run.stage === "done" ? (
            run.verified ? <Badge kind="ok"><CheckCircle2 size={12} /> verified</Badge>
              : <Badge kind="danger"><AlertTriangle size={12} /> not verified</Badge>
          ) : run.stage === "error" ? <Badge kind="danger">failed</Badge> : <Badge kind="info">running…</Badge>
        }
      />
      {run.line && <div className="console" style={{ maxHeight: 90, minHeight: 0 }}>{run.line}</div>}
      {run.error && <div className="small" style={{ color: "var(--danger)", marginTop: 8 }}>{run.error}</div>}
      {run.unapplied && run.unapplied.length > 0 && (
        <div className="small" style={{ color: "var(--danger)", marginTop: 8 }}>
          These edits did not land: {run.unapplied.join(", ")}
        </div>
      )}
      {run.after && (
        <>
          <div className="hr" />
          <div className="small muted" style={{ fontWeight: 600, marginBottom: 6 }}>Changes</div>
          <div className="console" style={{ maxHeight: 200 }}>
            {Object.entries(run.after)
              .filter(([k, v]) => run.before ? run.before[k] !== v : true)
              .map(([k, v]) => (
                <div key={k} className="mono small">
                  <span className="faint">{k}</span>: {run.before && run.before[k] !== undefined ? <span className="faint">{String(run.before[k]).slice(0, 60)} → </span> : null}
                  {String(v).slice(0, 80)}
                </div>
              ))}
          </div>
        </>
      )}
    </Card>
  );
}
