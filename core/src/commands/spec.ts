/**
 * The parameter-spec contract plus the shared parameter groups.
 *
 * This is the single source of truth for every llama.cpp option Osama exposes.
 * The GUI renders its forms straight from these specs and `buildArgv` turns the
 * values into an argv array, so a flag only ever has to be right in one place.
 *
 * Flag correctness is enforced by `scripts/check-flags.mjs` and
 * `scripts/probe-flags.mjs`, which run the installed binaries and fail when a
 * declared flag is not accepted.
 */

export type ParamType = "bool" | "string" | "number" | "enum" | "path" | "model";

/** Values the UI supplies for a tool's parameters, keyed by ParamSpec.key. */
export type ParamValues = Record<string, string | number | boolean | undefined | null>;

export interface ParamSpec {
  /** stable id used in the UI state */
  key: string;
  /** primary flag, e.g. "-m". Empty string for a bare positional. */
  flag: string;
  /** extra accepted spellings (informational, and used by the flag checker) */
  aliases?: string[];
  type: ParamType;
  label: string;
  help?: string;
  group: string;
  default?: string | number | boolean;
  enum?: string[];
  /** true if the value is a positional argument rather than a flag */
  positional?: boolean;
  /** UI ordering hint inside a group */
  order?: number;
  /** value is a number of tokens/layers/bytes with this unit label */
  unit?: string;
  advanced?: boolean;
  /**
   * true when the same flag may appear more than once (e.g. `--override-kv`
   * or `--tensor-type`). The value is then a newline- or comma-separated list
   * and `buildArgv` emits the flag once per entry.
   */
  repeat?: boolean;
  /**
   * With `repeat`, emit ONE flag with the entries comma-joined
   * (`--lora a.gguf,b.gguf`) instead of repeating the flag. Some tools parse a
   * list argument and would silently ignore a second occurrence.
   */
  joinCommas?: boolean;
  /**
   * Other param keys that must have a value for this one to be emitted. Used
   * where a tool has mutually exclusive modes (e.g. gguf-split --merge needs a
   * directory, not a single file).
   */
  requires?: string[];
  /** Hidden from the default form; still sendable programmatically. */
  hidden?: boolean;
}

/** A whole llama.cpp tool: its binary, where it shows up, and its parameters. */
export interface ToolSpec {
  id: ToolId;
  binary: string;
  title: string;
  summary: string;
  group: "run" | "serve" | "create" | "evaluate" | "inspect" | "distribute" | "edit";
  /** long-running process (start/stop) vs one-shot (run to completion) */
  mode: "process" | "oneshot";
  params: ParamSpec[];
}

export type ToolId =
  | "cli"
  | "completion"
  | "server"
  | "mtmd"
  | "quantize"
  | "gguf-edit"
  | "bench"
  | "batched-bench"
  | "perplexity"
  | "imatrix"
  | "split"
  | "tokenize"
  | "fit-params"
  | "tts"
  | "lora"
  | "rpc";

// ---------------------------------------------------------------------------
// Shared parameter groups
// ---------------------------------------------------------------------------

/**
 * The quantization types the installed build actually accepts, best-known
 * quality order. Kept long on purpose: the UI shows it as a picker, and
 * anything the build rejects is caught by the flag/behaviour probes.
 */
export const QUANT_TYPES = [
  "Q8_0", "Q6_K", "Q5_K_M", "Q5_K_S", "Q5_1", "Q5_0",
  "Q4_K_M", "Q4_K_S", "Q4_1", "Q4_0",
  "IQ4_NL", "IQ4_XS", "IQ3_M", "IQ3_S", "IQ3_XXS", "IQ3_XS",
  "Q3_K_L", "Q3_K_M", "Q3_K_S", "Q2_K", "Q2_K_S",
  "IQ2_M", "IQ2_S", "IQ2_XS", "IQ2_XXS",
  "IQ1_M", "IQ1_S", "TQ2_0", "TQ1_0",
  "MXFP4_MOE", "Q2_0", "Q1_0",
  "BF16", "F16", "F32", "COPY",
] as const;

/**
 * The ggml tensor types accepted by `--output-tensor-type` /
 * `--token-embedding-type`. These must be real ggml types: the binary aborts on
 * anything else, so the UI offers a picker rather than a free-text field.
 */
