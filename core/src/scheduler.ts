import fs from "node:fs";
import path from "node:path";
import { osamaHome } from "./paths.js";

/**
 * Scheduled jobs — recurring prompts the agent runs on a cadence.
 *
 * A job = a prompt + the model endpoint + how often + the approval policy +
 * whether it's enabled. Jobs are persisted as plain JSON under `.osama/jobs/`,
 * one file per job (small, no migrations). They share the agentic loop the
 * chat uses, so a scheduled job has access to the same tools, memory and skills
 * the user has when chatting.
 *
 * Jobs execute in the Node process that hosts the engine; a brief tick-loop
 * wakes every 30 s and fires anything whose next-run is past. Missed runs are
 * collapsed (we fire once, not N times) — a daily job that was off for two
 * days fires once on Monday, not 36 times.
 */

export type JobApproval = "ask" | "auto" | "deny";

export interface ScheduledJob {
  id: string;
  name: string;
  prompt: string;
  /** Either a workspace id (for the agent to read the cwd) or free-form. */
  workspace?: string;
  /** Minutes between runs. Cadences >= 5 minutes. */
  intervalMin: number;
  /** User-defined tags, surfaced in the scheduler UI. */
  tags: string[];
  approval: JobApproval;
  enabled: boolean;
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
  /** Last successful fire; used for the "next run in" hint. */
  lastRunAt: string | null;
  /** Next scheduled fire (ISO). Recomputed on save/enable/disable and after a fire. */
  nextRunAt: string;
  /** Result of the last fire. */
  lastStatus: "idle" | "running" | "ok" | "error" | "denied" | null;
  lastError: string | null;
  lastSummary: string | null;
  /** Append-only ring of the most recent runs (newest first). */
  history: JobRun[];
}

export interface JobRun {
  at: string;
  status: "ok" | "error" | "denied";
  durationMs: number;
  /** Short human caption from the final assistant message. */
  summary: string | null;
  error: string | null;
}

export const MIN_INTERVAL_MIN = 5;
export const MAX_INTERVAL_MIN = 60 * 24 * 30; // 30 days
export const TICK_MS = 30 * 1000;
export const MAX_HISTORY = 30;

function jobsDir(): string {
  const dir = path.join(osamaHome(), "jobs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function jobFile(id: string): string {
  return path.join(jobsDir(), `${id}.json`);
}

export function listJobs(): ScheduledJob[] {
  let names: string[] = [];
  try { names = fs.readdirSync(jobsDir()); } catch { return []; }
  const jobs: ScheduledJob[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      const raw = fs.readFileSync(path.join(jobsDir(), n), "utf8");
      const job = JSON.parse(raw) as ScheduledJob;
      if (job && job.id) jobs.push(job);
    } catch {
      /* skip corrupt files — never crash the tick loop */
    }
  }
  return jobs.sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
}

export function getJob(id: string): ScheduledJob | null {
  try {
    return JSON.parse(fs.readFileSync(jobFile(id), "utf8")) as ScheduledJob;
  } catch {
    return null;
  }
}

export function deleteJob(id: string): boolean {
  try {
    fs.unlinkSync(jobFile(id));
    return true;
  } catch {
    return false;
  }
}

