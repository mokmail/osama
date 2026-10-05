import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { osamaHome } from "./paths.js";
import { getWorkspace } from "./workspace.js";
import { logger } from "./logger.js";

/**
 * Memory: what the agent keeps across sessions.
 *
 * Modelled on Hermes' two-store design, because the split is the useful part:
 *
 *   memory  — the agent's own notes. Environment facts, conventions, lessons
 *             learned, completed work. Split further into `global` (follows the
 *             user everywhere) and `workspace` (describes where the agent is
 *             working right now).
 *   user    — the profile: who the user is, how they like to be answered, what
 *             they consistently want. Always global — a preference does not stop
 *             applying because the folder changed.
 *
 * Three properties make this work, and all three are deliberate:
 *
 * 1. **Bounded, and it refuses rather than truncating.** A write that would
 *    overflow returns an error carrying the current entries, so the agent
 *    consolidates in the same turn instead of silently losing a fact.
 * 2. **Rendered with a usage header.** The injected block reports its own fill
 *    level, so the model can see it is at 90% and act before it is full.
 * 3. **Frozen snapshot.** The text is captured once per turn and injected
 *    verbatim; nothing rewrites the middle of the conversation.
 *
 * Entries are separated by `§` on their own line, matching the format Hermes
 * uses, so a memory block reads the same here as it does there.
 */

export type MemoryScope = "global" | "workspace";
/** Which store an entry lives in. */
export type MemoryTarget = "memory" | "user";

export interface MemoryEntry {
  id: string;
  text: string;
  /** Always "global" for the user profile. */
  scope: MemoryScope;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  /** Bumped each time the entry is recalled, so useful facts can be ranked. */
  hits: number;
}

/** Per-store budgets, in characters. Mirrors Hermes' limits. */
export const MEMORY_BUDGET: Record<MemoryScope, number> = { global: 2200, workspace: 2200 };
export const USER_BUDGET = 1375;

/** The separator between entries in a rendered block. */
export const ENTRY_SEP = "\n§\n";

const log = logger("memory");

/* ----------------------------------------------------------------- storage */

/**
 * Where a store lives on disk.
 *
 * The user profile is one file. The agent's notes are split by scope — and the
 * workspace half is keyed by the workspace *itself*, not shared: a fact about
 * how one project builds is noise (or a wrong instruction) in another. The key
 * is a hash of the resolved path, because a directory name is neither unique
 * nor filesystem-safe, and the readable basename is kept alongside it so the
 * file is still identifiable.
 */
function storeFile(target: MemoryTarget, scope: MemoryScope): string {
  const dir = path.join(osamaHome(), "memory");
  fs.mkdirSync(dir, { recursive: true });
  if (target === "user") return path.join(dir, "user.json");
  if (scope === "global") return path.join(dir, "global.json");
  let ws = "";
  try {
    ws = getWorkspace();
  } catch {
    /* no workspace yet — fall back to a single shared file */
  }
  if (!ws) return path.join(dir, "workspace.json");
  const key = createHash("sha1").update(ws).digest("hex").slice(0, 12);
  const label = path.basename(ws).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40) || "ws";
  return path.join(dir, `workspace-${label}-${key}.json`);
}

interface MemoryDoc {
  version: number;
  target: MemoryTarget;
  scope: MemoryScope;
  entries: MemoryEntry[];
}

function readDoc(target: MemoryTarget, scope: MemoryScope): MemoryDoc {
  const file = storeFile(target, scope);
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<MemoryDoc> & { entries?: unknown };
    if (Array.isArray(parsed.entries)) {
      const entries = (parsed.entries as unknown[]).filter(
        (e): e is MemoryEntry => Boolean(e) && typeof (e as MemoryEntry).text === "string",
      );
      // Old files predate the `target` field; infer it from the filename so a
      // store written by an earlier version keeps working.
      return { version: 2, target, scope, entries };
    }
  } catch {
    /* missing or unreadable — start clean rather than throwing at the model */
  }
  return { version: 2, target, scope, entries: [] };
}

