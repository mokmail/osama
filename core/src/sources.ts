import { logger } from "./logger.js";

/**
 * Multi-source model discovery.
 *
 * Sources that publish GGUF over plain HTTPS, each verified live:
 * - huggingface  — the primary hub (search API + resolve CDN)
 * - modelscope   — the Chinese mirror; same repo ids, tree API + LFS CDN
 * - civitai      — API search; GGUF shows up under image/gen and text models
 * - ollama       — the docker-registry v2 protocol, anonymous; the GGUF layer
 *                  is the blob with mediaType application/vnd.ollama.image.model
 * - url          — any direct https(...)://...gguf link (LM Studio, personal
 *                  CDNs, torrent-free mirrors — whatever the user pastes)
 *
 * LM Studio itself has no public search API (its catalog *is* Hugging Face
 * behind the app), so it is covered by huggingface + the direct-URL import.
 */

const log = logger("sources");
const HF = "https://huggingface.co";
const MS = "https://modelscope.cn";
const CIV = "https://civitai.com";
const OREG = "https://registry.ollama.ai";

export type SourceId = "huggingface" | "modelscope" | "civitai" | "ollama" | "url";

export const SOURCES: Array<{ id: SourceId; label: string; note: string }> = [
  { id: "huggingface", label: "Hugging Face", note: "the primary GGUF hub — search, trending, full file trees" },
  { id: "modelscope", label: "ModelScope", note: "Alibaba's mirror — most HF GGUF repos by the same id, open access" },
  { id: "civitai", label: "CivitAI", note: "community checkpoints; some ship GGUF files" },
  { id: "ollama", label: "Ollama", note: "the ollama library pulled over the registry protocol — GGUF inside" },
  { id: "url", label: "Direct URL", note: "any https link to a .gguf file (LM Studio, personal hosting…)" },
];

/** A unified result row, whatever the source. */
export interface SourceModel {
  source: SourceId;
  /** The source's repo/reference id — resolvable back into files. */
  ref: string;
  name: string;
  author?: string;
  downloads?: number;
  likes?: number;
  tags: string[];
  /** true when a .gguf is known to exist (search-level hints only) */
  gguf?: boolean;
  url: string;
}

/** Files of one repo, unified with the HF HubFile shape. */
export interface SourceFile {
  path: string;
  size: number;
  quant?: string;
  isMmproj: boolean;
  isMain: boolean;
}

export interface SourceRepo {
  source: SourceId;
  ref: string;
  url: string;
  files: SourceFile[];
  totalSize: number;
  hasGguf: boolean;
  gated: boolean;
}

const QUANT_RE = /(?:^|[-_.])((?:UD-)?(?:IQ\d[_A-Z0-9]*|Q\d[_A-Z0-9]*|Q\d_K[_A-Z]*|F16|F32|BF16|MXFP4|TQ\d_\d))(?:[-_.]|$)/i;
export function detectQuant(filename: string): string | undefined {
  const base = filename.replace(/\.gguf$/i, "");
  const m = base.match(QUANT_RE);
  return m ? m[1] : undefined;
}

const UA = { "user-agent": "osama/0.1", accept: "application/json" };

