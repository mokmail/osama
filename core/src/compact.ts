import type { ChatMessage } from "./context.js";

/**
 * Compaction: condense an over-long conversation into a summary plus the recent
 * turns, so a turn can continue past the window.
 *
 * Follows `dsh-compaction`'s contract rather than inventing one: the condensed
 * conversation *replaces* the old turns for the model, while the originals stay
 * in the transcript the user sees, so nothing is lost and replay is stable.
 * This module performs no condensation itself — it decides what to keep and
 * hands the summarisation to a caller-supplied function (the model), exactly as
 * the harness separates the contract from its backend.
 */

export interface CompactionPlan {
  /** Whether condensing is worth doing at all. */
  needed: boolean;
  /** Messages to summarise (oldest first). */
  older: ChatMessage[];
  /** Messages kept verbatim. */
  recent: ChatMessage[];
  reason: string;
}

export interface CompactOptions {
  /** Tokens to leave free for the reply. */
  reserveForReply?: number;
  /** Rough ceiling on the summary itself. */
  maxSummaryTokens?: number;
  /**
   * Tokens that no amount of condensing can remove: the system prompt and the
   * tool schemas. The "keep this much conversation" target is derived from what
   * is LEFT of the window after these, or the plan keeps a share of the whole
   * window and every request stays over it — 5.2k of schemas + system on an 8k
   * server leaves ~1.7k for the conversation, not 3k.
   */
  fixedOverhead?: number;
  /** Never summarise away more than this share of the window in one pass. */
  maxCompactionShare?: number;
  /**
   * Measures one message in tokens. Pass the model's own tokenizer here and the
   * split will agree with the measured total; the default is a rough heuristic.
   */
  sizeOf?: (m: ChatMessage) => number;
}

const DEFAULTS = { reserveForReply: 1024, maxSummaryTokens: 768, maxCompactionShare: 0.75 } as const;

/**
 * Split a conversation into "summarise these" and "keep these".
 *
 * The trigger and the split are deliberately derived from the SAME per-message
 * measurement. An earlier version took a caller-supplied total for the trigger
 * and sized messages heuristically for the split, so the two could disagree —
 * the trigger fired while the split found nothing worth cutting. Pass `sizeOf`
 * with the real tokenizer to make both exact.
 *
 * Always keeps at least the most recent exchange, and never splits a tool-call
 * from its result — an orphaned `tool_calls` block makes the next request
 * invalid.
 */
export function planCompaction(
  messages: ChatMessage[],
  usedTokens: number | null,
  windowTokens: number,
  opts: CompactOptions = {},
): CompactionPlan {
  const o = { ...DEFAULTS, ...opts };
  const sizeOf = o.sizeOf ?? estimate;
  const trigger = windowTokens - o.reserveForReply;

  // Prefer the caller's measured total — it includes the chat-template overhead
  // AND the tool schemas, which are not messages at all — with the per-message
  // sum as the fallback.
  //
  // A measurement is legitimately LARGER than the message sum: the 37 built-in
  // tool schemas cost ~3.5k tokens that no message contains. Treating
  // "measured > 2× the sum" as an inconsistent meter made the plan fall back to
  // the smaller sum, so on a real 8k-per-slot server (llama.cpp `-c 32768 -np 4`
  // reports `default_generation_settings.n_ctx = 8192`) a request that had
  // already blown the window looked "within budget" — compaction never fired and
  // the turn died on the server's 400 after reading the files and before writing
  // anything. Only a measurement SMALLER than the content it measured is
  // suspicious, so that is the only case that falls back now.
  // The system prompt is the agent's instructions, not conversation: it is held
  // out of the split entirely and always kept verbatim. Letting the walk-back
  // include it meant a condensation could summarise the agent's own rules away —
  // which is worse than the overflow it was trying to fix.
  const head = messages[0]?.role === "system" ? messages[0] : null;
  const body = head ? messages.slice(1) : messages;

  const summed = body.reduce((n, m) => n + sizeOf(m), 0);
  const measured = usedTokens ?? summed;
  const inconsistent = usedTokens != null && summed > 0 && usedTokens < summed * 0.5;
  const used = inconsistent ? summed : measured;

  if (used < trigger) {
    return { needed: false, older: [], recent: messages, reason: `within budget (${used} < ${trigger})` };
  }

  // Walk backwards, keeping messages until the kept part fits the target.
  //
  // The share of the window is an upper bound; what actually fits is whatever is
  // left after the fixed overhead (system prompt + tool schemas) and the reply's
  // reserve. Without the overhead term the target is unreachable on a small
  // per-slot window and the plan condenses nothing, forever.
  const shareGoal = Math.floor(windowTokens * (1 - o.maxCompactionShare)) + o.reserveForReply;
  const fitsGoal = windowTokens - (o.fixedOverhead ?? 0) - o.reserveForReply;
  const keepGoal = Math.max(o.reserveForReply, Math.min(shareGoal, fitsGoal));
  let kept = 0;
  let cutIndex = body.length;

  for (let i = body.length - 1; i >= 0; i--) {
    const m = body[i]!;
    // A tool result is never cut on its own — it travels with the assistant turn
    // that requested it — so it is counted THERE, not here.
    if (m.role === "tool") continue;
    let size = sizeOf(m);
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      // Count the results this call produced. Skipping them made the walk-back
      // believe the recent part was tiny while in fact the tool OUTPUT was what
      // filled the window: a turn that read three files reported
      // "nothing could be condensed", so nothing ever was, and the next request
      // died over the window on the real server. Tool output is the biggest
      // thing a coding turn adds, so it has to weigh in the split.
      for (let j = i + 1; j < body.length && body[j]?.role === "tool"; j++) size += sizeOf(body[j]!);
    }
    if (kept > 0 && kept + size > keepGoal) break;
    kept += size;
    cutIndex = i;
  }

  // If a tool result sits at the cut, move back so its call comes with it.
  while (cutIndex > 0 && body[cutIndex]?.role === "tool") cutIndex--;
  // Always leave something to talk about.
  if (cutIndex >= body.length) cutIndex = Math.max(0, body.length - 1);

  const older = body.slice(0, cutIndex);
  // The held-out system prompt always goes back in front of the kept part.
  const recent = head ? [head, ...body.slice(cutIndex)] : body.slice(cutIndex);

  if (!older.length) {
    return {
      needed: false,
      older: [],
      recent: messages,
      reason: "nothing could be condensed without splitting a recent turn",
    };
  }

  return {
    needed: true,
    older,
    recent,
    reason: `condensing ${older.length} of ${messages.length} messages (~${kept} tokens kept)`,
  };
}