function writeDoc(doc: MemoryDoc): void {
  const file = storeFile(doc.target, doc.scope);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

const budgetOf = (target: MemoryTarget, scope: MemoryScope): number =>
  target === "user" ? USER_BUDGET : MEMORY_BUDGET[scope];

const charsOf = (doc: MemoryDoc): number => doc.entries.reduce((n, e) => n + e.text.length, 0);

/* ------------------------------------------------------- injection guard */

/**
 * Memory goes into the system prompt, so it is an injection surface. Unlike the
 * soul, a hit here is *refused*: memory is written by the model far more often
 * than the soul is, and a fact that tries to issue instructions is not a fact.
 */
const MEMORY_REJECT: Array<{ name: string; re: RegExp }> = [
  { name: "instruction_override", re: /\b(ignore|disregard|forget)\b[^.\n]{0,30}\b(previous|prior|earlier|above|all)\b[^.\n]{0,20}\b(instruction|rule|prompt|direction)/i },
  { name: "system_prompt_override", re: /\bsystem\s*prompt\s*(override|replace|inject)/i },
  { name: "credential_exfiltration", re: /\b(curl|wget|fetch|post|upload)\b[^\n]{0,80}(\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD)|\.env\b)/i },
  { name: "invisible_unicode", re: /[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/ },
];

export function scanMemory(text: string): string[] {
  return MEMORY_REJECT.filter((p) => p.re.test(text)).map((p) => p.name);
}

/* ------------------------------------------------------------------- reads */

/** Character count for a store. */
export function memoryChars(scope: MemoryScope): number {
  return charsOf(readDoc("memory", scope));
}

export function listMemory(scope?: MemoryScope): MemoryEntry[] {
  const scopes: MemoryScope[] = scope ? [scope] : ["global", "workspace"];
  return scopes.flatMap((s) => readDoc("memory", s).entries);
}

export function listUser(): MemoryEntry[] {
  return readDoc("user", "global").entries;
}

/** Every entry in both stores, for the journey/UI view. */
export function listAll(target?: MemoryTarget, scope?: MemoryScope): MemoryEntry[] {
  if (target === "user") return listUser();
  if (target === "memory") return listMemory(scope);
  return [...listMemory(scope), ...listUser()];
}

export function getEntry(id: string): MemoryEntry | undefined {
  for (const target of ["memory", "user"] as MemoryTarget[]) {
    for (const scope of ["global", "workspace"] as MemoryScope[]) {
      if (target === "user" && scope !== "global") continue;
      const hit = readDoc(target, scope).entries.find((e) => e.id === id);
      if (hit) return hit;
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ writes */

export interface SaveResult {
  ok: boolean;
  entry?: MemoryEntry;
  error?: string;
  used?: number;
  budget?: number;
  /** Pattern names that caused a refusal, when the write was blocked. */
  findings?: string[];
}

/** Which store an entry belongs in, when the caller is unsure. */
export function inferTarget(text: string): MemoryTarget {
  // Phrases about the person go to the profile; anything else is a note.
  return /\b(user|they|their|them)\b[^.\n]{0,40}\b(prefer|likes?|wants?|dislikes?|always|never|hates?|expects?|style|tone)\b|\bprefers?\b/i.test(text)
    ? "user"
    : "memory";
}

/**
 * Add a fact. Refuses rather than overflowing the budget, and refuses text
 * that tries to issue instructions from inside the prompt.
 */
export function saveMemory(
  text: string,
  scope: MemoryScope = "global",
  tags: string[] = [],
  target: MemoryTarget = "memory",
): SaveResult {
  const clean = text.trim();
  if (!clean) return { ok: false, error: "text is required" };
  if (clean.length > 1000) return { ok: false, error: "a single memory must be under 1000 characters" };

  const findings = scanMemory(clean);
  if (findings.length) {
    return { ok: false, error: `refused: this reads like an instruction to the assistant rather than a fact (${findings.join(", ")})`, findings };
  }

  // The profile is always global.
  const effScope: MemoryScope = target === "user" ? "global" : scope;
  const doc = readDoc(target, effScope);

  // Identical text is a no-op, not a duplicate: models repeat themselves.
  const dupe = doc.entries.find((e) => e.text.toLowerCase() === clean.toLowerCase());
  if (dupe) {
    dupe.updatedAt = new Date().toISOString();
    writeDoc(doc);
    return { ok: true, entry: dupe, used: charsOf(doc), budget: budgetOf(target, effScope) };
  }

  const budget = budgetOf(target, effScope);
  const used = charsOf(doc);
  if (used + clean.length > budget) {
    return {
      ok: false,
      error:
        `the ${target === "user" ? "user profile" : `${effScope} memory`} is full (${used}/${budget} chars). ` +
        `Consolidate now: replace overlapping entries with one shorter entry, or remove a stale one, then retry.`,
      used,
      budget,
    };
  }

  const now = new Date().toISOString();
  const entry: MemoryEntry = {
    id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    text: clean,
    scope: effScope,
    tags,
    createdAt: now,
    updatedAt: now,
    hits: 0,
  };
  doc.entries.push(entry);
  writeDoc(doc);
  return { ok: true, entry, used: used + clean.length, budget };
}

/** Replace an entry found by a unique substring. Shorter, merged content. */
export function replaceMemory(selector: string, content: string, target: MemoryTarget = "memory"): SaveResult {
  const hits = findEntries(selector, target);
  if (hits.length === 0) return { ok: false, error: `no entry matched "${selector}"` };
  if (hits.length > 1) {
    return { ok: false, error: `"${selector}" matches ${hits.length} entries — give a longer, unique substring` };
  }
  const found = hits[0]!;
  const clean = content.trim();
  if (!clean) return { ok: false, error: "content is required" };

  const findings = scanMemory(clean);
  if (findings.length) return { ok: false, error: `refused: ${findings.join(", ")}`, findings };

  const doc = readDoc(found.target, found.scope);
  const entry = doc.entries.find((e) => e.id === found.id);
  if (!entry) return { ok: false, error: "the entry disappeared while replacing" };

  const budget = budgetOf(found.target, found.scope);
  const delta = clean.length - entry.text.length;
  const used = charsOf(doc);
  if (used + delta > budget) {
    return {
      ok: false,
      error: `that replacement would overflow the store (${used + delta}/${budget}). Shorten the new text, or remove another entry in the same turn.`,
      used,
      budget,
    };
  }
  entry.text = clean;
  entry.updatedAt = new Date().toISOString();
  writeDoc(doc);
  return { ok: true, entry, used: used + delta, budget };
}

/** Remove one or all entries, by id or by unique substring. */
export function forgetMemory(
  selector: string,
  scope?: MemoryScope,
  target?: MemoryTarget,
): { ok: boolean; removed: number; error?: string } {
  const sel = selector.trim();
  if (!sel) return { ok: false, removed: 0, error: "provide an id, a unique substring, or 'all' to clear everything" };

  const targets: MemoryTarget[] = target ? [target] : ["memory", "user"];
  const scopes: MemoryScope[] = scope ? [scope] : ["global", "workspace"];
  let removed = 0;

  for (const t of targets) {
    for (const s of scopes) {
      if (t === "user" && s !== "global") continue;
      const doc = readDoc(t, s);
      const before = doc.entries.length;
      const low = sel.toLowerCase();
      doc.entries =
        low === "all"
          ? []
          : doc.entries.filter((e) => e.id.toLowerCase() !== low && !e.text.toLowerCase().includes(low));
      removed += before - doc.entries.length;
      if (before !== doc.entries.length) writeDoc(doc);
    }
  }
  return { ok: removed > 0, removed, error: removed ? undefined : `no memory matched "${selector}"` };
}

/* ------------------------------------------------------------- batch (atomic) */

export interface MemoryOp {
  action: "add" | "replace" | "remove";
  /** Which store. Defaults to `memory` for add, or inferred from the selector. */
  target?: MemoryTarget;
  /** Scope for an add. Ignored for the user profile. */
  scope?: MemoryScope;
  content?: string;
  tags?: string[];
  /** Required for replace/remove: a unique substring of the target entry. */
  old_text?: string;
}

export interface BatchResult {
  ok: boolean;
  /** One line per op, in order. */
  applied: string[];
  error?: string;
  /** Entries now in the touched stores, so the caller can show live state. */
  entries?: MemoryEntry[];
}

/**
 * Apply several additions, replacements and removals as ONE operation.
 *
 * This is the move that makes a full store recoverable: the alternative is to
 * remove an entry, fail the follow-up add, and have silently destroyed a fact.
 * The result of every op is checked by simulating against copies of the docs,
 * and nothing is written unless the whole batch fits.
 */
export function applyMemoryOps(ops: MemoryOp[]): BatchResult {
  if (!Array.isArray(ops) || ops.length === 0) return { ok: false, applied: [], error: "an operations list is required" };

  // Work on copies; commit only if every op succeeds.
  const docs = new Map<string, MemoryDoc>();
  const key = (t: MemoryTarget, s: MemoryScope): string => `${t}:${t === "user" ? "global" : s}`;
  const docFor = (t: MemoryTarget, s: MemoryScope): MemoryDoc => {
    const k = key(t, s);
    let d = docs.get(k);
    if (!d) {
      d = readDoc(t, s);
      docs.set(k, d);
    }
    return d;
  };

  const applied: string[] = [];

  for (const [i, op] of ops.entries()) {
    const label = `op ${i + 1} (${op.action})`;

    if (op.action === "add") {
      const text = String(op.content ?? "").trim();
      if (!text) return { ok: false, applied, error: `${label}: content is required` };
      const target: MemoryTarget = op.target ?? "memory";
      const scope: MemoryScope = target === "user" ? "global" : (op.scope ?? "global");
      const findings = scanMemory(text);
      if (findings.length) return { ok: false, applied, error: `${label}: refused (${findings.join(", ")})` };
      if (text.length > 1000) return { ok: false, applied, error: `${label}: a single memory must be under 1000 characters` };

      const doc = docFor(target, scope);
      if (doc.entries.some((e) => e.text.toLowerCase() === text.toLowerCase())) {
        applied.push(`${label}: already present, skipped`);
        continue;
      }
      const budget = budgetOf(target, scope);
      const used = charsOf(doc);
      if (used + text.length > budget) {
        return { ok: false, applied, error: `${label}: ${used}/${budget} chars — that would overflow. Free room with a remove/replace in this same call.` };
      }
      const now = new Date().toISOString();
      doc.entries.push({
        id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        text,
        scope,
        tags: Array.isArray(op.tags) ? op.tags.map(String) : [],
        createdAt: now,
        updatedAt: now,
        hits: 0,
      });
      applied.push(`${label}: added to ${target === "user" ? "user profile" : `${scope} memory`}`);
      continue;
    }

    // replace / remove need a unique selector
    const sel = String(op.old_text ?? "").trim();
    if (!sel) return { ok: false, applied, error: `${label}: old_text is required` };
    const found = findEntries(sel, op.target);
    if (found.length === 0) return { ok: false, applied, error: `${label}: nothing matched "${sel}"` };
    if (found.length > 1) {
      return { ok: false, applied, error: `${label}: "${sel}" matches ${found.length} entries — use a longer, unique substring` };
    }
    const hit = found[0]!;
    const doc = docFor(hit.target, hit.scope);
    const idx = doc.entries.findIndex((e) => e.id === hit.id);
    if (idx < 0) return { ok: false, applied, error: `${label}: the entry vanished mid-batch` };

    if (op.action === "remove") {
      doc.entries.splice(idx, 1);
      applied.push(`${label}: removed from ${hit.target === "user" ? "user profile" : `${hit.scope} memory`}`);
      continue;
    }

    const clean = String(op.content ?? "").trim();
    if (!clean) return { ok: false, applied, error: `${label}: content is required` };
    const findings = scanMemory(clean);
    if (findings.length) return { ok: false, applied, error: `${label}: refused (${findings.join(", ")})` };

    const budget = budgetOf(hit.target, hit.scope);
    const used = charsOf(doc);
    const delta = clean.length - doc.entries[idx]!.text.length;
    if (used + delta > budget) {
      return { ok: false, applied, error: `${label}: the replacement would overflow ${used + delta}/${budget} chars` };
    }
    doc.entries[idx]!.text = clean;
    doc.entries[idx]!.updatedAt = new Date().toISOString();
    applied.push(`${label}: replaced in ${hit.target === "user" ? "user profile" : `${hit.scope} memory`}`);
  }

  // Everything succeeded — commit.
  for (const doc of docs.values()) writeDoc(doc);
  log.info(`applied ${ops.length} memory op(s)`);
  const touched = [...docs.values()].flatMap((d) => d.entries);
  return { ok: true, applied, entries: touched };
}

interface Found extends MemoryEntry {
  target: MemoryTarget;
}

/** Find entries by id or unique lowercase substring, across the requested stores. */
function findEntries(selector: string, target?: MemoryTarget): Found[] {
  const sel = selector.trim().toLowerCase();
  const out: Found[] = [];
  const targets: MemoryTarget[] = target ? [target] : ["memory", "user"];
  for (const t of targets) {
    for (const s of ["global", "workspace"] as MemoryScope[]) {
      if (t === "user" && s !== "global") continue;
      for (const e of readDoc(t, s).entries) {
        if (e.id.toLowerCase() === sel || e.text.toLowerCase().includes(sel)) out.push({ ...e, target: t });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ recall */

/** Recall by keyword; a blank query returns everything, most-used first. */
export function recallMemory(query = "", scope?: MemoryScope): MemoryEntry[] {
  const all = listAll();
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
  for (const t of ["memory", "user"] as MemoryTarget[]) {
    for (const s of ["global", "workspace"] as MemoryScope[]) {
      if (t === "user" && s !== "global") continue;
      const doc = readDoc(t, s);
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
}

/* ------------------------------------------------------------- rendering */

export interface StoreFill {
  entries: number;
  chars: number;
  budget: number;
  /** 0..1 */
  pressure: number;
}

export interface MemoryStats {
  total: number;
  byScope: Record<MemoryScope, number>;
  byTarget: Record<MemoryTarget, number>;
  chars: Record<MemoryScope, number>;
  budget: Record<MemoryScope, number>;
  user: StoreFill;
  /** Per-store fill, for the UI panel and the context_status tool. */
  fills: Array<{ target: MemoryTarget; scope: MemoryScope; label: string; entries: number; chars: number; budget: number; pressure: number }>;
}

export function memoryStats(): MemoryStats {
  const scopes: MemoryScope[] = ["global", "workspace"];
  const byScope = {} as Record<MemoryScope, number>;
  const chars = {} as Record<MemoryScope, number>;
  for (const s of scopes) {
    const entries = readDoc("memory", s).entries;
    byScope[s] = entries.length;
    chars[s] = entries.reduce((n, e) => n + e.text.length, 0);
  }
  const userEntries = listUser();
  const userChars = userEntries.reduce((n, e) => n + e.text.length, 0);
  const user: StoreFill = {
    entries: userEntries.length,
    chars: userChars,
    budget: USER_BUDGET,
    pressure: USER_BUDGET ? userChars / USER_BUDGET : 0,
  };
  return {
    total: byScope.global + byScope.workspace + user.entries,
    byScope,
    byTarget: { memory: byScope.global + byScope.workspace, user: user.entries },
    chars,
    budget: { ...MEMORY_BUDGET },
    user,
    fills: [
      ...scopes.map((s) => ({
        target: "memory" as MemoryTarget,
        scope: s,
        label: s === "global" ? "Memory" : "Workspace memory",
        entries: byScope[s],
        chars: chars[s],
        budget: MEMORY_BUDGET[s],
        pressure: MEMORY_BUDGET[s] ? chars[s] / MEMORY_BUDGET[s] : 0,
      })),
      { target: "user" as MemoryTarget, scope: "global" as MemoryScope, label: "User profile", entries: user.entries, chars: user.chars, budget: USER_BUDGET, pressure: user.pressure },
    ],
  };
}

const bar = (pressure: number): string => {
  const shown = Math.round(Math.min(1, Math.max(0, pressure)) * 100);
  return `${shown}%`;
};

/**
 * The always-injected memory block.
 *
 * Reports its own fill level in the header (so the model can see it is nearly
 * full and consolidate) and names what it clipped rather than silently dropping
 * facts. Ordered most-relevant-first: a query boosts matching entries, so recall
 * follows the conversation rather than insertion order, and workspace facts lead
 * because they describe where the agent is working right now.
 */
export function memoryBlock(maxChars = 3000, query?: string): string {
  const stats = memoryStats();
  if (stats.total === 0) return "";

  /** Order one store's entries: relevant first, then most-recalled. */
  const orderStore = (entries: MemoryEntry[]): MemoryEntry[] => {
    const q = query?.trim().toLowerCase() ?? "";
    const terms = q.split(/\s+/).filter(Boolean);
    return [...entries].sort((a, b) => {
      if (terms.length) {
        const score = (e: MemoryEntry): number => {
          const hay = `${e.text} ${e.tags.join(" ")}`.toLowerCase();
          return terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
        };
        const d = score(b) - score(a);
        if (d) return d;
      }
      return b.hits - a.hits || b.updatedAt.localeCompare(a.updatedAt);
    });
  };

  // Workspace notes describe the current folder, so they come before global ones.
  const noteEntries = [...listMemory("workspace"), ...listMemory("global")];
  const profileEntries = listUser();

  const stores: Array<{ label: string; entries: MemoryEntry[]; budget: number; tagWs: boolean }> = [
    { label: "MEMORY (your personal notes)", entries: orderStore(noteEntries), budget: MEMORY_BUDGET.global, tagWs: true },
    { label: "USER PROFILE (who the user is)", entries: orderStore(profileEntries), budget: USER_BUDGET, tagWs: false },
  ];

  const sections: string[] = [];
  let budgetLeft = maxChars;
  let shown = 0;

  for (const store of stores) {
    if (!store.entries.length) continue;
    // Take as many as fit in both the store's own budget and the block budget.
    const visible: MemoryEntry[] = [];
    let storeChars = 0;
    let blockChars = budgetLeft;
    for (const e of store.entries) {
      const cost = e.text.length + (visible.length ? ENTRY_SEP.length : 0) + (store.tagWs && e.scope === "workspace" ? 12 : 0);
      if (storeChars + cost > store.budget || blockChars - cost < 0) break;
      visible.push(e);
      storeChars += cost;
      blockChars -= cost;
    }
    if (!visible.length) break;

    const chars = visible.reduce((n, e) => n + e.text.length, 0);
    const head = `${store.label} [${bar(store.budget ? chars / store.budget : 0)} — ${chars}/${store.budget} chars]`;
    const body = visible
      .map((e) => `${e.text}${store.tagWs && e.scope === "workspace" ? " [workspace]" : ""}`)
      .join(ENTRY_SEP);
    const text = `${head}\n${"═".repeat(46)}\n${body}`;
    sections.push(text);
    budgetLeft -= text.length;
    shown += visible.length;
    if (budgetLeft <= 0) break;
  }

  const hidden = stats.total - shown;
  if (hidden > 0) sections.push(`… and ${hidden} more saved fact(s) — call recall_memory to list them`);
  return sections.join("\n\n");
}
