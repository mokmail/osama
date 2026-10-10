import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { childEnv, engineKindForServer, listProcesses, servedModelForServer } from "./processes.js";
import { downloadFile } from "./downloader.js";

/** Local alias: keeps the import list at the top of this module readable. */
const mlxProcessHelpers = { engineKindForServer, servedModelForServer };
import { paths, osamaHome } from "./paths.js";

const log = logger("mlx");
import { logger } from "./logger.js";

/**
 * MLX — Apple's array framework — and the `mlx-lm` runtime that serves language
 * models over an OpenAI-compatible API on Apple silicon.
 *
 * This is deliberately a *second* engine rather than another entry in the
 * llama.cpp registry. Its builds come from PyPI, its models are safetensors
 * directories rather than GGUFs, and its server answers `/v1/models` and
 * `/health` where llama-server answers `/props`. Sharing `registry.json` would
 * make every field in it mean two things; MLX state lives under `.osama/mlx/`.
 *
 * Everything here is honest about absence: where llama-server reports a build,
 * an ftype and a slot count, MLX reports what it has and says "unknown" for the
 * rest (see docs/mlx-macos.md).
 */

/* ------------------------------------------------------------------ support */

export interface MlxSupport {
  /** true when this machine can run MLX at all */
  supported: boolean;
  platform: string;
  arch: string;
  /** a sentence to show when it cannot */
  reason?: string;
  /** Darwin major version, e.g. 27 */
  darwinMajor?: number;
}

/**
 * MLX needs Apple silicon and a Metal-capable macOS (13.5+ — Darwin 22+).
 * `os.release()` gives the Darwin version; the mapping is loose by design, so
 * this gate is deliberately generous and the runtime probe below is the real
 * answer: if mlx imports and a model loads, the machine is fine.
 */
export function mlxSupport(): MlxSupport {
  const platform = process.platform;
  const arch = process.arch;
  const darwinMajor = platform === "darwin" ? Number(os.release().split(".")[0]) || undefined : undefined;
  if (platform !== "darwin") {
    return { supported: false, platform, arch, reason: `MLX targets Apple silicon; this machine is ${platform}/${arch}.` };
  }
  if (arch !== "arm64") {
    return { supported: false, platform, arch, reason: `MLX needs an Apple silicon GPU; this Mac is ${arch}.` };
  }
  if (darwinMajor !== undefined && darwinMajor < 22) {
    return { supported: false, platform, arch, darwinMajor, reason: "MLX needs macOS 13.5 or newer." };
  }
  return { supported: true, platform, arch, darwinMajor };
}

/* -------------------------------------------------------------------- paths */

export function mlxPaths() {
  const home = path.join(osamaHome(), "mlx");
  const venv = path.join(home, "venv");
  const bin = path.join(venv, "bin");
  return {
    home,
    venv,
    bin,
    python: path.join(bin, "python"),
    /** the console script mlx-lm installs — preferred: it is not `python -m` */
    server: path.join(bin, "mlx_lm.server"),
  };
}

/**
 * Variables that must not reach a Python Osama spawns.
 *
 * They are how a *launcher's* Python environment leaks into the interpreter we
 * chose: with `PYTHONPATH` set by an agent runtime, the venv's own numpy is
 * shadowed and mlx-lm imports fail with "No module named
 * 'numpy._core._multiarray_umath'" — from a numpy that was never the venv's.
 * Osama's interpreters are ours; these are the four that decide that.
 */
export function mlxProcessEnv(): NodeJS.ProcessEnv {
  return { PYTHONHOME: undefined, PYTHONPATH: undefined, PYTHONSTARTUP: undefined, PYTHONEXECUTABLE: undefined };
}

/* ------------------------------------------------------------------ runtime */

export interface MlxRuntime {
  /** can we start a server right now? */
  ready: boolean;
  /** where the interpreter came from */
  source: "managed" | "system" | "none";
  python?: string;
  /** how the server is invoked (console script, or `python -m mlx_lm server`) */
  mode: "script" | "module";
  mlxLmVersion?: string;
  mlxVersion?: string;
  uv?: string;
  detail: string;
}

