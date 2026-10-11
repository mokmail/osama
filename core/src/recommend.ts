import { systemInfo } from "./platform.js";
import { getActiveEngine } from "./engine.js";
import { repoFiles, type HubFile } from "./hub.js";
import { detectRuntime, listMlxModels, mlxSupport, planMlxRepo } from "./mlx.js";
import { listServableModels } from "./models.js";

/**
 * A model on first run.
 *
 * Osama ships no weights: a fresh install opens on an empty library and the
 * user is asked to go and find a model. This module answers the other half of
 * that question — *which* model — with a small, concrete, honest starting point
 * for the machine that is actually in front of them.
 *
 * Two rules decide everything here, and both are load-bearing:
 *
 * 1. **Only recommend what the machine can run.** MLX is offered only where
 *    `mlxSupport()` says Apple silicon; llama.cpp works everywhere, so a GGUF
 *    pick is always available as the floor.
 * 2. **Never invent a size.** The rule below is pure and knows only a nominal
 *    `nominalBytes` band, which is used *solely* to decide whether a bigger
 *    model plainly fits — it is never shown as fact. The number the user sees
 *    comes from `resolveOffer()`, which reads the app's own plan endpoint
 *    (`repoFiles` for a GGUF, `planMlxRepo` for an MLX repo). When that call
 *    fails the offer says so instead of guessing.
 */

export type RecommendEngine = "llama.cpp" | "mlx";

/** The machine shape the rule is a pure function of — no I/O, no globals. */
export interface MachineShape {
  /** `process.platform` — darwin | linux | win32 */
  platform: string;
  /** `process.arch` — arm64 | x64 */
  arch: string;
  totalMemBytes: number;
  /** `core.mlxSupport().supported` — Apple silicon with a Metal-capable macOS */
  mlxSupported: boolean;
  /** the MLX runtime is installed and can import mlx-lm */
  mlxReady: boolean;
  /** a llama.cpp build is installed */
  llamaCppInstalled: boolean;
}

export interface ModelOffer {
  /** stable key for the UI and for the size cache, e.g. `gguf:Qwen/…` */
  id: string;
  engine: RecommendEngine;
  kind: "gguf" | "mlx";
  label: string;
  /** the Hugging Face repo id */
  ref: string;
  /** GGUF: the one file to fetch. MLX fetches the whole repo, so this stays unset. */
  file?: string;
  /** the size, read from the app's own plan endpoint. Absent until resolved. */
  sizeBytes?: number;
  /**
   * A nominal footprint, used **only** for the memory-fit decision. Never the
   * number shown to the user — that is `sizeBytes`, or nothing.
   */
  nominalBytes: number;
  paramsB: number;
  /** "Q4_K_M" for a GGUF, "4-bit" for MLX */
  quant: string;
  rationale: string;
  /** exactly one offer is the one to start with */
  recommended: boolean;
  /** GGUF: no llama.cpp build installed yet — the card must say so */
  needsEngine?: boolean;
  /** MLX: the runtime is not installed yet — the card must offer that step */
  needsRuntime?: boolean;
  /** set when the real size could not be read, so the UI can say why */
  sizeNote?: string;
}

export interface RecommendPlan {
  offers: ModelOffer[];
  mlxSupported: boolean;
  mlxReady: boolean;
  engineInstalled: boolean;
  totalMemBytes: number;
  platform: string;
  arch: string;
  /** a sentence for a case worth naming (a missing runtime, a tight machine) */
  note?: string;
}

export interface Recommendation extends RecommendPlan {
  /** true when the library holds no servable GGUF and no MLX model */
  needed: boolean;
}

const GB = 1024 ** 3;
/** A 3B at 4-bit is ~2 GB of weights; 8 GB of RAM runs it with room for the OS. */
const COMFORTABLE_MIN_MEM = 8 * GB;
/** Below this, say so rather than pretend the smallest model is comfortable. */
const TIGHT_MEM = 6 * GB;

/**
 * The starting catalogue. Every entry was checked against the Hub (repo exists,
 * pipeline_tag is text-generation, the quant is really in the file list); the
 * sizes are read live, never stated here.
 *
 * `nominalBytes` is a rounded footprint for the fit test only.
 */
interface Candidate {
  engine: RecommendEngine;
  kind: "gguf" | "mlx";
  tier: "small" | "comfortable";
  label: string;
  ref: string;
  /** gguf: the quant to pick out of the repo listing; mlx: how it ships */
  quant: string;
  paramsB: number;
  nominalBytes: number;
  rationale: string;
}

