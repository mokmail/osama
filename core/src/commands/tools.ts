/**
 * The tool catalogue, and the argv builder that renders it.
 *
 * Every flag here is exercised against the installed build by
 * `scripts/probe-flags.mjs`; a flag the build rejects fails that script.
 */
import path from "node:path";
import os from "node:os";
import { paths } from "../paths.js";
import {
  modelParams,
  performanceParams,
  loadModeParam,
  samplingParams,
  outputParams,
  serverParams,
  QUANT_TYPES,
  QUANT_ENUM_HELP,
  GGML_TYPES,
  GGML_ENUM_HELP,
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
    notes: [
      "llama-quantize reads a GGUF and writes a NEW, smaller file: the input is never modified. Leave the output empty and llama.cpp writes a name beside the input (…-Q4_K_M.gguf).",
      "Only the quant type is really a choice. Q4_K_M is the balanced default; step up to Q5_K_M or Q6_K when quality matters more than size, and step down to IQ3/IQ2 only after measuring the loss with perplexity.",
      "Read the type picker as families: Q4_0/Q5_1 are legacy uniform quants, Q*_K_* are k-quants (mixed precision per tensor), IQ* are importance-aware, TQ*/Q1_*/Q2_0 are experimental.",
      "An importance matrix (optional, advanced) records which tensors matter, so the same bit budget keeps more quality. Build one on the Importance matrix tab first, then point the imatrix field at it.",
      "Quantizing a file that is already quantized needs Allow requantize — and quality only compounds downward. Start from an F16/BF16 GGUF when you can.",
      "Threads changes how long the conversion takes, never the result.",
    ],
    params: [
      {
        key: "input", flag: "", type: "model", label: "Input GGUF", positional: true, group: "Quantize", order: 1,
        required: true,
        help: "The GGUF to convert — pick a library model or type any path. Unquantized (F16/BF16) input gives the best result.",
        example: "/Users/you/models/model-f16.gguf",
      },
      {
        key: "output", flag: "", type: "path", label: "Output GGUF", positional: true, group: "Quantize", order: 2,
        help: "Where the new file goes. Omit it to write alongside the input; the input file is never overwritten.",
        example: "/Users/you/models/model-Q4_K_M.gguf",
      },
      {
        key: "type", flag: "", type: "enum", enum: [...QUANT_TYPES], enumHelp: QUANT_ENUM_HELP, label: "Quant type",
        positional: true, group: "Quantize", order: 3, default: "Q4_K_M",
        help: "Target precision — the size/quality dial. The note under the picker explains the selected type.",
      },
      // NOT a flag: llama-quantize takes the thread count as a trailing
      // positional. Declaring it as "-t" made the binary read the input path AS
      // the ftype and abort with `invalid ftype '<model>'`.
      {
        key: "threads", flag: "", type: "number", label: "Threads", positional: true, group: "Quantize", order: 4,
        unit: "nthreads", help: "Worker threads, passed as a trailing number. Optional — more threads only finish sooner.",
        example: "8",
      },
      {
        key: "imatrix", flag: "--imatrix", type: "path", label: "Importance matrix", group: "Quantize", order: 5, advanced: true,
        help: "Optional .imatrix file from the Importance matrix tab. Worth adding for any type below Q5.",
        example: "/Users/you/models/model.imatrix",
      },
      {
        key: "allowRequantize", flag: "--allow-requantize", type: "bool", label: "Allow requantize", group: "Quantize", order: 6,
        advanced: true, help: "Needed when the input is already quantized — llama-quantize refuses that by default.",
      },
      {
        key: "pure", flag: "--pure", type: "bool", label: "Pure quant (no k-quant mix)", group: "Quantize", order: 7,
        advanced: true, help: "Force one type for every tensor instead of the k-quant mixture.",
      },
      {
        key: "leaveOutputTensor", flag: "--leave-output-tensor", type: "bool", label: "Leave output tensor unquantized",
        group: "Quantize", order: 8, advanced: true, help: "Keep the output (lm_head) tensor at f32 — slightly larger, slightly better.",
      },
      {
        key: "outputTensorType", flag: "--output-tensor-type", type: "enum", enum: [...GGML_TYPES], enumHelp: GGML_ENUM_HELP,
        label: "Output tensor type", group: "Tensors", order: 1, advanced: true,
        help: "Quantize the output tensor at its own type instead of leaving it alone.",
      },
      {
        key: "tokenEmbeddingType", flag: "--token-embedding-type", type: "enum", enum: [...GGML_TYPES], enumHelp: GGML_ENUM_HELP,
        label: "Token embedding type", group: "Tensors", order: 2, advanced: true,
        help: "Quantize the token embedding tensor at its own type.",
      },
      {
        key: "tensorType", flag: "--tensor-type", type: "string", label: "Per-tensor types", group: "Tensors", order: 3,
        advanced: true, repeat: true,
        help: "One rule per line: tensor_name=ggml_type. Names are regex-matched (blk.0.attn_q.weight). Overrides the global type for those tensors.",
        example: "blk.0.attn_q.weight=q4_k",
      },
      {
        key: "pruneLayers", flag: "--prune-layers", type: "string", label: "Prune layers", group: "Tensors", order: 4,
        advanced: true, help: "Comma-separated layer indices to drop entirely — shrinks the model and changes behaviour.",
        example: "24,25,26",
      },
      {
        key: "keepSplit", flag: "--keep-split", type: "bool", label: "Keep input shards", group: "Tensors", order: 5,
        advanced: true, help: "When the input is split into shards, quantize shard by shard instead of as one file.",
      },
      {
        key: "dryRun", flag: "--dry-run", type: "bool", label: "Dry run (size only)", group: "Tensors", order: 6,
        advanced: true, help: "Report the resulting size without writing anything.",
      },
      {
        key: "maxBufferSize", flag: "--max-buffer-size", type: "number", label: "Max buffer size", unit: "MiB",
        group: "Tensors", order: 7, advanced: true,
        help: "Working buffer per tensor. Raise it (e.g. 512) only if quantization is unusually slow.",
        example: "128",
      },
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
      { key: "input", flag: "", type: "model", label: "Input GGUF", positional: true, group: "Edit", order: 1, required: true },
      { key: "output", flag: "", type: "path", label: "Output GGUF", required: true, help: "A new file — the input is never overwritten.", positional: true, group: "Edit", order: 2 },
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
    notes: [
      "Run this BEFORE quantizing: it measures which tensors respond well to weight changes, written to a .imatrix file that the Quantize tab then consumes.",
      "Use the model you are about to quantize, ideally its F16/BF16 original.",
      "Calibration text should look like your use case (a few hundred KB of plain text is plenty). More chunks = a slower, slightly better matrix; 100–200 is a good default.",
    ],
    params: [
      { key: "model", flag: "-m", aliases: ["--model"], type: "model", label: "Model", group: "IMatrix", order: 1,
        required: true,
        help: "The model being measured — normally the unquantized source you will convert." },
      { key: "file", flag: "-f", aliases: ["--file"], type: "string", label: "Calibration file", group: "IMatrix", order: 2,
        help: "Plain-text corpus in the style of your prompts. Without it llama-imatrix uses its built-in wiki text.",
        example: "/Users/you/calibration.txt" },
      { key: "output", flag: "-o", aliases: ["--output", "--output-file"], type: "path", label: "Output .imatrix", group: "IMatrix", order: 3,
        help: "Where the matrix is written — feed this file to the Quantize tab's imatrix field.",
        example: "/Users/you/models/model.imatrix" },
      { key: "ctx", flag: "-c", aliases: ["--ctx-size"], type: "number", label: "Context", group: "IMatrix", order: 4,
        help: "Chunk size in tokens. 512 keeps memory small and is a good default.", example: "512" },
      { key: "chunks", flag: "-n", aliases: ["--chunks"], type: "number", label: "Chunks", group: "IMatrix", order: 5,
        help: "How many chunks to process — the run length versus matrix quality trade-off.", example: "100" },
      { key: "gpuLayers", flag: "-ngl", aliases: ["--n-gpu-layers"], type: "number", label: "GPU layers", group: "IMatrix", order: 6,
        help: "Offload layers to the GPU. 999 offloads everything.", example: "999" },
    ],
  },

  split: {
    id: "split",
    binary: "llama-gguf-split",
    title: "Split / merge GGUF",
    summary: "Split a large GGUF into parts, or merge parts back together.",
    group: "create",
    mode: "oneshot",
    notes: [
      "Split mode cuts one GGUF into shards small enough to move or to fit a host file-size limit; merge mode stitches a directory of shards back into a single file.",
      "Shard names carry the split index (…-00001-of-00003.gguf). Merging needs all of them present, and produces a new file — the shards stay unless you ask for --delete-splits.",
    ],
    params: [
      { key: "merge", flag: "--merge", type: "bool", label: "Merge mode", help: "Merge the shards in a directory into one file (off = split).", group: "Split", order: 1 },
      { key: "input", flag: "", type: "model", label: "Input GGUF", positional: true, group: "Split", order: 2,
        required: true,
        help: "Split mode: the GGUF to cut. Merge mode: the directory holding the shards.",
        example: "split: /Users/you/models/model.gguf  ·  merge: /Users/you/models/parts/" },
      { key: "output", flag: "", type: "path", label: "Output prefix / file", positional: true, group: "Split", order: 3,
        required: true,
        help: "Split mode: where the shards go (llama.cpp appends -00001-of-0000N). Merge mode: the single file to write.",
        example: "/Users/you/models/model-Q4_K_M.gguf" },
      { key: "size", flag: "--split-max-size", type: "string", label: "Max size per part", group: "Split", order: 4, default: "4G", unit: "e.g. 4G / 500M",
        help: "Split mode only: target maximum size of each shard.", requires: [] },
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

  /**
   * MLX conversion — which is also MLX quantisation.
   *
   * `mlx_lm.convert` turns a Hugging Face model into MLX format, and `-q` makes that
   * same pass write quantised weights. That is the honest difference from the
   * llama.cpp side, where llama-quantize is a second pass over an existing GGUF: here
   * "convert" and "quantise" are one step, and the tool is named for what comes first.
   */
  "mlx-convert": {
    id: "mlx-convert",
    binary: "mlx_lm.convert",
    engine: "mlx",
    title: "Convert (MLX)",
    summary: "Turn a Hugging Face model into an MLX model — unquantised, or quantised in the same pass.",
    group: "mlx",
    mode: "oneshot",
    notes: [
      "The input is a Hugging Face model: a repo id, or a folder holding config.json, the tokenizer and .safetensors weights (what `transformers` saves). An MLX model is what comes OUT — this tool cannot read an MLX directory.",
      "Quantisation is not a second pass here. Tick it and the conversion writes quantised weights directly, at the bit width, group size and mode you choose.",
      "Mixed precision is the lever for a model that will not otherwise fit: instead of one bit width everywhere, a recipe puts more bits in the layers that notice and fewer in the ones that do not. It costs time, because sensitivities are measured first.",
      "The output is an ordinary directory under your models folder: it appears in the library as soon as it is complete, and serves like any other MLX model.",
    ],
    params: [
      {
        key: "hfPath", flag: "--hf-path", aliases: ["--model"], type: "string",
        label: "Hugging Face model", group: "Input", order: 1, required: true,
        help: "A repo id, or a local folder with config.json + tokenizer + .safetensors.",
        example: "mlx-community/Qwen2.5-0.5B-Instruct",
      },
      {
        key: "mlxPath", flag: "--mlx-path", type: "string",
        label: "Output folder", group: "Input", order: 2, required: true,
        help: "An absolute path. Under the models folder, the library picks it up the moment it is complete.",
        example: path.join(paths().models, "Qwen2.5-0.5B-Instruct-mlx-4bit"),
      },
      {
        key: "quantize", flag: "-q", type: "bool",
        label: "Quantize while converting", group: "Quantisation", order: 1,
        help: "Without this the copy keeps the source dtype (float16/bfloat16) — correct, and several times larger.",
      },
      {
        key: "qBits", flag: "--q-bits", type: "enum", enum: ["2", "3", "4", "5", "6", "8"],
        enumHelp: {
          "2": "Smallest. Chat stays coherent; anything factual degrades badly.",
          "3": "A common compromise for a large model that must fit.",
          "4": "The default choice: about a quarter of float16, and hard to tell apart in conversation.",
          "5": "Slightly safer than 4, uncommon — prefer 4 or 6.",
          "6": "Better than 4 at roughly 1.5x the size.",
          "8": "Near-lossless, half of float16.",
        },
        label: "Bits per weight", group: "Quantisation", order: 2, requires: ["quantize"],
        help: "Used when Quantize is on. Ignored otherwise, and not emitted into the command.",
      },
      {
        key: "qGroupSize", flag: "--q-group-size", type: "enum", enum: ["32", "64", "128"],
        enumHelp: {
          "32": "Smaller groups track the weights more closely: better quality, slightly larger.",
          "64": "The usual default.",
          "128": "Faster and smaller, a little coarser.",
        },
        label: "Group size", group: "Quantisation", order: 3, requires: ["quantize"],
      },
      {
        key: "qMode", flag: "--q-mode", type: "enum", enum: ["affine", "mxfp4", "nvfp4", "mxfp8"],
        enumHelp: {
          "affine": "The standard scale + zero-point scheme: what nearly every MLX model on the Hub uses.",
          "mxfp4": "Microscaling 4-bit float, in the style of the OCP MX formats.",
          "nvfp4": "NVIDIA's 4-bit float format. MLX reads it; other runtimes usually cannot.",
          "mxfp8": "Microscaling 8-bit float.",
        },
        label: "Quantisation mode", group: "Quantisation", order: 4, advanced: true, requires: ["quantize"],
      },
      {
        key: "quantPredicate", flag: "--quant-predicate", type: "enum",
        enum: ["mixed_2_6", "mixed_3_4", "mixed_3_6", "mixed_4_6"],
        enumHelp: {
          "mixed_2_6": "2- and 6-bit layers: the smallest recipe.",
          "mixed_3_4": "3- and 4-bit layers.",
          "mixed_3_6": "3- and 6-bit layers — a good fit for a dense model squeezed hard.",
          "mixed_4_6": "4- and 6-bit layers: the gentlest, when quality matters more than size.",
        },
        label: "Mixed precision recipe", group: "Quantisation", order: 5, requires: ["quantize"],
        help: "Per-layer bits instead of one width everywhere. Takes precedence over Bits per weight.",
      },
      {
        key: "dtype", flag: "--dtype", type: "enum", enum: ["float16", "bfloat16", "float32"],
        label: "Dtype for unquantised weights", group: "Quantisation", order: 6, advanced: true, requires: ["quantize"],
        help: "Applies to the weights a mixed-precision recipe leaves unquantised.",
      },
      {
        key: "dequantize", flag: "-d", aliases: ["--dequantize"], type: "bool",
        label: "Dequantize instead", group: "Quantisation", order: 7, advanced: true,
        help: "Reads a quantised model and writes it back to full precision.",
      },
      {
        key: "trustRemoteCode", flag: "--trust-remote-code", type: "bool",
        label: "Trust remote code", group: "Advanced", order: 1, advanced: true,
        help: "For repos whose tokenizer loader needs custom Python. It runs that code.",
      },
    ],
  },

  /**
   * Dynamic quantisation: the second pass, on a model that is already MLX.
   *
   * One bit width for every layer is a compromise. This measures how much each layer
   * cares — with gradients — and spends the bits where they are noticed. Slower than
   * a convert, and the thing that makes a tight memory budget work.
   */
  "mlx-dynamic-quant": {
    id: "mlx-dynamic-quant",
    binary: "mlx_lm.dynamic_quant",
    engine: "mlx",
    title: "Dynamic quantisation",
    summary: "Quantise an MLX model you already have, choosing the bit width per layer for a target bits-per-weight.",
    group: "mlx",
    mode: "oneshot",
    notes: [
      "The input is an MLX model directory — convert first if what you have is a Hugging Face checkpoint.",
      "The target is an average: the tool splits the layers into a high-bit and a low-bit group, and measures sensitivities to decide which is which.",
      "Measuring sensitivities means gradients, so this is the slowest thing on this page. Report perplexity measures the base model too, which doubles it again.",
      "The output is a new directory; the original is left untouched.",
      "While it measures, it writes a `<model>_sensitivities.json` file into the working directory (your models folder). Keep it and pass it back with Sensitivities JSON to skip the measurement next time.",
    ],
    params: [
      {
        key: "model", flag: "--model", type: "string",
        label: "MLX model folder", group: "Input", order: 1, required: true,
        help: "A directory with config.json and .safetensors weights — an MLX model, not a GGUF. It must be full precision: sensitivities are gradients on the weights, and an already-quantised model has none to measure.",
        example: path.join(paths().models, "Qwen2.5-7B-Instruct-4bit"),
      },
      {
        key: "mlxPath", flag: "--mlx-path", type: "string",
        label: "Output folder", group: "Input", order: 2, required: true,
        help: "An absolute path, and not the input folder.",
        example: path.join(paths().models, "Qwen2.5-7B-Instruct-dynamic-4bit"),
      },
      {
        key: "targetBpw", flag: "--target-bpw", type: "number",
        label: "Target bits per weight", group: "Quantisation", order: 1,
        help: "The average to aim for. 4 is the usual choice.",
        example: "4",
      },
      { key: "lowBits", flag: "--low-bits", type: "enum", enum: ["2", "3", "4"], label: "Low group bits", group: "Quantisation", order: 2 },
      { key: "lowGroupSize", flag: "--low-group-size", type: "enum", enum: ["32", "64", "128"], label: "Low group size", group: "Quantisation", order: 3, advanced: true },
      { key: "highBits", flag: "--high-bits", type: "enum", enum: ["4", "6", "8"], label: "High group bits", group: "Quantisation", order: 4 },
      { key: "highGroupSize", flag: "--high-group-size", type: "enum", enum: ["32", "64", "128"], label: "High group size", group: "Quantisation", order: 5, advanced: true },
      {
        key: "reportPpl", flag: "--report-ppl", type: "bool",
        label: "Report perplexity", group: "Measurement", order: 1,
        help: "Measures the base model and the quantised one. Honest numbers, and a long wait.",
      },
      { key: "sensitivities", flag: "--sensitivities", type: "string", label: "Sensitivities JSON", group: "Advanced", order: 1, advanced: true,
        help: "Reuse an earlier run's sensitivity file instead of measuring again." },
      { key: "seed", flag: "--seed", type: "number", label: "Seed", group: "Advanced", order: 2, advanced: true,
        help: "For a reproducible measurement." },
      { key: "gradCheckpoint", flag: "--grad-checkpoint", type: "bool", label: "Gradient checkpointing", group: "Advanced", order: 3, advanced: true,
        help: "Less memory while measuring, a little slower." },
      { key: "accumulationDtype", flag: "--accumulation-dtype", type: "enum", enum: ["float32", "bfloat16"], label: "Accumulation dtype", group: "Advanced", order: 4, advanced: true,
        help: "What the sensitivities accumulate in. float32 is the careful default." },
      { key: "trustRemoteCode", flag: "--trust-remote-code", type: "bool", label: "Trust remote code", group: "Advanced", order: 5, advanced: true },
    ],
  },
};

// ---------------------------------------------------------------------------
// argv building
// ---------------------------------------------------------------------------

function isTruthy(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "" && v !== false;
}

/**
 * `~/x` is a shell convenience, and argv arrays never see a shell.
 *
 * A path typed as `~/Downloads/model.gguf` would otherwise become a literal directory
 * called `~` next to the process's cwd — which, for an output path, means the tool
 * "succeeds" while writing somewhere the user will never find. Harmless to expand:
 * no flag value legitimately begins with a tilde.
 */
function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
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
    if (p.positional) argv.push(expandHome(String(raw)));
    else argv.push(p.flag, expandHome(String(raw)));
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