/** Compare "0.27.0" < "0.32" without a dependency. */
function olderThan(version: string | undefined, floor: string): boolean {
  const parts = (v: string) => v.split(".").map((n) => Number(n.replace(/\D/g, "")) || 0);
  const a = parts(version ?? "0");
  const b = parts(floor);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/**
 * mlx-lm below 0.32 lowercases the model path inside `load()` and then checks
 * the lowercased string against the (mixed-case) working directory, so it refuses
 * every local model under `/Users`:
 *
 *   RuntimeError: Local models must be relative to the current working dir.
 *
 * 0.32 dropped the check. That is why Osama installs its own environment rather
 * than borrowing whatever `python3` happens to have — and why the status says so
 * instead of leaving the user with an unexplained failure.
 */
const LOCAL_MODEL_FLOOR = "0.32";

const PYTHON_CANDIDATES = [
  "/opt/homebrew/bin/python3",
  "/usr/local/bin/python3",
  "/usr/bin/python3",
  "python3",
];

/** `uv` on PATH or in its two usual homes (it ships as a single binary). */
export function findUv(): string | undefined {
  const names = ["uv"];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const p = path.join(dir, n);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch {
        /* keep looking */
      }
    }
  }
  for (const p of [path.join(os.homedir(), ".local", "bin", "uv"), "/opt/homebrew/bin/uv"]) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* not here */
    }
  }
  return undefined;
}

interface Probe {
  ok: boolean;
  out: string;
}

/** Run an interpreter and report its mlx versions, or why it has none. */
function probePython(python: string, timeoutMs = 15000): Promise<Probe> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      resolve({ ok, out: out.trim() });
    };
    let child;
    try {
      child = spawn(
        python,
        ["-c", "import mlx.core as mx, mlx_lm; print(mlx_lm.__version__); print(getattr(mx, '__version__', '?'))"],
        { stdio: ["ignore", "pipe", "pipe"], env: childEnv(mlxProcessEnv()) },
      );
    } catch {
      return finish(false);
    }
    const timer = setTimeout(() => {
      child?.kill();
      finish(false);
    }, timeoutMs);
    child.stdout?.on("data", (d) => (out += String(d)));
    child.stderr?.on("data", (d) => (out += String(d)));
    child.on("error", () => {
      clearTimeout(timer);
      finish(false);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
  });
}

/**
 * Work out what we could serve with.
 *
 * Preference is the managed venv: Osama knows exactly what is in it, can update
 * it, and does not depend on whatever the user's `python3` happens to be. A
 * system interpreter that already has mlx-lm is reported as a fallback — it lets
 * a developer work without a second copy of the world on disk, but the app says
 * which one it is using rather than pretending they are the same.
 */
export async function detectRuntime(): Promise<MlxRuntime> {
  const support = mlxSupport();
  const uv = findUv();
  if (!support.supported) {
    return { ready: false, source: "none", mode: "script", uv, detail: support.reason ?? "MLX is not supported on this machine." };
  }

  const p = mlxPaths();
  if (fs.existsSync(p.server)) {
    const probe = await probePython(p.python);
    if (probe.ok) {
      const [mlxLmVersion, mlxVersion] = probe.out.split("\n");
      return {
        ready: true,
        source: "managed",
        python: p.python,
        mode: "script",
        mlxLmVersion,
        mlxVersion,
        uv,
        detail: `Osama's own environment (mlx-lm ${mlxLmVersion ?? "?"}).`,
      };
    }
    return {
      ready: false,
      source: "managed",
      python: p.python,
      mode: "script",
      uv,
      detail: `The environment at ${p.venv} cannot import mlx-lm — reinstall it.`,
    };
  }

  for (const candidate of PYTHON_CANDIDATES) {
    const probe = await probePython(candidate);
    if (probe.ok) {
      const [mlxLmVersion, mlxVersion] = probe.out.split("\n");
      const stale = olderThan(mlxLmVersion, LOCAL_MODEL_FLOOR);
      return {
        ready: true,
        source: "system",
        python: candidate,
        mode: "module",
        mlxLmVersion,
        mlxVersion,
        uv,
        detail: stale
          ? `The system interpreter ${candidate} has mlx-lm ${mlxLmVersion}, which refuses to load a local model whose path is not entirely lowercase — every path under /Users is. Press Install to let Osama build its own environment (mlx-lm ${LOCAL_MODEL_FLOOR}+), which loads it.`
          : `The system interpreter ${candidate} (mlx-lm ${mlxLmVersion ?? "?"}). Osama installs its own environment when you press Install.`,
      };
    }
  }

  return {
    ready: false,
    source: "none",
    mode: "script",
    uv,
    detail: uv
      ? "No MLX runtime found. Install one to serve MLX models."
      : "No MLX runtime, and no `uv` to install one with — install uv first (brew install uv).",
  };
}

