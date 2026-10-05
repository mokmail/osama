/**
 * Read llama.cpp's startup log well enough to tell the user where a model is
 * in the load sequence. Pure and DOM-free on purpose — easy to reason about
 * and to test.
 */

export type LoadPhase = "idle" | "starting" | "weights" | "context" | "ready" | "error";

/** Ordered; `progress` maps an index onto the bar. */
export const PHASES = ["starting", "weights", "context", "ready"] as const;
export type ProgressPhase = (typeof PHASES)[number];

const PHASE_LABEL: Record<LoadPhase, string> = {
  idle: "idle",
  starting: "starting process",
  weights: "loading weights",
  context: "building context",
  ready: "ready",
  error: "failed",
};

export function phaseLabel(p: LoadPhase): string {
  return PHASE_LABEL[p] ?? p;
}

export function phaseIndex(p: LoadPhase): number {
  const i = (PHASES as readonly string[]).indexOf(p);
  return i < 0 ? -1 : i;
}

/** 0..1 for the progress bar; -1 phases (idle/error) report 0. */
export function phaseProgress(p: LoadPhase): number {
  const i = phaseIndex(p);
  return i < 0 ? 0 : i / (PHASES.length - 1);
}

/** One line -> the furthest phase it proves we have reached, or null. */
export function classifyLoadLine(line: string): LoadPhase | null {
  if (!line) return null;
  if (/server is listening|all slots are idle|main: server|HTTP server is listening/i.test(line)) return "ready";
  if (/\b(error|failed|aborted|segmentation|assert)\b/i.test(line)) return "error";
  // llama.cpp spells it `llama_kv_cache` — match both the symbol and the prose.
  if (/llama_context|llama_kv|kv cache|kv_cache|kv self size|n_ctx_per_seq|compute buffer|graph splits/i.test(line)) return "context";
  if (/load_tensors|llama_model_load|loading model|offloading|offloaded/i.test(line)) return "weights";
  return null;
}

/**
 * Fold a batch of lines into the furthest phase reached, keeping the running
 * "current" phase monotonic (llama.cpp interleaves its output).
 */
export function scanLines(lines: string[], max: LoadPhase = "starting"): { phase: LoadPhase; last: string | null } {
  let best = max;
  let bestIdx = Math.max(0, phaseIndex(max));
  let last: string | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    last = line;
    const p = classifyLoadLine(line);
    if (!p) continue;
    if (p === "error") return { phase: "error", last: line };
    const idx = phaseIndex(p);
    if (idx > bestIdx) {
      bestIdx = idx;
      best = p;
    }
  }
  return { phase: best, last };
}

const NOISE = /^(build:|system_info:|print_info:|llama_model_loader:|load_tensors:|main: |srv |slot )/i;

/**
 * The lines that actually explain a failed load — the error itself plus its
 * context. Falls back to the tail when nothing matches, so the user is never
 * shown an empty box.
 */
export function errorLines(lines: string[], max = 6): string[] {
  const scored = lines.map((raw) => raw.trim()).filter(Boolean);
  const errors = scored.filter((l) => /\b(error|failed|abort|assert|segmentation|out of memory|cannot|unable)\b/i.test(l));
  if (errors.length === 0) return scored.slice(-max);

  // Keep the last few errors plus a couple of preceding lines for context.
  const lastErrIdx = scored.lastIndexOf(errors[errors.length - 1]!);
  const start = Math.max(0, lastErrIdx - 3);
  const window = scored.slice(start, lastErrIdx + 1).filter((l) => !NOISE.test(l));
  const picked = (window.length ? window : errors).slice(-max);
  return picked;
}
