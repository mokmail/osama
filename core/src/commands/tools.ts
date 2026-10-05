/**
 * The tool catalogue, and the argv builder that renders it.
 *
 * Every flag here is exercised against the installed build by
 * `scripts/probe-flags.mjs`; a flag the build rejects fails that script.
 */
import {
  modelParams,
  performanceParams,
  loadModeParam,
  samplingParams,
  outputParams,
  serverParams,
  QUANT_TYPES,
  GGML_TYPES,
  type ParamSpec,
  type ParamValues,
  type ToolId,
  type ToolSpec,
} from "./spec.js";

export { QUANT_TYPES, GGML_TYPES };
export type { ParamSpec, ParamValues, ToolId, ToolSpec };

const runnableParams: ParamSpec[] = [...performanceParams, loadModeParam];

export const TOOLS: Record<ToolId, ToolSpec> = {
  cli: {
    id: "cli",
    binary: "llama-cli",
    title: "Chat (CLI)",
    summary: "Interactive chat / single-shot generation in the terminal.",
    group: "run",
    mode: "process",
    params: [...modelParams, ...runnableParams, ...samplingParams, ...outputParams],
  },
  server: {
    id: "server",
    binary: "llama-server",
    title: "Server",
    summary: "OpenAI + Anthropic-compatible HTTP API with a built-in web UI.",
    group: "serve",
    mode: "process",
    params: [...modelParams, ...runnableParams, ...serverParams],
  },
  mtmd: {
    id: "mtmd",
    binary: "llama-mtmd-cli",
    title: "Multimodal chat",
    summary: "Chat with image / audio input via libmtmd.",
    group: "run",
    mode: "process",
    params: [
      ...modelParams,
      ...runnableParams,
      { key: "mmproj", flag: "--mmproj", type: "string", label: "mmproj file", group: "Multimodal", order: 1 },
      { key: "image", flag: "--image", type: "string", label: "Image path", group: "Multimodal", order: 2 },
      { key: "audio", flag: "--audio", type: "string", label: "Audio path", group: "Multimodal", order: 3 },
      ...samplingParams,
    ],
  },

  quantize: {
    id: "quantize",
    binary: "llama-quantize",
    title: "Quantize",
    summary: "Convert a GGUF to a smaller quantized type (Q/IQ/imatrix).",
    group: "create",
    mode: "oneshot",
    params: [
      { key: "input", flag: "", type: "model", label: "Input GGUF", positional: true, group: "Quantize", order: 1 },
      { key: "output", flag: "", type: "path", label: "Output GGUF", help: "Omit to write alongside the input.", positional: true, group: "Quantize", order: 2 },
      { key: "type", flag: "", type: "enum", enum: [...QUANT_TYPES], label: "Quant type", positional: true, group: "Quantize", order: 3, default: "Q4_K_M" },
      // NOT a flag: llama-quantize takes the thread count as a trailing
      // positional. Declaring it as "-t" made the binary read the input path AS
      // the ftype and abort with `invalid ftype '<model>'`.
      { key: "threads", flag: "", type: "number", label: "Threads", help: "Trailing nthreads (optional).", positional: true, group: "Quantize", order: 4, unit: "nthreads" },
      { key: "imatrix", flag: "--imatrix", type: "string", label: "Importance matrix", group: "Quantize", order: 5, advanced: true },
      { key: "allowRequantize", flag: "--allow-requantize", type: "bool", label: "Allow requantize", group: "Quantize", order: 6, advanced: true },
      { key: "pure", flag: "--pure", type: "bool", label: "Pure quant (no k-quant mix)", group: "Quantize", order: 7, advanced: true },
      { key: "leaveOutputTensor", flag: "--leave-output-tensor", type: "bool", label: "Leave output tensor unquantized", group: "Quantize", order: 8, advanced: true },
      { key: "outputTensorType", flag: "--output-tensor-type", type: "enum", enum: [...GGML_TYPES], label: "Output tensor type", group: "Tensors", order: 1, advanced: true },
      { key: "tokenEmbeddingType", flag: "--token-embedding-type", type: "enum", enum: [...GGML_TYPES], label: "Token embedding type", group: "Tensors", order: 2, advanced: true },
      { key: "tensorType", flag: "--tensor-type", type: "string", label: "Per-tensor types", help: "One per line: tensor_name=ggml_type", group: "Tensors", order: 3, advanced: true, repeat: true },
      { key: "pruneLayers", flag: "--prune-layers", type: "string", label: "Prune layers", help: "Comma-separated layer numbers to drop.", group: "Tensors", order: 4, advanced: true },
      { key: "keepSplit", flag: "--keep-split", type: "bool", label: "Keep input shards", group: "Tensors", order: 5, advanced: true },
      { key: "dryRun", flag: "--dry-run", type: "bool", label: "Dry run (size only)", group: "Tensors", order: 6, advanced: true },
      { key: "maxBufferSize", flag: "--max-buffer-size", type: "number", label: "Max buffer size", unit: "MiB", group: "Tensors", order: 7, advanced: true },
    ],
  },

  /**
   * Edit a GGUF's metadata and resave it.
   *
   * llama.cpp exposes no `llama-gguf-edit` binary, so this is the official
   * COPY path: `llama-quantize <in> <out> COPY --override-kv k=type:v`. The
   * value spelling was pinned by experiment against b11398 — the type names are
   * `str` / `int` / `float` / `bool` (NOT the gguf enum names like STRING).
   */
  "gguf-edit": {
    id: "gguf-edit",
    binary: "llama-quantize",
    title: "Edit GGUF metadata",
    summary: "Change metadata key/values and resave the GGUF without re-quantizing.",
    group: "edit",
    mode: "oneshot",
    params: [
      { key: "input", flag: "", type: "model", label: "Input GGUF", positional: true, group: "Edit", order: 1 },
      { key: "output", flag: "", type: "path", label: "Output GGUF", help: "A new file — the input is never overwritten.", positional: true, group: "Edit", order: 2 },
      { key: "type", flag: "", type: "enum", enum: ["COPY"], label: "Mode", positional: true, group: "Edit", order: 3, default: "COPY" },
      { key: "edits", flag: "--override-kv", type: "string", label: "Metadata edits", help: "One per line: key=type:value — type is str | int | float | bool.", group: "Edit", order: 4, repeat: true },
      { key: "dryRun", flag: "--dry-run", type: "bool", label: "Dry run (no file written)", group: "Edit", order: 5, advanced: true },
      { key: "keepSplit", flag: "--keep-split", type: "bool", label: "Keep input shards", group: "Edit", order: 6, advanced: true },
    ],
  },

  bench: {
    id: "bench",
    binary: "llama-bench",
    title: "Benchmark",
    summary: "Measure prompt-processing and token-generation throughput.",
    group: "evaluate",
    mode: "oneshot",
    params: [
      { key: "model", flag: "-m", aliases: ["--model"], type: "model", label: "Model", group: "Benchmark", order: 1 },
      { key: "hfRepo", flag: "-hf", aliases: ["--hf-repo"], type: "string", label: "HF repo", group: "Benchmark", order: 2 },
      { key: "gpuLayers", flag: "-ngl", aliases: ["--n-gpu-layers"], type: "number", label: "GPU layers", group: "Benchmark", order: 3 },
      { key: "threads", flag: "-t", aliases: ["--threads"], type: "number", label: "Threads", group: "Benchmark", order: 4 },
      { key: "batchSize", flag: "-b", aliases: ["--batch-size"], type: "number", label: "Batch size", group: "Benchmark", order: 5, advanced: true },
      { key: "promptTokens", flag: "-p", aliases: ["--n-prompt"], type: "number", label: "Prompt tokens", group: "Benchmark", order: 6 },
      { key: "genTokens", flag: "-n", aliases: ["--n-gen"], type: "number", label: "Gen tokens", group: "Benchmark", order: 7 },
      { key: "repetitions", flag: "-r", aliases: ["--repetitions"], type: "number", label: "Repetitions", group: "Benchmark", order: 8, default: 5 },
      { key: "output", flag: "-o", aliases: ["--output"], type: "enum", enum: ["md", "csv", "json", "sql", "jsonl"], label: "Output format", group: "Benchmark", order: 9 },
      { key: "flashAttn", flag: "-fa", aliases: ["--flash-attn"], type: "enum", enum: ["auto", "on", "off"], label: "Flash attention", group: "Benchmark", order: 10 },
    ],
  },

  "batched-bench": {
    id: "batched-bench",
    binary: "llama-batched-bench",
    title: "Batched benchmark",
    summary: "Throughput across batched / parallel sequences.",
    group: "evaluate",
    mode: "oneshot",
    params: [
      { key: "model", flag: "-m", aliases: ["--model"], type: "model", label: "Model", group: "Batched", order: 1 },
      { key: "npp", flag: "-npp", type: "number", label: "Prompt tokens", group: "Batched", order: 2 },
      { key: "ntg", flag: "-ntg", type: "number", label: "Gen tokens", group: "Batched", order: 3 },
      { key: "batchSizes", flag: "-b", aliases: ["--batch-size"], type: "string", label: "Batch sizes (comma)", group: "Batched", order: 4, default: "2048,4096" },
      { key: "parallel", flag: "-np", aliases: ["--parallel"], type: "string", label: "Parallel sizes (comma)", group: "Batched", order: 5, default: "1,2,4,8,16,32" },
    ],
  },

  perplexity: {
    id: "perplexity",
    binary: "llama-perplexity",
    title: "Perplexity",
    summary: "Evaluate model quality on a text/KL-divergence dataset.",
    group: "evaluate",
    mode: "oneshot",
    params: [
      { key: "model", flag: "-m", aliases: ["--model"], type: "model", label: "Model", group: "Perplexity", order: 1 },
      { key: "file", flag: "-f", aliases: ["--file"], type: "string", label: "Corpus file", group: "Perplexity", order: 2 },
      { key: "ctx", flag: "-c", aliases: ["--ctx-size"], type: "number", label: "Context", group: "Perplexity", order: 3 },
      { key: "chunks", flag: "--chunks", type: "number", label: "Chunks", group: "Perplexity", order: 4 },
      { key: "gpuLayers", flag: "-ngl", aliases: ["--n-gpu-layers"], type: "number", label: "GPU layers", group: "Perplexity", order: 5 },
      { key: "klDivergence", flag: "--kl-divergence", type: "bool", label: "KL divergence vs base", group: "Perplexity", order: 6, advanced: true },
      // Was `---ppl-str` (three dashes) — the build rejects it.
      { key: "pplStride", flag: "--ppl-stride", type: "number", label: "Perplexity stride", group: "Perplexity", order: 7, advanced: true },
    ],
  },

  imatrix: {
    id: "imatrix",
    binary: "llama-imatrix",
    title: "Importance matrix",
    summary: "Generate an importance matrix used for better quantization.",
    group: "create",
    mode: "oneshot",
    params: [
      { key: "model", flag: "-m", aliases: ["--model"], type: "model", label: "Model", group: "IMatrix", order: 1 },
      { key: "file", flag: "-f", aliases: ["--file"], type: "string", label: "Calibration file", group: "IMatrix", order: 2 },
      { key: "output", flag: "-o", aliases: ["--output", "--output-file"], type: "path", label: "Output .imatrix", group: "IMatrix", order: 3 },
      { key: "ctx", flag: "-c", aliases: ["--ctx-size"], type: "number", label: "Context", group: "IMatrix", order: 4 },
      { key: "chunks", flag: "-n", aliases: ["--chunks"], type: "number", label: "Chunks", group: "IMatrix", order: 5 },
      { key: "gpuLayers", flag: "-ngl", aliases: ["--n-gpu-layers"], type: "number", label: "GPU layers", group: "IMatrix", order: 6 },
    ],
  },

  split: {
    id: "split",
    binary: "llama-gguf-split",
    title: "Split / merge GGUF",
    summary: "Split a large GGUF into parts, or merge parts back together.",
    group: "create",
    mode: "oneshot",
    params: [
      { key: "merge", flag: "--merge", type: "bool", label: "Merge mode", help: "Merge the shards in a directory into one file (off = split).", group: "Split", order: 1 },
      { key: "input", flag: "", type: "model", label: "Input GGUF", positional: true, group: "Split", order: 2 },
      { key: "output", flag: "", type: "path", label: "Output prefix / file", positional: true, group: "Split", order: 3 },
      { key: "size", flag: "--split-max-size", type: "string", label: "Max size per part", group: "Split", order: 4, default: "4G", unit: "e.g. 4G / 500M", requires: [] },
      { key: "tensors", flag: "--split-max-tensors", type: "number", label: "Max tensors per part", group: "Split", order: 5, advanced: true },
      { key: "noTensorFirst", flag: "--no-tensor-first-split", type: "bool", label: "No metadata in first split", group: "Split", order: 6, advanced: true },
      { key: "deleteSplits", flag: "--delete-splits", type: "bool", label: "Delete shards after merge", help: "Destructive — only with a verified merge.", group: "Split", order: 7, advanced: true },
      { key: "dryRun", flag: "--dry-run", type: "bool", label: "Dry run (plan only)", group: "Split", order: 8, advanced: true },
    ],
  },

  tokenize: {
    id: "tokenize",
    binary: "llama-tokenize",
    title: "Tokenize",
    summary: "Show how text is split into tokens by the model's tokenizer.",
    group: "inspect",
    mode: "oneshot",
    params: [
      { key: "model", flag: "-m", aliases: ["--model"], type: "model", label: "Model", group: "Tokenize", order: 1 },
      { key: "prompt", flag: "-p", aliases: ["--prompt"], type: "string", label: "Text", group: "Tokenize", order: 2 },
      { key: "file", flag: "-f", aliases: ["--file"], type: "string", label: "Text file", group: "Tokenize", order: 3 },
      { key: "ids", flag: "--ids", type: "bool", label: "Show token ids", group: "Tokenize", order: 4 },
      { key: "showCount", flag: "--show-count", type: "bool", label: "Show count", group: "Tokenize", order: 5 },
      { key: "stdin", flag: "--stdin", type: "bool", label: "Read from stdin", group: "Tokenize", order: 6, advanced: true },
      { key: "noBos", flag: "--no-bos", type: "bool", label: "No BOS token", group: "Tokenize", order: 7, advanced: true },
    ],
  },

  completion: {
    id: "completion",
    binary: "llama-completion",
    title: "Completion",
    summary: "Single-shot text or code completion (no chat template).",
    group: "run",
    mode: "process",
    params: [...modelParams, ...runnableParams, ...samplingParams, ...outputParams],
  },

  "fit-params": {
    id: "fit-params",
    binary: "llama-fit-params",
    title: "Fit parameters",
    summary: "Estimate the largest context / offload that fits your memory.",
    group: "inspect",
    mode: "oneshot",
    params: [
      { key: "model", flag: "-m", aliases: ["--model"], type: "model", label: "Model", group: "Fit", order: 1 },
      { key: "ctx", flag: "-c", aliases: ["--ctx-size"], type: "number", label: "Context", group: "Fit", order: 2 },
      { key: "gpuLayers", flag: "-ngl", aliases: ["--n-gpu-layers"], type: "number", label: "GPU layers", group: "Fit", order: 3 },
    ],
  },

  tts: {
    id: "tts",
    binary: "llama-tts",
    title: "Text to speech",
    summary: "Generate speech audio with a supported TTS model.",
    group: "run",
    mode: "oneshot",
    params: [
      { key: "model", flag: "-m", aliases: ["--model"], type: "model", label: "Model", group: "TTS", order: 1 },
      { key: "mmproj", flag: "-mm", aliases: ["--mmproj"], type: "string", label: "Backbone / mmproj", help: "Required by some TTS models.", group: "TTS", order: 2, advanced: true },
      { key: "prompt", flag: "-p", aliases: ["--prompt"], type: "string", label: "Text", group: "TTS", order: 3 },
      { key: "output", flag: "-o", aliases: ["--output", "--output-file"], type: "path", label: "Output WAV", group: "TTS", order: 4 },
      // Was `-v/--voice`; in this build `-v` is `--log-verbose` and the real
      // speaker flag is `--tts-speaker-file`. The old mapping would have turned
      // a verbosity request into a bogus voice path.
      { key: "speakerFile", flag: "--tts-speaker-file", type: "path", label: "Speaker file", help: "Optional voice/speaker reference.", group: "TTS", order: 5 },
      { key: "lang", flag: "--tts-lang", type: "string", label: "Language", help: "Not supported by every model.", group: "TTS", order: 6, advanced: true },
    ],
  },

  /**
   * Apply / merge a LoRA adapter into a base model and resave it.
   *
   * llama.cpp's release builds ship no trainer; what they DO ship is
   * `llama-export-lora`, which folds adapters into a standalone GGUF — the
   * "finetune result" side of the workflow. Training itself happens outside
   * this binary set, and the UI says so instead of pretending otherwise.
   */
  lora: {
    id: "lora",
    binary: "llama-export-lora",
    title: "Apply / merge LoRA",
    summary: "Fold one or more LoRA adapters into the base model and resave a GGUF.",
    group: "edit",
    mode: "oneshot",
    params: [
      { key: "model", flag: "-m", aliases: ["--model"], type: "model", label: "Base GGUF", group: "LoRA", order: 1 },
      { key: "lora", flag: "--lora", type: "path", label: "LoRA adapter(s)", help: "One per line — emitted comma-separated, which is what the tool expects.", group: "LoRA", order: 2, repeat: true, joinCommas: true },
      { key: "output", flag: "-o", aliases: ["--output", "--output-file"], type: "path", label: "Output GGUF", help: "Default: ggml-lora-merged-f16.gguf. Output is always F16.", group: "LoRA", order: 3 },
    ],
  },

  rpc: {
    id: "rpc",
    binary: "ggml-rpc-server",
    title: "RPC server",
    summary: "Expose a machine's GPU/RAM as an RPC backend for another instance.",
    group: "distribute",
    mode: "process",
    params: [
      { key: "host", flag: "-H", aliases: ["--host"], type: "string", label: "Bind host", group: "RPC", order: 1, default: "127.0.0.1" },
      { key: "port", flag: "-p", aliases: ["--port"], type: "number", label: "Port", group: "RPC", order: 2, default: 50052 },
      { key: "device", flag: "-d", aliases: ["--device"], type: "string", label: "Devices", help: "comma-separated device list", group: "RPC", order: 3, advanced: true },
      { key: "threads", flag: "-t", aliases: ["--threads"], type: "number", label: "CPU threads", group: "RPC", order: 4, advanced: true },
      { key: "cache", flag: "-c", aliases: ["--cache"], type: "bool", label: "Enable local cache", group: "RPC", order: 5, advanced: true },
    ],
  },
};

