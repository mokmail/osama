/**
 * Declarative catalogue of llama.cpp tool arguments, plus argv builders.
 * The GUI renders forms straight from these specs, and every command it runs
 * is produced by `buildArgv` — so there is exactly one source of truth for the
 * flags Osama exposes.
 */

export type ParamType = "bool" | "string" | "number" | "enum" | "path" | "model";

export interface ParamSpec {
  /** stable id used in the UI state */
  key: string;
  /** primary flag, e.g. "-m" */
  flag: string;
  /** extra aliases that should be accepted (informational) */
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
}

export type ToolId =
  | "cli"
  | "completion"
  | "server"
  | "mtmd"
  | "quantize"
  | "bench"
  | "batched-bench"
  | "perplexity"
  | "imatrix"
  | "split"
  | "tokenize"
  | "fit-params"
  | "tts"
  | "rpc";

export interface ToolSpec {
  id: ToolId;
  binary: string;
  title: string;
  summary: string;
  group: "run" | "serve" | "create" | "evaluate" | "inspect" | "distribute";
  /** long-running process (start/stop) vs one-shot (run to completion) */
  mode: "process" | "oneshot";
  params: ParamSpec[];
}

// ---------------------------------------------------------------------------
// Shared parameter groups
// ---------------------------------------------------------------------------

const modelParams: ParamSpec[] = [
  { key: "model", flag: "-m", aliases: ["--model"], type: "model", label: "Model file", help: "Path to a local GGUF file.", group: "Model", order: 1 },
  { key: "hfRepo", flag: "-hf", aliases: ["--hf-repo"], type: "string", label: "Hugging Face repo", help: "user/model[:quant] — download & run straight from the Hub.", group: "Model", order: 2 },
  { key: "hfFile", flag: "--hf-file", type: "string", label: "HF file", help: "Exact GGUF filename inside the repo.", group: "Model", order: 3, advanced: true },
  { key: "ctx", flag: "-c", aliases: ["--ctx-size"], type: "number", label: "Context size", help: "Prompt context in tokens (0 = from model).", group: "Model", order: 4, unit: "tokens" },
  { key: "predict", flag: "-n", aliases: ["--predict", "--n-predict"], type: "number", label: "Max tokens", help: "-1 = until the model stops.", group: "Model", order: 5, unit: "tokens" },
  { key: "threads", flag: "-t", aliases: ["--threads"], type: "number", label: "CPU threads", group: "Performance", order: 1 },
  { key: "threadsBatch", flag: "-tb", aliases: ["--threads-batch"], type: "number", label: "Batch threads", group: "Performance", order: 2, advanced: true },
  { key: "gpuLayers", flag: "-ngl", aliases: ["--n-gpu-layers", "-n-gpu-layers"], type: "number", label: "GPU layers (offload)", help: "999 offloads every layer (full Metal/CUDA offload).", group: "Performance", order: 3 },
  { key: "splitMode", flag: "-sm", aliases: ["--split-mode"], type: "enum", enum: ["none", "layer", "row"], label: "Split mode", group: "Performance", order: 4, advanced: true },
  { key: "flashAttn", flag: "-fa", aliases: ["--flash-attn"], type: "enum", enum: ["auto", "on", "off"], label: "Flash attention", group: "Performance", order: 5 },
  { key: "batchSize", flag: "-b", aliases: ["--batch-size"], type: "number", label: "Batch size", group: "Performance", order: 6, advanced: true },
  { key: "ubatchSize", flag: "-ub", aliases: ["--ubatch-size"], type: "number", label: "Micro-batch", group: "Performance", order: 7, advanced: true },
  { key: "cacheTypeK", flag: "-ctk", aliases: ["--cache-type-k"], type: "enum", enum: ["f32", "f16", "bf16", "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1"], label: "KV cache K", group: "Performance", order: 8, advanced: true },
  { key: "cacheTypeV", flag: "-ctv", aliases: ["--cache-type-v"], type: "enum", enum: ["f32", "f16", "bf16", "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1"], label: "KV cache V", group: "Performance", order: 9, advanced: true },
  { key: "noMmap", flag: "--no-mmap", type: "bool", label: "Disable mmap", group: "Performance", order: 10, advanced: true },
  { key: "mlock", flag: "--mlock", type: "bool", label: "Lock in RAM (mlock)", group: "Performance", order: 11, advanced: true },
  { key: "numa", flag: "--numa", type: "enum", enum: ["distribute", "isolate", "numactl"], label: "NUMA", group: "Performance", order: 12, advanced: true },
];

const samplingParams: ParamSpec[] = [
  { key: "temp", flag: "--temp", aliases: ["--temperature"], type: "number", label: "Temperature", group: "Sampling", order: 1, default: 0.8 },
  { key: "topK", flag: "--top-k", type: "number", label: "Top-K", group: "Sampling", order: 2, default: 40 },
  { key: "topP", flag: "--top-p", type: "number", label: "Top-P", group: "Sampling", order: 3, default: 0.95 },
  { key: "minP", flag: "--min-p", type: "number", label: "Min-P", group: "Sampling", order: 4, default: 0.05 },
  { key: "repeatPenalty", flag: "--repeat-penalty", type: "number", label: "Repeat penalty", group: "Sampling", order: 5, default: 1.1 },
  { key: "repeatLastN", flag: "--repeat-last-n", type: "number", label: "Repeat last N", group: "Sampling", order: 6, default: 64, advanced: true },
  { key: "seed", flag: "-s", aliases: ["--seed"], type: "number", label: "Seed", help: "-1 = random.", group: "Sampling", order: 7, default: -1 },
  { key: "nKeep", flag: "--keep", type: "number", label: "Keep tokens", group: "Sampling", order: 8, advanced: true },
];