export const GGML_TYPES = [
  "f32", "f16", "bf16", "q8_0", "q6_k", "q5_k", "q5_1", "q5_0",
  "q4_k", "q4_1", "q4_0", "iq4_nl", "iq4_xs", "q3_k", "q2_k", "iq3_s",
] as const;

export const modelParams: ParamSpec[] = [
  { key: "model", flag: "-m", aliases: ["--model"], type: "model", label: "Model file", help: "Path to a local GGUF file.", group: "Model", order: 1 },
  { key: "hfRepo", flag: "-hf", aliases: ["--hf-repo"], type: "string", label: "Hugging Face repo", help: "user/model[:quant] — download & run straight from the Hub.", group: "Model", order: 2 },
  { key: "hfFile", flag: "--hf-file", type: "string", label: "HF file", help: "Exact GGUF filename inside the repo.", group: "Model", order: 3, advanced: true },
  { key: "ctx", flag: "-c", aliases: ["--ctx-size"], type: "number", label: "Context size", help: "Prompt context in tokens (0 = from model).", group: "Model", order: 4, unit: "tokens" },
  { key: "predict", flag: "-n", aliases: ["--predict", "--n-predict"], type: "number", label: "Max tokens", help: "-1 = until the model stops.", group: "Model", order: 5, unit: "tokens" },
];

export const performanceParams: ParamSpec[] = [
  { key: "threads", flag: "-t", aliases: ["--threads"], type: "number", label: "CPU threads", group: "Performance", order: 1 },
  { key: "threadsBatch", flag: "-tb", aliases: ["--threads-batch"], type: "number", label: "Batch threads", group: "Performance", order: 2, advanced: true },
  { key: "gpuLayers", flag: "-ngl", aliases: ["--n-gpu-layers", "-n-gpu-layers"], type: "number", label: "GPU layers (offload)", help: "999 offloads every layer (full Metal/CUDA offload).", group: "Performance", order: 3 },
  { key: "splitMode", flag: "-sm", aliases: ["--split-mode"], type: "enum", enum: ["none", "layer", "row", "tensor"], label: "Split mode", group: "Performance", order: 4, advanced: true },
  { key: "flashAttn", flag: "-fa", aliases: ["--flash-attn"], type: "enum", enum: ["auto", "on", "off"], label: "Flash attention", group: "Performance", order: 5 },
  { key: "batchSize", flag: "-b", aliases: ["--batch-size"], type: "number", label: "Batch size", group: "Performance", order: 6, advanced: true },
  { key: "ubatchSize", flag: "-ub", aliases: ["--ubatch-size"], type: "number", label: "Micro-batch", group: "Performance", order: 7, advanced: true },
  { key: "cacheTypeK", flag: "-ctk", aliases: ["--cache-type-k"], type: "enum", enum: ["f32", "f16", "bf16", "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1"], label: "KV cache K", group: "Performance", order: 8, advanced: true },
  { key: "cacheTypeV", flag: "-ctv", aliases: ["--cache-type-v"], type: "enum", enum: ["f32", "f16", "bf16", "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1"], label: "KV cache V", group: "Performance", order: 9, advanced: true },
  { key: "numa", flag: "--numa", type: "enum", enum: ["distribute", "isolate", "numactl"], label: "NUMA", group: "Performance", order: 12, advanced: true },
];

/**
 * Model loading mode. Replaces the old `--no-mmap` / `--mlock` pair, which the
 * current build rejects ("unknown argument") on cli, server and mtmd alike.
 */
export const loadModeParam: ParamSpec = {
  key: "loadMode",
  flag: "--load-mode",
  aliases: ["-lm"],
  type: "enum",
  enum: ["auto", "none", "mmap", "mlock", "mmap+mlock", "dio"],
  label: "Load mode",
  help: "auto (mmap) · none · mmap · mlock (keep in RAM) · mmap+mlock · dio.",
  group: "Performance",
  order: 10,
  advanced: true,
};

