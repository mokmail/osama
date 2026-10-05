import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";
import { readGguf } from "./gguf.js";

/**
 * Edit a GGUF's metadata and resave it.
 *
 * llama.cpp ships **no** metadata-editing binary. What it does ship is
 * `llama-quantize … COPY --override-kv`, which rewrites the file carrying the
 * tensors over untouched — the officially supported way to change metadata.
 * Osama drives exactly that and then *proves* the edit landed by re-reading the
 * result with its own GGUF parser, because a silent no-op here would be worse
 * than an error.
 *
 * The value spelling was pinned by experiment against b11398: the type names
 * are `str` / `int` / `float` / `bool`. `STRING`, `u32`, `i32` … are all
 * rejected by `string_parse_kv_override`.
 */

const log = logger("ggufEdit");

export type OverrideType = "str" | "int" | "float" | "bool";

export interface MetadataEdit {
  key: string;
  /** the type name the binary expects — NOT the gguf enum name */
  type: OverrideType;
  value: string | number | boolean;
}

/**
 * One `--override-kv` argument, in the exact spelling the binary accepts.
 *
 * Pinned by experiment against b11398: the type names are `str` / `int` /
 * `float` / `bool`, and a bool value must be the literal `true` or `false` —
 * `bool:1` is rejected with "invalid boolean value for KV override".
 */
export function formatOverride(edit: MetadataEdit): string {
  const v = typeof edit.value === "boolean" ? (edit.value ? "true" : "false") : String(edit.value);
  return `${edit.key}=${edit.type}:${v}`;
}

export interface EditPlan {
  ok: boolean;
  /** The argv for llama-quantize (without the resolved binary). */
  argv: string[];
  /** The `--override-kv` values, for display. */
  overrides: string[];
  error?: string;
}

/**
 * Build the llama-quantize argv for a metadata edit.
 * `verify` re-reads the output instead of trusting the exit code.
 */
export function planEdit(input: string, output: string, edits: MetadataEdit[], opts: { dryRun?: boolean; keepSplit?: boolean } = {}): EditPlan {
  if (!input) return { ok: false, argv: [], overrides: [], error: "an input GGUF is required" };
  if (!output) return { ok: false, argv: [], overrides: [], error: "an output path is required" };
  if (!edits.length) return { ok: false, argv: [], overrides: [], error: "at least one metadata edit is required" };
  for (const e of edits) {
    if (!e.key || !/^[A-Za-z0-9._-]+$/.test(e.key)) {
      return { ok: false, argv: [], overrides: [], error: `"${e.key}" is not a valid GGUF metadata key` };
    }
    if (!["str", "int", "float", "bool"].includes(e.type)) {
      return { ok: false, argv: [], overrides: [], error: `unknown override type "${e.type}" (use str, int, float or bool)` };
    }
    // A bool must be a real boolean: the binary rejects `bool:1` outright, and
    // a string "false" is truthy in JS, so guessing here would flip the value.
    if (e.type === "bool" && typeof e.value !== "boolean") {
      if (e.value === "true" || e.value === "false") continue;
      return { ok: false, argv: [], overrides: [], error: `"${e.key}" wants true or false, got ${JSON.stringify(e.value)}` };
    }
    if ((e.type === "int" || e.type === "float") && !Number.isFinite(Number(e.value))) {
      return { ok: false, argv: [], overrides: [], error: `"${e.key}" wants a number, got ${JSON.stringify(e.value)}` };
    }
  }
  const overrides = edits.map(formatOverride);
  const argv: string[] = [];
  for (const o of overrides) argv.push("--override-kv", o);
  if (opts.dryRun) argv.push("--dry-run");
  if (opts.keepSplit) argv.push("--keep-split");
  argv.push(input, output, "COPY");
  return { ok: true, argv, overrides };
}

export interface EditResult {
  ok: boolean;
  output?: string;
  /** Metadata before, for the diff the UI shows. */
  before?: Record<string, string | number | boolean>;
  /** Metadata after the edit, read back from the new file. */
  after?: Record<string, string | number | boolean>;
  /** Edits that did NOT land (each is a silent failure). */
  unapplied?: string[];
  error?: string;
}

/**
 * Verify that each intended edit is present in the resaved file.
 *
 * A COPY without `--override-kv` support, or a mistyped key, still exits 0 —
 * so the only trustworthy check is reading the result back. Takes the metadata
 * map rather than a whole GgufInfo so callers can pass what they just read.
 */
export function verifyEdits(metadata: Record<string, unknown>, edits: MetadataEdit[]): string[] {
  const unapplied: string[] = [];
  for (const e of edits) {
    const got = metadata[e.key];
    const want = e.value;
    // Numbers come back as numbers; compare loosely, and report a key that is
    // simply absent as unapplied rather than pretending it worked. GGUF stores
    // a bool as a 0/1 integer, so a bool edit is compared as a truthiness.
    const same =
      got === undefined
        ? false
        : e.type === "str"
          ? String(got) === String(want)
          : e.type === "bool"
            ? Boolean(got) === Boolean(e.value)
            : Number(got) === Number(want);
    if (!same) unapplied.push(formatOverride(e));
  }
  return unapplied;
}

/** Read just the metadata of a file, tolerating failure. */
export function readMetadataSafe(file: string): Record<string, string | number | boolean> | undefined {
  try {
    return readGguf(file).metadata;
  } catch (err) {
    log.warn(`could not read ${file}: ${(err as Error).message}`);
    return undefined;
  }
}

/** Refuse an output that would clobber the input — a COPY rewrites in place. */
export function assertDistinctPaths(input: string, output: string): void {
  if (path.resolve(input) === path.resolve(output)) {
    throw new Error("the output must be a different file — editing never overwrites the input in place");
  }
}

/** Sensible default: `<name>.<label>.gguf` next to the input. */
export function suggestOutput(input: string, label = "edited"): string {
  const dir = path.dirname(input);
  const base = path.basename(input).replace(/\.gguf$/i, "");
  return path.join(dir, `${base}.${label}.gguf`);
}

/**
 * Metadata a user most often wants to change, surfaced by the UI as editable
 * rows. Values are read from the file so the form starts from the truth.
 */
export const EDITABLE_KEYS: Array<{ key: string; label: string; type: OverrideType; help?: string }> = [
  { key: "general.name", label: "Name", type: "str" },
  { key: "general.architecture", label: "Architecture", type: "str", help: "Rarely worth changing; the loader keys off it." },
  { key: "general.quantization_version", label: "Quantization version", type: "int" },
  { key: "tokenizer.chat_template", label: "Chat template", type: "str", help: "Jinja template; large but valid as a single-line string." },
  { key: "tokenizer.ggml.add_bos_token", label: "Add BOS token", type: "bool" },
  { key: "tokenizer.ggml.add_eos_token", label: "Add EOS token", type: "bool" },
];

/** Context-length keys are architecture-prefixed, so resolve them per file. */
export function contextLengthKey(meta: Record<string, unknown>): string | undefined {
  return Object.keys(meta).find((k) => k.endsWith(".context_length"));
}

/** Does a path look like a GGUF we can edit? Cheap pre-flight for the UI. */
export function isEditable(file: string): { ok: boolean; reason?: string } {
  if (!fs.existsSync(file)) return { ok: false, reason: "the file does not exist" };
  try {
    readGguf(file, 4 * 1024 * 1024);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}