const CATALOGUE: Candidate[] = [
  {
    engine: "mlx",
    kind: "mlx",
    tier: "small",
    label: "Qwen2.5 0.5B Instruct",
    ref: "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
    quant: "4-bit",
    paramsB: 0.5,
    nominalBytes: 300 * 1024 * 1024,
    rationale: "the smallest chat model here — 4-bit MLX, quick on Metal, and a real first reply",
  },
  {
    engine: "llama.cpp",
    kind: "gguf",
    tier: "small",
    label: "Qwen2.5 0.5B Instruct",
    ref: "Qwen/Qwen2.5-0.5B-Instruct-GGUF",
    quant: "Q4_K_M",
    paramsB: 0.5,
    nominalBytes: 500 * 1024 * 1024,
    rationale: "the smallest GGUF worth downloading — Q4_K_M, runs on any CPU",
  },
  {
    engine: "mlx",
    kind: "mlx",
    tier: "comfortable",
    label: "Llama 3.2 3B Instruct",
    ref: "mlx-community/Llama-3.2-3B-Instruct-4bit",
    quant: "4-bit",
    paramsB: 3,
    nominalBytes: 1900 * 1024 * 1024,
    rationale: "a noticeably more capable 3B — 4-bit MLX",
  },
  {
    engine: "llama.cpp",
    kind: "gguf",
    tier: "comfortable",
    label: "Llama 3.2 3B Instruct",
    ref: "bartowski/Llama-3.2-3B-Instruct-GGUF",
    quant: "Q4_K_M",
    paramsB: 3,
    nominalBytes: 2100 * 1024 * 1024,
    rationale: "a noticeably more capable 3B — Q4_K_M",
  },
];

const SMALL_MLX = CATALOGUE[0]!;
const SMALL_GGUF = CATALOGUE[1]!;
const BIG_MLX = CATALOGUE[2]!;
const BIG_GGUF = CATALOGUE[3]!;

/**
 * The rule. Pure: give it a machine shape and it returns the offers, smallest
 * first, with exactly one flagged `recommended`.
 *
 * - MLX is offered only when `mlxSupported` — a pick that cannot run is not a
 *   starting point, it is a dead end.
 * - llama.cpp is always offered: it works on every OS and CPU.
 * - The bigger 3B alternative is included only when the machine *plainly* fits
 *   it (`max(6 GB, 3 × nominal)`), never on a machine that would have to
 *   stream it off disk.
 * - The primary is the native MLX model on a Mac where the runtime is ready;
 *   otherwise the smallest GGUF.
 */
export function recommendFor(shape: MachineShape): RecommendPlan {
  const fits = (bytes: number) => shape.totalMemBytes >= Math.max(TIGHT_MEM, bytes * 3);

  const offers: ModelOffer[] = [];
  const push = (c: Candidate) => {
    const offer: ModelOffer = {
      id: `${c.kind}:${c.ref}`,
      engine: c.engine,
      kind: c.kind,
      label: c.label,
      ref: c.ref,
      nominalBytes: c.nominalBytes,
      paramsB: c.paramsB,
      quant: c.quant,
      rationale: c.rationale,
      recommended: false,
    };
    if (c.kind === "gguf" && !shape.llamaCppInstalled) offer.needsEngine = true;
    if (c.kind === "mlx" && !shape.mlxReady) offer.needsRuntime = true;
    offers.push(offer);
  };

  if (shape.mlxSupported) {
    push(SMALL_MLX);
    if (fits(BIG_MLX.nominalBytes)) push(BIG_MLX);
  }
  push(SMALL_GGUF);
  if (fits(BIG_GGUF.nominalBytes)) push(BIG_GGUF);

  const preferMlx = shape.mlxSupported && shape.mlxReady;
  const primary =
    (preferMlx ? offers.find((o) => o.kind === "mlx") : offers.find((o) => o.kind === "gguf")) ?? offers[0];
  if (primary) primary.recommended = true;

  // Recommended first, then smallest → largest.
  offers.sort((a, b) => Number(b.recommended) - Number(a.recommended) || a.nominalBytes - b.nominalBytes);

  const note =
    shape.mlxSupported && !shape.mlxReady
      ? "MLX can run on this Mac, but its runtime is not installed yet — the MLX pick needs that step first."
      : shape.totalMemBytes < TIGHT_MEM
        ? "This machine has little memory to spare — start small, and quantise further if you need the room."
        : undefined;

  return {
    offers,
    mlxSupported: shape.mlxSupported,
    mlxReady: shape.mlxReady,
    engineInstalled: shape.llamaCppInstalled,
    totalMemBytes: shape.totalMemBytes,
    platform: shape.platform,
    arch: shape.arch,
    ...(note ? { note } : {}),
  };
}

/* -------------------------------------------------------------- resolution */

interface SizeEntry {
  at: number;
  file?: string;
  sizeBytes?: number;
  note?: string;
}