/* ------------------------------------------------------------------ install */

export interface InstallEvent {
  stage: "venv" | "pip" | "line" | "done" | "error";
  line?: string;
  error?: string;
}

function run(cmd: string, argv: string[], onLine: (l: string) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { env: childEnv({ ...mlxProcessEnv(), PIP_DISABLE_PIP_VERSION_CHECK: "1" }) });
    const pump = (buf: Buffer) => {
      for (const line of String(buf).split(/\r?\n/)) if (line.trim()) onLine(line.trim());
    };
    child.stdout.on("data", pump);
    child.stderr.on("data", pump);
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? -1));
  });
}

/**
 * Create Osama's MLX environment: a venv with `uv`, then mlx-lm into it.
 *
 * `uv` does this in seconds and without a Python of its own — it fetches a
 * managed 3.12 if the machine has none. Progress is streamed line by line so the
 * UI can show the same kind of live log it shows for a llama.cpp install.
 */
export async function installRuntime(onEvent: (e: InstallEvent) => void): Promise<MlxRuntime> {
  const support = mlxSupport();
  if (!support.supported) throw new Error(support.reason ?? "MLX is not supported on this machine.");
  const uv = findUv();
  if (!uv) throw new Error("uv is required to create the MLX environment — install it with `brew install uv`.");

  const p = mlxPaths();
  fs.mkdirSync(p.home, { recursive: true });

  const say = (e: InstallEvent) => {
    onEvent(e);
    if (e.line) log.info(`mlx: ${e.line}`);
  };

  try {
    if (!fs.existsSync(p.python)) {
      say({ stage: "venv", line: `uv venv --python 3.12 ${p.venv}` });
      const code = await run(uv, ["venv", "--python", "3.12", p.venv], (l) => say({ stage: "line", line: l }));
      if (code !== 0) throw new Error(`uv venv exited with code ${code}`);
    }
    say({ stage: "pip", line: `uv pip install --python ${p.python} -U mlx-lm` });
    const code = await run(
      uv,
      ["pip", "install", "--python", p.python, "-U", "mlx-lm"],
      (l) => say({ stage: "line", line: l }),
    );
    if (code !== 0) throw new Error(`uv pip install exited with code ${code}`);
    const runtime = await detectRuntime();
    if (!runtime.ready) throw new Error(runtime.detail);
    say({ stage: "done", line: `MLX ready — mlx-lm ${runtime.mlxLmVersion ?? "?"}` });
    return runtime;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    say({ stage: "error", error: message });
    throw err;
  }
}

/* ------------------------------------------------------------------- models */

export interface MlxQuantization {
  bits?: number;
  groupSize?: number;
}

export interface MlxModel {
  id: string;
  name: string;
  /** the directory mlx-lm loads: --model takes exactly this */
  dir: string;
  sizeBytes: number;
  files: number;
  architecture?: string;
  quantization?: MlxQuantization;
  contextLength?: number;
  layers?: number;
  /** how it was found: the models dir, or a folder the user pointed at */
  origin: "models-dir" | "external";
  addedAt: string;
  /** true when an adapter (adapters.safetensors) sits beside the weights */
  hasAdapter?: boolean;
}

function readJson(file: string): any | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Written while a repo is being fetched, removed when it is complete.
 *
 * A multi-file model is unusable until the last shard lands, and a directory that
 * *looks* like a model half-way through would be listed, offered, and then fail at
 * load time. The marker is the difference between "partly here" and "a model".
 */
export const MLX_INCOMPLETE = ".osama-incomplete";

/** An MLX model is a directory: a config and at least one safetensors shard. */
export function isMlxModelDir(dir: string): boolean {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    if (fs.existsSync(path.join(dir, MLX_INCOMPLETE))) return false;
    if (!fs.existsSync(path.join(dir, "config.json"))) return false;
    return fs.readdirSync(dir).some((f) => f.endsWith(".safetensors"));
  } catch {
    return false;
  }
}

/**
 * Describe a model from its own files — never from a name.
 *
 * `config.json` is the ground truth mlx-lm itself reads: the architecture, the
 * quantisation (bits and group size), the context length and the layer count.
 * Sizes come from the filesystem, so the number shown is the number on disk.
 */
