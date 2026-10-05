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

  // Prefer the caller's measured total (it includes template overhead); fall
  // back to summing the messages. Whichever is used, sanity-check it against the
  // per-message sum so the two cannot silently diverge.
  const summed = messages.reduce((n, m) => n + sizeOf(m), 0);
  const measured = usedTokens ?? summed;
  const inconsistent = usedTokens != null && summed > 0 && (measured < summed * 0.5 || measured > summed * 2);
  const used = inconsistent ? summed : measured;

  if (used < trigger) {
    return { needed: false, older: [], recent: messages, reason: `within budget (${used} < ${trigger})` };
  }

  // Walk backwards, keeping messages until the kept part fits the target.
  const keepGoal = Math.max(
    Math.floor(windowTokens * (1 - o.maxCompactionShare)) + o.reserveForReply,
    o.reserveForReply, // never aim to keep less than the reply needs
  );
  let kept = 0;
  let cutIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    // A tool result must stay with the assistant turn that requested it.
    if (m.role === "tool") continue;
    const size = sizeOf(m);
    if (kept > 0 && kept + size > keepGoal) break;
    kept += size;
    cutIndex = i;
  }

  // If a tool result sits at the cut, move back so its call comes with it.
  while (cutIndex > 0 && messages[cutIndex]?.role === "tool") cutIndex--;
  // Always leave something to talk about.
  if (cutIndex >= messages.length) cutIndex = Math.max(0, messages.length - 1);

  const older = messages.slice(0, cutIndex);
  const recent = messages.slice(cutIndex);

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