export const samplingParams: ParamSpec[] = [
  { key: "temp", flag: "--temp", aliases: ["--temperature"], type: "number", label: "Temperature", group: "Sampling", order: 1, default: 0.8 },
  { key: "topK", flag: "--top-k", type: "number", label: "Top-K", group: "Sampling", order: 2, default: 40 },
  { key: "topP", flag: "--top-p", type: "number", label: "Top-P", group: "Sampling", order: 3, default: 0.95 },
  { key: "minP", flag: "--min-p", type: "number", label: "Min-P", group: "Sampling", order: 4, default: 0.05 },
  { key: "repeatPenalty", flag: "--repeat-penalty", type: "number", label: "Repeat penalty", group: "Sampling", order: 5, default: 1.1 },
  { key: "repeatLastN", flag: "--repeat-last-n", type: "number", label: "Repeat last N", group: "Sampling", order: 6, default: 64, advanced: true },
  { key: "seed", flag: "-s", aliases: ["--seed"], type: "number", label: "Seed", help: "-1 = random.", group: "Sampling", order: 7, default: -1 },
  { key: "nKeep", flag: "--keep", type: "number", label: "Keep tokens", group: "Sampling", order: 8, advanced: true },
];

export const outputParams: ParamSpec[] = [
  { key: "systemPrompt", flag: "-sys", aliases: ["--system-prompt"], type: "string", label: "System prompt", group: "Prompt", order: 1 },
  { key: "prompt", flag: "-p", aliases: ["--prompt"], type: "string", label: "Prompt", group: "Prompt", order: 2 },
  { key: "singleTurn", flag: "-st", aliases: ["--single-turn"], type: "bool", label: "Single turn", help: "Answer once and exit (chat is otherwise the default).", group: "Prompt", order: 3 },
  { key: "grammar", flag: "--grammar", type: "string", label: "GBNF grammar", group: "Constraints", order: 1, advanced: true },
  { key: "jsonSchema", flag: "--json-schema", type: "string", label: "JSON schema (file)", group: "Constraints", order: 2, advanced: true },
  { key: "jinja", flag: "--jinja", type: "bool", label: "Use Jinja chat template", group: "Constraints", order: 3 },
  { key: "noDisplayPrompt", flag: "--no-display-prompt", type: "bool", label: "Hide prompt echo", group: "Display", order: 1, advanced: true },
];

export const serverParams: ParamSpec[] = [
  { key: "host", flag: "--host", type: "string", label: "Host", group: "Network", order: 1, default: "127.0.0.1" },
  { key: "port", flag: "--port", type: "number", label: "Port", group: "Network", order: 2, default: 8080 },
  { key: "apiKey", flag: "--api-key", type: "string", label: "API key", help: "When set, requests must send this key.", group: "Network", order: 3 },
  { key: "chatTemplate", flag: "--chat-template", type: "string", label: "Chat template override", group: "Network", order: 4, advanced: true },
  { key: "parallel", flag: "-np", aliases: ["--parallel"], type: "number", label: "Parallel slots", group: "Serving", order: 1, default: 1 },
  { key: "contBatching", flag: "-cb", aliases: ["--cont-batching"], type: "bool", label: "Continuous batching", group: "Serving", order: 2 },
  { key: "nPredict", flag: "-n", aliases: ["--n-predict"], type: "number", label: "Max predict", group: "Serving", order: 3, advanced: true },
  { key: "metrics", flag: "--metrics", type: "bool", label: "Expose /metrics (Prometheus)", group: "Serving", order: 4 },
  { key: "slots", flag: "--slots", type: "bool", label: "Enable /slots endpoint", group: "Serving", order: 5, advanced: true },
  { key: "props", flag: "--props", type: "bool", label: "Enable /props endpoint", group: "Serving", order: 6, advanced: true },
  { key: "embedding", flag: "--embedding", type: "bool", label: "Embedding mode", help: "Serve /v1/embeddings.", group: "Serving", order: 7 },
  { key: "rerank", flag: "--rerank", type: "bool", label: "Reranking mode", group: "Serving", order: 8, advanced: true },
  { key: "jinjaServer", flag: "--jinja", type: "bool", label: "Use Jinja chat template", group: "Serving", order: 9 },
  { key: "sleepIdle", flag: "--sleep-idle-seconds", type: "number", label: "Sleep on idle (s)", group: "Serving", order: 10, advanced: true },
  { key: "mmproj", flag: "--mmproj", type: "string", label: "Multimodal projector", group: "Multimodal", order: 1 },
  { key: "noMmprojOffload", flag: "--no-mmproj-offload", type: "bool", label: "Keep projector on CPU", group: "Multimodal", order: 2, advanced: true },
];