export function describeMlxModel(dir: string, origin: MlxModel["origin"] = "models-dir"): MlxModel {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile());
  let sizeBytes = 0;
  let files = 0;
  let hasAdapter = false;
  for (const e of entries) {
    try {
      // Every file in the directory, not just the weights: the number shown is the
      // footprint on disk, so it has to agree with what `du` would say.
      sizeBytes += fs.statSync(path.join(dir, e.name)).size;
      if (e.name.startsWith("adapters") && e.name.endsWith(".safetensors")) hasAdapter = true;
      files++;
    } catch {
      /* a file that vanished mid-scan is not worth failing over */
    }
  }
  const config = readJson(path.join(dir, "config.json")) ?? {};
  const quant = config.quantization ?? config.quantization_config;
  return {
    id: path.basename(dir),
    name: path.basename(dir),
    dir,
    sizeBytes,
    files,
    architecture: Array.isArray(config.architectures) ? config.architectures[0] : config.model_type,
    quantization: quant
      ? { bits: quant.bits, groupSize: quant.group_size ?? quant.groupSize }
      : undefined,
    contextLength: config.max_position_embeddings ?? config.text_config?.max_position_embeddings,
    layers: config.num_hidden_layers ?? config.text_config?.num_hidden_layers,
    origin,
    addedAt: new Date(fs.statSync(dir).mtimeMs).toISOString(),
    hasAdapter,
  };
}

/** Bounded walk for MLX model directories (never follows directory symlinks). */
export function findMlxModels(root: string, depth = 3): MlxModel[] {
  const found: MlxModel[] = [];
  const seen = new Set<string>();
  const walk = (dir: string, left: number) => {
    if (left < 0) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (isMlxModelDir(dir)) {
      const real = fs.realpathSync(dir);
      if (!seen.has(real)) {
        seen.add(real);
        found.push(describeMlxModel(dir, dir.startsWith(paths().models) ? "models-dir" : "external"));
      }
      return; // a model directory is a leaf — do not walk into its shards
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      walk(path.join(dir, e.name), left - 1);
    }
  };
  walk(root, depth);
  return found;
}

