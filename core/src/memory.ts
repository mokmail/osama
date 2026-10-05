import fs from "node:fs";
import path from "node:path";
import { osamaHome } from "./paths.js";

/**
 * Memory: durable facts the agent chooses to keep.
 *
 * The DeepSeek Harness has no `memory` package — memory-like behaviour there is
 * context providers plus the session log. This gives Osama a small, explicit
 * store of its own instead: plain JSON on disk, scoped, and only written when
 * the model decides something is worth remembering, so it stays a deliberate
 * action rather than an invisible side effect of every turn.
 *
 * A hard character budget per scope keeps it honest: entries compete for room
 * exactly as they do in a context window, and the model is told when it is full
 * rather than silently truncated.
 */

export type MemoryScope = "global" | "workspace";

export interface MemoryEntry {
  id: string;
  text: string;
  scope: MemoryScope;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  /** Bumped each time the entry is recalled, so useful facts can be ranked. */
  hits: number;
}

/** Per-scope budget. Mirrors the "keep it small" discipline of a context file. */
export const MEMORY_BUDGET = { global: 4000, workspace: 4000 } as const;

function memoryFile(scope: MemoryScope): string {
  const dir = path.join(osamaHome(), "memory");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${scope}.json`);
}

interface MemoryDoc {
  version: number;
  scope: MemoryScope;
  entries: MemoryEntry[];
}

function readDoc(scope: MemoryScope): MemoryDoc {
  const file = memoryFile(scope);
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<MemoryDoc>;
    if (Array.isArray(parsed.entries)) {
      return { version: 1, scope, entries: parsed.entries.filter((e) => e && typeof e.text === "string") as MemoryEntry[] };
    }
  } catch {
    /* missing or corrupt — start clean rather than throwing at the model */
  }
  return { version: 1, scope, entries: [] };
}

function writeDoc(doc: MemoryDoc): void {
  const file = memoryFile(doc.scope);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

export function memoryChars(scope: MemoryScope): number {
  return readDoc(scope).entries.reduce((n, e) => n + e.text.length, 0);
}

export function listMemory(scope?: MemoryScope): MemoryEntry[] {
  const scopes: MemoryScope[] = scope ? [scope] : ["global", "workspace"];
  return scopes.flatMap((s) => readDoc(s).entries);
}

export interface SaveResult {
  ok: boolean;
  entry?: MemoryEntry;
  error?: string;
  used?: number;
  budget?: number;
}

/** Add a fact. Refuses rather than overflowing the budget. */
export function saveMemory(text: string, scope: MemoryScope = "global", tags: string[] = []): SaveResult {
  const clean = text.trim();
  if (!clean) return { ok: false, error: "text is required" };
  if (clean.length > 1000) return { ok: false, error: "a single memory must be under 1000 characters" };

  const doc = readDoc(scope);
  // Identical text is a no-op, not a duplicate: models repeat themselves.
  const dupe = doc.entries.find((e) => e.text.toLowerCase() === clean.toLowerCase());
  if (dupe) {
    dupe.updatedAt = new Date().toISOString();
    writeDoc(doc);
    return { ok: true, entry: dupe, used: memoryChars(scope), budget: MEMORY_BUDGET[scope] };
  }

  const budget = MEMORY_BUDGET[scope];
  const used = doc.entries.reduce((n, e) => n + e.text.length, 0);
  if (used + clean.length > budget) {
    return {
      ok: false,
      error: `the ${scope} memory is full (${used}/${budget} chars). Remove an entry with forget_memory, or replace a less useful one.`,
      used,
      budget,
    };
  }

  const now = new Date().toISOString();
  const entry: MemoryEntry = {
    id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    text: clean,
    scope,
    tags,
    createdAt: now,
    updatedAt: now,
    hits: 0,
  };
  doc.entries.push(entry);
  writeDoc(doc);
  return { ok: true, entry, used: used + clean.length, budget };
}

/** Remove one or all entries, by id or by substring. */
export function forgetMemory(selector: string, scope?: MemoryScope): { ok: boolean; removed: number; error?: string } {
  const scopes: MemoryScope[] = scope ? [scope] : ["global", "workspace"];
  const sel = selector.trim().toLowerCase();
  if (!sel) return { ok: false, removed: 0, error: "provide an id, or 'all' to clear everything" };
  let removed = 0;
  for (const s of scopes) {
    const doc = readDoc(s);
    const before = doc.entries.length;
    doc.entries = sel === "all" ? [] : doc.entries.filter((e) => e.id.toLowerCase() !== sel && !e.text.toLowerCase().includes(sel));
    removed += before - doc.entries.length;
    if (before !== doc.entries.length) writeDoc(doc);
  }
  return { ok: removed > 0, removed, error: removed ? undefined : `no memory matched "${selector}"` };
}

/** Recall by keyword; a blank query returns everything, most-used first. */
export function recallMemory(query = "", scope?: MemoryScope): MemoryEntry[] {
  const all = listMemory(scope);
  const q = query.trim().toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  const scored = all.map((e) => {
    const hay = `${e.text} ${e.tags.join(" ")}`.toLowerCase();
    const score = terms.length === 0 ? 0 : terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
    return { e, score };
  });
  const hits = terms.length ? scored.filter((s) => s.score > 0) : scored;
  hits.sort((a, b) => b.score - a.score || b.e.hits - a.e.hits || b.e.updatedAt.localeCompare(a.e.updatedAt));
  return hits.map((s) => s.e);
}

/** Record that entries were surfaced, so ranking improves over time. */
export function markRecalled(ids: string[]): void {
  if (!ids.length) return;
  for (const scope of ["global", "workspace"] as MemoryScope[]) {
    const doc = readDoc(scope);
    let touched = false;
    for (const e of doc.entries) {
      if (ids.includes(e.id)) {
        e.hits += 1;
        touched = true;
      }
    }
    if (touched) writeDoc(doc);
  }
}

/**
 * The always-injected memory block.
 *
 * Workspace entries go first (they describe where the agent is right now),
 * global ones after, most-recalled first within each group — so the facts most
 * likely to matter are the least likely to be clipped. The block names when it
 * clipped instead of silently dropping facts, and `stats` reports what the
 * caller (the UI panel) needs to show the real fill level.
 */
export function memoryBlock(maxChars = 1200, query?: string): string {
  const stats = memoryStats();
  if (stats.total === 0) return "";

  // Relevant first: a query (say, the user's current message) boosts matching
  // entries so recall follows the conversation rather than insertion order.
  const scored = query
    ? recallMemory(query)
    : [...listMemory()].sort((a, b) => b.hits - a.hits || b.updatedAt.localeCompare(a.updatedAt));
  if (!scored.length) return "";

  let out = "";
  let shown = 0;
  for (const e of scored) {
    const line = `- ${e.text}${e.scope === "workspace" ? " [workspace]" : ""}\n`;
    if (out.length + line.length > maxChars) break;
    out += line;
    shown++;
  }
  const hidden = stats.total - shown;
  if (hidden > 0) {
    out += `… and ${hidden} more saved fact(s) — call recall_memory to list them\n`;
  }
  return out.trimEnd();
}

/** Fill levels for the UI panel and the context_status tool. */
export interface MemoryStats {
  total: number;
  byScope: Record<MemoryScope, number>;
  chars: Record<MemoryScope, number>;
  budget: Record<MemoryScope, number>;
}

export function memoryStats(): MemoryStats {
  const scopes: MemoryScope[] = ["global", "workspace"];
  const byScope = {} as Record<MemoryScope, number>;
  const chars = {} as Record<MemoryScope, number>;
  for (const s of scopes) {
    const entries = readDoc(s).entries;
    byScope[s] = entries.length;
    chars[s] = entries.reduce((n, e) => n + e.text.length, 0);
  }
  return { total: byScope.global + byScope.workspace, byScope, chars, budget: { ...MEMORY_BUDGET } };
}
