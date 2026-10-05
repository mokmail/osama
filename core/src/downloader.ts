import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";

const log = logger("download");

export interface DownloadProgress {
  /** bytes downloaded so far (this run + any resumed bytes) */
  received: number;
  /** total bytes if the server reported Content-Length */
  total: number | null;
  /** 0..1 when total is known */
  percent: number | null;
  /** bytes per second, measured over the last sample window */
  speed: number;
  /** estimated seconds remaining, or null when unknown */
  eta: number | null;
}

export interface DownloadOptions {
  onProgress?: (p: DownloadProgress) => void;
  signal?: AbortSignal;
  /** Resume from an existing `dest.part` file if present. Default true. */
  resume?: boolean;
  /** Extra request headers. */
  headers?: Record<string, string>;
}

export class DownloadError extends Error {
  constructor(message: string, readonly status?: number, readonly url?: string) {
    super(message);
    this.name = "DownloadError";
  }
}

/**
 * Download a URL to `dest` with byte-accurate progress and resume support.
 * Writes to `dest.part` and atomically renames on success, so a partial file
 * never masquerades as a complete one.
 */
export async function downloadFile(url: string, dest: string, opts: DownloadOptions = {}): Promise<void> {
  const resume = opts.resume ?? true;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;

  let start = 0;
  if (resume && fs.existsSync(part)) {
    start = fs.statSync(part).size;
  } else if (fs.existsSync(part)) {
    fs.unlinkSync(part);
  }

  const headers: Record<string, string> = { "user-agent": "osama/0.1", ...(opts.headers ?? {}) };
  if (start > 0) headers["range"] = `bytes=${start}-`;

  log.info(`GET ${url} (resume from ${start} bytes)`);
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: opts.signal, redirect: "follow" });
  } catch (err) {
    throw new DownloadError(`network error: ${(err as Error).message}`, undefined, url);
  }

  if (res.status === 416) {
    // Range not satisfiable — the partial file is already complete.
    fs.renameSync(part, dest);
    return;
  }
  if (!res.ok || !res.body) {
    throw new DownloadError(`HTTP ${res.status} ${res.statusText}`, res.status, url);
  }

  // If we asked to resume but the server ignored the range, restart cleanly.
  const gotRange = res.status === 206;
  if (start > 0 && !gotRange) {
    start = 0;
    if (fs.existsSync(part)) fs.unlinkSync(part);
  }

  const contentLength = res.headers.get("content-length");
  const total = contentLength ? Number(contentLength) + start : null;

  const out = fs.createWriteStream(part, { flags: start > 0 ? "a" : "w" });
  let received = start;
  let windowBytes = 0;
  let windowStart = Date.now();
  let speed = 0;

  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      windowBytes += value.byteLength;
      const now = Date.now();
      if (now - windowStart >= 500) {
        speed = (windowBytes * 1000) / (now - windowStart);
        windowBytes = 0;
        windowStart = now;
      }
      const ok = out.write(Buffer.from(value));
      if (!ok) await new Promise<void>((r) => out.once("drain", () => r()));
      const percent = total ? received / total : null;
      opts.onProgress?.({
        received,
        total,
        percent,
        speed,
        eta: speed > 0 && total ? Math.max(0, (total - received) / speed) : null,
      });
    }
  } finally {
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  }

  // Final sanity: if we know the size, refuse to promote a truncated file.
  const finalSize = fs.statSync(part).size;
  if (total !== null && finalSize < total) {
    throw new DownloadError(`incomplete download: ${finalSize}/${total} bytes`, undefined, url);
  }
  fs.renameSync(part, dest);
  log.info(`saved ${dest} (${finalSize} bytes)`);
}

/** Follow a `?`-less URL and return the final resolved URL (for asset discovery). */
export async function resolveRedirect(url: string): Promise<string> {
  const res = await fetch(url, { method: "HEAD", redirect: "follow" });
  return res.url || url;
}
