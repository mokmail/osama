import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { logger, processLogPath } from "./logger.js";

const log = logger("process");

export type ProcStatus = "starting" | "running" | "exited" | "failed" | "stopped";

export interface ManagedProcessInfo {
  id: string;
  label: string;
  tool: string;
  argv: string[];
  cwd: string;
  pid?: number;
  status: ProcStatus;
  exitCode?: number | null;
  signal?: string | null;
  startedAt: number;
  endedAt?: number;
  /** convenience: a URL a server is reachable at, when applicable */
  url?: string;
  logPath: string;
}

interface Managed extends ManagedProcessInfo {
  child?: ChildProcess;
  fd?: number;
  buffer: string[];
  emitter: EventEmitter;
}

const RUNNING = new Map<string, Managed>();
const MAX_BUFFER = 4000;

export interface StartOptions {
  label: string;
  tool: string;
  argv: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  url?: string;
}

export function startProcess(opts: StartOptions): ManagedProcessInfo {
  const binName = opts.tool.split(/[/\\]/).pop() ?? "tool";
  const slug = binName.replace(/^llama-/, "").replace(/\.exe$/i, "");
  const id = `${slug}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const logPath = processLogPath(id);
  const managed: Managed = {
    id,
    label: opts.label,
    tool: opts.tool,
    argv: opts.argv,
    cwd: opts.cwd ?? process.cwd(),
    status: "starting",
    startedAt: Date.now(),
    logPath,
    url: opts.url,
    buffer: [],
    emitter: new EventEmitter(),
  };
  RUNNING.set(id, managed);

  let fd: number | null = null;
  let child: ChildProcess;
  try {
    fd = fs.openSync(logPath, "a");
    child = spawn(opts.tool, opts.argv, {
      cwd: managed.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    managed.child = child;
    managed.pid = child.pid;
    managed.status = "running";
  } catch (err) {
    managed.status = "failed";
    managed.endedAt = Date.now();
    const msg = `[osama] could not start ${binName}: ${(err as Error).message}`;
    managed.buffer.push(msg);
    log.error(msg);
    // Don't leave a half-built record behind.
    RUNNING.delete(id);
    throw err;
  }
  if (fd !== null) managed.fd = fd;
  log.info(`started ${id}: ${opts.tool} ${opts.argv.join(" ")} (pid ${child.pid})`);

  const attach = (stream: NodeJS.ReadableStream | null) => {
    if (!stream) return;
    stream.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      try {
        fs.writeSync(fd, text);
      } catch {
        /* ignore */
      }
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        managed.buffer.push(line);
        if (managed.buffer.length > MAX_BUFFER) managed.buffer.shift();
        managed.emitter.emit("line", line);
      }
    });
  };
  attach(child.stdout);
  attach(child.stderr);

  child.on("error", (err) => {
    managed.status = "failed";
    managed.endedAt = Date.now();
    managed.buffer.push(`[osama] process error: ${err.message}`);
    managed.emitter.emit("line", `[osama] process error: ${err.message}`);
    managed.emitter.emit("exit", managed);
    log.error(`${id} error: ${err.message}`);
  });

  child.on("exit", (code, signal) => {
    managed.exitCode = code;
    managed.signal = signal;
    managed.endedAt = Date.now();
    if (managed.fd !== null && managed.fd !== undefined) {
      try {
        fs.closeSync(managed.fd);
      } catch {
        /* ignore */
      }
      managed.fd = undefined;
    }
    if (signal === "SIGTERM" || signal === "SIGKILL") managed.status = "stopped";
    else managed.status = code === 0 ? "exited" : "failed";
    managed.buffer.push(`[osama] process exited (code=${code ?? "null"}, signal=${signal ?? "none"})`);
    managed.emitter.emit("exit", managed);
    log.info(`${id} exited code=${code} signal=${signal}`);
    // Keep the record around so the UI can show the exit state.
    setTimeout(() => RUNNING.delete(id), 5 * 60_000).unref?.();
  });

  return toInfo(managed);
}

function toInfo(m: Managed): ManagedProcessInfo {
  return {
    id: m.id,
    label: m.label,
    tool: m.tool,
    argv: m.argv,
    cwd: m.cwd,
    pid: m.pid,
    status: m.status,
    exitCode: m.exitCode,
    signal: m.signal,
    startedAt: m.startedAt,
    endedAt: m.endedAt,
    url: m.url,
    logPath: m.logPath,
  };
}

export function listProcesses(includeFinished = true): ManagedProcessInfo[] {
  return [...RUNNING.values()]
    .filter((m) => includeFinished || m.status === "running" || m.status === "starting")
    .map(toInfo)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function getProcess(id: string): ManagedProcessInfo | undefined {
  const m = RUNNING.get(id);
  return m ? toInfo(m) : undefined;
}

/**
 * Drop finished records (exited/failed/stopped) from the list — housekeeping
 * for the Processes view, which keeps every historical entry otherwise. A
 * running or starting process is never touched.
 */
export function pruneFinishedProcesses(): number {
  let n = 0;
  for (const [id, m] of [...RUNNING.entries()]) {
    if (m.status === "exited" || m.status === "failed" || m.status === "stopped") {
      RUNNING.delete(id);
      n++;
    }
  }
  return n;
}

export function processLog(id: string, limit = 500): string[] {
  const m = RUNNING.get(id);
  if (!m) return [];
  return m.buffer.slice(-limit);
}

export function onProcessLine(id: string, fn: (line: string) => void): () => void {
  const m = RUNNING.get(id);
  if (!m) return () => {};
  m.emitter.on("line", fn);
  return () => m.emitter.off("line", fn);
}

export function onProcessExit(id: string, fn: (info: ManagedProcessInfo) => void): () => void {
  const m = RUNNING.get(id);
  if (!m) return () => {};
  const handler = (mm: Managed) => fn(toInfo(mm));
  m.emitter.on("exit", handler);
  return () => m.emitter.off("exit", handler);
}

function isTerminal(status: ProcStatus): boolean {
  return status === "stopped" || status === "exited" || status === "failed";
}

export async function stopProcess(id: string, timeoutMs = 5000): Promise<boolean> {
  const m = RUNNING.get(id);
  if (!m || !m.child) return false;
  if (m.status !== "running" && m.status !== "starting") return false;
  log.info(`stopping ${id} (pid ${m.pid})`);
  m.child.kill("SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isTerminal(m.status)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (m.child.pid) {
    try {
      m.child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
  return true;
}

/** Check whether a TCP port can be bound on the given host. */
export async function isPortFree(host: string, port: number): Promise<boolean> {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    try {
      srv.listen(port, host);
    } catch {
      resolve(false);
    }
  });
}

/**
 * A just-killed process can hold its socket for a moment, so poll instead of
 * concluding the port is taken after a single failed bind.
 */
export async function waitForPortFree(host: string, port: number, timeoutMs = 6000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isPortFree(host, port)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** First bindable port in [from, to], or null. Never touches other processes. */
export async function findFreePort(host: string, from: number, to = from + 40): Promise<number | null> {
  for (let p = from; p <= to; p++) {
    if (await isPortFree(host, p)) return p;
  }
  return null;
}

/**
 * Stop every `llama-server` Osama manages. Used to enforce one server at a
 * time: a stale server for another model holds both the port and the memory.
 */
export async function stopAllServers(): Promise<string[]> {
  const servers = [...RUNNING.values()].filter(
    (m) => m.tool.includes("llama-server") && (m.status === "running" || m.status === "starting"),
  );
  const stopped: string[] = [];
  for (const s of servers) {
    const ok = await stopProcess(s.id);
    if (ok) stopped.push(s.id);
  }
  return stopped;
}

/**
 * Synchronously SIGKILL every live child. Spawned processes do not die with
 * their parent, so without this the engine leaks a llama-server (holding the
 * port and its memory) on every restart. Safe to call from an exit handler.
 */
export function killAllProcesses(): number {
  let killed = 0;
  for (const m of RUNNING.values()) {
    if (!m.child) continue;
    if (m.status !== "running" && m.status !== "starting") continue;
    try {
      m.child.kill("SIGKILL");
      killed++;
    } catch {
      /* already gone */
    }
  }
  return killed;
}

/** Run a tool to completion and capture stdout/stderr (for bench, quantize, …). */
export interface RunResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export function runToCompletion(
  tool: string,
  argv: string[],
  opts: { cwd?: string; onLine?: (line: string) => void; signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(tool, argv, { cwd: opts.cwd ?? process.cwd(), env: { ...process.env, ...(opts.env ?? {}) } });
    let stdout = "";
    let stderr = "";
    const pump = (stream: NodeJS.ReadableStream | null, sink: (s: string) => void) => {
      if (!stream) return;
      stream.on("data", (c: Buffer) => {
        const t = c.toString();
        sink(t);
        for (const line of t.split(/\r?\n/)) if (line) opts.onLine?.(line);
      });
    };
    pump(child.stdout, (t) => (stdout += t));
    pump(child.stderr, (t) => (stderr += t));
    child.on("error", reject);
    opts.signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    child.on("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr, durationMs: Date.now() - started }),
    );
  });
}
