import fs from "node:fs";
import path from "node:path";
import { paths, ensureDirs } from "./paths.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  ts: number;
  level: LogLevel;
  scope: string;
  msg: string;
}

type Listener = (r: LogRecord) => void;

const RING = 1000;
const ring: LogRecord[] = [];
const listeners = new Set<Listener>();
let stream: fs.WriteStream | null = null;

function logFile(): fs.WriteStream {
  if (!stream) {
    const p = ensureDirs();
    stream = fs.createWriteStream(path.join(p.logs, "osama.log"), { flags: "a" });
  }
  return stream;
}

function emit(level: LogLevel, scope: string, msg: string): void {
  const rec: LogRecord = { ts: Date.now(), level, scope, msg };
  ring.push(rec);
  if (ring.length > RING) ring.shift();
  const line = `${new Date(rec.ts).toISOString()} [${level}] (${scope}) ${msg}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  try {
    logFile().write(line + "\n");
  } catch {
    /* logging must never throw */
  }
  for (const l of listeners) l(rec);
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  child(scope: string): Logger;
}

export function logger(scope: string): Logger {
  return {
    debug: (m) => emit("debug", scope, m),
    info: (m) => emit("info", scope, m),
    warn: (m) => emit("warn", scope, m),
    error: (m) => emit("error", scope, m),
    child: (sub) => logger(`${scope}:${sub}`),
  };
}

export function recent(limit = 200): LogRecord[] {
  return ring.slice(-limit);
}

export function onLog(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Path for a dedicated per-process log file. */
export function processLogPath(id: string): string {
  const p = ensureDirs();
  return path.join(p.logs, `proc-${id}.log`);
}
