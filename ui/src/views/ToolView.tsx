import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, FolderOpen, Lightbulb, PackagePlus, Play, RefreshCw, Settings2, Terminal, Wrench, XCircle, Zap } from "lucide-react";
import { api, mlxApi } from "../lib/api";
import type { LocalModel, ManagedProcess, MlxExtras, MlxModel, ParamSpec, ToolSpec } from "../lib/types";
import { Badge, Button, Card, CardHead, Console, Empty, Field, Spinner, useToast } from "../components/ui";
import { GgufPicker } from "../components/GgufPicker";
import { bytes, fileBase, shortPath, timeAgo } from "../lib/format";
import type { EventBus } from "../App";

type Values = Record<string, string | number | boolean | undefined>;

const GROUP_ORDER = ["Model", "Performance", "Prompt", "Sampling", "Constraints", "Display", "Quantize", "Benchmark", "Batched", "Perplexity", "IMatrix", "Split", "Tokenize", "Embedding", "Hash", "Fit", "TTS", "LoRA", "RPC", "Multimodal", "Serving", "Network"];

export function ToolView({ group, bus }: { group: string; bus: EventBus }) {
  const [tools, setTools] = useState<ToolSpec[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  /**
   * An MLX tool can be reached by URL on a machine that cannot run MLX. The nav hides
   * it, and the routes refuse it, but a form that produces a guaranteed failure is
   * still worth explaining rather than showing.
   */
  const [mlxReason, setMlxReason] = useState<string | null>(null);
  /**
   * mlx-lm's evaluation extras, from the same status call. `mlx_lm.evaluate` imports
   * lm-evaluation-harness and perplexity's loader imports `datasets` — neither is in
   * mlx-lm's base install, and without them those two forms produce a guaranteed
   * import traceback. Fetched once here and handed to the tool.
   */
  const [mlxExtras, setMlxExtras] = useState<MlxExtras | null>(null);
  const reloadExtras = useCallback(() => {
    mlxApi.status().then((s) => setMlxExtras(s.extras)).catch(() => {});
  }, []);
  useEffect(() => {
    if (!tools.some((t) => t.engine === "mlx")) return;
    mlxApi
      .status()
      .then((s) => {
        setMlxReason(s.support.supported ? null : (s.support.reason ?? "MLX is not supported on this machine."));
        setMlxExtras(s.extras);
      })
      .catch(() => {});
  }, [tools]);

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
      {active && active.engine === "mlx" && mlxReason ? (
        <Empty title="MLX is not available on this machine" sub={mlxReason} />
      ) : active ? (
        <ToolRunner spec={active} bus={bus} extras={mlxExtras} onExtrasChanged={reloadExtras} />
      ) : (
        <Empty title="No tools in this group" />
      )}
    </div>
  );
}

/**
 * The numbers llama-quantize prints on its last lines:
 *   llama_model_quantize_impl: model size  =   167.00 MiB (26.75 BPW)
 *   llama_model_quantize_impl: quant size  =   151.62 MiB (24.28 BPW)
 *   llama_quantize: quantize time =   198.66 ms
 * Parsed rather than guessed, so the result card states what the tool measured.
 */
function summariseRun(lines: string[]): {
  inputSize?: string; inputBpw?: number;
  outputSize?: string; outputBpw?: number;
  quantizeTime?: string; totalTime?: string;
  parts?: number;
  /** MLX: what dynamic quantisation decided, and what it cost in memory. */
  bpw?: number; peakMemory?: string; dtype?: string;
} {
  const s: ReturnType<typeof summariseRun> = {};
  for (const l of lines) {
    let m = /model size\s*=\s*([\d.]+)\s*([KMGT]?i?B)\s*\(([\d.]+) BPW\)/.exec(l);
    if (m) { s.inputSize = `${m[1]} ${m[2]}`; s.inputBpw = Number(m[3]); continue; }
    m = /quant size\s*=\s*([\d.]+)\s*([KMGT]?i?B)\s*\(([\d.]+) BPW\)/.exec(l);
    if (m) { s.outputSize = `${m[1]} ${m[2]}`; s.outputBpw = Number(m[3]); continue; }
    m = /quantize time\s*=\s*([\d.]+)\s*(\w+)/.exec(l);
    if (m) { s.quantizeTime = `${m[1]} ${m[2]}`; continue; }
    m = /total time\s*=\s*([\d.]+)\s*(\w+)/.exec(l);
    if (m) { s.totalTime = `${m[1]} ${m[2]}`; continue; }
    m = /split into\s*(\d+)\s*parts/.exec(l);
    if (m) { s.parts = Number(m[1]); continue; }
    // mlx-lm's own summary lines, taken from a real run:
    //   [INFO] Quantized model with 3.993 bits per weight.
    //   Peak memory used: 4.250GB
    m = /Quantized model with\s*([\d.]+)\s*bits per weight/.exec(l);
    if (m) { s.bpw = Number(m[1]); continue; }
    m = /Peak memory used:\s*([\d.]+)\s*GB/.exec(l);
    if (m) { s.peakMemory = `${m[1]} GB`; continue; }
    m = /\[INFO\]\s*Using dtype:\s*(\w+)/.exec(l);
    if (m) { s.dtype = m[1]; }
  }
  return s;
}