async function getJson<T>(url: string, opts: { headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<T> {
  const res = await fetch(url, {
    headers: { ...UA, ...(opts.headers ?? {}) },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText} (${url.slice(0, 90)})`);
  return (await res.json()) as T;
}

function hfHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  if (process.env.HF_TOKEN) h.authorization = `Bearer ${process.env.HF_TOKEN}`;
  return h;
}

/* ------------------------------------------------------------------ search */

/** Search across the enabled sources; HF first (its API is the richest), others appended. */
export async function searchAllSources(
  query: string,
  opts: { limit?: number; sort?: string } = {},
): Promise<{ models: SourceModel[]; errors: string[] }> {
  const limit = opts.limit ?? 30;
  const q = query.trim();
  const errors: string[] = [];
  const out: SourceModel[] = [];

  const jobs: Array<{ src: SourceId; run: () => Promise<SourceModel[]> }> = [
    { src: "huggingface", run: () => searchHF(q, limit) },
    { src: "modelscope", run: () =>searchModelscope(q, limit) },
    { src: "civitai", run: () => searchCivitai(q, Math.min(12, limit)) },
    { src: "ollama", run: () => searchOllama(q, Math.min(12, limit)) },
  ];

  const settled = await Promise.allSettled(jobs.map((j) => j.run()));
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") out.push(...r.value);
    else errors.push(`${jobs[i]!.src}: ${(r.reason as Error).message?.slice(0, 120)}`);
  });
  return { models: dedupe(out), errors };
}

export async function trendingAllSources(limit = 24): Promise<{ models: SourceModel[]; errors: string[] }> {
  return searchAllSources("", { limit });
}

function dedupe(models: SourceModel[]): SourceModel[] {
  const seen = new Map<string, SourceModel>();
  for (const m of models) {
    const k = `${m.source}:${m.ref.toLowerCase()}`;
    if (!seen.has(k)) seen.set(k, m);
  }
  return [...seen.values()];
}

async function searchHF(q: string, limit: number): Promise<SourceModel[]> {
  const params = new URLSearchParams({ filter: "gguf", sort: "downloads", direction: "-1", limit: String(limit), full: "false" });
  if (q) params.set("search", q);
  const rows = await getJson<any[]>(`${HF}/api/models?${params}`, { headers: hfHeaders() });
  return rows.map((r) => {
    const id: string = r.id ?? r.modelId;
    return {
      source: "huggingface" as const,
      ref: id,
      name: id.split("/").pop() ?? id,
      author: r.author,
      downloads: r.downloads,
      likes: r.likes,
      tags: r.tags ?? [],
      gguf: true,
      url: `${HF}/${id}`,
    };
  });
}

/**
 * ModelScope has no open keyword-search endpoint (their site queries are
 * internal), but it mirrors HF repo ids — search HF, keep ids that exist on
 * ModelScope. One HEAD-equivalent call per candidate, bounded.
 */
async function searchModelscope(q: string, limit: number): Promise<SourceModel[]> {
  const hfRows = await searchHF(q, limit * 2);
  const candidates = hfRows.slice(0, 14);
  const checks = await Promise.allSettled(candidates.map((c) => msRepoExists(c.ref)));
  const out: SourceModel[] = [];
  checks.forEach((c, i) => {
    if (c.status === "fulfilled" && c.value) {
      const src = candidates[i]!;
      out.push({ ...src, source: "modelscope", url: `${MS}/models/${src.ref}` });
    }
  });
  return out.slice(0, limit);
}

async function msRepoExists(repo: string): Promise<boolean> {
  try {
    const d = await getJson<any>(`${MS}/api/v1/models/${repo}`);
    return d?.Code === 200;
  } catch {
    return false;
  }
}

async function searchCivitai(q: string, limit: number): Promise<SourceModel[]> {
  const params = new URLSearchParams({ limit: String(limit), types: "Checkpoint" });
  if (q) params.set("query", q);
  const d = await getJson<any>(`${CIV}/api/v1/models?${params}`);
  const out: SourceModel[] = [];
  for (const it of d.items ?? []) {
    // The list endpoint hides file entries for some categories; version
    // objects are where the visible entries live, so gguf presence comes
    // from there — and when the list is hidden entirely, a gguf-named
    // checkpoint still earns a row (its repo page stays browseable).
    const versionFiles: any[] = (it.modelVersions ?? []).flatMap((v: any) => v.files ?? []);
    const hasGgufFiles = versionFiles.some((f: any) => String(f.name ?? "").toLowerCase().endsWith(".gguf"));
    const filesHidden = versionFiles.length === 0;
    if (!hasGgufFiles && !(filesHidden && /gguf|quant/i.test(String(it.name ?? "")))) continue;
    out.push({
      source: "civitai",
      ref: String(it.id),
      name: String(it.name ?? it.id),
      author: it.creator?.username,
      downloads: it.stats?.downloadCount,
      likes: it.stats?.thumbsUpCount,
      tags: (it.tags ?? []).slice(0, 6),
      gguf: hasGgufFiles ? true : undefined,
      url: `https://civitai.com/models/${it.id}`,
    });
  }
  return out;
}

/**
 * Ollama's library over the registry protocol. Their model list API is local
 * only, so search = the well-known library list filtered by the query; the
 * manifest tells us the real GGUF layer size.
 */
const OLLAMA_CATALOG = [
  "qwen3", "qwen2.5", "qwen3-coder", "llama3.2", "llama3.1", "llama4", "gemma3",
  "deepseek-r1", "deepseek-v3.1", "mistral", "mistral-nemo", "phi4", "phi3",
  "gpt-oss", "granite3.3", "smollm2", "tinyllama", "nomic-embed-text",
  "llava", "minicpm-v", "qwen2.5-coder", "qwen3-vl", "devstral", "magistral",
];

