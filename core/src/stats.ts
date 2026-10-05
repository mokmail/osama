import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { paths } from "./paths.js";
import { listModels, listDownloads } from "./models.js";
import { listProcesses } from "./processes.js";
import { listInstalled, getActiveEngine, KNOWN_TOOLS } from "./engine.js";

/**
 * Aggregate everything Osama knows about the machine, the engine, the library
 * and the processes into one snapshot for the dashboard. Pure reads — safe to
 * call on a short interval.
 */

export interface DiskUsage {
  bytes: number;
  files: number;
}

export interface DiskBreakdown {
  models: DiskUsage;
  engines: DiskUsage;
  downloads: DiskUsage;
  logs: DiskUsage;
  partialBytes: number;
  partialFiles: number;
  totalBytes: number;
  volume: { totalBytes: number; freeBytes: number; usedPct: number } | null;
}

export interface ActivityEntry {
  type: string;
  count: number;
  lastTs: number | null;
}

export interface HealthCheck {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export interface StatsSnapshot {
  generatedAt: string;
  uptimeMs: number;
  engine: {
    installed: boolean;
    tag?: string;
    acceleration?: string;
    installedAt?: string;
    dir?: string;
    tools: number;
    toolNames: string[];
    knownTools: number;
    enginesInstalled: number;
    sizeBytes: number;
  };
  library: {
    count: number;
    servable: number;
    drafts: number;
    external: number;
    missing: number;
    totalBytes: number;
    avgBytes: number;
    maxBytes: number;
    contextMax: number | null;
    contextTotal: number | null;
    architectures: Array<{ name: string; count: number; bytes: number }>;
    quantizations: Array<{ name: string; count: number; bytes: number }>;
    recent: Array<{
      id: string;
      name: string;
      quantization?: string;
      architecture?: string;
      sizeBytes: number;
      addedAt: string;
    }>;
  };
  disk: DiskBreakdown;
  processes: {
    total: number;
    running: number;
    exited: number;
    failed: number;
    stopped: number;
    byTool: Array<{ tool: string; count: number }>;
    runningNow: Array<{ id: string; label: string; tool: string; pid?: number; url?: string; uptimeMs: number }>;
    oldestUptimeMs: number | null;
  };
  downloads: {
    active: number;
    done: number;
    error: number;
    cancelled: number;
    records: Array<{ id: string; file: string; repo: string; received: number; total: number | null; status: string }>;
  };
  system: {
    hostname: string;
    os: string;
    arch: string;
    release: string;
    cpuModel: string;
    cpus: number;
    totalMemBytes: number;
    freeMemBytes: number;
    usedMemBytes: number;
    memUsedPct: number;
    loadavg: number[];
    loadPct: number;
  };
  activity: ActivityEntry[];
  health: {
    score: number;
    checks: HealthCheck[];
  };
}

function walkUsage(dir: string, filter?: (name: string) => boolean): DiskUsage {
  let bytes = 0;
  let files = 0;
  const walk = (d: string, depth: number): void => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (filter && !filter(entry.name)) continue;
        try {
          const st = fs.statSync(full);
          bytes += st.size;
          files += 1;
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(dir, 0);
  return { bytes, files };
}

function volumeUsage(dir: string): DiskBreakdown["volume"] {
  try {
    const st: any = (fs as any).statfsSync(dir);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    if (!total) return null;
    return { totalBytes: total, freeBytes: free, usedPct: Math.round(((total - free) / total) * 100) };
  } catch {
    return null;
  }
}

function tally<T extends string>(items: T[]): Array<{ name: string; count: number }> {
  const map = new Map<string, number>();
  for (const it of items) map.set(it, (map.get(it) ?? 0) + 1);
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Build the snapshot. `activity` is supplied by the caller (the server owns the
 * SSE event counters) so core stays free of transport concerns.
 */
export function buildStats(activity: ActivityEntry[] = []): StatsSnapshot {
  const p = paths();
  const models = listModels();
  const procs = listProcesses(true);
  const downloads = listDownloads();
  const engine = getActiveEngine();
  const engines = listInstalled();

  // --- library -------------------------------------------------------------
  const totalBytes = models.reduce((s, m) => s + (m.sizeBytes ?? 0), 0);
  const byArch = new Map<string, { count: number; bytes: number }>();
  const byQuant = new Map<string, { count: number; bytes: number }>();
  const contexts: number[] = [];
  for (const m of models) {
    const arch = m.card?.architecture ?? "unknown";
    const quant = m.card?.quantization ?? "unknown";
    const size = m.sizeBytes ?? 0;
    const a = byArch.get(arch) ?? { count: 0, bytes: 0 };
    byArch.set(arch, { count: a.count + 1, bytes: a.bytes + size });
    const q = byQuant.get(quant) ?? { count: 0, bytes: 0 };
    byQuant.set(quant, { count: q.count + 1, bytes: q.bytes + size });
    if (m.card?.contextLength) contexts.push(m.card.contextLength);
  }
  const toArr = (map: Map<string, { count: number; bytes: number }>) =>
    [...map.entries()]
      .map(([name, v]) => ({ name, count: v.count, bytes: v.bytes }))
      .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));

  // --- disk ----------------------------------------------------------------
  const modelsUsage = walkUsage(p.models, (n) => n.toLowerCase().endsWith(".gguf"));
  const enginesUsage = walkUsage(p.bin);
  const logsUsage = walkUsage(p.logs);
  let partialBytes = 0;
  let partialFiles = 0;
  const walkPartial = (d: string, depth: number): void => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walkPartial(full, depth + 1);
      else if (e.isFile() && e.name.endsWith(".part")) {
        try {
          partialBytes += fs.statSync(full).size;
          partialFiles += 1;
        } catch {
          /* ignore */
        }
      }
    }
  };
  walkPartial(p.downloads, 0);
  walkPartial(p.models, 0);

  const disk: DiskBreakdown = {
    models: modelsUsage,
    engines: enginesUsage,
    downloads: walkUsage(p.downloads),
    logs: logsUsage,
    partialBytes,
    partialFiles,
    totalBytes: modelsUsage.bytes + enginesUsage.bytes + logsUsage.bytes + partialBytes,
    volume: volumeUsage(fs.existsSync(p.models) ? p.models : p.home),
  };

  // --- processes -----------------------------------------------------------
  const running = procs.filter((x) => x.status === "running" || x.status === "starting");
  const byTool = tally(procs.map((x) => (x.tool.split(/[/\\]/).pop() ?? x.tool).replace(/\.exe$/i, ""))).map(
    (t) => ({ tool: t.name, count: t.count }),
  );
  const runningNow = running.map((x) => ({
    id: x.id,
    label: x.label,
    tool: x.tool.split(/[/\\]/).pop() ?? x.tool,
    pid: x.pid,
    url: x.url,
    uptimeMs: Date.now() - x.startedAt,
  }));
  const uptimes = running.map((x) => Date.now() - x.startedAt);

  // --- system --------------------------------------------------------------
  const total = os.totalmem();
  const free = os.freemem();
  const load = os.loadavg();
  const cpus = os.cpus();
  const system = {
    hostname: os.hostname(),
    os: os.platform(),
    arch: process.arch,
    release: os.release(),
    cpuModel: cpus[0]?.model?.trim() ?? "unknown",
    cpus: cpus.length,
    totalMemBytes: total,
    freeMemBytes: free,
    usedMemBytes: total - free,
    memUsedPct: total ? Math.round(((total - free) / total) * 100) : 0,
    loadavg: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
    loadPct: cpus.length ? Math.max(0, Math.round(((load[0] ?? 0) / cpus.length) * 100)) : 0,
  };

  const serverProc = running.find((x) => x.tool.includes("llama-server"));

  // --- health --------------------------------------------------------------
  const checks: HealthCheck[] = [];
  checks.push(
    engine
      ? { id: "engine", label: "llama.cpp engine", status: "ok", detail: `${engine.tag} · ${engine.acceleration}` }
      : { id: "engine", label: "llama.cpp engine", status: "fail", detail: "no build installed" },
  );
  const toolCount = engine ? Object.keys(engine.tools).length : 0;
  checks.push(
    toolCount > 0
      ? { id: "tools", label: "Tool binaries", status: toolCount >= 10 ? "ok" : "warn", detail: `${toolCount} of ${KNOWN_TOOLS.length} known tools present` }
      : { id: "tools", label: "Tool binaries", status: "fail", detail: "none resolved" },
  );
  checks.push(
    models.length > 0
      ? { id: "library", label: "Model library", status: "ok", detail: `${models.length} model(s)` }
      : { id: "library", label: "Model library", status: "warn", detail: "empty — download a GGUF" },
  );
  checks.push(
    serverProc
      ? { id: "server", label: "Inference server", status: "ok", detail: serverProc.url ?? "running" }
      : { id: "server", label: "Inference server", status: "warn", detail: "not running" },
  );
  const vol = disk.volume;
  if (vol) {
    const freeGb = vol.freeBytes / 1024 ** 3;
    checks.push({
      id: "disk",
      label: "Disk headroom",
      status: freeGb > 10 ? "ok" : freeGb > 3 ? "warn" : "fail",
      detail: `${freeGb.toFixed(1)} GB free (${vol.usedPct}% used)`,
    });
  }
  if (partialFiles > 0) {
    checks.push({
      id: "partials",
      label: "Partial downloads",
      status: "warn",
      detail: `${partialFiles} unfinished file(s) · ${(partialBytes / 1024 ** 2).toFixed(0)} MB`,
    });
  }
  const missing = models.filter((m) => m.missing).length;
  if (missing > 0) {
    checks.push({ id: "missing", label: "Missing model files", status: "warn", detail: `${missing} entr(ies) point at deleted files` });
  }

  const weight = { ok: 1, warn: 0.5, fail: 0 } as const;
  const score = checks.length
    ? Math.round((checks.reduce((s, c) => s + weight[c.status], 0) / checks.length) * 100)
    : 100;

  return {
    generatedAt: new Date().toISOString(),
    uptimeMs: Math.round(process.uptime() * 1000),
    engine: {
      installed: !!engine,
      tag: engine?.tag,
      acceleration: engine?.acceleration,
      installedAt: engine?.installedAt,
      dir: engine?.dir,
      tools: toolCount,
      toolNames: engine ? Object.keys(engine.tools).sort() : [],
      knownTools: KNOWN_TOOLS.length,
      enginesInstalled: engines.length,
      sizeBytes: enginesUsage.bytes,
    },
    library: {
      count: models.length,
      servable: models.filter((m) => !m.draftOnly).length,
      drafts: models.filter((m) => m.draftOnly).length,
      external: models.filter((m) => m.external).length,
      missing,
      totalBytes,
      avgBytes: models.length ? Math.round(totalBytes / models.length) : 0,
      maxBytes: models.reduce((s, m) => Math.max(s, m.sizeBytes ?? 0), 0),
      contextMax: contexts.length ? Math.max(...contexts) : null,
      contextTotal: contexts.length ? contexts.reduce((s, c) => s + c, 0) : null,
      architectures: toArr(byArch),
      quantizations: toArr(byQuant),
      recent: models.slice(0, 6).map((m) => ({
        id: m.id,
        name: m.name,
        quantization: m.card?.quantization,
        architecture: m.card?.architecture,
        sizeBytes: m.sizeBytes ?? 0,
        addedAt: m.addedAt,
      })),
    },
    disk,
    processes: {
      total: procs.length,
      running: running.length,
      exited: procs.filter((x) => x.status === "exited").length,
      failed: procs.filter((x) => x.status === "failed").length,
      stopped: procs.filter((x) => x.status === "stopped").length,
      byTool,
      runningNow,
      oldestUptimeMs: uptimes.length ? Math.max(...uptimes) : null,
    },
    downloads: {
      active: downloads.filter((d) => d.status === "downloading").length,
      done: downloads.filter((d) => d.status === "done").length,
      error: downloads.filter((d) => d.status === "error").length,
      cancelled: downloads.filter((d) => d.status === "cancelled").length,
      records: downloads.slice(0, 6).map((d) => ({
        id: d.id,
        file: d.file,
        repo: d.repo,
        received: d.received,
        total: d.total,
        status: d.status,
      })),
    },
    system,
    activity,
    health: { score, checks },
  };
}

