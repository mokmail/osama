import { identityBlock } from "./soul.js";
import { memoryBlock, memoryStats, type MemoryStats } from "./memory.js";
import { schedulerBlock } from "./scheduler.js";
import { skillsBlock } from "./tools.js";
import { loadSkill } from "./skills.js";
import { workspaceSnapshot } from "./workspace.js";

/**
 * The system prompt, assembled in the order it matters.
 *
 * This is the Hermes prompt stack, ported:
 *
 *   1. identity        — SOUL.md (+ a session personality overlay). Slot #1:
 *                        it REPLACES the default identity rather than adding to
 *                        it, which is what makes it load-bearing.
 *   2. tool guidance    — how to use tools well (working rules).
 *   3. memory           — the agent's notes and the user profile, as a frozen,
 *                        self-describing block.
 *   4. skills           — the catalog, plus any skill the user switched on.
 *   5. project context  — the workspace the agent is working inside.
 *   6. environment      — the scheduler's recurring work, and the clock.
 *
 * The ordering is not cosmetic. Identity first means a later block cannot
 * accidentally *become* the personality; memory before skills means the agent
 * knows who it is talking to before it decides what procedure to apply; the
 * timestamp last keeps everything above it stable across turns, which preserves
 * the model's prompt cache.
 *
 * Every section is optional and independently suppressible, so callers (a
 * subagent, a focused utility call) can build exactly the prompt they need
 * without growing a second implementation.
 */

export interface PromptParts {
  /** Caller-supplied system text. Becomes part of the identity section. */
  system?: string;
  /** Session personality overlay id (see soul.ts). */
  personality?: string;
  /** Include the identity section. Always on in practice; off for raw calls. */
  identity?: boolean;
  /** Include tool working-rules. Only meaningful when tools are exposed. */
  toolRules?: boolean;
  /** Include memory + user profile. */
  memory?: boolean;
  /** Include the skill catalog and active skill bodies. */
  skills?: boolean;
  /** Skill ids the user switched on for this session. */
  activeSkills?: string[];
  /** Include the workspace snapshot. */
  workspace?: boolean;
  /** Include the scheduler's recurring jobs. */
  scheduler?: boolean;
  /** Include a timestamp line. Off by default — it breaks prompt caching if it
   *  changes every turn, so it is opt-in for callers that need it. */
  timestamp?: boolean;
  /** Extra blocks a caller wants appended verbatim, in order. */
  extra?: string[];
}

export interface BuiltPrompt {
  /** The assembled system prompt, ready to put in the `system` role. */
  prompt: string;
  /** Which sections actually contributed, in order — for the UI's inspector. */
  sections: Array<{ name: string; chars: number; tokens: number | null }>;
  /** Live memory fill, so a caller can show it without a second read. */
  memory: MemoryStats;
}

/** A rough token estimate, used only for the inspector's proportions. */
const approxTokens = (s: string): number => Math.ceil(s.length / 4);

/**
 * Build the system prompt.
 *
 * Returns the section breakdown alongside the text so the UI can show the user
 * exactly what the model is being told and in what order — the prompt is the
 * agent's behaviour, so it should be inspectable rather than a black box.
 */