/** Ask the model to summarise the older turns; the prompt is the contract. */
export function summarizationPrompt(older: ChatMessage[], maxTokens: number): string {
  const transcript = older
    .map((m) => {
      const body = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      const extra = Array.isArray(m.tool_calls)
        ? ` [called: ${(m.tool_calls as any[]).map((c) => c?.function?.name).join(", ")}]`
        : "";
      return `${m.role}: ${body}${extra}`;
    })
    .join("\n\n");

  return [
    "Condense the conversation below into a compact summary that preserves everything needed to continue the work.",
    "Keep: decisions made, constraints and preferences the user stated, exact file paths, commands that mattered, and the current state of any unfinished task.",
    "Drop: pleasantries, repetition, and detail that no longer affects the outcome.",
    `Write at most ~${maxTokens} tokens of plain prose or terse bullets. Do not add commentary about summarizing.`,
    "",
    "<conversation>",
    transcript,
    "</conversation>",
  ].join("\n");
}

/**
 * Elide oversized tool output when nothing else can free enough room.
 *
 * The last resort, and the one that actually unblocks a coding turn: a single
 * `read_file` of a 340-line component can be ~3.4k tokens, which on a server
 * whose per-request window is 8k (llama.cpp `-c 32768 -np 4`) is more than the
 * conversation is allowed to hold — and a lone tool result can never be split
 * off by the plan, so condensing "older turns" frees nothing. Measured live:
 * `request (8495 tokens) exceeds the available context size (8192)` with
 * compaction already enabled.
 *
 * The newest results are kept verbatim (the model is working from them), the
 * oldest are replaced with a notice that says what happened and how to get the
 * content back, so nothing is lost silently.
 */
export function planResultElision(
  messages: ChatMessage[],
  excessTokens: number,
  opts: { keepRecent?: number } = {},
): { messages: ChatMessage[]; elided: number; freed: number } {
  if (excessTokens <= 0) return { messages, elided: 0, freed: 0 };
  const keepRecent = Math.max(0, opts.keepRecent ?? 1);
  // Pass 1 keeps the newest results (the model is working from them). If that
  // still does not free enough — the newest result is itself the oversized one,
  // which is the common case for a single big file read — pass 2 gives up the
  // newest as well rather than letting the request go over the window and die.
  const pass1 = elideFrom(messages, excessTokens, keepRecent);
  if (pass1.freed >= excessTokens || keepRecent === 0) return pass1;
  const pass2 = elideFrom(pass1.messages, excessTokens - pass1.freed, 0);
  return { messages: pass2.messages, elided: pass1.elided + pass2.elided, freed: pass1.freed + pass2.freed };
}

/** One elision pass: replace the oldest oversized tool output, keeping the last N. */
function elideFrom(
  messages: ChatMessage[],
  excessTokens: number,
  keepRecent: number,
): { messages: ChatMessage[]; elided: number; freed: number } {
  if (excessTokens <= 0) return { messages, elided: 0, freed: 0 };
  const toolIndexes = messages.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
  // `slice(-0)` is `slice(0)` — the whole array — so 0 has to be special-cased or
  // "protect nothing" protects everything and the elision never fires.
  const keep = keepRecent > 0 ? new Set(toolIndexes.slice(-keepRecent)) : new Set<number>();
  const out = messages.map((m) => ({ ...m }));
  let freed = 0;
  let elided = 0;
  // Oldest first: the most recent output is what the model is reasoning about.
  for (const i of toolIndexes) {
    if (freed >= excessTokens) break;
    if (keep.has(i)) continue;
    const m = out[i]!;
    const body = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    if (!body || body.startsWith("[output elided")) continue;
    const size = estimate(m);   // the same per-message measure the plan uses
    out[i] = {
      ...m,
      content: `[output elided: ${size} tokens from ${m.name ?? "a tool"} — re-run it, or read just the range you need, if this is still required]`,
    };
    freed += size;
    elided += 1;
  }
  return { messages: out, elided, freed };
}

/** Build the message list the model sees after a compaction. */
export function applyCompaction(summary: string, recent: ChatMessage[]): ChatMessage[] {
  const note: ChatMessage = {
    role: "user",
    content: `<conversation-summary>\n${summary.trim()}\n</conversation-summary>`,
  };
  return [note, ...recent];
}

function estimate(m: ChatMessage): number {
  const body = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
  let n = Math.ceil(body.length / 4) + 4;
  if (Array.isArray(m.tool_calls)) n += Math.ceil(JSON.stringify(m.tool_calls).length / 4);
  return n;
}

export { estimate as estimateMessageTokens };