function genId(): string {
  return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function nextRunAfter(now: Date, intervalMin: number): string {
  const t = new Date(now.getTime() + Math.max(MIN_INTERVAL_MIN, intervalMin) * 60_000);
  return t.toISOString();
}

export interface CreateJobInput {
  name: string;
  prompt: string;
  workspace?: string;
  intervalMin: number;
  tags?: string[];
  approval?: JobApproval;
}

export function createJob(input: CreateJobInput): { ok: boolean; job?: ScheduledJob; error?: string } {
  const name = (input.name || "").trim().slice(0, 80);
  const prompt = (input.prompt || "").trim();
  if (!name) return { ok: false, error: "name is required" };
  if (!prompt) return { ok: false, error: "prompt is required" };
  if (prompt.length > 4000) return { ok: false, error: "prompt must be under 4000 characters" };
  const iv = Math.max(MIN_INTERVAL_MIN, Math.min(MAX_INTERVAL_MIN, Math.floor(input.intervalMin)));
  const now = new Date();
  const job: ScheduledJob = {
    id: genId(),
    name,
    prompt,
    workspace: input.workspace,
    intervalMin: iv,
    tags: (input.tags ?? []).slice(0, 8),
    approval: input.approval ?? "auto",
    enabled: true,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    lastRunAt: null,
    nextRunAt: nextRunAfter(now, iv),
    lastStatus: "idle",
    lastError: null,
    lastSummary: null,
    history: [],
  };
  try {
    fs.writeFileSync(jobFile(job.id), JSON.stringify(job, null, 2));
    return { ok: true, job };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export interface UpdateJobInput {
  name?: string;
  prompt?: string;
  workspace?: string | null;
  intervalMin?: number;
  tags?: string[];
  approval?: JobApproval;
  enabled?: boolean;
}

export function updateJob(id: string, patch: UpdateJobInput): { ok: boolean; job?: ScheduledJob; error?: string } {
  const cur = getJob(id);
  if (!cur) return { ok: false, error: "no such job" };
  if (patch.name !== undefined) cur.name = patch.name.trim().slice(0, 80);
  if (patch.prompt !== undefined) {
    const p = patch.prompt.trim();
    if (!p) return { ok: false, error: "prompt is required" };
    if (p.length > 4000) return { ok: false, error: "prompt must be under 4000 characters" };
    cur.prompt = p;
  }
  if (patch.workspace !== undefined) cur.workspace = patch.workspace ?? undefined;
  if (patch.intervalMin !== undefined) {
    const iv = Math.max(MIN_INTERVAL_MIN, Math.min(MAX_INTERVAL_MIN, Math.floor(patch.intervalMin)));
    cur.intervalMin = iv;
    if (!cur.lastRunAt) cur.nextRunAt = nextRunAfter(new Date(), iv);
    else cur.nextRunAt = new Date(new Date(cur.lastRunAt).getTime() + iv * 60_000).toISOString();
  }
  if (patch.tags !== undefined) cur.tags = patch.tags.slice(0, 8);
  if (patch.approval !== undefined) cur.approval = patch.approval;
  if (patch.enabled !== undefined) {
    cur.enabled = patch.enabled;
    if (cur.enabled && new Date(cur.nextRunAt).getTime() <= Date.now()) {
      cur.nextRunAt = nextRunAfter(new Date(), cur.intervalMin);
    }
  }
  cur.updatedAt = new Date().toISOString();
  try {
    fs.writeFileSync(jobFile(cur.id), JSON.stringify(cur, null, 2));
    return { ok: true, job: cur };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function recordRun(id: string, run: JobRun): { ok: boolean; job?: ScheduledJob; error?: string } {
  const cur = getJob(id);
  if (!cur) return { ok: false, error: "no such job" };
  cur.lastRunAt = run.at;
  cur.lastStatus = run.status;
  cur.lastError = run.error;
  cur.lastSummary = run.summary;
  cur.history = [run, ...cur.history].slice(0, MAX_HISTORY);
  // Recompute next-run from now (NOT from lastRunAt): the user sees the
  // schedule as "every N minutes after the run actually happened" — easier to
  // reason about than "N minutes after the run *should* have happened".
  cur.nextRunAt = nextRunAfter(new Date(), cur.intervalMin);
  cur.updatedAt = new Date().toISOString();
  try {
    fs.writeFileSync(jobFile(cur.id), JSON.stringify(cur, null, 2));
    return { ok: true, job: cur };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Jobs whose `nextRunAt` is in the past. Side-effect-free: read-only filter. */
export function dueJobs(now = new Date()): ScheduledJob[] {
  return listJobs().filter((j) => j.enabled && new Date(j.nextRunAt).getTime() <= now.getTime());
}

/**
 * Short, plain-text summary of the scheduler state, used in the agent's system
 * prompt — it should know what recurring work the user has scheduled without
 * needing to call a tool first.
 */
export function schedulerBlock(maxChars = 600): string {
  const jobs = listJobs();
  if (jobs.length === 0) return "";
  const lines = jobs.slice(0, 12).map((j) => {
    const tag = j.enabled ? "" : " (disabled)";
    const next = new Date(j.nextRunAt).toLocaleString();
    return `- ${j.name}: every ${j.intervalMin}m, next ${next}${tag}`;
  });
  const out = lines.join("\n");
  if (out.length > maxChars) return out.slice(0, maxChars - 1) + "…";
  return out;
}

/**
 * The recent run history of one job as plain text — for the job_history tool.
 * Capped by `limit`.
 */
export function jobHistoryBlock(id: string, limit = 10): string {
  const job = getJob(id);
  if (!job) return "";
  const rows = job.history.slice(0, limit).map((r) => {
    const at = new Date(r.at).toLocaleString();
    return `- ${at} · ${r.status}${r.durationMs ? ` · ${r.durationMs}ms` : ""}${r.summary ? `\n  ${r.summary}` : ""}${r.error ? `\n  error: ${r.error}` : ""}`;
  });
  return rows.join("\n");
}