async function searchOllama(q: string, limit: number): Promise<SourceModel[]> {
  const ql = q.toLowerCase();
  const names = (q ? OLLAMA_CATALOG.filter((n) => n.includes(ql) || ql.includes(n)) : OLLAMA_CATALOG)
    .slice(0, limit);
  const settled = await Promise.allSettled(
    names.map(async (n) => {
      const manifest = await ollamaManifest(n, "latest");
      const layer = manifest.layers?.find((l: any) => l.mediaType === "application/vnd.ollama.image.model");
      return {
        source: "ollama" as SourceId,
        ref: `${n}:latest`,
        name: n,
        downloads: undefined,
        likes: undefined,
        tags: ["ollama"],
        gguf: true,
        url: `https://ollama.com/library/${n}`,
        ...(layer ? { sizeBytes: layer.size } : {}),
      } as unknown as SourceModel;
    }),
  );
  return settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
}

/* ------------------------------------------------------------------- files */

/** Enumerate the downloadable GGUF files of one repo — any source. */
export async function repoFilesAny(source: SourceId, ref: string): Promise<SourceRepo> {
  switch (source) {
    case "huggingface": return repoFilesHF(ref);
    case "modelscope": return repoFilesMS(ref);
    case "civitai": return repoFilesCivitai(ref);
    case "ollama": return repoFilesOllama(ref);
    case "url": return repoFilesUrl(ref);
  }
}

