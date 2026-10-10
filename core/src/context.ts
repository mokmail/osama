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
/**
 * What an endpoint can actually answer, remembered per URL.
 *
 * This exists because of a real report: Osama pointed at an mlx-lm server kept
 * POSTing `/tokenize` and `/apply-template` — llama.cpp routes mlx-lm does not
 * have — on every poll, forever, because nothing recorded the 404. Probing once
 * and remembering the "no" (as well as the "yes") is the difference between a
 * meter that measures and a meter that hammers.
 */
interface EndpointCaps {
  /** the server renders templates and tokenizes for us (llama.cpp) */
  tokenize: boolean;
  template: boolean;
  engine: "llamacpp" | "mlx" | "ollama" | "unknown";
  at: number;
}
const CAPS = new Map<string, EndpointCaps>();
const CAPS_TTL = 5 * 60_000;

async function detectCaps(root: string, isOllama: boolean): Promise<EndpointCaps> {
  const cached = CAPS.get(root);
  if (cached && Date.now() - cached.at < CAPS_TTL) return cached;
  const caps: EndpointCaps = { tokenize: false, template: false, engine: isOllama ? "ollama" : "unknown", at: Date.now() };
  // One tiny tokenize is the honest test for the thing we want to use.
  if (!isOllama) {
    try {
      const r = await fetch(`${root}/tokenize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "x" }),
        signal: AbortSignal.timeout(3000),
      });
      if (r.ok) {
        caps.tokenize = true;
        caps.template = true;
        caps.engine = "llamacpp";
      }
    } catch {
      /* unreachable for now — treat as a "no" and re-probe after the TTL */
    }
  }
  if (caps.engine === "unknown") {
    // `GET /v1/models` with an OpenAI-compatible `/health` and no tokenizer route
    // is mlx-lm (docs/mlx-macos.md). Knowing this is what lets `window()` answer
    // with the model's own config instead of a 4096 default.
    try {
      const r = await fetch(`${root}/v1/models`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) caps.engine = "mlx";
    } catch {
      /* leave it unknown */
    }
  }
  CAPS.set(root, caps);
  return caps;
}

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
  /** A window we could not read: remembered briefly so we do not re-probe on every poll. */
  let windowMiss = 0;

  return {
    async count(text: string): Promise<number> {
      if (!text) return 0;
      const caps = await detectCaps(root, isOllama);
      if (!caps.tokenize) return estimateTokens(text);
      const out = await post("/tokenize", { content: text });
      const tokens = out?.tokens;
      if (Array.isArray(tokens)) return tokens.length;
      return estimateTokens(text);
    },

    async countMessages(messages: ChatMessage[]): Promise<number> {
      if (!messages.length) return 0;
      // A server without a tokenizer route has neither of these; estimating is the
      // honest answer, and asking anyway would be a 404 per poll.
      const caps = await detectCaps(root, isOllama);
      if (!caps.template || !caps.tokenize) {
        let total = 0;
        for (const m of messages) {
          total += 4;
          total += estimateTokens(typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""));
          if (Array.isArray(m.tool_calls)) total += estimateTokens(JSON.stringify(m.tool_calls));
        }
        return total;
      }
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
        /* fall through */
      }
      // mlx-lm has no /props. The model's own config.json is the answer — first for
      // a server Osama started, then for any MLX server, identified by the model id
      // it reports on /v1/models (which is why this works for one started by hand).
      const { mlxWindowFor, mlxWindowForModelId, probeMlxServer } = await import("./mlx.js");
      const own = mlxWindowFor(root);
      if (own && own > 0) {
        memo.set("window", own);
        return own;
      }
      if (Date.now() > windowMiss) {
        const info = await probeMlxServer(root);
        const fromId = info.ok && info.model ? mlxWindowForModelId(info.model) : undefined;
        if (fromId && fromId > 0) {
          memo.set("window", fromId);
          return fromId;
        }
        windowMiss = Date.now() + 60_000;
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
