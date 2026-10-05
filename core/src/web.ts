import fs from "node:fs";
import path from "node:path";

/**
 * The web toolkit backing the agent's internet tools.
 *
 * Everything here is deliberately dependency-free (Node's own fetch): the app
 * must stay offline-capable, so "no network" is a structured error the model
 * can act on, never a crash. Three capabilities, in rising order of power:
 *
 *   fetchText   — one URL to readable text/markdown (existing web_fetch path)
 *   httpRequest — arbitrary method/headers/body, for JSON APIs
 *   crawl       — bounded same-site BFS over links, one page at a time
 *   download    — binary-safe fetch straight into the workspace
 *
 * SSRF guard: private/loopback/link-local hosts are refused unless the caller
 * explicitly opts in — an agent should not be able to reach the user's router.
 */

export interface FetchResult {
  ok: boolean;
  url: string;
  status?: number;
  title?: string;
  contentType?: string;
  text?: string;
  error?: string;
}

export interface CrawlPage {
  url: string;
  title?: string;
  text: string;
}

export interface CrawlResult {
  ok: boolean;
  pages: CrawlPage[];
  visited: number;
  skipped: number;
  error?: string;
}

const UA = "Mozilla/5.0 (compatible; Osama local agent)";
const DEFAULT_TIMEOUT = 20_000;
const MAX_TEXT = 200_000;

/* --------------------------------------------------------------- SSRF guard */

/** Hosts that must never be reachable: loopback, private ranges, link-local. */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  // IPv6 loopback / unique-local / link-local
  if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

export interface WebOpts {
  /** Allow private/loopback hosts (off by default). */
  allowPrivate?: boolean;
  timeoutMs?: number;
}

function checkUrl(raw: string, opts: WebOpts): { ok: true; url: URL } | { ok: false; error: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: `not a valid URL: ${raw.slice(0, 120)}` };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: `only http(s) URLs are supported (got ${u.protocol.replace(":", "")})` };
  }
  if (!opts.allowPrivate && isPrivateHost(u.hostname)) {
    return { ok: false, error: `${u.hostname} is a private/loopback host — refused` };
  }
  return { ok: true, url: u };
}

/* ------------------------------------------------------------ HTML → text */