/** Tensor progress: `[  12/ 291] blk.0.attn_q.weight - [ 4096, 4096], …` */
const TENSOR_PROGRESS = /^\[\s*(\d+)\s*\/\s*(\d+)\s*\]\s*(\S+)/;

/**
 * mlx-lm's progress, which is tqdm rather than a tensor counter:
 *   `Estimating sensitivities:  42%|████▏     | 29/69 [00:12<00:17,  1.94it/s]`
 *   `Fetching 12 files: 100%|██████████| 12/12 [00:06<00:00,  1.91it/s]`
 * The phase name is the useful part — "Estimating sensitivities" tells the user what
 * the wait is for, which no percentage can.
 */
function mlxProgress(lines: string[]): { label: string; pct: number } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^(.+?):\s*(\d+)%\|/.exec(lines[i]!.trim());
    if (m?.[1]) return { label: m[1].trim(), pct: Number(m[2]) };
  }
  return null;
}

function tensorProgress(lines: string[]): { done: number; total: number; tensor: string } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = TENSOR_PROGRESS.exec(lines[i]!.trim());
    if (m) return { done: Number(m[1]), total: Number(m[2]), tensor: m[3]! };
  }
  return null;
}

/**
 * A failed run, turned into the setting that would fix it.
 *
 * llama-quantize's errors are one line in a thousand-line log; naming the flag
 * that resolves them is the difference between "it failed" and "do this".
 */
function failureHint(lines: string[], code: number | null, engine: "llamacpp" | "mlx" = "llamacpp"): string | null {
  const text = lines.slice(-40).join("\n");
  if (engine === "mlx") {
    // The one that bit us: dynamic quantisation measures sensitivities with gradients,
    // and a model that is already quantised has no trainable weights to measure — mlx
    // raises "Must specify at least one argument" rather than saying "nothing to do".
    if (/Must specify at least one argument|trainable_parameters/i.test(text)) {
      return "There is nothing left to measure: this model is already quantised. Dynamic quantisation needs a full-precision MLX model — convert it without Quantize, then quantise that.";
    }
    if (/Repository Not Found|gated|401|403/i.test(text)) {
      return "The model could not be fetched. Check the repo id — it must be a Hugging Face transformers model (or an MLX folder on disk) — and set HF_TOKEN for a gated repo.";
    }
    if (/No module named '(lm_eval|datasets)'/.test(text)) {
      return "This tool needs mlx-lm's evaluation extras, which are not in Osama's MLX environment yet — press “Install extras” above the Run button and they are added to it.";
    }
    if (/No module named|not installed/i.test(text)) {
      return "The MLX environment is missing something this tool needs — build or update it from the Models page.";
    }
    if (code !== null && code !== 0) {
      return `The MLX tool exited with code ${code}; the last lines of the log above say why.`;
    }
    return null;
  }
  if (/already quantized|not a valid model with quantization/i.test(text)) {
    return "This file is already quantized. Under “Show advanced options”, tick “Allow requantize” and run it again.";
  }
  if (/invalid ftype|not a valid quant type/i.test(text)) {
    return "This build rejected that quant type — pick another from the Quant type list.";
  }
  if (/does not exist|No such file|cannot open/i.test(text)) {
    return "The input file was not found — check the path, or pick a model from the library.";
  }
  if (/failed to open output|Permission denied|Read-only file system/i.test(text)) {
    return "The output file could not be written — choose a folder you can write to.";
  }
  if (/buffer too small|out of memory|failed to allocate|ggml_backend/i.test(text)) {
    return "The conversion ran out of room — raise “Max buffer size”, or quantize fewer tensors at a time (-t / threads lower).";
  }
  if (code !== null && code !== 0) {
    return `llama-quantize exited with code ${code}; the last lines of the log above say why.`;
  }
  return null;
}

