import fs from "node:fs";

/**
 * Minimal, dependency-free GGUF reader. Parses the header and metadata
 * key/value store from a GGUF file so Osama can show a real model card
 * (architecture, context length, quantization, parameter count) without
 * loading the weights.
 *
 * Spec: https://github.com/ggml-org/ggml/blob/master/docs/gguf.md
 */

const GGUF_MAGIC = 0x46554747; // "GGUF" little-endian

enum GgufType {
  UINT8 = 0,
  INT8 = 1,
  UINT16 = 2,
  INT16 = 3,
  UINT32 = 4,
  INT32 = 5,
  FLOAT32 = 6,
  BOOL = 7,
  STRING = 8,
  ARRAY = 9,
  UINT64 = 10,
  INT64 = 11,
  FLOAT64 = 12,
}

export interface GgufInfo {
  version: number;
  tensorCount: number;
  metadataCount: number;
  /** scalar metadata values (strings + numbers + bools) */
  metadata: Record<string, string | number | boolean>;
  /** array-valued metadata, kept as counts to keep the object light */
  arrayCounts: Record<string, number>;
}

class Reader {
  private buf: Buffer;
  private off = 0;
  constructor(buf: Buffer) {
    this.buf = buf;
  }
  u8(): number {
    return this.buf.readUInt8(this.off++);
  }
  i8(): number {
    return this.buf.readInt8(this.off++);
  }
  u16(): number {
    const v = this.buf.readUInt16LE(this.off);
    this.off += 2;
    return v;
  }
  i16(): number {
    const v = this.buf.readInt16LE(this.off);
    this.off += 2;
    return v;
  }
  u32(): number {
    const v = this.buf.readUInt32LE(this.off);
    this.off += 4;
    return v;
  }
  i32(): number {
    const v = this.buf.readInt32LE(this.off);
    this.off += 4;
    return v;
  }
  u64(): bigint {
    const v = this.buf.readBigUInt64LE(this.off);
    this.off += 8;
    return v;
  }
  i64(): bigint {
    const v = this.buf.readBigInt64LE(this.off);
    this.off += 8;
    return v;
  }
  f32(): number {
    const v = this.buf.readFloatLE(this.off);
    this.off += 4;
    return v;
  }
  f64(): number {
    const v = this.buf.readDoubleLE(this.off);
    this.off += 8;
    return v;
  }
  str(): string {
    const len = Number(this.u64());
    const s = this.buf.toString("utf8", this.off, this.off + len);
    this.off += len;
    return s;
  }
  skip(n: number): void {
    this.off += n;
  }
  get offset(): number {
    return this.off;
  }
}

function readValue(r: Reader, type: GgufType): { scalar?: string | number | boolean; arrayLen?: number } {
  switch (type) {
    case GgufType.UINT8:
      return { scalar: r.u8() };
    case GgufType.INT8:
      return { scalar: r.i8() };
    case GgufType.UINT16:
      return { scalar: r.u16() };
    case GgufType.INT16:
      return { scalar: r.i16() };
    case GgufType.UINT32:
      return { scalar: r.u32() };
    case GgufType.INT32:
      return { scalar: r.i32() };
    case GgufType.FLOAT32:
      return { scalar: r.f32() };
    case GgufType.BOOL:
      return { scalar: Boolean(r.u8()) };
    case GgufType.STRING:
      return { scalar: r.str() };
    case GgufType.UINT64:
      return { scalar: Number(r.u64()) };
    case GgufType.INT64:
      return { scalar: Number(r.i64()) };
    case GgufType.FLOAT64:
      return { scalar: r.f64() };
    case GgufType.ARRAY: {
      const elemType = r.u32() as GgufType;
      const len = Number(r.u64());
      // Skip elements (we only keep the length).
      for (let i = 0; i < len; i++) readValue(r, elemType);
      return { arrayLen: len };
    }
    default:
      throw new Error(`unknown GGUF value type ${type}`);
  }
}

/**
 * Read GGUF header + metadata.
 *
 * Metadata can honestly be large — a chat template alone runs to kilobytes, and
 * a tokenizer vocabulary can be megabytes — so `maxBytes` is a *starting*
 * window, not a hard ceiling. If the metadata runs past it the buffer is grown
 * and the parse retried, which is what makes this safe to call with a small
 * window (the metadata editor's pre-flight check does exactly that). A genuine
 * parse fault still throws.
 */