const outputParams: ParamSpec[] = [
  { key: "systemPrompt", flag: "-sys", aliases: ["--system-prompt"], type: "string", label: "System prompt", group: "Prompt", order: 1 },
  { key: "prompt", flag: "-p", aliases: ["--prompt"], type: "string", label: "Prompt", group: "Prompt", order: 2 },
  { key: "conversation", flag: "-cnv", aliases: ["--conversation"], type: "bool", label: "Conversation mode", group: "Prompt", order: 3 },
  { key: "singleTurn", flag: "-st", aliases: ["--single-turn"], type: "bool", label: "Single turn", group: "Prompt", order: 4 },
  { key: "grammar", flag: "--grammar", type: "string", label: "GBNF grammar", group: "Constraints", order: 1, advanced: true },
  { key: "jsonSchema", flag: "--json-schema", type: "string", label: "JSON schema (file)", group: "Constraints", order: 2, advanced: true },
  { key: "jinja", flag: "--jinja", type: "bool", label: "Use Jinja chat template", group: "Constraints", order: 3 },
  { key: "noDisplayPrompt", flag: "--no-display-prompt", type: "bool", label: "Hide prompt echo", group: "Display", order: 1, advanced: true },
];

const serverParams: ParamSpec[] = [
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

// ---------------------------------------------------------------------------
// Tool specs
// ---------------------------------------------------------------------------

export const TOOLS: Record<ToolId, ToolSpec> = {
  cli: {
    id: "cli",
    binary: "llama-cli",
    title: "Chat (CLI)",
    summary: "Interactive chat / single-shot generation in the terminal.",
    group: "run",
    mode: "process",
    params: [...modelParams, ...samplingParams, ...outputParams],
  },
  server: {
    id: "server",
    binary: "llama-server",
    title: "Server",
    summary: "OpenAI + Anthropic-compatible HTTP API with a built-in web UI.",
    group: "serve",
    mode: "process",
    params: [...modelParams, ...serverParams],
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
      { key: "output", flag: "", type: "path", label: "Output GGUF", positional: true, group: "Quantize", order: 2 },
      { key: "type", flag: "", type: "enum", enum: ["Q4_0", "Q4_K_S", "Q4_K_M", "Q5_K_S", "Q5_K_M", "Q6_K", "Q8_0", "IQ4_NL", "IQ4_XS", "IQ3_M", "Q3_K_M", "Q2_K", "F16", "BF16"], label: "Quant type", positional: true, group: "Quantize", order: 3, default: "Q4_K_M" },
      { key: "imatrix", flag: "--imatrix", type: "string", label: "Importance matrix", group: "Quantize", order: 4, advanced: true },
      { key: "threads", flag: "-t", aliases: ["--threads"], type: "number", label: "Threads", group: "Quantize", order: 5 },
      { key: "allowRequantize", flag: "--allow-requantize", type: "bool", label: "Allow requantize", group: "Quantize", order: 6, advanced: true },
      { key: "pure", flag: "--pure", type: "bool", label: "Pure quant", group: "Quantize", order: 7, advanced: true },
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
      { key: "pplStr", flag: "---ppl-str", type: "string", label: "Perplexity string", group: "Perplexity", order: 7, advanced: true },
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
      { key: "output", flag: "-o", aliases: ["--output"], type: "path", label: "Output .imatrix", group: "IMatrix", order: 3 },
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
      { key: "split", flag: "--split", type: "bool", label: "Split mode", group: "Split", order: 1 },
      { key: "merge", flag: "--merge", type: "bool", label: "Merge mode", group: "Split", order: 2 },
      { key: "input", flag: "--split", type: "model", label: "Input GGUF", positional: true, group: "Split", order: 3 },
      { key: "output", flag: "--split-file", type: "path", label: "Output prefix", positional: true, group: "Split", order: 4 },
      { key: "size", flag: "--split-max-size", type: "string", label: "Max size per part", group: "Split", order: 5, default: "4G", unit: "e.g. 4G / 500M" },
      { key: "tensors", flag: "--split-max-tensors", type: "number", label: "Max tensors per part", group: "Split", order: 6, advanced: true },
      { key: "noTensorFirst", flag: "--no-tensor-first-split", type: "bool", label: "No metadata in first split", group: "Split", order: 7, advanced: true },
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
    params: [...modelParams, ...samplingParams, ...outputParams],
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
      { key: "prompt", flag: "-p", aliases: ["--prompt"], type: "string", label: "Text", group: "TTS", order: 2 },
      { key: "output", flag: "-o", aliases: ["--output"], type: "path", label: "Output WAV", group: "TTS", order: 3 },
      { key: "voice", flag: "-v", aliases: ["--voice"], type: "string", label: "Voice file", group: "TTS", order: 4 },
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

export type ParamValues = Record<string, string | number | boolean | undefined | null>;

function isTruthy(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "" && v !== false;
}

/** Escape nothing — args are passed as an argv array, never through a shell. */
export function buildArgv(toolId: ToolId, values: ParamValues): string[] {
  const spec = TOOLS[toolId];
  if (!spec) throw new Error(`unknown tool: ${toolId}`);
  const argv: string[] = [];

  const byGroup = [...spec.params].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const p of byGroup) {
    const raw = values[p.key];
    if (p.type === "bool") {
      if (isTruthy(raw)) argv.push(p.flag);
      continue;
    }
    if (!isTruthy(raw)) continue;
    if (p.positional) {
      argv.push(String(raw));
    } else {
      argv.push(p.flag, String(raw));
    }
  }
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