/** Every MLX model under the models dir. */
export function listMlxModels(extraRoots: string[] = []): MlxModel[] {
  const roots = [paths().models, ...extraRoots];
  const out: MlxModel[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    out.push(...findMlxModels(root));
  }
  const byDir = new Map(out.map((m) => [m.dir, m]));
  return [...byDir.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/* -------------------------------------------------------------------- serve */

export interface MlxServeOptions {
  model: string;
  host?: string;
  port?: number;
  temp?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  maxTokens?: number;
  chatTemplate?: string;
  adapterPath?: string;
  draftModel?: string;
  numDraftTokens?: number;
  trustRemoteCode?: boolean;
}

/**
 * The argv for `mlx_lm server`.
 *
 * Long flags only, and `--model` rather than `-m`: the Library works out which
 * model a running process serves by looking for the model flag, and `python -m
 * mlx_lm` would put the *module* where a model path belongs. This flag set is
 * the server's own (see `mlx_lm server --help`); anything not listed there is
 * not invented here.
 */
export function mlxServeArgv(opts: MlxServeOptions): string[] {
  const argv = ["server", "--model", opts.model];
  argv.push("--host", opts.host ?? "127.0.0.1");
  argv.push("--port", String(opts.port ?? 8082));
  if (opts.temp !== undefined) argv.push("--temp", String(opts.temp));
  if (opts.topP !== undefined) argv.push("--top-p", String(opts.topP));
  if (opts.topK !== undefined) argv.push("--top-k", String(opts.topK));
  if (opts.minP !== undefined) argv.push("--min-p", String(opts.minP));
  if (opts.maxTokens !== undefined) argv.push("--max-tokens", String(opts.maxTokens));
  if (opts.chatTemplate) argv.push("--chat-template", opts.chatTemplate);
  if (opts.adapterPath) argv.push("--adapter-path", opts.adapterPath);
  if (opts.draftModel) {
    argv.push("--draft-model", opts.draftModel);
    if (opts.numDraftTokens !== undefined) argv.push("--num-draft-tokens", String(opts.numDraftTokens));
  }
  if (opts.trustRemoteCode) argv.push("--trust-remote-code");
  return argv;
}

/**
 * How to launch it, given the runtime we found.
 *
 * The managed venv has a console script, so the command is just that script. A
 * system interpreter is launched as a module, which is why the argv carries the
 * `server` subcommand — `mlx_lm` decides which of the two it is.
 *
 * The working directory is not incidental. mlx-lm validates the model path
 * (`server.py: _validate_model_path`) with:
 *
 *   if model_path.exists() and not model_path.is_relative_to(Path.cwd()):
 *       raise RuntimeError("Local models must be relative to the current working dir.")
 *
 * The message is misleading: `Path.cwd()` is absolute, so `is_relative_to` is
 * False for every *relative* path that exists — a relative `--model` always
 * fails. What it actually accepts is an **absolute path that sits inside the
 * process's working directory**. So the process is started from a directory that
 * contains the model (the models dir for anything under it, the model's own
 * parent otherwise) and is given the absolute path.
 */
export function mlxServeCommand(
  runtime: MlxRuntime,
  opts: MlxServeOptions,
): { tool: string; argv: string[]; cwd: string } {
  if (!runtime.ready) throw new Error(runtime.detail || "no MLX runtime available");

  const model = path.resolve(opts.model);
  const root = paths().models;
  // A directory that contains the model, so the absolute path passes the check.
  const cwd = model === root || model.startsWith(root + path.sep) ? root : path.dirname(model);

  const opts2: MlxServeOptions = { ...opts, model };
  const inside = (target: string) => target === cwd || target.startsWith(cwd + path.sep);
  if (opts.adapterPath) {
    const adapter = path.resolve(opts.adapterPath);
    if (!inside(adapter)) {
      throw new Error(
        `mlx-lm only loads local weights that sit inside the process's working directory (${cwd}), so an adapter at ${adapter} cannot be served with this model — put the adapter beside the weights, or under the models dir.`,
      );
    }
    opts2.adapterPath = adapter;
  }
  if (opts.draftModel) {
    const draft = path.resolve(opts.draftModel);
    if (!inside(draft)) throw new Error(`a draft model must also sit inside ${cwd} for mlx-lm to load it`);
    opts2.draftModel = draft;
  }

  const argv = mlxServeArgv(opts2);
  if (runtime.source === "managed" && runtime.mode === "script") {
    return { tool: mlxPaths().server, argv: argv.slice(1), cwd };
  }
  if (!runtime.python) throw new Error("no MLX interpreter available");
  return { tool: runtime.python, argv: ["-m", "mlx_lm", ...argv], cwd };
}

/**
 * The context window of the MLX model a given server is serving.
 *
 * mlx-lm has no `/props`, so the meter in `context.ts` would otherwise fall back
 * to a 4096 default and over-report pressure on a model that carries 32k. The
 * model's own `config.json` is the honest source, and it is a number Osama already
 * reads for the Library.
 */
export function mlxWindowFor(baseUrl: string): number | undefined {
  const { engineKindForServer, servedModelForServer } = mlxProcessHelpers;
  if (engineKindForServer(baseUrl) !== "mlx") return undefined;
  const dir = servedModelForServer(baseUrl);
  if (!dir) return undefined;
  try {
    return describeMlxModel(dir).contextLength;
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------- probe */

export interface MlxServedInfo {
  ok: boolean;
  /** the id the server reports, e.g. a directory name */
  model?: string;
  models?: string[];
  error?: string;
}

/**
 * What an MLX server is serving, from its own OpenAI surface.
 *
 * `GET /v1/models` and `/health` are the whole story here — there is no `/props`
 * to ask (docs/mlx-macos.md), so Osama reports the model name and nothing it
 * cannot know: no ftype, no slot count, no context length.
 */
export async function probeMlxServer(baseUrl: string, timeoutMs = 4000): Promise<MlxServedInfo> {
  try {
    const [modelsRes, healthRes] = await Promise.all([
      fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) }),
      fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) }).catch(() => null),
    ]);
    const body: any = await modelsRes.json().catch(() => null);
    const models: string[] = Array.isArray(body?.data) ? body.data.map((m: any) => String(m?.id ?? "")).filter(Boolean) : [];
    return { ok: modelsRes.ok && (healthRes?.ok ?? true), model: models[0], models };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}


/* ------------------------------------------------------------------ sources */

/**
 * Where MLX models come from.
 *
 * MLX conversions are *safetensors* directories, so none of the GGUF sources
 * apply: HF is the only catalogue that matters, and it splits into the two
 * publishers that actually do the conversions plus the general `mlx` tag. The
 * mirror is here because a blocked network is a real case, but it is honest about
 * being download-only — hf-mirror.com serves files, not the search API.
 */
export type MlxSourceId = "mlx" | "mlx-community" | "lmstudio-community" | "hf-mirror" | "ref";

export interface MlxSource {
  id: MlxSourceId;
  label: string;
  note: string;
  /** whether this source can be searched, or only pasted into */
  searchable: boolean;
}

