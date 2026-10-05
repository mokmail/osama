import fs from "node:fs";
import path from "node:path";
import { osamaHome } from "./paths.js";

/**
 * Durable agent sessions.
 *
 * The DeepSeek Harness treats the session log as the spine: an append-only log
 * of events that survives restarts, with a fresh id per conversation. Osama's
 * chat kept state in React only, so a restart lost everything; this gives the
 * agent turns a durable home and gives the session-query tools something real
 * to search.
 *
 * Same core guarantees as dsh's `core/session`: append-only, replayable in
 * order, nothing deleted on compaction — compaction only shadows old turns in
 * what the model sees, never in the log.
 */

export type SessionEventKind =
  | "message"      // a chat message (user/assistant)
  | "tool_call"    // the model asked for a tool
  | "tool_result"  // the tool answered
  | "artifact"     // a file the agent wrote or edited
  | "todo"         // a whole-list snapshot from write_todo
  | "summary"      // a compaction record: what was condensed, and its summary text
  | "error";

export interface SessionEvent {
  seq: number;
  ts: number;
  kind: SessionEventKind;
  data: Record<string, unknown>;
}

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  workspace: string;
  eventCount: number;
  /** true when a compaction has shadowed some of the log */
  compacted: boolean;
}

export interface SessionRecord extends Omit<SessionMeta, "eventCount"> {
  events: SessionEvent[];
}

const dir = (): string => path.join(osamaHome(), "sessions");

function fileOf(id: string): string {
  return path.join(dir(), `${id}.json`);
}

export function newSessionId(): string {
  const d = new Date();
  const stamp = d.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_");
  return `s_${stamp}_${Math.random().toString(36).slice(2, 6)}`;
}

export function listSessions(): SessionMeta[] {
  try {
    return fs
      .readdirSync(dir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          const rec = readSession(f.replace(/\.json$/, ""));
          if (!rec) return null;
          const first = rec.events.find((e) => e.kind === "message" && e.data.role === "user");
          return {
            id: rec.id,
            title: rec.title || String(first?.data.preview ?? "untitled"),
            createdAt: rec.createdAt,
            updatedAt: rec.updatedAt,
            workspace: rec.workspace,
            eventCount: rec.events.length,
            compacted: rec.compacted,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean as unknown as (x: SessionMeta | null) => x is SessionMeta)
      .sort((a, b) => (b!.updatedAt > a!.updatedAt ? 1 : -1));
  } catch {
    return [];
  }
}

export function readSession(id: string): SessionRecord | null {
  if (!/^[a-z0-9_]+$/.test(id)) return null; // ids are generated, never user paths
  try {
    return JSON.parse(fs.readFileSync(fileOf(id), "utf8")) as SessionRecord;
  } catch {
    return null;
  }
}

/** Append events; returns the new seq numbers. Never rewrites existing lines. */
export function appendEvents(id: string, workspace: string, events: Array<Omit<SessionEvent, "seq" | "ts">>): SessionEvent[] {
  fs.mkdirSync(dir(), { recursive: true });
  const rec = readSession(id) ?? {
    id,
    title: "",
    createdAt: new Date().toISOString(),
    updatedAt: "",
    workspace,
    events: [],
    compacted: false,
  };
  const out: SessionEvent[] = [];
  for (const e of events) {
    const full: SessionEvent = { seq: rec.events.length + 1, ts: Date.now(), ...e };
    rec.events.push(full);
    out.push(full);
  }
  rec.workspace = workspace;
  rec.updatedAt = new Date().toISOString();
  if (!rec.title) {
    // a title from the first user message
    const first = rec.events.find((e) => e.kind === "message" && e.data.role === "user");
    if (first) rec.title = String(first.data.preview ?? "").slice(0, 60);
  }
  const tmp = `${fileOf(id)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), "utf8");
  fs.renameSync(tmp, fileOf(id));
  return out;
}

/** Mark a compaction: the summary text and what it replaced go into the log. */
export function recordCompaction(id: string, summary: string, shadowedCount: number): void {
  appendEvents(id, "", [{ kind: "summary", data: { summary: summary.slice(0, 4000), shadowedCount } }]);
  try {
    const rec = readSession(id);
    if (rec) {
      rec.compacted = true;
      const tmp = `${fileOf(id)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), "utf8");
      fs.renameSync(tmp, fileOf(id));
    }
  } catch {
    /* the marker is best-effort */
  }
}

export function deleteSession(id: string): boolean {
  try {
    fs.rmSync(fileOf(id), { force: true });
    return true;
  } catch {
    return false;
  }
}