export function ToolRunner({ spec, bus, extras, onExtrasChanged }: {
  spec: ToolSpec;
  bus: EventBus;
  /** mlx-lm's evaluation extras, or null while the answer is unknown */
  extras?: MlxExtras | null;
  onExtrasChanged?: () => void;
}) {
  const toast = useToast();
  const [models, setModels] = useState<LocalModel[]>([]);
  const [values, setValues] = useState<Values>({});
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [preview, setPreview] = useState<string>("");
  const [starting, setStarting] = useState(false);
  const [outBytes, setOutBytes] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  /**
   * Wall-clock of the last Start click.
   *
   * Events older than this belong to the PREVIOUS run: without the cut, clicking
   * Run while a finished run's result is still on screen re-renders that stale
   * result (and its badge) until the new run's first event lands, which reads as
   * "the new run already finished, with the old numbers".
   */
  const [since, setSince] = useState(0);
  /** An extras install this page started, so the button can say what is happening. */
  const [installingExtras, setInstallingExtras] = useState(false);

  /**
   * What this tool needs beyond mlx-lm's base install and does not have.
   *
   * Only ever non-empty when the answer is KNOWN (`extras.checked`): a probe that
   * could not run is not evidence that a package is missing, and blocking a run on it
   * would be the same guess as assuming it is present.
   */
  const missingExtras = useMemo(() => {
    if (!spec.extras?.length || !extras?.checked) return [];
    return spec.extras.filter((n) => (n === "evaluate" ? !extras.evaluate : !extras.datasets));
  }, [spec.extras, extras]);

  /** The install is backgrounded server-side; watch the status until it lands. */
  useEffect(() => {
    if (!installingExtras) return;
    let alive = true;
    let tries = 0;
    const id = setInterval(async () => {
      tries += 1;
      const s = await mlxApi.status().catch(() => null);
      if (!alive) return;
      const done = Boolean(s?.extras.checked && s.extras.evaluate && s.extras.datasets);
      if (done) {
        clearInterval(id);
        setInstallingExtras(false);
        onExtrasChanged?.();
        toast.push("ok", "mlx-lm's evaluation extras are installed — this tool can run now.");
      } else if (tries >= 75) {
        // Five minutes: long enough for uv to resolve and download. Say so rather
        // than leaving a button that claims to be installing forever.
        clearInterval(id);
        setInstallingExtras(false);
        onExtrasChanged?.();
        toast.push("info", "The extras install is still running — the MLX log on the Models page has its output.");
      }
    }, 4000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [installingExtras, onExtrasChanged, toast]);

  async function installExtras() {
    setInstallingExtras(true);
    try {
      await mlxApi.extras(missingExtras);
      toast.push(
        "info",
        `Installing ${missingExtras.map((n) => (n === "evaluate" ? "lm-eval" : "datasets")).join(" and ")} into Osama's MLX environment…`,
      );
    } catch (e) {
      setInstallingExtras(false);
      toast.push("err", (e as Error).message);
    }
  }

  useEffect(() => {
    api.models().then((r) => setModels(r.models)).catch(() => {});
  }, []);

  // seed defaults whenever the tool changes
  useEffect(() => {
    const v: Values = {};
    for (const p of spec.params) if (p.default !== undefined) v[p.key] = p.default;
    setValues(v);
    setOutBytes(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.id]);

  // live command preview (debounced)
  useEffect(() => {
    const t = setTimeout(() => {
      api.preview(spec.id, values).then((r) => setPreview(r.command)).catch(() => setPreview(""));
    }, 120);
    return () => clearTimeout(t);
  }, [spec.id, values]);

  /** Any param carrying a sample value can offer the one-click fill. */
  const withExamples = spec.params.some((p) => p.example);
  const groups = useMemo(() => orderedGroups(spec.params), [spec.params]);
  const advanced = useMemo(() => groups.filter((g) => spec.params.filter((p) => p.group === g).every((p) => p.advanced)), [groups, spec.params]);

  /**
   * The run, read back out of the event bus instead of accumulated in state.
   *
   * A oneshot run is a user-level activity: leaving the page and coming back must
   * show the same progress and the same result rather than an empty console, and
   * the bus is where the server has already put every line.
   */
  const run = useMemo(() => {
    const mine = bus.events.filter((e) => e.type === "run" && e.data?.tool === spec.id);
    const fresh = mine.filter((e) => e.ts >= since);
    const id: string | null = fresh.length ? (fresh[fresh.length - 1]!.data?.id ?? null) : null;
    const all = id ? mine.filter((e) => e.data?.id === id && e.ts >= since) : [];
    const start = all.find((e) => e.data?.stage === "start");
    const done = all.find((e) => e.data?.stage === "done");
    const failed = all.find((e) => e.data?.stage === "error");
    const lines: string[] = all.filter((e) => typeof e.data?.line === "string").map((e) => e.data.line as string);
    const tail = done?.data?.result?.stdout;
    if (typeof tail === "string") for (const l of tail.split(/\r?\n/)) if (l.trim()) lines.push(l);
    const result = done?.data?.result ?? null;
    const error: string | null = failed?.data?.error ?? null;
    return {
      id,
      lines: lines.slice(-800),
      command: start?.data?.command ?? null,
      startedAt: start?.ts ?? null,
      result,
      error,
      finishedAt: (done ?? failed)?.ts ?? null,
      finished: Boolean(done || failed),
      running: Boolean(id) && !done && !failed,
    };
  }, [bus.events, spec.id, since]);

  const progress = useMemo(() => tensorProgress(run.lines), [run.lines]);
  /** MLX tools draw a tqdm bar per phase instead of a tensor counter. */
  const mlxSteps = useMemo(() => (spec.engine === "mlx" ? mlxProgress(run.lines) : null), [spec.engine, run.lines]);
  const summary = useMemo(() => summariseRun(run.lines), [run.lines]);
  const running = starting ? !run.finished : run.running;

  // Tick only while a run is in flight; an idle page must not re-render every second.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  useEffect(() => {
    if (run.finished) setStarting(false);
  }, [run.finished]);

  /**
   * Does this tool write anything? Only those get an output path and a size on disk:
   * an evaluate, a generate or an upload has no output to describe, and inventing one
   * from an arbitrary argv slot is how a run gets reported as writing its own input.
   */
  const writesOutput = useMemo(
    () => spec.params.some((p) => p.key === "output" || p.key === "mlxPath" || p.key === "savePath"),
    [spec.params],
  );

  /**
   * The output path: what the user typed, else the second positional argument.
   */
  const outputPath = useMemo(() => {
    // An MLX tool is told where to write with a flag of its own — --mlx-path for a
    // conversion, --save-path for a fuse; the tools that write nothing have neither.
    if (spec.engine === "mlx") return writesOutput ? String(values.mlxPath ?? values.savePath ?? "").trim() : "";
    // llama.cpp tools name it as the second positional: `llama-quantize [opts] IN OUT`.
    const typed = String(values.output ?? "").trim();
    if (typed) return typed;
    const argv = run.command ? run.command.split(" ") : [];
    return argv.length >= 3 && argv[1] === "-m" ? "" : (argv[2] ?? "");
  }, [spec.engine, writesOutput, values.output, values.mlxPath, values.savePath, run.command]);

  /**
   * The size on disk, from the real directory listing — the parsed "quant size"
   * is the tool's own accounting, and the two disagreeing is worth seeing.
   */
  useEffect(() => {
    setOutBytes(null);
    if (!run.finished || !run.result || run.result.code !== 0) return;
    const path = outputPath;
    if (!path) return;
    // An MLX model is a directory, and `/api/browse` lists a folder's *entries* — for a
    // directory of files it returns nothing to size. The MLX route describes the model
    // itself (the same call the library card makes), which is the honest number.
    if (spec.engine === "mlx") {
      let alive = true;
      mlxApi
        .inspect(path)
        .then((r) => { if (alive) setOutBytes(r.model?.sizeBytes ?? null); })
        .catch(() => {});
      return () => { alive = false; };
    }
    if (!path.endsWith(".gguf")) return;
    const slash = path.lastIndexOf("/");
    const dir = slash > 0 ? path.slice(0, slash) : ".";
    const name = path.slice(slash + 1);
    let alive = true;
    api.browse(dir, ["gguf"])
      .then((r) => {
        if (!alive) return;
        const hit = r.entries.find((e) => e.name === name && e.file);
        setOutBytes(hit?.size ?? null);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [run.finished, run.result, outputPath]);

  /**
   * Fill the sample values into EMPTY fields only.
   *
   * Examples are a starting point, not a substitution: nothing the user typed is
   * ever overwritten, and a filled value is still visible and editable before
   * the command runs.
   */
  function fillExamples() {
    const next: Values = { ...values };
    let filled = 0;
    for (const p of spec.params) {
      if (!p.example) continue;
      const cur = next[p.key];
      if (cur !== undefined && cur !== null && String(cur).trim() !== "") continue;
      next[p.key] = p.example;
      filled++;
    }
    setValues(next);
    toast.push("info", filled > 0 ? `Filled ${filled} example value${filled === 1 ? "" : "s"} — edit before running.` : "Every example is already in place.");
  }

  const reloadModels = () => api.models().then((r) => setModels(r.models)).catch(() => {});

  async function start() {
    setStarting(true);
    setSince(Date.now());
    setOutBytes(null);
    try {
      await api.run({ tool: spec.id, values });
      toast.push("info", `${spec.title} started — progress streams below.`);
    } catch (e) {
      toast.push("err", (e as Error).message);
      setStarting(false);
    }
  }

  const isLongRunning = spec.mode === "process";
  /**
   * A command missing a required value cannot succeed, so it is not offered:
   * llama-quantize with no input prints only the quant type, which reads like a
   * bug rather than a blank field. The missing names are listed instead.
   */
  const missingRequired = spec.params.filter((p) => p.required && String(values[p.key] ?? "").trim() === "");

  const code = run.result?.code ?? null;
  const failed = Boolean(run.error) || (code !== null && code !== 0);
  const hint = run.finished && failed ? failureHint(run.lines, code, spec.engine ?? "llamacpp") : null;
  const elapsedMs = running && run.startedAt ? now - run.startedAt : (run.finishedAt && run.startedAt ? run.finishedAt - run.startedAt : 0);
  const pct = spec.engine === "mlx"
    ? (mlxSteps ? Math.max(1, Math.min(100, mlxSteps.pct)) : null)
    : progress && progress.total > 0
      ? Math.max(1, Math.min(100, Math.round((progress.done / progress.total) * 100)))
      : null;
  const outInLibrary = Boolean(outputPath) && models.some((m) => m.file === outputPath);

  return (
    <div className="stack">
      <Card className="card-pad">
        <CardHead title={spec.title} sub={spec.summary} right={<span className="badge mono">{spec.binary}</span>} />

        {spec.notes && spec.notes.length > 0 && (
          <ul className="notes">
            {spec.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}

        <div className="grid-2">
          {groups.map((g) => {
            const params = spec.params.filter((p) => p.group === g).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
            const onlyAdvanced = params.every((p) => p.advanced);
            if (onlyAdvanced && !showAdvanced) return null;
            return (
              <div key={g} className="stack" style={{ gap: 10 }}>
                {g !== spec.title && <div className="small muted" style={{ fontWeight: 600 }}>{g}</div>}
                {params.map((p) => (
                  <ParamInput
                    key={p.key}
                    spec={p}
                    engine={spec.engine}
                    value={values[p.key]}
                    models={models}
                    onLibraryChanged={reloadModels}
                    onChange={(v) => setValues((s) => ({ ...s, [p.key]: v }))}
                  />
                ))}
              </div>
            );
          })}
        </div>

        {(advanced.length > 0 || withExamples) && (
          <div className="row wrap" style={{ marginTop: 12, gap: 16, alignItems: "center" }}>
            {advanced.length > 0 && (
              <label className="check">
                <input type="checkbox" checked={showAdvanced} onChange={(e) => setShowAdvanced(e.target.checked)} />
                <Settings2 size={13} /> Show advanced options
              </label>
            )}
            {withExamples && (
              <Button size="sm" variant="ghost" onClick={fillExamples} title="Put the sample values into the empty fields — nothing you typed is overwritten.">
                <Lightbulb size={13} /> Fill example values
              </Button>
            )}
          </div>
        )}

        <div className="hr" />
        <div className="small muted" style={{ fontWeight: 600, marginBottom: 6 }}>Command</div>
        <div className="console" style={{ maxHeight: 120, minHeight: 0 }}>{preview || "…"}</div>
        {missingRequired.length > 0 && (
          <div className="help" style={{ marginTop: 8 }}>
            Still needed before this can run: {missingRequired.map((p) => p.label).join(", ")}.
          </div>
        )}
        {missingExtras.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div className="help" style={{ color: "var(--warn)" }}>
              This tool imports {missingExtras.map((n) => (n === "evaluate" ? "lm-evaluation-harness" : "`datasets`")).join(" and ")}{" "}
              before it reads a single argument, and mlx-lm does not install it by default. Run it as it is and it fails on that
              import, whatever you put in the form.
            </div>
            <div style={{ marginTop: 6 }}>
              <Button size="sm" variant="ghost" onClick={installExtras} disabled={installingExtras}>
                {installingExtras ? <Spinner /> : <PackagePlus size={13} />}
                {installingExtras ? "Installing — this can take a minute" : "Install extras"}
              </Button>
            </div>
          </div>
        )}

        <div className="row wrap" style={{ marginTop: 14, gap: 10, alignItems: "center" }}>
          <Button
            variant="primary"
            onClick={start}
            disabled={running || starting || missingRequired.length > 0 || missingExtras.length > 0 || installingExtras}
          >
            {running ? <Spinner /> : isLongRunning ? <Play size={15} /> : <Zap size={15} />}
            {running ? "Running…" : `${isLongRunning ? "Start" : "Run"} ${spec.binary}`}
          </Button>
          {running && (
            <span className="faint small">
              started {run.startedAt ? timeAgo(new Date(run.startedAt).toISOString()) : "just now"}
            </span>
          )}
          {isLongRunning && !running && <span className="faint small">Long-running tools are started from the Server / Processes views so you can stop them.</span>}
        </div>
      </Card>

      {running && (
        <Card className="card-pad">
          <CardHead
            title="Process"
            sub={
              spec.engine === "mlx"
                ? (mlxSteps ? mlxSteps.label : "waiting for the tool to report…")
                : progress
                  ? `tensor ${progress.done} of ${progress.total}`
                  : "waiting for the first tensor…"
            }
            right={<span className="faint mono small">{formatMs(elapsedMs)}</span>}
          />
          {pct !== null && (
            <div className="meter" style={{ marginBottom: 8 }}>
              <i style={{ width: `${pct}%`, background: "var(--text)" }} />
            </div>
          )}
          <div className="row wrap" style={{ gap: 10, justifyContent: "space-between" }}>
            <span className="mono small truncate" style={{ minWidth: 0 }} title={progress?.tensor ?? ""}>
              {progress ? progress.tensor : run.lines[run.lines.length - 1] ?? "…"}
            </span>
            {pct !== null && <span className="faint mono small">{pct}%</span>}
          </div>
          {summary.inputSize && (
            <>
              <div className="hr" />
              <dl className="kv">
                <dt>Source</dt><dd>{summary.inputSize} <span className="faint">{summary.inputBpw} BPW</span></dd>
                {summary.outputSize && <dt>Target</dt>}
                {summary.outputSize && <dd>{summary.outputSize} <span className="faint">{summary.outputBpw} BPW</span></dd>}
              </dl>
            </>
          )}
          {summary.bpw !== undefined && (
            <>
              <div className="hr" />
              <dl className="kv">
                <dt>Quantised to</dt>
                <dd>{summary.bpw} bits per weight <span className="faint">(the tool's own number, for the whole model)</span></dd>
                {summary.peakMemory && <dt>Peak memory</dt>}
                {summary.peakMemory && <dd>{summary.peakMemory}</dd>}
                {summary.dtype && <dt>Dtype</dt>}
                {summary.dtype && <dd className="mono small">{summary.dtype}</dd>}
              </dl>
            </>
          )}
          <div className="hr" />
          <Console lines={run.lines} max={40} />
        </Card>
      )}

      {run.finished && (
        <Card className="card-pad">
          <CardHead
            title="Result"
            sub={
              run.error
                ? "the run stopped before it finished"
                : failed
                  ? "finished with an error"
                  : writesOutput
                    ? "the output is ready"
                    : "the run finished"
            }
            right={
              <div className="row" style={{ gap: 8 }}>
                <Badge kind={failed ? "danger" : "ok"}>{failed ? <XCircle size={11} /> : <CheckCircle2 size={11} />} {code === null ? "error" : `exit ${code}`}</Badge>
                <span className="faint mono small">{formatMs(elapsedMs)}</span>
              </div>
            }
          />

          {hint && (
            <div className="help" style={{ marginBottom: 10, color: "var(--warn)" }}>
              {hint}
            </div>
          )}

          <dl className="kv">
            {writesOutput && (
              <>
                <dt>Output</dt>
                <dd className="mono small" title={outputPath || undefined}>
                  {outputPath ? shortPath(outputPath, 64) : <span className="faint">beside the input</span>}
                  {outBytes !== null && <span className="faint"> · {bytes(outBytes)} on disk</span>}
                </dd>
              </>
            )}
            {summary.inputSize && <dt>From</dt>}
            {summary.inputSize && <dd>{summary.inputSize} <span className="faint">{summary.inputBpw} BPW</span></dd>}
            {summary.outputSize && <dt>To</dt>}
            {summary.outputSize && <dd>{summary.outputSize} <span className="faint">{summary.outputBpw} BPW{summary.inputBpw && summary.outputBpw ? ` · ${Math.round((1 - summary.outputBpw / summary.inputBpw) * 100)}% smaller per weight` : ""}</span></dd>}
            {summary.quantizeTime && <dt>Quantize time</dt>}
            {summary.quantizeTime && <dd>{summary.quantizeTime}{summary.totalTime && summary.totalTime !== summary.quantizeTime ? <span className="faint"> · {summary.totalTime} total</span> : null}</dd>}
            {summary.parts ? <dt>Shards</dt> : null}
            {summary.parts ? <dd>{summary.parts}</dd> : null}
            <dt>Tensors</dt>
            <dd>{progress ? `${progress.total} processed` : <span className="faint">—</span>}</dd>
          </dl>

          {run.error && (
            <div className="wspick-error" style={{ marginTop: 10 }}>
              {run.error}
            </div>
          )}

          <div className="hr" />
          <div className="row wrap" style={{ gap: 9, alignItems: "center" }}>
            {spec.engine !== "mlx" && !failed && outputPath && !outInLibrary && (
              <Button
                variant="primary"
                disabled={adding || outBytes === 0}
                onClick={async () => {
                  setAdding(true);
                  try {
                    await api.addModel({ file: outputPath });
                    await reloadModels();
                    toast.push("ok", "Added to the library — it can be served and chatted with now.");
                  } catch (e) {
                    toast.push("err", (e as Error).message);
                  } finally {
                    setAdding(false);
                  }
                }}
              >
                {adding ? <Spinner /> : <PackagePlus size={14} />} Add to library
              </Button>
            )}
            {outInLibrary && <Badge kind="ok">in the library</Badge>}
            {failed && (
              <Button variant="ghost" onClick={() => setShowAdvanced(true)} title="Reveal the option that usually fixes this">
                <Wrench size={14} /> Show advanced options
              </Button>
            )}
            <div className="spacer" style={{ flex: 1 }} />
            <Button variant="ghost" onClick={() => setValues((s) => ({ ...s }))} title="Keep the settings and run it again">
              <RefreshCw size={14} /> Run again
            </Button>
          </div>

          <div className="hr" />
          <details>
            <summary className="small muted" style={{ cursor: "pointer" }}>Full log ({run.lines.length} lines)</summary>
            <div style={{ marginTop: 8 }}>
              <Console lines={run.lines} />
            </div>
          </details>
        </Card>
      )}
    </div>
  );
}

/** A duration for the eye: 1.2s, 1m 04s. */
function formatMs(ms: number): string {
  if (!ms || ms < 0) return "—";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

function orderedGroups(params: ParamSpec[]): string[] {
  const set = new Set(params.map((p) => p.group));
  const ordered = GROUP_ORDER.filter((g) => set.has(g));
  for (const g of set) if (!ordered.includes(g)) ordered.push(g);
  return ordered;
}

function ParamInput({
  spec, engine, value, models, onChange, onLibraryChanged,
}: {
  spec: ParamSpec;
  /** the engine of the tool this field belongs to: MLX models are directories */
  engine?: "llamacpp" | "mlx";
  value: string | number | boolean | undefined;
  models: LocalModel[];
  onChange: (v: string | number | boolean) => void;
  /** called after a file picked off the disk joins the library */
  onLibraryChanged?: () => void;
}) {
  const toast = useToast();
  const [picker, setPicker] = useState(false);
  /**
   * MLX models, for an MLX tool's model field. A model there is a DIRECTORY, so the
   * llama.cpp picker — the GGUF library plus a .gguf disk browser — would offer the
   * wrong thing entirely.
   */
  const [mlxModels, setMlxModels] = useState<MlxModel[]>([]);
  useEffect(() => {
    if (engine !== "mlx" || spec.type !== "model") return;
    mlxApi.models().then((r) => setMlxModels(r.models)).catch(() => {});
  }, [engine, spec.type]);
  const label = `${spec.label}${spec.unit ? ` · ${spec.unit}` : ""}`;
  /** A sample value first: a concrete example teaches more than a description. */
  const placeholder = spec.example ?? "—";

  if (spec.type === "bool") {
    return (
      <div className="field">
        <label className="check" title={spec.help}>
          <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
          {spec.label}
        </label>
        {spec.help && <span className="help">{spec.help}</span>}
      </div>
    );
  }

  if (spec.type === "enum") {
    // The picked option's own note, so a 35-entry quant list explains itself.
    const note = spec.enumHelp?.[String(value ?? "")];
    return (
      <Field label={label} help={spec.help} required={spec.required}>
        <select className="select" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          <option value="">— default —</option>
          {spec.enum?.map((o) => (
            <option key={o} value={o} title={spec.enumHelp?.[o]}>
              {o}{spec.default === o ? "  · default" : ""}
            </option>
          ))}
        </select>
        {note && <span className="help">{note}</span>}
      </Field>
    );
  }

  if (spec.type === "number") {
    return (
      <Field label={label} help={spec.help}>
        <input
          className="input"
          type="number"
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
          placeholder={placeholder}
        />
      </Field>
    );
  }

  /**
   * An MLX tool's model field: a directory in the MLX catalogue, or a Hugging Face
   * repo id. The path stays the value — the list is a shortcut into it, and typing an
   * id the app has never seen is still allowed.
   */
  if (spec.type === "model" && engine === "mlx") {
    const chosen = String(value ?? "");
    const known = mlxModels.some((m) => m.dir === chosen);
    return (
      <Field label={label} help={spec.help} required={spec.required}>
        <input
          className="input"
          value={chosen}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          placeholder={spec.example ?? "/path/to/an/mlx-model"}
        />
        <select className="select" value={known ? chosen : ""} onChange={(e) => e.target.value && onChange(e.target.value)}>
          <option value="">— {mlxModels.length > 0 ? "pick an MLX model" : "no MLX models yet"} —</option>
          {mlxModels.map((m) => (
            <option key={m.dir} value={m.dir}>
              {m.name} · {m.quantization?.bits ? `${m.quantization.bits}-bit` : "unquantised"} · {bytes(m.sizeBytes)}
            </option>
          ))}
        </select>
        {chosen && (
          <span className="mono small faint" title={chosen}>
            {shortPath(chosen, 72)}
            {known ? " · in your MLX models" : " · external"}
          </span>
        )}
      </Field>
    );
  }

  if (spec.type === "model") {
    const chosen = String(value ?? "");
    const inLibrary = models.some((m) => m.file === chosen);
    const pick = async (path: string, opts: { addToLibrary: boolean }) => {
      onChange(path);
      setPicker(false);
      if (!opts.addToLibrary) return;
      try {
        await api.addModel({ file: path });
        toast.push("ok", `${fileBase(path)} added to the model library.`);
        onLibraryChanged?.();
      } catch (e) {
        toast.push("err", (e as Error).message);
      }
    };
    return (
      <Field label={label} help={spec.help} required={spec.required}>
        {/* The path is the value, so it stays editable: a library pick below fills
            it in, and anything outside the library can be typed or browsed. */}
        <div className="row" style={{ gap: 8 }}>
          <input
            className="input"
            value={chosen}
            spellCheck={false}
            onChange={(e) => onChange(e.target.value)}
            placeholder={spec.example ?? "/path/to/model.gguf"}
          />
          <Button size="sm" variant="ghost" onClick={() => setPicker(true)} title="Browse the disk for a .gguf file">
            <FolderOpen size={13} /> Browse…
          </Button>
        </div>
        <select className="select" value={inLibrary ? chosen : ""} onChange={(e) => e.target.value && onChange(e.target.value)}>
          <option value="">— {models.length > 0 ? "pick from the library" : "no library models yet"} —</option>
          {models.map((m) => (
            <option key={m.id} value={m.file}>
              {m.name} · {m.card?.quantization ?? "?"} · {bytes(m.sizeBytes)}
            </option>
          ))}
        </select>
        {chosen && (
          <span className="mono small faint" title={chosen}>
            {shortPath(chosen, 72)}{inLibrary ? " · in the library" : " · not in the library"}
          </span>
        )}
        {picker && <GgufPicker models={models} value={chosen} onPick={pick} onClose={() => setPicker(false)} />}
      </Field>
    );
  }

  return (
    <Field label={label} help={spec.help} required={spec.required}>
      <input
        className="input"
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </Field>
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