export const MLX_SOURCES: MlxSource[] = [
  {
    id: "mlx",
    label: "Hugging Face · mlx",
    note: "every repo tagged mlx — mlx-community, lmstudio-community and individual publishers, by downloads",
    searchable: true,
  },
  {
    id: "mlx-community",
    label: "mlx-community",
    note: "the reference MLX conversions, published by Apple's community org",
    searchable: true,
  },
  {
    id: "lmstudio-community",
    label: "lmstudio-community",
    note: "LM Studio's own MLX conversions, named …-MLX-4bit / -8bit",
    searchable: true,
  },
  {
    id: "hf-mirror",
    label: "HF mirror",
    note: "the same files through hf-mirror.com when huggingface.co is unreachable — download only, no search",
    searchable: false,
  },
  {
    id: "ref",
    label: "Repo id or link",
    note: "paste any owner/repo, or a huggingface.co model link, to fetch it directly",
    searchable: false,
  },
];

export function mlxSources(): MlxSource[] {
  return MLX_SOURCES;
}

/** The host a source reads from. Search always uses HF: the mirror has no API. */
function mlxBase(source: MlxSourceId = "mlx"): string {
  return source === "hf-mirror" ? "https://hf-mirror.com" : "https://huggingface.co";
}

function hfAuth(): Record<string, string> {
  const token = process.env.HF_TOKEN?.trim();
  return token ? { authorization: `Bearer ${token}` } : {};
}

export interface MlxSearchHit {
  ref: string;
  name: string;
  author?: string;
  downloads?: number;
  likes?: number;
  updatedAt?: string;
  tags: string[];
  url: string;
  source: MlxSourceId;
}

/**
 * Search the MLX catalogue.
 *
 * `filter=mlx` is the Hub's own library tag for these conversions, so this finds
 * every publisher of them rather than one org's naming convention. The two org
 * sources add `author=`, which is what makes "more sources" mean something
 * different from "the same list, filtered".
 */
export async function searchMlxModels(
  query: string,
  opts: { source?: MlxSourceId; limit?: number } = {},
): Promise<{ models: MlxSearchHit[]; note?: string; errors: string[] }> {
  const source = opts.source ?? "mlx";
  const errors: string[] = [];
  if (source === "hf-mirror" || source === "ref") {
    return { models: [], note: `${source === "hf-mirror" ? "The mirror" : "A pasted reference"} is fetched directly — there is nothing to search.`, errors };
  }
  const limit = Math.max(1, Math.min(60, opts.limit ?? 24));
  const params = new URLSearchParams({
    filter: "mlx",
    sort: "downloads",
    direction: "-1",
    limit: String(limit),
    full: "false",
  });
  if (source === "mlx-community" || source === "lmstudio-community") params.set("author", source);
  if (query.trim()) params.set("search", query.trim());

  const res = await fetch(`https://huggingface.co/api/models?${params}`, {
    headers: { accept: "application/json", "user-agent": "osama/0.1", ...hfAuth() },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Hugging Face search failed: HTTP ${res.status} ${res.statusText}`);
  const rows = (await res.json()) as any[];
  const models = rows.map((r) => {
    const ref: string = r.id ?? r.modelId;
    return {
      ref,
      name: ref.split("/").pop() ?? ref,
      author: r.author ?? ref.split("/")[0],
      downloads: r.downloads,
      likes: r.likes,
      updatedAt: r.lastModified ?? r.createdAt,
      tags: (r.tags ?? []).filter((t: string) => !["transformers", "safetensors"].includes(t)).slice(0, 6),
      url: `https://huggingface.co/${ref}`,
      source,
    };
  });
  return { models, errors };
}

/* --------------------------------------------------------------- repo plan */

export interface MlxRepoServed {
  path: string;
  size: number;
  /** weights (a safetensors shard) or a file the runtime needs alongside them */
  kind: "weights" | "config" | "tokenizer" | "other";
  required: boolean;
}

export interface MlxRepoPlan {
  ref: string;
  url: string;
  source: MlxSourceId;
  files: MlxRepoServed[];
  /** bytes of safetensors weights */
  weightsBytes: number;
  /** bytes of everything that will be fetched */
  totalBytes: number;
  gated: boolean;
  quantization?: MlxQuantization;
  contextLength?: number;
  architecture?: string;
  /** files that would be skipped, with the reason */
  skipped: Array<{ path: string; reason: string }>;
}

