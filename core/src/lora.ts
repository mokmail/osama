import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";
import { readGguf } from "./gguf.js";

/**
 * LoRA adapters: inspecting them, and folding them into a base model.
 *
 * Honest scope. llama.cpp's release binaries contain **no trainer** — there is
 * no `llama-finetune`. What they do contain is `llama-export-lora`, which
 * merges adapters into a standalone GGUF. So "finetune" inside Osama means the
 * *result* side of the workflow:
 *
 *   train elsewhere (unsloth / PEFT / llama-finetune)  ->  adapter.gguf
 *   Osama: merge adapter + base, resave a servable GGUF
 *
 * The UI states this plainly rather than offering a button that cannot work.
 */

const log = logger("lora");

export interface LoraMergePlan {
  ok: boolean;
  argv: string[];
  error?: string;
}

/**
 * Plan a LoRA merge.
 *
 * `--lora` takes a comma-separated list, so several adapters become ONE
 * argument — emitting the flag repeatedly would leave the later ones silently
 * unused. `-o` must be given: if it is omitted the tool writes
 * `ggml-lora-merged-f16.gguf` into the process cwd, which nobody asked for.
 */
export function planLoraMerge(
  base: string,
  adapters: string[],
  output: string,
  opts: { threads?: number } = {},
): LoraMergePlan {
  if (!base) return { ok: false, argv: [], error: "a base GGUF is required" };
  const list = adapters.map((a) => a.trim()).filter(Boolean);
  if (!list.length) return { ok: false, argv: [], error: "at least one LoRA adapter is required" };
  if (!output) return { ok: false, argv: [], error: "an output path is required — the tool would otherwise write into the current directory" };
  if (path.resolve(base) === path.resolve(output)) {
    return { ok: false, argv: [], error: "the output must differ from the base model" };
  }
  const missing = list.filter((a) => !fs.existsSync(a));
  if (missing.length) return { ok: false, argv: [], error: `adapter not found: ${missing.join(", ")}` };

  const argv = ["-m", base, "--lora", list.join(","), "-o", output];
  if (opts.threads && opts.threads > 0) argv.push("-t", String(opts.threads));
  return { ok: true, argv };
}

export interface LoraInspection {
  file: string;
  ok: boolean;
  sizeBytes?: number;
  /** Which base the adapter was trained against, when the header records it. */
  baseModel?: string;
  error?: string;
}

/** Best-effort read of an adapter's own metadata (they are GGUFs themselves). */
export function inspectLora(file: string): LoraInspection {
  if (!fs.existsSync(file)) return { file, ok: false, error: "not found" };
  const sizeBytes = fs.statSync(file).size;
  try {
    // Adapters are small GGUF files; the same reader works.
    const info = readGguf(file, 8 * 1024 * 1024);
    const base = info.metadata["general.base_model.name"] ?? info.metadata["lora.base_model"];
    return { file, ok: true, sizeBytes, ...(typeof base === "string" ? { baseModel: base } : {}) };
  } catch (err) {
    log.debug(`could not read adapter metadata for ${file}: ${(err as Error).message}`);
    // A .safetensors or a raw adapter is still perfectly usable by the merge —
    // not being able to read a header is not a reason to refuse.
    return { file, ok: true, sizeBytes };
  }
}

/** Which adapters a directory offers, for the picker. */
export function findAdapters(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.(gguf|safetensors|bin)$/i.test(e.name))
      .map((e) => path.join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

export const LORA_NOTES = {
  noTrainer:
    "llama.cpp's binary releases ship no trainer — there is no llama-finetune to drive. Train an adapter with " +
    "unsloth, PEFT or llama-finetune, then merge it here into a standalone GGUF.",
  outputF16: "Merged output is always F16 — quantize it afterwards if you need a smaller file.",
} as const;
