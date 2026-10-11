import {
  createJob, deleteJob, getJob, jobHistoryBlock, listJobs, updateJob,
  MIN_INTERVAL_MIN, type JobApproval, type ScheduledJob,
} from "../scheduler.js";
import type { ExecOptions, ToolContext, ToolResult } from "./spec.js";

/* ----------------------------------------------------------- scheduler tools */

function fmtJobLine(j: ScheduledJob): string {
  const last = j.lastRunAt ? new Date(j.lastRunAt).toLocaleString() : "never";
  const next = new Date(j.nextRunAt).toLocaleString();
  const status = j.lastStatus ?? "idle";
  return `${j.id}  "${j.name}"  every ${j.intervalMin}m  next=${next}  last=${last} (${status})`;
}

/** Dispatch the scheduler tools. Pure (does not need onCommand — scheduler has its own approval). */
export async function executeSchedulerTool(
  name: string,
  args: Record<string, unknown>,
  // Approval hook — when the policy is 'ask' we block until the UI decides.
  ask?: (q: { command: string }) => Promise<boolean>,
): Promise<ToolResult> {
  switch (name) {
    case "list_jobs": {
      const jobs = listJobs();
      if (!jobs.length) return { ok: true, content: "(no scheduled jobs)", summary: "0 jobs" };
      const body = jobs.map(fmtJobLine).join("\n");
      return { ok: true, content: body, summary: `${jobs.length} job(s)` };
    }

    case "create_job": {
      const jobName = String(args.name ?? "").trim();
      const prompt = String(args.prompt ?? "").trim();
      const iv = Math.floor(Number(args.intervalMin ?? 0));
      const approval = (args.approval === "ask" || args.approval === "auto" || args.approval === "deny") ? args.approval : "auto";
      const tags = Array.isArray(args.tags) ? (args.tags as unknown[]).map(String) : [];
      if (!jobName || !prompt || !iv) {
        return { ok: false, content: "name, prompt and intervalMin are required", summary: "missing fields" };
      }
      if (iv < MIN_INTERVAL_MIN) {
        return { ok: false, content: `cadence must be at least ${MIN_INTERVAL_MIN} minutes`, summary: "too often" };
      }
      if (ask) {
        const ok = await ask({ command: `create scheduled job "${jobName}" (every ${iv}m)` });
        if (!ok) return { ok: false, content: "the user denied creating this job", summary: "denied by user" };
      }
      const r = createJob({ name: jobName, prompt, intervalMin: iv, approval, tags });
      if (!r.ok || !r.job) return { ok: false, content: r.error ?? "could not create job", summary: "refused" };
      return { ok: true, content: `created job ${r.job.id} — next fire ${r.job.nextRunAt}`, summary: `created ${r.job.name}` };
    }

    case "delete_job": {
      const id = String(args.id ?? "").trim();
      if (!id) return { ok: false, content: "id is required", summary: "no id" };
      const job = getJob(id);
      if (!job) return { ok: false, content: `no job with id "${id}"`, summary: "unknown job" };
      if (ask) {
        const ok = await ask({ command: `delete scheduled job "${job.name}"` });
        if (!ok) return { ok: false, content: "the user denied deleting this job", summary: "denied by user" };
      }
      const removed = deleteJob(id);
      return { ok: removed, content: removed ? `removed ${job.name}` : "could not remove the job file", summary: removed ? `removed ${job.name}` : "delete failed" };
    }

    case "set_job": {
      const id = String(args.id ?? "").trim();
      if (!id) return { ok: false, content: "id is required", summary: "no id" };
      const job = getJob(id);
      if (!job) return { ok: false, content: `no job with id "${id}"`, summary: "unknown job" };
      const patch: Parameters<typeof updateJob>[1] = {};
      if (typeof args.name === "string") patch.name = args.name;
      if (typeof args.prompt === "string") patch.prompt = args.prompt;
      if (typeof args.intervalMin === "number") patch.intervalMin = args.intervalMin;
      if (args.approval === "ask" || args.approval === "auto" || args.approval === "deny") patch.approval = args.approval;
      if (typeof args.enabled === "boolean") patch.enabled = args.enabled;
      if (Array.isArray(args.tags)) patch.tags = (args.tags as unknown[]).map(String);
      if (Object.keys(patch).length === 0) return { ok: false, content: "nothing to change", summary: "no-op" };
      if (ask) {
        const ok = await ask({ command: `change scheduled job "${job.name}"` });
        if (!ok) return { ok: false, content: "the user denied changing this job", summary: "denied by user" };
      }
      const r = updateJob(id, patch);
      if (!r.ok || !r.job) return { ok: false, content: r.error ?? "could not update job", summary: "refused" };
      return { ok: true, content: `updated ${r.job.name} — next fire ${r.job.nextRunAt}`, summary: `updated ${r.job.name}` };
    }

    case "job_history": {
      const id = String(args.id ?? "").trim();
      if (!id) return { ok: false, content: "id is required", summary: "no id" };
      const limit = Math.max(1, Math.min(50, Math.floor(Number(args.limit ?? 10)) || 10));
      const block = jobHistoryBlock(id, limit);
      const job = getJob(id);
      if (!job) return { ok: false, content: `no job with id "${id}"`, summary: "unknown job" };
      if (!block) return { ok: true, content: `${job.name}: no runs yet`, summary: "0 runs" };
      return { ok: true, content: `${job.name} — last ${limit} run(s):\n${block}`, summary: `${job.history.length} run(s)` };
    }

    default:
      return { ok: false, content: `scheduler tool ${name} is not implemented`, summary: "not implemented" };
  }
}