/** A single point on the dashboard's live sparklines. */
export interface SeriesSample {
  ts: number;
  memFreeBytes: number;
  memUsedPct: number;
  loadPct: number;
  runningProcesses: number;
  activeDownloads: number;
  libraryBytes: number;
}

const SERIES: SeriesSample[] = [];
const SERIES_MAX = 180; // 180 × 5 s = 15 minutes

export function sampleSeries(): SeriesSample {
  const total = os.totalmem();
  const free = os.freemem();
  const load = os.loadavg();
  const cpus = os.cpus().length || 1;
  const sample: SeriesSample = {
    ts: Date.now(),
    memFreeBytes: free,
    memUsedPct: total ? Math.round(((total - free) / total) * 100) : 0,
    loadPct: Math.max(0, Math.min(100, Math.round(((load[0] ?? 0) / cpus) * 100))),
    runningProcesses: listProcesses(false).length,
    activeDownloads: listDownloads().filter((d) => d.status === "downloading").length,
    libraryBytes: listModels().reduce((s, m) => s + (m.sizeBytes ?? 0), 0),
  };
  SERIES.push(sample);
  if (SERIES.length > SERIES_MAX) SERIES.splice(0, SERIES.length - SERIES_MAX);
  return sample;
}

export function getSeries(): SeriesSample[] {
  if (SERIES.length === 0) sampleSeries();
  return SERIES;
}

/** Start the 5 s background sampler (idempotent). */
let sampler: NodeJS.Timeout | null = null;
export function startSeriesSampler(intervalMs = 5000): void {
  if (sampler) return;
  sampleSeries();
  sampler = setInterval(() => {
    try {
      sampleSeries();
    } catch {
      /* never let the sampler kill the server */
    }
  }, intervalMs);
  sampler.unref?.();
}
