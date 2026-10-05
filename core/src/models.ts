import fs from "node:fs";
import path from "node:path";
import { paths, ensureDirs } from "./paths.js";
import { logger } from "./logger.js";
import { readGguf, toModelCard, type ModelCard } from "./gguf.js";
import { downloadFile, type DownloadProgress } from "./downloader.js";
import { repoFiles, resolveUrl } from "./hub.js";
import { resolveAnyAsync, type SourceId } from "./sources.js";

const log = logger("models");

export interface LocalModel {
  id: string;
  name: string;
  file: string;
  sizeBytes: number;
  /** repo id if known (from a sidecar .json or a download) */
  repo?: string;
  card?: ModelCard;
  addedAt: string;
  /** true when the file lives outside the Osama models dir (imported in place) */
  external?: boolean;
  missing?: boolean;
  /** true when the GGUF is a speculative-decoding draft head and must not be served as a main model */
  draftOnly?: boolean;
}

interface LibraryFile {
  models: LocalModel[];
}

interface DownloadRecord {
  id: string;
  repo: string;
  file: string;
  dest: string;
  received: number;
  total: number | null;
  status: "downloading" | "done" | "error" | "cancelled";
  error?: string;
  startedAt: number;
}

const downloads = new Map<string, DownloadRecord>();
const downloadAborts = new Map<string, AbortController>();

function libraryFile(): string {
  return path.join(ensureDirs().models, "library.json");
}

function readLibrary(): LibraryFile {
  const f = libraryFile();
  if (!fs.existsSync(f)) return { models: [] };
  try {
    return JSON.parse(fs.readFileSync(f, "utf8")) as LibraryFile;
  } catch {
    return { models: [] };
  }
}

function writeLibrary(lib: LibraryFile): void {
  fs.writeFileSync(libraryFile(), JSON.stringify(lib, null, 2));
}

/** Re-scan on every list so files added/removed on disk are reflected. */
export function listModels(): LocalModel[] {
  const lib = readLibrary();
  const seen = new Set<string>();
  const out: LocalModel[] = [];
  for (const m of lib.models) {
    const exists = fs.existsSync(m.file);
    if (!exists) {
      out.push({ ...m, missing: true });
      continue;
    }
    seen.add(path.resolve(m.file));
    const stat = fs.statSync(m.file);
    out.push({ ...m, sizeBytes: stat.size, missing: false });
  }
  return out.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}

/** Models that can be served as the main model (draft heads excluded). */
export function listServableModels(): LocalModel[] {
  return listModels().filter((m) => !m.draftOnly);
}

export function getModel(id: string): LocalModel | undefined {
  return listModels().find((m) => m.id === id);
}

/** Read the model card for a GGUF, cached on the library entry when possible. */
export function describeModel(file: string): ModelCard {
  return toModelCard(readGguf(file));
}

export interface AddModelOptions {
  file: string;
  repo?: string;
  name?: string;
}

/** Register a local GGUF with the library (does not copy the file). */
export function addModel(opts: AddModelOptions): LocalModel {
  const abs = path.resolve(opts.file);
  if (!fs.existsSync(abs)) throw new Error(`file not found: ${abs}`);
  if (!abs.toLowerCase().endsWith(".gguf")) throw new Error("only .gguf files can be added");
  let card: ModelCard | undefined;
  try {
    card = describeModel(abs);
  } catch (err) {
    log.warn(`could not read GGUF metadata for ${abs}: ${(err as Error).message}`);
  }
  const lib = readLibrary();
  const existing = lib.models.find((m) => path.resolve(m.file) === abs);
  if (existing) return { ...existing, missing: false };
  const model: LocalModel = {
    id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: opts.name ?? path.basename(abs).replace(/\.gguf$/i, ""),
    file: abs,
    repo: opts.repo,
    sizeBytes: fs.statSync(abs).size,
    card,
    addedAt: new Date().toISOString(),
    external: !abs.startsWith(paths().models),
  };
  lib.models.push(model);
  writeLibrary(lib);
  log.info(`added model ${model.name} (${abs})`);
  return model;
}

