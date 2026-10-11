import { osamaHome } from "../paths.js";
import { describeBreakdown, measureContext, type ChatMessage, type Meter } from "../context.js";
import { discoverSkills, loadSkill, skillCatalog, skillRoots } from "../skills.js";
import {
  applyMemoryOps, forgetMemory, inferTarget, listAll, listUser, markRecalled,
  memoryBlock, memoryStats, recallMemory, saveMemory,
} from "../memory.js";
import { writeSoul } from "../soul.js";
import { listSessions, readSession } from "../sessions.js";
import { delegateConcurrent } from "../orchestr.js";
import type { AgentToolSpec, ExecOptions, TodoItem, ToolContext, ToolResult } from "./spec.js";
import { QUESTION_TIMEOUT_MS } from "./spec.js";

/** Execute a tool that depends on session state rather than the filesystem. */
export async function executeContextTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "write_todo": {
        const raw = Array.isArray(args.todos) ? args.todos : [];
        const todos: TodoItem[] = [];
        for (const t of raw) {
          const content = String((t as any)?.content ?? "").trim();
          const status = String((t as any)?.status ?? "pending");
          if (!content) continue;
          if (status !== "pending" && status !== "in_progress" && status !== "completed") continue;
          todos.push({ content, status });
        }
        if (!todos.length) return { ok: false, content: "todos must be a non-empty list of {content, status}", summary: "empty list" };
        const active = todos.filter((t) => t.status === "in_progress").length;
        if (ctx.todos) {
          ctx.todos.length = 0;
          ctx.todos.push(...todos);
        }
        const done = todos.filter((t) => t.status === "completed").length;
        return {
          ok: true,
          content: todos.map((t) => `[${t.status === "completed" ? "x" : t.status === "in_progress" ? ">" : " "}] ${t.content}`).join("\n"),
          summary: `${done}/${todos.length} done${active > 1 ? `, ${active} in progress` : ""}`,
        };
      }

      case "list_skills": {
        const skills = discoverSkills();
        return {
          ok: true,
          content: skills.length
            ? skills.map((s) => `${s.id}: ${s.description || s.name}`).join("\n")
            : "(no skills installed)",
          summary: `${skills.length} skill(s)`,
        };
      }

      case "load_skill": {
        const id = String(args.name ?? "").trim();
        if (!id) return { ok: false, content: "name is required", summary: "no name" };
        const skill = loadSkill(id);
        if (!skill) {
          const available = discoverSkills().map((s) => s.id);
          return {
            ok: false,
            content: `no skill named "${id}". Available: ${available.join(", ") || "none"}`,
            summary: "unknown skill",
          };
        }
        const files = skill.files.length ? `\n\nSupporting files: ${skill.files.join(", ")}` : "";
        return {
          ok: true,
          content: `${skill.body.trim()}${files}`,
          summary: `loaded ${skill.id} (${skill.body.length} chars)`,
        };
      }

      case "save_memory": {
        // Workspace facts default to the workspace scope (they describe where
        // the agent is working); an explicit scope always wins. Facts about the
        // *person* belong in the profile, not in the agent's own notes.
        const text = String(args.text ?? "");
        const explicitTarget = args.target === "user" ? "user" : args.target === "memory" ? "memory" : undefined;
        const target = explicitTarget ?? inferTarget(text);
        const wantsWorkspace =
          args.scope === "workspace" ||
          (!args.scope && /\b(here|this (workspace|project|repo|folder|directory)|current (workspace|project))\b/i.test(text));
        const scope = wantsWorkspace ? "workspace" : "global";
        const tags = Array.isArray(args.tags) ? (args.tags as unknown[]).map(String) : [];
        const r = saveMemory(text, scope, tags, target);
        if (!r.ok) {
          // Report the fill so the model can consolidate in the same turn
          // rather than retrying blindly against a store that cannot fit it.
          const stats = memoryStats();
          const store = target === "user" ? stats.user : { chars: stats.chars[scope] ?? 0, budget: stats.budget[scope] ?? 0, entries: stats.byScope[scope] ?? 0, pressure: 0 };
          const current = listAll(target, scope).map((e) => e.text);
          return {
            ok: false,
            content: `${r.error}\n\nCurrent entries:\n${current.map((t) => `- ${t}`).join("\n") || "(none)"}\n\nFree room in this same turn with update_memory (remove/replace + add together), then the new fact will fit.`,
            summary: `refused — ${store.chars ?? 0}/${store.budget ?? 0} chars used`,
          };
        }
        return {
          ok: true,
          content: `saved to ${target === "user" ? "the user profile" : `${scope} memory`} (${r.used}/${r.budget} chars used there)`,
          summary: `remembered: ${String(args.text ?? "").slice(0, 60)}`,
        };
      }

      case "update_memory": {
        const ops = Array.isArray(args.operations) ? (args.operations as Record<string, unknown>[]) : [];
        if (!ops.length) return { ok: false, content: "operations must be a non-empty list", summary: "empty ops" };
        const r = applyMemoryOps(
          ops.map((o) => ({
            action: String(o.action ?? "add") as "add" | "replace" | "remove",
            target: o.target === "user" ? "user" : o.target === "memory" ? "memory" : undefined,
            scope: o.scope === "workspace" ? "workspace" : o.scope === "global" ? "global" : undefined,
            content: o.content === undefined ? undefined : String(o.content),
            old_text: o.old_text === undefined ? undefined : String(o.old_text),
            tags: Array.isArray(o.tags) ? (o.tags as unknown[]).map(String) : undefined,
          })),
        );
        if (!r.ok) {
          return {
            ok: false,
            content: `${r.error}\n\n${r.applied.length ? `Applied before the failure (nothing was written):\n${r.applied.join("\n")}` : "Nothing was written."}`,
            summary: "batch refused",
          };
        }
        const stats = memoryStats();
        return {
          ok: true,
          content:
            `${r.applied.join("\n")}\n\nNow: memory ${stats.chars.global ?? 0}/${stats.budget.global ?? 0}, ` +
            `workspace ${stats.chars.workspace ?? 0}/${stats.budget.workspace ?? 0}, user ${stats.user.chars}/${stats.user.budget} chars.`,
          summary: `${r.applied.length} op(s) applied`,
        };
      }

      case "update_soul": {
        const text = String(args.text ?? "").trim();
        if (!text) return { ok: false, content: "text is required", summary: "empty soul" };
        const r = writeSoul(text);
        if (!r.ok) return { ok: false, content: r.error ?? "could not write the soul", summary: "refused" };
        const warn = r.flagged
          ? `\n\nNote: the text matched prompt-injection heuristic(s): ${r.findings?.join(", ")}. It was saved — review it if you did not intend that phrasing.`
          : "";
        return {
          ok: true,
          content: `your identity was updated (${r.chars} chars). It takes effect from the next turn — the running conversation keeps the soul it started with, because the system prompt is captured once per session.${warn}`,
          summary: `soul updated (${r.chars} chars)`,
        };
      }

      case "recall_memory": {
        const query = String(args.query ?? "");
        const target = args.target === "user" ? "user" : args.target === "memory" ? "memory" : undefined;
        const hits = recallMemory(query).filter((h) => !target || (target === "user" ? listUser().some((u) => u.id === h.id) : !listUser().some((u) => u.id === h.id)));
        if (!hits.length) {
          return { ok: true, content: query ? `(nothing matched "${query}")` : "(memory is empty)", summary: "0 hits" };
        }
        markRecalled(hits.map((h) => h.id));
        const isUser = new Set(listUser().map((u) => u.id));
        return {
          ok: true,
          content: hits
            .map((h) => `${h.id}${isUser.has(h.id) ? " [user]" : h.scope === "workspace" ? " [workspace]" : ""}: ${h.text}`)
            .join("\n"),
          summary: `${hits.length} hit(s)`,
        };
      }

      case "forget_memory": {
        const scope = args.scope === "workspace" ? "workspace" : args.scope === "global" ? "global" : undefined;
        const target = args.target === "user" ? "user" : args.target === "memory" ? "memory" : undefined;
        const r = forgetMemory(String(args.selector ?? ""), scope, target);
        return { ok: r.ok, content: r.ok ? `removed ${r.removed} entr(y/ies)` : (r.error ?? "nothing removed"), summary: r.ok ? `${r.removed} removed` : "no match" };
      }

      case "context_status": {
        if (!ctx.meter) return { ok: false, content: "no running model to measure against", summary: "unavailable" };
        const b = await measureContext(ctx.meter, ctx.messages ?? [], ctx.tools ?? []);
        const s = memoryStats();
        return {
          ok: true,
          content: `${describeBreakdown(b)}\n\nmemory: ${s.total} fact(s) — ${s.byScope.global} global (${s.chars.global}/${s.budget.global} chars), ${s.byScope.workspace} workspace (${s.chars.workspace}/${s.budget.workspace} chars)\n${memoryBlock() || "(the memory block is empty)"}`,
          summary: `${b.used}/${b.window} tokens (${(b.pressure * 100).toFixed(1)}%) · ${s.total} memory fact(s)`,
        };
      }

      case "ask_user_question": {
        const question = String(args.question ?? "").trim();
        if (!question) return { ok: false, content: "question is required", summary: "empty question" };
        if (!ctx.askUser) return { ok: false, content: "no user is attached to this run", summary: "unavailable" };
        const options = Array.isArray(args.options) ? (args.options as unknown[]).map(String).filter(Boolean) : undefined;
        const answer = await ctx.askUser({ id: `q_${Date.now().toString(36)}`, question, options }, QUESTION_TIMEOUT_MS);
        if (answer === null) {
          return {
            ok: false,
            content: "no answer arrived in time — continue with your best judgement and say what you assumed",
            summary: "timed out",
          };
        }
        return { ok: true, content: `the user answered: ${answer}`, summary: `answered: ${answer.slice(0, 50)}` };
      }

      case "session_search": {
        const query = String(args.query ?? "").trim().toLowerCase();
        if (!query) return { ok: false, content: "query is required", summary: "empty query" };
        const terms = query.split(/\s+/);
        const limit = Math.min(50, Math.max(1, Number(args.limit ?? 10) || 10));
        const hits: string[] = [];
        for (const s of listSessions()) {
          if (s.id === ctx.sessionId) continue; // never matches itself
          const rec = readSession(s.id);
          if (!rec) continue;
          for (const e of rec.events) {
            const text = JSON.stringify(e.data).toLowerCase();
            if (terms.every((t) => text.includes(t))) {
              const role = e.data.role ? `${e.data.role}: ` : "";
              hits.push(`${s.id} seq=${e.seq} ${e.kind} ${role}${JSON.stringify(e.data).slice(0, 160)}`);
              if (hits.length >= limit) break;
            }
          }
          if (hits.length >= limit) break;
        }
        return {
          ok: true,
          content: hits.join("\n") || `(no earlier session matched "${query}")`,
          summary: hits.length ? `${hits.length} match(es)` : "0 matches",
        };
      }

      case "session_events": {
        const id = String(args.id ?? "").trim();
        const rec = id ? readSession(id) : null;
        if (!rec) return { ok: false, content: `no session with id "${id}" — use session_search to find one`, summary: "unknown session" };
        if (rec.id === ctx.sessionId) {
          return { ok: false, content: "that is the current session — its events are already in front of you", summary: "self" };
        }
        const kind = String(args.kind ?? "").trim();
        const limit = Math.min(200, Math.max(1, Number(args.limit ?? 50) || 50));
        const rows = rec.events
          .filter((e) => !kind || e.kind === kind)
          .slice(0, limit)
          .map((e) => `${String(e.seq).padStart(4, " ")} ${e.kind.padEnd(11)} ${JSON.stringify(e.data).slice(0, 220)}`);
        return {
          ok: true,
          content: `session ${rec.id} — ${rec.title || "untitled"} · ${rec.events.length} events` + (rows.length ? `\n${rows.join("\n")}` : " (no events of that kind)"),
          summary: `${rec.events.length} events`,
        };
      }

      case "delegate_task": {
        if (!ctx.delegate) {
          return { ok: false, content: "delegation is not available in this run (plain chat has no subagents)", summary: "unavailable" };
        }
        const tasks = (Array.isArray(args.tasks) ? args.tasks : [args.tasks])
          .map((x) => String(x ?? "").trim()).filter((x) => x.length > 0).slice(0, 4);
        if (!tasks.length) return { ok: false, content: "tasks must be a non-empty list of self-contained task strings", summary: "empty tasks" };
        const results = await ctx.delegate(tasks);
        const body = results
          .map((r, i) => [
            `--- subagent ${i + 1} ${r.ok ? "(ok)" : "(failed)"} ---`,
            r.error ? `error: ${r.error}` : "",
            r.text.slice(0, 3000),
          ].filter(Boolean).join("\n"))
          .join("\n\n");
        const oks = results.filter((r) => r.ok).length;
        return { ok: oks === results.length, content: body || "(all subagents produced no text)", summary: `${oks}/${results.length} subagent(s) completed` };
      }

      default:
        return { ok: false, content: `context tool ${name} is not implemented`, summary: "not implemented" };
    }
  } catch (e) {
    return { ok: false, content: `${name} failed: ${(e as Error).message}`, summary: "error" };
  }
}

/** The skills catalog block, injected so `load_skill` is discoverable. */
export function skillsBlock(): string {
  return skillCatalog(discoverSkills());
}

export { skillRoots };
