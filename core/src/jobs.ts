import { recordRun, dueJobs, listJobs, type JobRun } from "./scheduler.js";
import { runAgent, type AgentEvent, type AgentTransport, type ApprovalPolicy } from "./agent.js";
import { memoryBlock } from "./memory.js";

/**
 * The runner: fires due scheduled jobs and records the result.
 *
 * `fireOne` runs a single job against a transport (typically the same SSE
 * proxy the chat uses) and writes a `JobRun` to the job's history. It does
 * NOT loop on its own — `tickDue` is the scheduler that wakes periodically
 * and decides what to fire next.
 *
 * Jobs created with approval='deny' get a no-op approval policy; 'ask' goes
 * through the supplied `ask` hook (server uses an in-memory queue); 'auto'
 * approves everything. The runner itself never blocks on a real network
 * connection.
 */

export interface FireInput {
  jobId: string;
  transport: AgentTransport;
  model: string;
  /** Workspace to run the agent in — typically the user's chosen workspace. */
  workspace: string;
  /** Approval hook for mutating commands (run_command). */
  approve: ApprovalPolicy;
  /** Optional ask_user_question hook. */
  askUser?: (q: { id: string; question: string; options?: string[] }, ms: number) => Promise<string | null>;
  signal?: AbortSignal;
}

export async function fireOne(input: FireInput): Promise<JobRun | null> {
  const jobs = listJobs();
  const job = jobs.find((j) => j.id === input.jobId);
  if (!job) return null;

  const started = Date.now();
  let text = "";
  try {
    const events: AgentEvent[] = [];
    for await (const ev of runAgent({
      transport: input.transport,
      model: input.model,
      history: [{ role: "user", content: job.prompt }],
      system: `You are running as a scheduled job named "${job.name}". Do the task, then give a short final summary.`,
      workspace: input.workspace,
      // Job-level approval goes through the same approval policy as chat;
      // the per-job 'ask'/'auto'/'deny' setting governs how mutating tools
      // are treated — it is applied by the caller wiring the policy.
      approval: input.approve,
      askUser: input.askUser,
      // No askUser for jobs by default — a job can ask_user_question, but
      // only if the host wires it. We don't block forever on an offline user.
      maxSteps: 8,
      injectMemory: true,
      injectSkills: true,
    })) {
      events.push(ev);
      if (ev.type === "final") text = ev.text;
      if (ev.type === "error") {
        throw new Error(ev.message);
      }
    }
    const run: JobRun = {
      at: new Date().toISOString(),
      status: "ok",
      durationMs: Date.now() - started,
      summary: text.slice(0, 200).replace(/\s+/g, " ").trim() || "(no output)",
      error: null,
    };
    recordRun(job.id, run);
    return run;
  } catch (e) {
    const run: JobRun = {
      at: new Date().toISOString(),
      status: "error",
      durationMs: Date.now() - started,
      summary: null,
      error: (e as Error).message,
    };
    recordRun(job.id, run);
    return run;
  }
}

export interface TickInput {
  transport: AgentTransport;
  model: string;
  workspace: string;
  approve: ApprovalPolicy;
  askUser?: FireInput["askUser"];
}

/**
 * Fire all jobs whose next-run is past. Returns the runs that were fired.
 *
 * Called by the server's periodic timer; safe to call often — jobs that are
 * already running (status === 'running') are skipped here (the per-job server
 * path marks them).
 */
export async function tickDue(input: TickInput): Promise<JobRun[]> {
  const due = dueJobs();
  const runs: JobRun[] = [];
  for (const j of due) {
    const run = await fireOne({ jobId: j.id, ...input });
    if (run) runs.push(run);
  }
  return runs;
}

/** Compose the system-prompt prelude a job sees: same memory + scheduler context the chat does. */
export function jobSystemPrelude(): string {
  const mem = memoryBlock();
  return mem ? `<memory>\n${mem}\n</memory>\n\n` : "";
}