import fs from "node:fs";
import path from "node:path";
import { paths, ensureDirs, findFiles } from "./paths.js";
import { logger } from "./logger.js";
import {
  assetSpec,
  currentArch,
  currentOs,
  defaultAcceleration,
  type Acceleration,
  type Arch,
  type Os,
} from "./platform.js";
import { downloadFile, type DownloadProgress } from "./downloader.js";
import { extractArchive, stripCommonRoot, repairSymlinks } from "./extract.js";

const log = logger("engine");

const GITHUB_API = "https://api.github.com/repos/ggml-org/llama.cpp/releases";

/**
 * The front-ends Osama's command catalogue can build an argv for. A missing
 * entry here is a real problem: the Tools views have nothing to run.
 */
export const DRIVEN_TOOLS = [
  "llama-cli",
  "llama-completion",
  "llama-server",
  "llama-mtmd-cli",
  "llama-tts",
  "llama-quantize",
  "llama-imatrix",
  "llama-gguf-split",
  "llama-bench",
  "llama-batched-bench",
  "llama-perplexity",
  "llama-tokenize",
  "llama-fit-params",
  "llama-export-lora",
  "ggml-rpc-server",
] as const;

/** Shipped by a release, but not (yet) driven from a Tools view. */
export const EXTRA_TOOLS = [
  "llama", // the unified front-end: `llama serve | cli | download | version`
  "llama-results",
  "llama-cvector-generator",
  "llama-mtmd-debug",
  "llama-gemma3-cli",
  "llama-llava-cli",
  "llama-minicpmv-cli",
  "llama-qwen2vl-cli",
  "ggml-metal-tuning",
] as const;

/**
 * Every tool binary a release ships — the inventory coverage is counted against.
 *
 * It must mirror the *current* release. A name upstream has dropped reads as a
 * permanently missing binary, which is exactly what a healthy build used to
 * report: `llama-embedding`, `llama-gguf` and `llama-gguf-hash` are gone, while
 * the per-model CLIs and the unified `llama` front-end never made the list — so
 * the dashboard showed "16 of 19" for a build that was complete.
 */
export const KNOWN_TOOLS = [
  ...DRIVEN_TOOLS,
  ...EXTRA_TOOLS,
] as const;

export type ToolName = (typeof KNOWN_TOOLS)[number] | string;

export interface ReleaseAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

export interface ReleaseInfo {
  tag: string;
  name: string;
  publishedAt: string;
  htmlUrl: string;
  assets: ReleaseAsset[];
}

export interface InstalledEngine {
  tag: string;
  os: Os;
  arch: Arch;
  acceleration: Acceleration;
  /** installed build directory */
  dir: string;
  installedAt: string;
  /** absolute path -> tool binary basename */
  tools: Record<string, string>;
}

interface Registry {
  engines: InstalledEngine[];
  /** tag of the engine the user considers active */
  activeTag?: string;
}

// ---------------------------------------------------------------------------
// GitHub release discovery
// ---------------------------------------------------------------------------