export function removeModel(id: string, deleteFile = false): void {
  const lib = readLibrary();
  const model = lib.models.find((m) => m.id === id);
  if (!model) return;
  if (deleteFile && fs.existsSync(model.file) && model.file.startsWith(paths().models)) {
    fs.rmSync(model.file, { force: true });
    log.info(`deleted file ${model.file}`);
  }
  lib.models = lib.models.filter((m) => m.id !== id);
  writeLibrary(lib);
}

/** Scan the Osama models dir and auto-register GGUFs not yet in the library. */
export function scanModelsDir(): LocalModel[] {
  const dir = paths().models;
  if (!fs.existsSync(dir)) return listModels();
  const lib = readLibrary();
  const known = new Set(lib.models.map((m) => path.resolve(m.file)));
  let added = 0;
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".gguf") && !known.has(path.resolve(full))) {
        known.add(path.resolve(full));
        try {
          const card = describeModel(full);
          lib.models.push({
            id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            name: full.replace(/\.gguf$/i, "").replace(dir + path.sep, ""),
            file: full,
            sizeBytes: fs.statSync(full).size,
            card,
            addedAt: new Date().toISOString(),
          });
          added++;
        } catch (err) {
          log.warn(`skipped ${full}: ${(err as Error).message}`);
        }
      }
    }
  };
  walk(dir);
  if (added) {
    writeLibrary(lib);
    log.info(`auto-registered ${added} model(s) found in ${dir}`);
  }
  return listModels();
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

export interface DownloadRequest {
  repo: string;
  file: string;
  /** which hub the repo lives on — default huggingface (the legacy shape) */
  source?: SourceId;
  /** optional friendly name */
  name?: string;
  onProgress?: (rec: DownloadRecord) => void;
}

export function listDownloads(): DownloadRecord[] {
  return [...downloads.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function cancelDownload(id: string): void {
  downloadAborts.get(id)?.abort();
  const rec = downloads.get(id);
  if (rec && rec.status === "downloading") rec.status = "cancelled";
}

/**
 * Download a GGUF from the Hugging Face Hub into the Osama models dir with
 * resume + progress, then register it in the library.
 */
export async function downloadModel(req: DownloadRequest): Promise<LocalModel> {
  const p = ensureDirs();
  const id = `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const safe = req.file.replace(/[/\\]/g, "_");
  const dest = path.join(p.models, req.repo.replace("/", "__"), safe);
  const rec: DownloadRecord = {
    id,
    repo: req.repo,
    file: req.file,
    dest,
    received: 0,
    total: null,
    status: "downloading",
    startedAt: Date.now(),
  };
  downloads.set(id, rec);
  const ac = new AbortController();
  downloadAborts.set(id, ac);
  const url = req.source && req.source !== "huggingface"
    ? await resolveAnyAsync(req.source, req.repo, req.file)
    : resolveUrl(req.repo, req.file);
  if (!url) throw new Error(`could not resolve a download URL for ${req.repo} / ${req.file}`);
  try {
    await downloadFile(url, dest, {
      signal: ac.signal,
      onProgress: (pr: DownloadProgress) => {
        rec.received = pr.received;
        rec.total = pr.total;
        req.onProgress?.(rec);
      },
    });
    rec.status = "done";
    req.onProgress?.(rec);
    return addModel({ file: dest, repo: req.repo, name: req.name ?? safe.replace(/\.gguf$/i, "") });
  } catch (err) {
    if (ac.signal.aborted) rec.status = "cancelled";
    else {
      rec.status = "error";
      rec.error = (err as Error).message;
    }
    req.onProgress?.(rec);
    throw err;
  } finally {
    downloadAborts.delete(id);
  }
}

/** Resolve the full file list for a repo (thin re-export for the API layer). */
export async function repoManifest(repo: string) {
  return repoFiles(repo);
}
