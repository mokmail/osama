import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
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
        { stdio: ["ignore", "pipe", "pipe"] },
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
    const child = spawn(cmd, argv, { env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: "1" } });
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

/** An MLX model is a directory: a config and at least one safetensors shard. */
export function isMlxModelDir(dir: string): boolean {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
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