export function buildPrompt(parts: PromptParts = {}): BuiltPrompt {
  const sections: Array<{ name: string; body: string }> = [];
  const push = (name: string, body: string): void => {
    const t = body.trim();
    if (t) sections.push({ name, body: t });
  };

  // 1. Identity — soul (+ overlay) and any caller system text.
  if (parts.identity !== false) {
    const soul = identityBlock(parts.personality);
    const caller = parts.system?.trim();
    // The caller's text is a brief, not a replacement identity: it follows the
    // soul so it refines behaviour instead of overwriting who the agent is.
    push("identity", caller ? `${soul}\n\n${caller}` : soul);
  }

  // 2. Tool guidance.
  if (parts.toolRules) {
    push("tool rules", orchestrationRules());
  }

  // 3. Memory + user profile.
  if (parts.memory !== false) {
    const lastUserHint = undefined; // relevance comes from the caller's query
    const block = memoryBlock(3000, lastUserHint);
    if (block) {
      push(
        "memory",
        `<memory>\nWhat you already know, from what was saved earlier. Treat these as established — do not re-ask:\n\n${block}\n</memory>`,
      );
    }
  }

  // 4. Skills — activated bodies first, then the catalog.
  if (parts.skills !== false) {
    const active = (parts.activeSkills ?? []).map((s) => String(s).trim()).filter(Boolean);
    const loaded: string[] = [];
    const missing: string[] = [];
    for (const id of active) {
      const sk = loadSkillBody(id);
      if (sk) loaded.push(sk);
      else missing.push(id);
    }
    if (loaded.length) {
      push(
        "active skills",
        `<active_skills>\nThe user activated these for this conversation. Follow them. When they conflict, the one listed later wins.\n\n${loaded.join("\n\n---\n\n")}\n</active_skills>`,
      );
    }
    if (missing.length) push("active skills note", `<active_skills_note>\nCould not load: ${missing.join(", ")}\n</active_skills_note>`);

    const cat = skillsBlock();
    if (cat && cat !== "(no skills installed)") {
      push("skill catalog", `<skills>\nLoad one with load_skill before acting on a task it matches:\n${cat}\n</skills>`);
    }
  }

  // 5. Project context — the workspace.
  if (parts.workspace !== false) {
    const snap = workspaceSnapshot(600);
    push(
      "workspace",
      `<workspace>\nYou are running inside this directory. Read or write files relative to it (or give absolute paths).\n${snap}\n</workspace>`,
    );
  }

  // 6. Environment — recurring work, and the clock when asked for.
  if (parts.scheduler) {
    const sched = schedulerBlock(400);
    if (sched) {
      push(
        "scheduler",
        `<scheduler>\nRecurring jobs the user configured. They run automatically against this same agent; use list_jobs / create_job / set_job / delete_job / job_history to manage them.\n${sched}\n</scheduler>`,
      );
    }
  }
  if (parts.timestamp) push("clock", `<clock>\n${new Date().toISOString()}\n</clock>`);

  for (const e of parts.extra ?? []) push("extra", e);

  const prompt = sections.map((s) => s.body).join("\n\n");
  return {
    prompt,
    sections: sections.map((s) => ({ name: s.name, chars: s.body.length, tokens: approxTokens(s.body) })),
    memory: memoryStats(),
  };
}

/* ------------------------------------------------------------- helpers */

/** Load a skill's body with its name, or null when it cannot be read. */
function loadSkillBody(id: string): string | null {
  const sk = loadSkill(id);
  if (!sk || !sk.body) return null;
  return `### ${sk.name || sk.id}\n${sk.body.trim()}`;
}

/**
 * The working rules. Ported from the harness discipline: batch independent
 * calls, trust tool results over plans, verify before declaring done — plus the
 * file-and-script workflow that makes real work in a workspace possible.
 */
export function orchestrationRules(): string {
  return [
    "How to work:",
    "- Orient before acting: on an unfamiliar task use tree/glob/grep to find the right files, then file_info before read_file on anything large.",
    "- Batch independent tool calls in one turn instead of round-tripping serially (reads first, writes after).",
    "- Tool results are authoritative: if a result contradicts your plan, adapt — never claim a step succeeded without a result showing it.",
    "- Before saying a task is done, re-check it against every requirement; if verification is cheap (reading back a file you wrote, recomputing a number), do it.",
    "- If a tool fails, change the approach rather than repeating the same call.",
    "- Save a fact to memory when it will still matter later — a preference, a constraint, a decision. Not for task progress.",
    "- Hand a self-contained subtask to a subagent with delegate_task; give it everything it needs and return only its report.",
    "",
    "Working with files and scripts:",
    "- Prefer real files over pasted text. When asked to produce a document, config, dataset or program, write it into the workspace with write_file so it persists and can be re-opened.",
    "- When a task needs more than a one-line command — a build step, data transform, batch rename, parser, or anything you might run twice — write a script with write_script and run it, rather than a giant inline command. Scripts are reviewable, re-runnable and easy to fix.",
    "- For a mechanical change across many files (a rename, a repeated edit), use replace_in_files in dry-run first, confirm the hits, then run it for real. Do not edit dozens of files one-by-one.",
    "- Use edit_file for a targeted change to one file; it fails loudly if the text is missing or ambiguous, so include enough surrounding context to be unique.",
    "- Use manage_file for copy, move, mkdir and delete. Never shell out to `rm`/`mv` for these.",
    "- Paths are relative to the workspace; absolute paths are accepted only inside the allowed roots.",
  ].join("\n");
}
