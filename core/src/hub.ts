import { logger } from "./logger.js";

const log = logger("hub");
const HF = "https://huggingface.co";

export interface HubModel {
  id: string;
  author?: string;
  downloads?: number;
  likes?: number;
  lastModified?: string;
  tags: string[];
  pipelineTag?: string;
  gated?: boolean | string;
  /** true when the repo appears to contain a chat/instruct model */
  instruct: boolean;
  url: string;
}

export interface HubFile {
  path: string;
  size: number;
  /** true for the main weights, false for mmproj / auxiliary files */
  isMain: boolean;
  quant?: string;
  isMmproj: boolean;
}

export interface HubRepo {
  id: string;
  downloads?: number;
  likes?: number;
  gated?: boolean | string;
  tags: string[];
  files: HubFile[];
  totalSize: number;
  hasGguf: boolean;
}

const QUANT_RE = /(?:^|[-_.])((?:UD-)?(?:IQ\d[_A-Z0-9]*|Q\d[_A-Z0-9]*|Q\d_K[_A-Z]*|F16|F32|BF16|MXFP4|TQ\d_\d))(?:[-_.]|$)/i;

function detectQuant(filename: string): string | undefined {
  const base = filename.replace(/\.gguf$/i, "");
  const m = base.match(QUANT_RE);
  return m ? m[1] : undefined;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "user-agent": "osama/0.1", accept: "application/json" };
  if (process.env.HF_TOKEN) h.authorization = `Bearer ${process.env.HF_TOKEN}`;
  return h;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`Hugging Face API ${res.status}: ${res.statusText} (${url})`);
  return (await res.json()) as T;
}

/**
 * Search Hugging Face for GGUF / llama.cpp-compatible models.
 * `sort` maps to HF's `sort` param (downloads | likes | lastModified | trending).
 */
export async function searchModels(query: string, opts: { limit?: number; sort?: string } = {}): Promise<HubModel[]> {
  const params = new URLSearchParams();
  params.set("filter", "gguf");
  if (query.trim()) params.set("search", query.trim());
  params.set("sort", opts.sort ?? "downloads");
  params.set("direction", "-1");
  params.set("limit", String(opts.limit ?? 30));
  params.set("full", "false");
  const url = `${HF}/api/models?${params.toString()}`;
  log.debug(`search ${url}`);
  const raw = await getJson<any[]>(url);
  return raw.map(mapModel);
}

/** Trending GGUF models with no query (empty search). */
export async function trendingModels(limit = 24): Promise<HubModel[]> {
  return searchModels("", { limit, sort: "downloads" });
}

function mapModel(r: any): HubModel {
  const id: string = r.id ?? r.modelId;
  const author = r.author ?? id.split("/")[0];
  const tags: string[] = r.tags ?? [];
  return {
    id,
    author,
    downloads: r.downloads,
    likes: r.likes,
    lastModified: r.lastModified,
    tags,
    pipelineTag: r.pipeline_tag,
    gated: r.gated,
    instruct: /instruct|chat|-it\b|it$/i.test(id) || tags.some((t) => /instruct|chat|conversational/i.test(t)),
    url: `${HF}/${id}`,
  };
}

/** Enumerate a repo's GGUF files with real byte sizes (tree API). */
export async function repoFiles(repo: string): Promise<HubRepo> {
  const info = await getJson<any>(`${HF}/api/models/${repo}`);
  const tree = await getJson<any[]>(`${HF}/api/models/${repo}/tree/main?recursive=true`);
  const files: HubFile[] = [];
  for (const entry of tree) {
    if (entry.type !== "file") continue;
    const p: string = entry.path;
    if (!p.toLowerCase().endsWith(".gguf")) continue;
    const isMmproj = /mmproj/i.test(p);
    files.push({
      path: p,
      size: entry.size ?? entry.lfs?.size ?? 0,
      isMmproj,
      isMain: !isMmproj && !/^bf16\//i.test(p),
      quant: detectQuant(p),
    });
  }
  files.sort((a, b) => b.size - a.size);
  const totalSize = files.filter((f) => f.isMain).reduce((s, f) => s + f.size, 0);
  return {
    id: repo,
    downloads: info.downloads,
    likes: info.likes,
    gated: info.gated,
    tags: info.tags ?? [],
    files,
    totalSize,
    hasGguf: files.length > 0,
  };
}

/** Direct download URL for a file in a repo (HF resolves to a CDN redirect). */
export function resolveUrl(repo: string, file: string): string {
  return `${HF}/${repo}/resolve/main/${file}`;
}

export interface HardwareHint {
  quant: string;
  rationale: string;
}

/** Recommend a default quant given available RAM/VRAM in bytes. */
export function recommendQuant(totalMemBytes: number, modelBytesAtQ4: number): HardwareHint {
  const gb = totalMemBytes / 1024 ** 3;
  if (gb >= 64) return { quant: "Q6_K", rationale: "≥64 GB memory — prefer higher fidelity (Q6_K / Q8_0)." };
  if (gb >= 32) return { quant: "Q5_K_M", rationale: "32–64 GB memory — Q5_K_M balances quality and size." };
  if (gb >= 16) return { quant: "Q4_K_M", rationale: "16–32 GB memory — Q4_K_M is the sweet spot." };
  if (gb >= 8) return { quant: "Q4_K_S", rationale: "8–16 GB memory — Q4_K_S or a smaller model." };
  return { quant: "Q3_K_M", rationale: "under 8 GB — use Q3_K_M or an IQ variant, or a smaller model." };
}