// ---------------------------------------------------------------------------
// argv building
// ---------------------------------------------------------------------------

function isTruthy(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "" && v !== false;
}

/** Split a repeatable value into its individual entries. */
export function splitEntries(raw: string | number | boolean): string[] {
  return String(raw)
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Build the argv for a tool from UI values.
 *
 * Two rules, both learned from the real binaries:
 *
 * 1. **Flags before positionals.** Some tools (llama-quantize) scan argv for
 *    their positional slots and will swallow a flag that follows the first
 *    positional — `llama-quantize in.gguf --token-embedding-type f32 out.gguf …`
 *    dies with `invalid ftype '--token-embedding-type'`. Emitting every option
 *    ahead of the positionals is what the tools document (`[options] IN OUT`)
 *    and what the probe verifies.
 * 2. **Declaration order within each half.** Positionals keep the order they
 *    are declared in, which is what makes `GGUF_IN GGUF_OUT` come out right.
 *
 * Values are pushed as separate array entries — never through a shell — so a
 * path with spaces or a `;` cannot be interpreted as syntax.
 */
export function buildArgv(toolId: ToolId, values: ParamValues): string[] {
  const spec = TOOLS[toolId];
  if (!spec) throw new Error(`unknown tool: ${toolId}`);
  const argv: string[] = [];

  const enabled = spec.params.filter((p) => {
    // A param that declares `requires` is only emitted when those keys are set
    // (used for mutually exclusive modes).
    if (p.requires && !p.requires.every((k) => isTruthy(values[k]))) return false;
    const raw = values[p.key];
    return p.type === "bool" ? isTruthy(raw) : isTruthy(raw);
  });

  const emit = (p: ParamSpec): void => {
    const raw = values[p.key];
    if (p.type === "bool") {
      argv.push(p.flag);
      return;
    }
    if (p.repeat) {
      const parts = splitEntries(raw as string);
      // Repeatable flags are comma-joined where the tool documents a list
      // (`--lora a,b`), and repeated where it documents repetition
      // (`--override-kv k=v` may be given many times).
      if (p.joinCommas) argv.push(p.flag, parts.join(","));
      else for (const entry of parts) argv.push(p.flag, entry);
      return;
    }
    if (p.positional) argv.push(String(raw));
    else argv.push(p.flag, String(raw));
  };

  // 1) options, in declaration order  2) positionals, in declaration order
  for (const p of enabled) if (!p.positional) emit(p);
  for (const p of enabled) if (p.positional) emit(p);
  return argv;
}

/** A copy-pasteable, shell-safe rendering of a command for the UI. */
export function renderCommand(binary: string, argv: string[]): string {
  return [binary, ...argv]
    .map((a) => (/[\s"'$`\\]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a))
    .join(" ");
}

export function toolSpec(id: ToolId): ToolSpec {
  const spec = TOOLS[id];
  if (!spec) throw new Error(`unknown tool: ${id}`);
  return spec;
}

export function allTools(): ToolSpec[] {
  return Object.values(TOOLS);
}

/**
 * Does this tool produce a new file rather than run a model? Used by the UI to
 * pick the right affordance (a run button with a progress log vs a chat).
 */
export function isTransformTool(id: ToolId): boolean {
  return TOOLS[id].group === "create" || TOOLS[id].group === "edit";
}