async function repoFilesHF(ref: string): Promise<SourceRepo> {
  const info = await getJson<any>(`${HF}/api/models/${ref}`, { headers: hfHeaders() });
  const tree = await getJson<any[]>(`${HF}/api/models/${ref}/tree/main?recursive=true`, { headers: hfHeaders() });
  const files: SourceFile[] = [];
  for (const e of tree) {
    if (e.type !== "file") continue;
    const p: string = e.path;
    if (!p.toLowerCase().endsWith(".gguf")) continue;
    const isMmproj = /mmproj/i.test(p);
    files.push({ path: p, size: e.size ?? e.lfs?.size ?? 0, isMmproj, isMain: !isMmproj && !/^bf16\//i.test(p), quant: detectQuant(p) });
  }
  files.sort((a, b) => b.size - a.size);
  return { source: "huggingface", ref, url: `${HF}/${ref}`, files, totalSize: files.filter((f) => f.isMain).reduce((s, f) => s + f.size, 0), hasGguf: files.length > 0, gated: Boolean(info.gated) };
}

async function repoFilesMS(ref: string): Promise<SourceRepo> {
  const d = await getJson<any>(`${MS}/api/v1/models/${ref}/repo/files?Revision=master&Recursive=true&PageSize=200`);
  const rows: any[] = d?.Data?.Files ?? [];
  const files: SourceFile[] = [];
  for (const e of rows) {
    const p = String(e.Path ?? "");
    if (!p.toLowerCase().endsWith(".gguf")) continue;
    const isMmproj = /mmproj/i.test(p);
    files.push({ path: p, size: Number(e.Size ?? 0), isMmproj, isMain: !isMmproj, quant: detectQuant(p) });
  }
  files.sort((a, b) => b.size - a.size);
  return { source: "modelscope", ref, url: `${MS}/models/${ref}`, files, totalSize: files.filter((f) => f.isMain).reduce((s, f) => s + f.size, 0), hasGguf: files.length > 0, gated: false };
}

async function repoFilesCivitai(ref: string): Promise<SourceRepo> {
  const d = await getJson<any>(`${CIV}/api/v1/models/${ref}`);
  const files: SourceFile[] = [];
  const versions = d.items ?? (Array.isArray(d.modelVersions) ? d.modelVersions : []);
  for (const v of versions) {
    for (const f of v.files ?? []) {
      const p = String(f.name ?? "");
      if (!p.toLowerCase().endsWith(".gguf")) continue;
      files.push({
        path: p,
        size: Number(f.sizeKB ?? 0) * 1024,
        isMmproj: false,
        isMain: true,
        quant: detectQuant(p),
      });
      // remember the actual URL for the resolver
      dlUrls.set(p, String(f.downloadUrl ?? ""));
    }
  }
  files.sort((a, b) => b.size - a.size);
  return { source: "civitai", ref, url: `${CIV}/models/${ref}`, files, totalSize: files.reduce((s, f) => s + f.size, 0), hasGguf: files.length > 0, gated: false };
}

/** The actual per-file civitai URLs, filled while enumerating. */
const dlUrls = new Map<string, string>();

async function repoFilesOllama(ref: string): Promise<SourceRepo> {
  const [rawName, rawTag] = ref.split(":");
  const name = rawName ?? ref;
  const tag = rawTag || "latest";
  const manifest = await ollamaManifest(name, tag);
  const modelLayers = (manifest.layers ?? []).filter((l: any) => l.mediaType === "application/vnd.ollama.image.model");
  const files: SourceFile[] = modelLayers.map((l: any, i: number) => ({
    path: i === 0 ? `${name}-${tag}.gguf` : `${name}-${tag}-part${i + 1}.gguf`,
    size: Number(l.size ?? 0),
    isMmproj: false,
    isMain: true,
    quant: detectQuant(name),
  }));
  // register the blob URLs for the downloader
  modelLayers.forEach((l: any, i: number) => {
    dlUrls.set(files[i]!.path, `${OREG}/v2/library/${name}/blobs/${l.digest}`);
  });
  return { source: "ollama", ref, url: `https://ollama.com/library/${name}`, files, totalSize: files.reduce((s, f) => s + f.size, 0), hasGguf: files.length > 0, gated: false };
}

async function ollamaManifest(name: string, tag: string): Promise<any> {
  return getJson(`${OREG}/v2/library/${name}/manifests/${tag}`, {
    headers: { accept: "application/vnd.docker.distribution.manifest.v2+json, application/vnd.ollama.image.manifest.v1+json" },
  });
}

/** A pasted URL: one file, self-contained. */
async function repoFilesUrl(ref: string): Promise<SourceRepo> {
  let parsed: URL;
  try { parsed = new URL(ref); } catch { throw new Error(`not a URL: ${ref.slice(0, 80)}`); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("only http(s) URLs");
  const name = decodeURIComponent(parsed.pathname.split("/").pop() ?? "model.gguf");
  if (!name.toLowerCase().endsWith(".gguf")) throw new Error("the URL must point at a .gguf file");
  // HEAD for the size (redirects: follow)
  let size = 0;
  try {
    const r = await fetch(ref, { method: "GET", headers: { range: "bytes=0-1023" }, redirect: "follow", signal: AbortSignal.timeout(15_000) });
    const cr = /\/(\d+)$/.exec(r.headers.get("content-range") ?? "");
    if (cr) size = Number(cr[1]);
    else size = Number(r.headers.get("content-length") ?? 0);
    if (size) dlUrls.set(name, ref);
  } catch { /* the downloader will retry; size 0 = unknown */ }
  const files: SourceFile[] = [{ path: name, size, isMmproj: false, isMain: true, quant: detectQuant(name) }];
  return { source: "url", ref, url: ref, files, totalSize: size, hasGguf: true, gated: false };
}

/* -------------------------------------------------------------- resolution */

/** The direct download URL for one file of a repo (async: providers may need a manifest call). */
export async function resolveAnyAsync(source: SourceId, ref: string, file: string): Promise<string> {
  switch (source) {
    case "huggingface":
      return `${HF}/${ref}/resolve/main/${file}`;
    case "modelscope": {
      const [ns, name] = ref.split("/");
      if (!ns || !name) throw new Error(`a modelscope ref is namespace/name, got: ${ref}`);
      return `${MS}/models/${ns}/${name}/resolve/master/${file}`;
    }
    case "civitai": {
      const hit = dlUrls.get(file);
      if (hit) return hit;
      await repoFilesCivitai(ref); // fills dlUrls
      const again = dlUrls.get(file);
      if (again) return again;
      throw new Error(`civitai has no file "${file}" on the API — it may need a CIVITAI_TOKEN`);
    }
    case "ollama": {
      const hit2 = dlUrls.get(file);
      if (hit2) return hit2;
      // resolve the manifest now (the file key convention: <name>-<tag>.gguf)
      const [name, tag = "latest"] = ref.split(":");
      const manifest = await ollamaManifest(name ?? ref, tag);
      const layers = (manifest.layers ?? []).filter((l: any) => l.mediaType === "application/vnd.ollama.image.model");
      if (!layers.length) throw new Error(`ollama model ${ref} has no GGUF layer`);
      const key = file.startsWith(`${name}-${tag}`) ? file : `${name}-${tag}.gguf`;
      const idx = file.endsWith(`part${file.match(/part(\d+)/)?.[1] ?? 1}.gguf`) ? Math.max(0, Number(file.match(/part(\d+)/)?.[1] ?? 1) - 1) : 0;
      const layer = layers[Math.min(idx, layers.length - 1)];
      const url = `${OREG}/v2/library/${name}/blobs/${layer.digest}`;
      dlUrls.set(key, url);
      return url;
    }
    case "url":
      return ref; // the ref IS the url
  }
}

/** The async resolver is defined above. */

export { dlUrls as sourceDownloadUrls };