/** A model repo, or a link to one, reduced to `owner/repo`. */
export function normaliseMlxRef(input: string): string {
  const raw = input.trim().replace(/\/+$/, "");
  const m = /^https?:\/\/(?:www\.)?(?:huggingface\.co|hf-mirror\.com)\/([^/]+\/[^/?#]+)/i.exec(raw);
  if (m) return m[1]!;
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) return raw;
  throw new Error(`that is not a model reference — expected owner/repo, or a huggingface.co link`);
}

/** Files worth fetching. Docs, images and training leftovers are not. */
function classifyMlxFile(p: string): MlxRepoServed["kind"] | "skip" {
  const lower = p.toLowerCase();
  if (lower.endsWith(".safetensors")) return /(^|\/)adapters?\.safetensors$/.test(lower) ? "other" : "weights";
  if (lower === "config.json" || lower.endsWith("/config.json")) return "config";
  if (lower.startsWith("tokenizer") || /(^|\/)(vocab\.json|merges\.txt|special_tokens_map\.json|added_tokens\.json|chat_template\.jinja|tokenizer\.json|\.model)$/.test(lower)) {
    return "tokenizer";
  }
  if (lower.endsWith("generation_config.json") || lower.endsWith("model.safetensors.index.json")) return "other";
  return "skip";
}

/**
 * What fetching a repo would involve, before fetching it.
 *
 * Two small API calls (the tree, and `config.json` for the quantisation and the
 * window) — enough to show size, bits and context in the list, which is the
 * difference between choosing a model and guessing at one.
 */
export async function planMlxRepo(input: string, opts: { source?: MlxSourceId } = {}): Promise<MlxRepoPlan> {
  const ref = normaliseMlxRef(input);
  const source = opts.source ?? "mlx";
  const base = mlxBase(source);
  const headers = { accept: "application/json", "user-agent": "osama/0.1", ...hfAuth() };

  const [infoRes, treeRes] = await Promise.all([
    fetch(`${base}/api/models/${ref}`, { headers, signal: AbortSignal.timeout(20_000) }),
    fetch(`${base}/api/models/${ref}/tree/main?recursive=true`, { headers, signal: AbortSignal.timeout(20_000) }),
  ]);
  if (!treeRes.ok) {
    if (treeRes.status === 401 || treeRes.status === 403) throw new Error(`${ref} is gated: accept its licence on Hugging Face and set HF_TOKEN, then retry`);
    throw new Error(`${ref}: HTTP ${treeRes.status} ${treeRes.statusText}`);
  }
  const tree = (await treeRes.json()) as any[];
  const info: any = infoRes.ok ? await infoRes.json().catch(() => ({})) : {};

  const files: MlxRepoServed[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  for (const e of tree) {
    if (e.type !== "file") continue;
    const path_: string = e.path;
    const kind = classifyMlxFile(path_);
    const size = Number(e.size ?? e.lfs?.size ?? 0);
    if (kind === "skip") {
      skipped.push({ path: path_, reason: "not needed to run the model" });
      continue;
    }
    files.push({ path: path_, size, kind, required: kind !== "other" });
  }
  const weights = files.filter((f) => f.kind === "weights");
  if (!weights.length) throw new Error(`${ref} has no safetensors weights — it is not an MLX model repo`);
  if (!files.some((f) => f.kind === "config")) throw new Error(`${ref} has no config.json — an MLX directory needs it`);

  // config.json is a few KB: read it now so the row can state bits and window.
  let quant: MlxQuantization | undefined;
  let contextLength: number | undefined;
  let architecture: string | undefined;
  try {
    const cfgRes = await fetch(`${base}/${ref}/resolve/main/config.json`, { headers, signal: AbortSignal.timeout(15_000) });
    if (cfgRes.ok) {
      const cfg: any = await cfgRes.json();
      const q = cfg.quantization ?? cfg.quantization_config;
      if (q) quant = { bits: q.bits, groupSize: q.group_size ?? q.groupSize };
      contextLength = cfg.max_position_embeddings ?? cfg.text_config?.max_position_embeddings;
      architecture = Array.isArray(cfg.architectures) ? cfg.architectures[0] : cfg.model_type;
    }
  } catch {
    /* the plan is still valid without these */
  }

  return {
    ref,
    url: `https://huggingface.co/${ref}`,
    source,
    files,
    weightsBytes: weights.reduce((n, f) => n + f.size, 0),
    totalBytes: files.reduce((n, f) => n + f.size, 0),
    gated: Boolean(info.gated),
    quantization: quant,
    contextLength,
    architecture,
    skipped,
  };
}

/* ---------------------------------------------------------------- download */

export interface MlxDownloadEvent {
  stage: "start" | "file" | "done" | "error";
  file?: string;
  index?: number;
  count?: number;
  received?: number;
  total?: number;
  dir?: string;
  error?: string;
}

/** Where a repo's files live under the models dir (same convention as GGUFs). */
export function mlxModelDirFor(ref: string): string {
  return path.join(paths().models, ref.replace(/[\/\\]/g, "__"));
}

/**
 * Fetch a whole MLX repo into the models dir.
 *
 * Support files first, weights last, each one atomically (the downloader writes
 * `.part` and renames), with an in-progress marker for the directory so a
 * half-fetched model is never discovered, listed or served. An interrupted
 * download resumes: the marker stays until the last file lands.
 */
export async function downloadMlxRepo(
  input: string,
  opts: { source?: MlxSourceId; signal?: AbortSignal; onEvent?: (e: MlxDownloadEvent) => void } = {},
): Promise<{ dir: string; files: number; bytes: number; model: MlxModel }> {
  const plan = await planMlxRepo(input, { source: opts.source });
  const dir = mlxModelDirFor(plan.ref);
  fs.mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, MLX_INCOMPLETE);
  fs.writeFileSync(marker, `fetching ${plan.ref} since ${new Date().toISOString()}\n`);

  // Support first: a directory with weights but no tokenizer is not runnable, and
  // the marker is cleared only after the last byte.
  const ordered = [...plan.files].sort((a, b) => (a.kind === "weights" ? 1 : 0) - (b.kind === "weights" ? 1 : 0));
  const say = (e: MlxDownloadEvent) => opts.onEvent?.(e);
  say({ stage: "start", dir, count: ordered.length, total: plan.totalBytes });

  let bytes = 0;
  try {
    for (let i = 0; i < ordered.length; i++) {
      const f = ordered[i]!;
      const dest = path.join(dir, f.path);
      const url = `${mlxBase(opts.source ?? plan.source)}/${plan.ref}/resolve/main/${f.path}`;
      say({ stage: "file", file: f.path, index: i + 1, count: ordered.length, total: f.size });
      await downloadFile(url, dest, {
        signal: opts.signal,
        onProgress: (pr) => say({ stage: "file", file: f.path, index: i + 1, count: ordered.length, received: pr.received, total: pr.total ?? f.size }),
      });
      bytes += f.size;
    }
    fs.unlinkSync(marker);
    say({ stage: "done", dir, count: ordered.length, total: bytes });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    say({ stage: "error", error: message });
    throw err;
  }
  if (!isMlxModelDir(dir)) throw new Error(`fetched ${plan.ref}, but ${dir} still does not look like an MLX model`);
  return { dir, files: ordered.length, bytes, model: describeMlxModel(dir) };
}

/* ------------------------------------------------------------------- delete */

/** Is a running MLX server pointed at this directory? */
export function mlxModelInUse(dir: string): boolean {
  const target = path.resolve(dir);
  return listProcesses().some((p) => {
    // A stopped server no longer holds the weights: `listProcesses` includes
    // finished records, and counting those made a model permanent.
    if (p.status !== "running" && p.status !== "starting") return false;
    if (!/mlx_lm/.test(`${p.tool} ${p.argv.join(" ")}`)) return false;
    const model = p.argv.indexOf("--model");
    if (model < 0) return false;
    const value = p.argv[model + 1] ?? "";
    return path.resolve(path.isAbsolute(value) ? value : path.join(p.cwd ?? ".", value)) === target;
  });
}

/**
 * Remove a model from disk.
 *
 * Three guards, because this is the one destructive action in the view: the
 * directory must be a real MLX model, it must live *under* the models directory
 * (so a path the user merely pointed at is never touched), and no running server
 * may be reading it.
 */
export function removeMlxModel(dir: string): { removed: string } {
  const target = path.resolve(dir);
  const root = path.join(paths().models) + path.sep;
  if (!isMlxModelDir(target)) throw new Error(`${target} is not an MLX model directory`);
  if (!target.startsWith(root)) throw new Error(`${target} is outside ${paths().models} — Osama will not delete a directory it does not manage`);
  if (mlxModelInUse(target)) throw new Error(`${target} is being served right now — stop the MLX server first`);
  fs.rmSync(target, { recursive: true, force: true });
  log.info(`removed MLX model ${target}`);
  return { removed: target };
}