/** List recent llama.cpp releases (newest first), with their assets. */
export async function listReleases(limit = 10): Promise<ReleaseInfo[]> {
  const res = await fetch(`${GITHUB_API}?per_page=${limit}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "osama/0.1" },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
  const raw = (await res.json()) as any[];
  return raw.map((r) => ({
    tag: r.tag_name,
    name: r.name ?? r.tag_name,
    publishedAt: r.published_at,
    htmlUrl: r.html_url,
    assets: (r.assets ?? []).map((a: any) => ({
      name: a.name,
      size: a.size,
      browser_download_url: a.browser_download_url,
    })),
  }));
}

export async function latestRelease(): Promise<ReleaseInfo> {
  const [first] = await listReleases(1);
  if (!first) throw new Error("no llama.cpp releases found");
  return first;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

function readRegistry(): Registry {
  const p = ensureDirs();
  if (!fs.existsSync(p.registryFile)) return { engines: [] };
  try {
    const data = JSON.parse(fs.readFileSync(p.registryFile, "utf8")) as Registry;
    return { engines: data.engines ?? [], activeTag: data.activeTag };
  } catch (err) {
    log.warn(`registry unreadable, starting fresh: ${(err as Error).message}`);
    return { engines: [] };
  }
}

function writeRegistry(reg: Registry): void {
  const p = ensureDirs();
  fs.writeFileSync(p.registryFile, JSON.stringify(reg, null, 2));
}

export function listInstalled(): InstalledEngine[] {
  reconcileAll();
  return readRegistry().engines;
}

export function getActiveEngine(): InstalledEngine | undefined {
  const reg = readRegistry();
  const engine = pickEngine(reg, reg.activeTag);
  if (engine) reconcile(engine);
  return pickEngine(readRegistry(), engine?.tag);
}

export function setActiveEngine(tag: string): void {
  const reg = readRegistry();
  if (!reg.engines.some((e) => e.tag === tag)) throw new Error(`engine ${tag} is not installed`);
  reg.activeTag = tag;
  writeRegistry(reg);
}

export function removeEngine(tag: string): void {
  const reg = readRegistry();
  const engine = reg.engines.find((e) => e.tag === tag);
  if (engine && fs.existsSync(engine.dir)) {
    fs.rmSync(engine.dir, { recursive: true, force: true });
    log.info(`removed engine ${tag}`);
  }
  reg.engines = reg.engines.filter((e) => e.tag !== tag);
  if (reg.activeTag === tag) delete reg.activeTag;
  writeRegistry(reg);
}

/** Resolve a tool binary path for the active engine (or a specific tag). */
export function resolveTool(tool: ToolName, tag?: string): string {
  const engine = tag ? readRegistry().engines.find((e) => e.tag === tag) : getActiveEngine();
  if (!engine) throw new Error("no llama.cpp engine installed — install one from the Engine view");
  const hit = engine.tools[tool];
  if (!hit) throw new Error(`tool '${tool}' is not part of engine ${engine.tag}`);
  return hit;
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

export interface InstallOptions {
  tag?: string; // default: latest release
  acceleration?: Acceleration; // default: best for this machine
  os?: Os;
  arch?: Arch;
  onProgress?: (stage: string, p: DownloadProgress | null) => void;
  signal?: AbortSignal;
}

/** Discover the tool binaries inside an extracted engine directory. */
function discoverTools(dir: string, osName: Os): Record<string, string> {
  const exe = osName === "windows" ? ".exe" : "";
  const tools: Record<string, string> = {};
  for (const name of KNOWN_TOOLS) {
    const matches = findFiles(dir, (f) => f === `${name}${exe}`);
    if (matches[0]) tools[name] = matches[0];
  }
  // ggml-rpc-server sometimes ships as rpc-server
  if (!tools["ggml-rpc-server"]) {
    const rpc = findFiles(dir, (f) => f === `rpc-server${exe}` || f === `ggml-rpc-server${exe}`);
    if (rpc[0]) tools["ggml-rpc-server"] = rpc[0];
  }
  return tools;
}

/* ------------------------------------------------------------------ rescan */

/**
 * Tool maps go stale, because they are written once.
 *
 * `installEngine` discovers the binaries a single time and stores the result in
 * registry.json; nothing re-reads the directory afterwards. A later release that
 * adds or drops a binary therefore keeps the old map forever, and the dashboard
 * counts coverage against a set the build never had. An engine dir walk is one
 * directory listing, so it is reconciled lazily — at most once per process per
 * tag — rather than on every read.
 */
const reconciled = new Set<string>();

function pickEngine(reg: Registry, tag?: string): InstalledEngine | undefined {
  if (tag) {
    const found = reg.engines.find((e) => e.tag === tag);
    if (found) return found;
  }
  return reg.engines[0];
}

function reconcile(engine: InstalledEngine): void {
  if (reconciled.has(engine.tag)) return;
  reconciled.add(engine.tag);
  try {
    refreshEngineTools(engine.tag);
  } catch (err) {
    // Keep the stored map: a scan that fails must not report a build as untooled.
    log.warn(`tool rescan failed for ${engine.tag}: ${(err as Error).message}`);
  }
}

function reconcileAll(): void {
  for (const e of readRegistry().engines) reconcile(e);
}

/**
 * Re-scan one installed build and persist its tool map if it moved.
 * Returns what changed, so a caller can report it instead of leaving a stale
 * count on screen (the dashboard's "N of M binaries" reads from here).
 */
export function refreshEngineTools(tag?: string): { tag?: string; added: string[]; removed: string[] } {
  const reg = readRegistry();
  const engine = tag ? reg.engines.find((e) => e.tag === tag) : pickEngine(reg, reg.activeTag);
  if (!engine || !fs.existsSync(engine.dir)) return { added: [], removed: [] };
  const found = discoverTools(engine.dir, engine.os);
  const names = Object.keys(found);
  // An empty result means the dir is unreadable or still extracting; never
  // overwrite a good map with nothing.
  if (names.length === 0) return { tag: engine.tag, added: [], removed: [] };
  const added = names.filter((n) => !engine.tools[n]);
  const removed = Object.keys(engine.tools).filter((n) => !found[n]);
  const before = JSON.stringify(engine.tools);
  engine.tools = found;
  if (JSON.stringify(found) !== before) {
    writeRegistry(reg);
    log.info(`rescanned ${engine.tag}: ${names.length} binaries (+${added.length} / -${removed.length})`);
  }
  return { tag: engine.tag, added, removed };
}

function chmodExecutables(dir: string, osName: Os): void {
  if (osName === "windows") return;
  for (const file of findFiles(dir, () => true)) {
    try {
      const mode = fs.statSync(file).mode;
      // add execute for owner/group/other where read is present
      fs.chmodSync(file, mode | 0o111);
    } catch {
      /* best effort */
    }
  }
}

/**
 * Install a llama.cpp release. Idempotent: re-running with an already-installed
 * tag returns the existing engine.
 */
export async function installEngine(opts: InstallOptions = {}): Promise<InstalledEngine> {
  const osName = opts.os ?? currentOs();
  const arch = opts.arch ?? currentArch();
  const accel = opts.acceleration ?? defaultAcceleration(osName, arch);
  const p = ensureDirs();

  const release = opts.tag ? (await listReleases(30)).find((r) => r.tag === opts.tag) : await latestRelease();
  if (!release) throw new Error(`release ${opts.tag} not found`);
  const tag = release.tag;

  const existing = readRegistry().engines.find((e) => e.tag === tag && e.acceleration === accel);
  if (existing && fs.existsSync(existing.dir)) {
    log.info(`engine ${tag}/${accel} already installed`);
    return existing;
  }

  const spec = assetSpec(osName, arch, accel);
  const wanted = [spec.pattern, ...(spec.companions ?? [])].map((x) => x.replace("%BUILD%", tag));
  const assets = wanted.map((name) => {
    const found = release.assets.find((a) => a.name === name);
    if (!found) {
      const avail = release.assets.map((a) => a.name).filter((n) => n.startsWith("llama-") || n.startsWith("cudart-"));
      throw new Error(`asset '${name}' not found in release ${tag}. Available: ${avail.join(", ")}`);
    }
    return found;
  });

  const engineDir = path.join(p.llamaBin, `${tag}-${accel}`);
  const tmp = fs.mkdtempSync(path.join(p.downloads, `engine-${tag}-`));

  try {
    for (const asset of assets) {
      const archive = path.join(tmp, asset.name);
      opts.onProgress?.(`downloading ${asset.name}`, null);
      await downloadFile(asset.browser_download_url, archive, {
        signal: opts.signal,
        onProgress: (pr) => opts.onProgress?.(`downloading ${asset.name}`, pr),
      });
      opts.onProgress?.(`extracting ${asset.name}`, null);
      const stage = path.join(tmp, `x-${asset.name}`);
      await extractArchive(archive, stage);
      // Merge into engineDir (companion archives overlay the main one).
      fs.mkdirSync(engineDir, { recursive: true });
      for (const entry of stripCommonRoot(stage)) {
        const target = path.join(engineDir, path.basename(entry));
        // verbatimSymlinks is essential: without it Node resolves the relative
        // .so symlinks inside the release into absolute paths pointing at the
        // temp dir, and every tool fails to load its libraries.
        fs.cpSync(entry, target, { recursive: true, force: true, verbatimSymlinks: true });
      }
      fs.rmSync(stage, { recursive: true, force: true });
    }

    chmodExecutables(engineDir, osName);
    const tools = discoverTools(engineDir, osName);
    if (Object.keys(tools).length === 0) {
      throw new Error(`no llama.cpp tools found in ${engineDir} after extraction`);
    }
    // Belt and braces: also repair any absolute .so links left behind.
    repairSymlinks(engineDir);

    const engine: InstalledEngine = {
      tag,
      os: osName,
      arch,
      acceleration: accel,
      dir: engineDir,
      installedAt: new Date().toISOString(),
      tools,
    };
    const reg = readRegistry();
    reg.engines = reg.engines.filter((e) => !(e.tag === tag && e.acceleration === accel));
    reg.engines.push(engine);
    if (!reg.activeTag) reg.activeTag = tag;
    writeRegistry(reg);
    log.info(`installed engine ${tag}/${accel} with ${Object.keys(tools).length} tools`);
    opts.onProgress?.("done", null);
    return engine;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Which downloadable variants exist in the latest release for the current OS. */
export function planForCurrentMachine(tagRelease: ReleaseInfo): Array<{ acceleration: Acceleration; asset: string; size: number; available: boolean }> {
  const osName = currentOs();
  const arch = currentArch();
  const accels: Acceleration[] = ["cpu", "metal", "cuda", "vulkan", "rocm", "sycl", "openvino", "opencl"];
  const out: Array<{ acceleration: Acceleration; asset: string; size: number; available: boolean }> = [];
  const seen = new Set<string>();
  for (const accel of accels) {
    let spec;
    try {
      spec = assetSpec(osName, arch, accel);
    } catch {
      continue;
    }
    const name = spec.pattern.replace("%BUILD%", tagRelease.tag);
    if (seen.has(name)) continue;
    seen.add(name);
    const asset = tagRelease.assets.find((a) => a.name === name);
    if (!asset && !isPlausible(accel, osName)) continue;
    out.push({ acceleration: accel, asset: name, size: asset?.size ?? 0, available: Boolean(asset) });
  }
  return out;
}

function isPlausible(accel: Acceleration, osName: Os): boolean {
  if (osName === "macos") return accel === "metal" || accel === "cpu";
  return true;
}