export function readGguf(file: string, maxBytes = 64 * 1024 * 1024): GgufInfo {
  const fd = fs.openSync(file, "r");
  try {
    const fileSize = fs.statSync(file).size;
    let window = Math.max(4096, Math.min(fileSize, maxBytes));
    for (;;) {
      const buf = Buffer.alloc(window);
      fs.readSync(fd, buf, 0, window, 0);
      const r = new Reader(buf);
      try {
        return parseHeader(r, window >= fileSize);
      } catch (err) {
        // Short read: the metadata ran past our window and there is more file
        // to fetch. Grow and retry — once.
        if (window < fileSize) {
          window = Math.min(fileSize, window * 4);
          continue;
        }
        throw err;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

function parseHeader(r: Reader, wholeFile: boolean): GgufInfo {
  const magic = r.u32();
  if (magic !== GGUF_MAGIC) throw new Error("not a GGUF file (bad magic)");
  const version = r.u32();
  const tensorCount = Number(r.u64());
  const metadataCount = Number(r.u64());
  const metadata: Record<string, string | number | boolean> = {};
  const arrayCounts: Record<string, number> = {};
  for (let i = 0; i < metadataCount; i++) {
    const key = r.str();
    const type = r.u32() as GgufType;
    const { scalar, arrayLen } = readValue(r, type);
    if (scalar !== undefined) metadata[key] = scalar;
    else if (arrayLen !== undefined) arrayCounts[key] = arrayLen;
  }
  void wholeFile;
  return { version, tensorCount, metadataCount, metadata, arrayCounts };
}

/** Human file-type names per llama.cpp's ggml file_type enum (partial, common values). */
const FILE_TYPE: Record<number, string> = {
  0: "F32",
  1: "F16",
  2: "Q4_0",
  3: "Q4_1",
  7: "Q8_0",
  8: "Q5_0",
  9: "Q5_1",
  10: "Q2_K",
  11: "Q3_K_S",
  12: "Q3_K_M",
  13: "Q3_K_L",
  14: "Q4_K_S",
  15: "Q4_K_M",
  16: "Q5_K_S",
  17: "Q5_K_M",
  18: "Q6_K",
  19: "IQ2_XXS",
  20: "IQ2_XS",
  21: "Q2_K_S",
  22: "IQ3_XS",
  23: "IQ3_XXS",
  24: "IQ1_S",
  25: "IQ4_NL",
  26: "IQ3_S",
  27: "IQ3_M",
  28: "IQ2_S",
  29: "IQ2_M",
  30: "IQ4_XS",
  31: "IQ1_M",
  32: "BF16",
  33: "Q4_0_4_4",
  34: "Q4_0_4_8",
  35: "Q4_0_8_8",
  36: "TQ1_0",
  37: "TQ2_0",
  // Added upstream since this table was written; without them a modern model
  // reads as "unknown quantization" in the library and on the dashboard.
  38: "MXFP4_MOE",
  40: "Q1_0",
  41: "Q2_0",
};

export interface ModelCard {
  architecture?: string;
  name?: string;
  contextLength?: number;
  embeddingLength?: number;
  parameterCount?: number;
  quantization?: string;
  fileType?: number;
  tokenizerModel?: string;
  chatTemplate?: boolean;
}

/**
 * Does this GGUF look like a speculative-decoding draft head (MTP / NextN)
 * rather than a full model?
 *
 * llama-server SIGSEGVs when a draft head is loaded as the main model, and the
 * UI/server already have a 422 guard for it — but nothing ever set the flag, so
 * the guard never fired. A draft head is recognisably short: a handful of
 * blocks and a near-zero parameter count. Both facts come straight from the
 * header, so this needs no heuristics beyond generous thresholds.
 */
export function isDraftModel(info: GgufInfo): boolean {
  const md = info.metadata;
  const arch = typeof md["general.architecture"] === "string" ? (md["general.architecture"] as string) : undefined;
  const blocks = arch ? md[`${arch}.block_count`] : undefined;
  const params = typeof md["general.parameter_count"] === "number" ? (md["general.parameter_count"] as number) : undefined;

  // A real generative model never has fewer than ~8 blocks.
  if (typeof blocks === "number" && blocks > 0 && blocks <= 4) return true;
  // A draft head is a single block's worth of weights: far under 200M params,
  // while every servable model in practice exceeds 500M.
  if (typeof params === "number" && params > 0 && params < 200_000_000) return true;
  if (typeof params === "number" && params < 0) return true;
  return false;
}

/** Turn raw GGUF metadata into a friendly model card. */
export function toModelCard(info: GgufInfo): ModelCard {
  const md = info.metadata;
  const arch = typeof md["general.architecture"] === "string" ? (md["general.architecture"] as string) : undefined;
  const fileType = typeof md["general.file_type"] === "number" ? (md["general.file_type"] as number) : undefined;
  const ctx = arch ? md[`${arch}.context_length`] : md["llama.context_length"];
  const emb = arch ? md[`${arch}.embedding_length`] : md["llama.embedding_length"];
  const paramCount = md["general.parameter_count"] ?? md["general.size_label"];
  return {
    architecture: arch,
    name: typeof md["general.name"] === "string" ? (md["general.name"] as string) : undefined,
    contextLength: typeof ctx === "number" ? ctx : undefined,
    embeddingLength: typeof emb === "number" ? emb : undefined,
    parameterCount: typeof paramCount === "number" ? paramCount : undefined,
    quantization: fileType !== undefined ? FILE_TYPE[fileType] : undefined,
    fileType,
    tokenizerModel: typeof md["tokenizer.ggml.model"] === "string" ? (md["tokenizer.ggml.model"] as string) : undefined,
    chatTemplate: typeof md["tokenizer.chat_template"] === "string" || "tokenizer.chat_template" in md,
  };
}