export function htmlToMarkdown(html: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  // keep heading/list structure the model can use
  s = s
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, body: string) => `\n\n${"#".repeat(Number(n))} ${stripTags(body)}\n\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, body: string) => `\n- ${stripTags(body)}`)
    .replace(/<(br|hr)[^>]*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|tr|table|ul|ol|blockquote|pre)>/gi, "\n")
    .replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, body: string) => {
      const label = stripTags(body);
      return label && !href.startsWith("javascript:") ? `${label} (${href})` : label;
    });

  s = stripTags(s);
  return s
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ fetch */

/** Fetch one URL as readable text (markdown-ish). HTML, text and JSON all work. */
export async function fetchReadable(raw: string, opts: WebOpts = {}): Promise<FetchResult> {
  const check = checkUrl(raw, opts);
  if (!check.ok) return { ok: false, url: raw, error: check.error };
  const url = check.url.toString();
  try {
    const r = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT),
      headers: { "user-agent": UA, accept: "text/html,application/json,text/plain,*/*" },
    });
    const ct = r.headers.get("content-type") ?? "";
    const body = (await r.text()).slice(0, MAX_TEXT * 2);
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1];
    const text = ct.includes("html") ? htmlToMarkdown(body) : body.slice(0, MAX_TEXT);
    return {
      ok: r.ok,
      url,
      status: r.status,
      title: title ? stripTags(title) : undefined,
      contentType: ct || undefined,
      text,
      error: r.ok ? undefined : `HTTP ${r.status}`,
    };
  } catch (e) {
    return { ok: false, url, error: describeFetchError(e) };
  }
}

function describeFetchError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/abort|timeout/i.test(msg)) return `request timed out or was aborted (${msg})`;
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) return `could not resolve the host — check the URL or the network`;
  if (/ECONNREFUSED/i.test(msg)) return `connection refused by the host`;
  return msg;
}

/* --------------------------------------------------------- arbitrary HTTP */

export interface HttpResult {
  ok: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  contentType?: string;
  truncated?: boolean;
  error?: string;
}

/** Any method, any headers, any body — the escape hatch for JSON APIs. */
export async function httpRequest(
  raw: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  opts: WebOpts = {},
): Promise<HttpResult> {
  const check = checkUrl(raw, opts);
  if (!check.ok) return { ok: false, error: check.error };
  const method = (init.method ?? "GET").toUpperCase();
  if (!/^[A-Z]{3,10}$/.test(method)) return { ok: false, error: `unusual HTTP method: ${method}` };
  try {
    const r = await fetch(check.url.toString(), {
      method,
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT),
      headers: { "user-agent": UA, ...(init.headers ?? {}) },
      body: init.body && method !== "GET" && method !== "HEAD" ? init.body : undefined,
    });
    const ct = r.headers.get("content-type") ?? "";
    const full = await r.text();
    const cap = MAX_TEXT;
    const truncated = full.length > cap;
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => { headers[k] = v; });
    // JSON stays JSON; HTML is demoted to markdown so the model can read it
    const body = ct.includes("html") ? htmlToMarkdown(full.slice(0, cap * 2)) : full.slice(0, cap);
    return { ok: r.ok, status: r.status, headers, body, contentType: ct || undefined, truncated };
  } catch (e) {
    return { ok: false, error: describeFetchError(e) };
  }
}

/* ----------------------------------------------------------------- crawl */

export interface CrawlOptions extends WebOpts {
  /** How many pages to collect (1..25). */
  limit?: number;
  /** Stay on the seed host unless set. */
  sameHost?: boolean;
  /** Only follow links whose URL contains this substring. */
  include?: string;
}

/** Bounded breadth-first crawl. Depth 1 by default: the links on the page. */
export async function crawl(seed: string, options: CrawlOptions = {}): Promise<CrawlResult> {
  const start = checkUrl(seed, options);
  if (!start.ok) return { ok: false, pages: [], visited: 0, skipped: 0, error: start.error };

  const limit = Math.min(Math.max(1, options.limit ?? 6), 25);
  const sameHost = options.sameHost !== false;
  const originHost = start.url.hostname;
  const seen = new Set<string>();
  const queue: string[] = [start.url.toString()];
  const pages: CrawlPage[] = [];
  let visited = 0;
  let skipped = 0;

  while (queue.length && pages.length < limit) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);

    const page = await fetchReadable(url, options);
    visited++;
    if (!page.ok || !page.text) {
      skipped++;
      continue;
    }
    pages.push({ url, title: page.title, text: page.text });

    // find more links (from raw HTML only)
    if (pages.length < limit) {
      try {
        const r = await fetch(url, {
          signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT),
          headers: { "user-agent": UA, accept: "text/html" },
        });
        const ct = r.headers.get("content-type") ?? "";
        if (ct.includes("html")) {
          const html = (await r.text()).slice(0, MAX_TEXT * 2);
          for (const href of extractLinks(html, url)) {
            if (seen.has(href)) continue;
            let u: URL;
            try {
              u = new URL(href);
            } catch {
              continue;
            }
            if (options.sameHost !== false && sameHost && u.hostname !== originHost) continue;
            if (options.include && !href.includes(options.include)) continue;
            queue.push(href);
          }
        }
      } catch {
        /* link discovery is best-effort */
      }
    }
  }

  return { ok: pages.length > 0, pages, visited, skipped, error: pages.length ? undefined : "could not read the seed page" };
}

/** Absolute http(s) links from an HTML document, deduped, fragments dropped. */
export function extractLinks(html: string, base: string): string[] {
  const out = new Set<string>();
  const re = /<a[^>]+href=["']([^"'#]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const u = new URL(m[1]!, base);
      if (u.protocol === "http:" || u.protocol === "https:") {
        u.hash = "";
        out.add(u.toString());
      }
    } catch {
      /* relative garbage */
    }
  }
  return [...out];
}

/* -------------------------------------------------------------- download */

export interface DownloadResult {
  ok: boolean;
  file?: string;
  bytes?: number;
  contentType?: string;
  error?: string;
}

/**
 * Fetch a URL and write the bytes into `dir`. The name comes from the URL's
 * last segment (sanitized), never from the server's content-disposition — a
 * remote header must not choose where bytes land in the user's folder.
 */
export async function downloadTo(raw: string, dir: string, name?: string, opts: WebOpts = {}): Promise<DownloadResult> {
  const check = checkUrl(raw, opts);
  if (!check.ok) return { ok: false, error: check.error };
  try {
    const r = await fetch(check.url.toString(), {
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT),
      headers: { "user-agent": UA },
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status} ${r.statusText}` };
    const buf = Buffer.from(await r.arrayBuffer());
    const MAX = 256 * 1024 * 1024;
    if (buf.length > MAX) return { ok: false, error: `file is larger than ${Math.round(MAX / 1024 / 1024)} MB` };

    const guess = name?.trim() || decodeURIComponent(check.url.pathname.split("/").filter(Boolean).pop() ?? "download");
    const safe = guess.replace(/[/\\?%*:|"<>]/g, "-").replace(/^\.+/, "").slice(0, 120) || "download";
    fs.mkdirSync(dir, { recursive: true });
    let target = path.join(dir, safe);
    // never overwrite: suffix -1, -2, …
    for (let i = 1; fs.existsSync(target) && i < 1000; i++) {
      const ext = path.extname(safe);
      target = path.join(dir, `${safe.slice(0, safe.length - ext.length)}-${i}${ext}`);
    }
    fs.writeFileSync(target, buf);
    return { ok: true, file: target, bytes: buf.length, contentType: r.headers.get("content-type") ?? undefined };
  } catch (e) {
    return { ok: false, error: describeFetchError(e) };
  }
}
