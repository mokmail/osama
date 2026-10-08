/**
 * Context-window and memory management.
 *
 * Mirrors what the DeepSeek Harness splits across `dsh-token-meter` and
 * `dsh-compaction`, in the same spirit: measurement never calls the model, and
 * condensation keeps the recent turns intact while shadowing the old ones.
 *
 * The real numbers come from llama.cpp itself — `POST /tokenize` and
 * `POST /apply-template` — so nothing here guesses. Estimation exists only as a
 * fallback for a server that does not expose those routes.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** tool-calling fields, passed through untouched */
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
}

export type ToolSupport = "full" | "none" | "unknown";

/**
 * Whether the served model can call tools at all, read from its chat template.
 *
 * Model identity is not enough — a family can ship both a tool-calling and a
 * plain variant — but the template the server is actually using is exactly the
 * thing that decides. A template with no tool tokens cannot render a tool call,
 * so the model will answer in prose however clearly it is asked. gemma-3's
 * template has none; Llama-3.2's has `tool_calls`, `tools` and `function`.
 */
export function detectToolSupport(chatTemplate: string | null | undefined): ToolSupport {
  if (!chatTemplate) return "unknown";
  return /tool_calls|\btools?\b|function/i.test(chatTemplate) ? "full" : "none";
}

export interface Meter {
  /** Count tokens in a plain string, using the server's own tokenizer. */
  count(text: string): Promise<number>;
  /** Count the tokens of a message list exactly, template overhead included. */
  countMessages(messages: ChatMessage[]): Promise<number>;
  /** The model's context window, from the server. */
  window(): Promise<number>;
}

/** Rough fallback, only used when the server cannot tokenize for us. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const chars = text.length;
  const words = text.split(/\s+/).filter(Boolean).length;
  // ~4 chars/token for Latin text; CJK and code drift either way, so take the
  // larger of the two heuristics rather than under-counting the window.
  return Math.max(Math.ceil(chars / 4), Math.ceil(words * 1.3));
}

/**
 * A running server's meter. Every call is scoped to one endpoint.
 *
 * Works against both llama.cpp (`/tokenize`, `/apply-template`, `/props`) and
 * Ollama (`/v1/chat/completions` + `/api/show`): Ollama has no tokenizer route,
 * so its token counts fall back to the estimate while its window is read from
 * `/api/show`. `opts.model` names the Ollama model to inspect for the window.
 */
export function createMeter(base: string, opts: { model?: string } = {}): Meter {
  const root = base.replace(/\/$/, "");
  const isOllama = ((): boolean => {
    try {
      const u = new URL(root);
      return u.port === "11434" || /ollama/i.test(u.hostname);
    } catch {
      return false;
    }
  })();
  const ollamaModel = opts.model;

  const post = async (path: string, body: unknown, timeoutMs = 8000): Promise<any | null> => {
    try {
      const r = await fetch(`${root}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  };

  const memo = new Map<string, number>();

  return {
    async count(text: string): Promise<number> {
      if (!text) return 0;
      const out = await post("/tokenize", { content: text });
      const tokens = out?.tokens;
      if (Array.isArray(tokens)) return tokens.length;
      return estimateTokens(text);
    },

    async countMessages(messages: ChatMessage[]): Promise<number> {
      if (!messages.length) return 0;
      // Prefer rendering the real template, then tokenizing the result: that
      // captures per-message overhead a naive concatenation would miss.
      const rendered = await post("/apply-template", { messages });
      const prompt = rendered?.prompt;
      if (typeof prompt === "string" && prompt) {
        const out = await post("/tokenize", { content: prompt });
        if (Array.isArray(out?.tokens)) return out.tokens.length;
        return estimateTokens(prompt);
      }
      let total = 0;
      for (const m of messages) {
        total += 4; // role + separators the template would add
        total += await this.count(typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""));
        if (Array.isArray(m.tool_calls)) total += await this.count(JSON.stringify(m.tool_calls));
      }
      return total;
    },

    async window(): Promise<number> {
      const cached = memo.get("window");
      if (cached) return cached;
      // Ollama has no /props — read the model's window from /api/show.
      if (isOllama) {
        if (ollamaModel) {
          const { ollamaShow } = await import("./ollama.js");
          const info = await ollamaShow(ollamaModel, root);
          if (info?.contextLength && Number.isFinite(info.contextLength) && info.contextLength > 0) {
            memo.set("window", info.contextLength);
            return info.contextLength;
          }
        }
        return 4096;
      }
      try {
        const r = await fetch(`${root}/props`, { signal: AbortSignal.timeout(6000) });
        if (r.ok) {
          const p: any = await r.json();
          const n = p?.default_generation_settings?.n_ctx ?? p?.n_ctx ?? p?.n_ctx_train;
          if (Number.isFinite(n) && n > 0) {
            memo.set("window", n);
            return n;
          }
        }
      } catch {
        /* fall through to the default */
      }
      return 4096;
    },
  };
}

export interface ContextBreakdown {
  window: number;
  used: number;
  /** tokens still available for the reply */
  remaining: number;
  /** 0..1 */
  pressure: number;
  segments: Array<{ label: string; tokens: number }>;
  /** true when the request would not fit */
  overflow: boolean;
  exact: boolean;
}

/** Measure a request against the window, splitting it into labelled segments. */
export async function measureContext(
  meter: Meter,
  messages: ChatMessage[],
  tools: Array<Record<string, unknown>> = [],
): Promise<ContextBreakdown> {
  const system = messages.filter((m) => m.role === "system");
  const history = messages.filter((m) => m.role !== "system");

  const [window, systemTokens, historyTokens, toolTokens] = await Promise.all([
    meter.window(),
    meter.countMessages(system),
    meter.countMessages(history),
    tools.length ? meter.count(JSON.stringify(tools)) : Promise.resolve(0),
  ]);

  const used = systemTokens + historyTokens + toolTokens;
  const segments = [
    { label: "system prompt", tokens: systemTokens },
    { label: "conversation", tokens: historyTokens },
    { label: "tool schemas", tokens: toolTokens },
  ].filter((s) => s.tokens > 0);

  return {
    window,
    used,
    remaining: Math.max(0, window - used),
    pressure: window > 0 ? used / window : 0,
    segments,
    overflow: used >= window,
    exact: true,
  };
}

/** A compact, model-readable rendering of the breakdown. */
export function describeBreakdown(b: ContextBreakdown, reservedForReply = 0): string {
  const lines = [
    `context window: ${b.window} tokens`,
    `used: ${b.used} (${(b.pressure * 100).toFixed(1)}%)`,
    `free: ${b.remaining}`,
  ];
  if (reservedForReply) lines.push(`reserved for the reply: ${reservedForReply}`);
  if (b.segments.length) {
    lines.push("breakdown:");
    for (const s of b.segments) lines.push(`  ${s.label}: ${s.tokens}`);
  }
  if (b.overflow) lines.push("WARNING: the request already exceeds the window");
  return lines.join("\n");
}