const sizeCache = new Map<string, SizeEntry>();
const SIZE_TTL = 10 * 60_000;

/** Normalise a quant name so `Q4_K_M` and `q4_k_m` are the same thing. */
function normQuant(s: string | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The one GGUF file worth fetching for a wanted quant: main weights, smallest first. */
function pickGgufFile(files: HubFile[], wanted: string): HubFile | undefined {
  const main = files.filter((f) => f.isMain && !/^bf16\//i.test(f.path));
  const want = normQuant(wanted);
  const exact = main.filter((f) => normQuant(f.quant) === want);
  // A repo that renames or drops the exact quant still gets a sane 4-bit pick.
  const fourBit = main.filter((f) => /^q4/.test(normQuant(f.quant)) || /q4/.test(normQuant(f.quant)));
  const pool = exact.length ? exact : fourBit.length ? fourBit : main;
  return pool.slice().sort((a, b) => a.size - b.size)[0];
}

/**
 * Fill in the size (and, for a GGUF, the file) from the app's own plan endpoint.
 *
 * This is the only place a number is allowed to become real: `GET /api/hub/repo`
 * for a GGUF, `GET /api/mlx/repo` for an MLX repo — the same calls the Models
 * page makes. A failure leaves the size unset and records `sizeNote`, so the UI
 * can say "size unknown" rather than showing a figure it made up.
 */
export async function resolveOffer(offer: ModelOffer, opts: { refresh?: boolean } = {}): Promise<ModelOffer> {
  const key = offer.id;
  const hit = sizeCache.get(key);
  let entry: SizeEntry | undefined = hit && !opts.refresh && Date.now() - hit.at < SIZE_TTL ? hit : undefined;
  if (!entry) {
    try {
      if (offer.kind === "gguf") {
        const repo = await repoFiles(offer.ref);
        const file = pickGgufFile(repo.files, offer.quant);
        if (!file) throw new Error(`no ${offer.quant} file in ${offer.ref}`);
        entry = { at: Date.now(), file: file.path, sizeBytes: file.size };
      } else {
        const plan = await planMlxRepo(offer.ref, { source: "mlx" });
        entry = { at: Date.now(), sizeBytes: plan.totalBytes };
      }
    } catch (err) {
      entry = { at: Date.now(), note: err instanceof Error ? err.message : String(err) };
    }
    sizeCache.set(key, entry);
  }
  return {
    ...offer,
    ...(entry.file ? { file: entry.file } : {}),
    ...(entry.sizeBytes ? { sizeBytes: entry.sizeBytes } : {}),
    ...(entry.note ? { sizeNote: entry.note } : {}),
  };
}

/* --------------------------------------------------------------- assembly */

let shapeCache: { at: number; value: MachineShape } | null = null;
const SHAPE_TTL = 30_000;

/**
 * The machine, read from the app's own probes — the same ones the rest of the
 * app trusts. `mlxSupport()` is a pure platform/arch check; `detectRuntime()` is
 * only asked on a machine where MLX is supported at all (it spawns an
 * interpreter), and the answer is held for 30 s.
 */
export async function machineShape(): Promise<MachineShape> {
  if (shapeCache && Date.now() - shapeCache.at < SHAPE_TTL) return shapeCache.value;
  const support = mlxSupport();
  const runtime = support.supported ? await detectRuntime() : null;
  const sys = systemInfo();
  const value: MachineShape = {
    platform: process.platform,
    arch: sys.arch,
    totalMemBytes: sys.totalMemBytes,
    mlxSupported: support.supported,
    mlxReady: Boolean(runtime?.ready),
    llamaCppInstalled: Boolean(getActiveEngine()),
  };
  shapeCache = { at: Date.now(), value };
  return value;
}

/**
 * Is this a first run? A servable GGUF **or** a finished MLX model means the
 * user already has something to chat with, and the offer should not nag. A
 * half-fetched MLX directory is not a model (`listMlxModels` skips the marked
 * ones), so it does not count here either.
 */
export function libraryEmpty(): boolean {
  return listServableModels().length === 0 && listMlxModels().length === 0;
}

/**
 * The whole answer for the Dashboard card: what is offered, and whether it
 * should be offered at all. `needed` is read live; the offers are cached by
 * `resolveOffer` so a poll costs nothing after the first call.
 */
export async function firstRunRecommendation(opts: { refresh?: boolean } = {}): Promise<Recommendation> {
  const needed = libraryEmpty();
  const shape = await machineShape();
  const plan = recommendFor(shape);
  if (!needed) return { ...plan, needed: false, offers: [] };
  const offers = await Promise.all(plan.offers.map((o) => resolveOffer(o, opts)));
  return { ...plan, needed: true, offers };
}
