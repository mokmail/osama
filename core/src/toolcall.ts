import { AGENT_TOOLS } from "./tools/index.js";
import type { EngineKind } from "./processes.js";

/**
 * Guided tool calls: one envelope the model replies in, and the constraint that makes
 * it the only thing it can reply.
 *
 * The problem this answers is measured, not theoretical. A small local model handed 37
 * tool schemas over-calls: it reaches for a tool on a turn that needed none, invents a
 * tool name, or emits arguments that are not JSON at all. The loop already repairs the
 * near-misses (`parseArgs`, `coerceArgs`, `missingRequiredArg` in agent.ts), and that
 * repair layer is what makes a 3B model *survivable*. Guided mode is the other half:
 * instead of cleaning up a malformed call, make the malformed call impossible.
 *
 * Two strengths, and the app says which one is in force rather than blurring them:
 *
 *   constrained  llama.cpp takes `json_schema` in the request body and turns it into a
 *                grammar, so the sampler cannot emit anything but the envelope. The tool
 *                name is an enum in that schema, so an invented name is not merely
 *                rejected — it is unrepresentable.
 *   requested    mlx-lm has no such field (it is not part of its OpenAI surface — see
 *                `toolConstraintFor` below), so the envelope is asked for in the prompt
 *                and checked when it arrives. Weaker, and labelled that way.
 *
 * Nothing here replaces the native path: with mode "auto" the loop is exactly what it
 * was, and "off" stops offering tools at all.
 */
export type ToolMode = "auto" | "guided" | "off";

/**
 * Every tool name a run can offer: the built-ins, plus whatever the caller injected
 * (MCP tools). The schema's enum and the parser's "is this name real?" test must both be
 * built from this one list, or guided mode would enforce a set the loop does not accept.
 */
export function toolNamesOf(extra?: Array<{ name: string }>): string[] {
  return [...AGENT_TOOLS.map((t) => t.name), ...(extra ?? []).map((t) => t.name)];
}

/** True when the mode asks the model to answer inside the envelope. */
export function isGuided(mode: ToolMode | undefined): boolean {
  return mode === "guided";
}

/**
 * The JSON Schema the whole reply must satisfy in guided mode.
 *
 * Every key is optional and the shape is flat on purpose: both keys may be present,
 * and the parser decides which one was meant. A `oneOf` would say exactly what is
 * intended but is the part of JSON Schema that converters disagree about — llama.cpp
 * turns this one into a grammar without a complaint, which is what makes the guarantee
 * real rather than aspirational.
 */
export function guidedSchema(toolNames: string[]): Record<string, unknown> {
  const names = [...new Set(toolNames.filter((n) => typeof n === "string" && n.trim()))];
  return {
    type: "object",
    properties: {
      tool: {
        type: "string",
        enum: names,
        description: "The tool to run. Must be one of the listed names.",
      },
      arguments: {
        type: "object",
        description: "The arguments for that tool, matching its own schema.",
      },
      answer: {
        type: "string",
        description: "The reply to the user, when no tool is needed. Markdown is fine.",
      },
    },
    required: [],
    additionalProperties: false,
  };
}

/**
 * The instruction that goes with the constraint — and, in guided mode, the tool catalogue.
 *
 * WHY THE CATALOGUE MOVES IN HERE. llama.cpp cannot take `tools` and `json_schema` in the
 * same request: the combination dies with
 *
 *   Failed to initialize samplers: failed to parse grammar
 *
 * measured against b11541 with this very schema, while either field alone is accepted.
 * Since the envelope needs both the tool names (for the enum) and each tool's arguments
 * (for the model to fill correctly), guided mode sends NO native schemas and states the
 * catalogue here instead. One mechanism for both engines, and the same text that mlx-lm
 * needs anyway — it has no constraint to lean on, so the instruction is its only map.
 *
 * The schemas are rendered compactly: name, one-line description, then the parameters
 * as JSON. That is the same information the `tools` field carries, in the place that
 * still works when a grammar is in force.
 */
export function guidedInstruction(tools: Array<Record<string, unknown>>): string {
  type Fn = { name?: unknown; description?: unknown; parameters?: unknown };
  const fns = tools
    .map((t) => (t as { function?: Fn }).function)
    .filter((f): f is Fn => Boolean(f && typeof f.name === "string"));

  const catalogue = fns.map((f) => {
    const params = f.parameters === undefined ? {} : f.parameters;
    return `- ${String(f.name)}: ${String(f.description ?? "").split("\n")[0]}${"\n"}  parameters: ${JSON.stringify(params)}`;
  });

  return [
    "<tool_calls>",
    "Answer with ONE JSON object and nothing else — no prose before or after, no code fence, no explanation.",
    "",
    'To use a tool:      {"tool": "<name>", "arguments": { … }}',
    'To answer instead:  {"answer": "<your reply>"}',
    "",
    "Use a tool only when it gets you information or an effect you cannot produce yourself; if the conversation already answers the question, answer with {\"answer\": …}.",
    "The arguments must satisfy the tool's own parameters below, with its required fields present.",
    "",
    fns.length ? "The tools you may name, with their parameters:" : "No tools are available for this turn.",
    ...catalogue,
    "</tool_calls>",
  ].join("\n");
}

/**
 * Read the envelope back out.
 *
 * `known` is what makes "the model cannot invent a tool" true on the engine that only
 * *asks* for the envelope: a name that is not a declared tool is not a call, it is
 * prose that happens to look like one, and it falls back to being treated as an answer
 * rather than being dispatched at a guess.
 *
 * The repairs mirror `parseArgs` in agent.ts (fence, surrounding prose, trailing comma)
 * because the models that need this most are the models that add all three.
 */
export function parseGuided(
  text: string,
  known: (name: string) => boolean,
): { kind: "call"; tool: string; args: Record<string, unknown> } | { kind: "answer"; answer: string } | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;

  const asObject = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

  let s = raw.replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1").trim();
  if (!s.startsWith("{")) {
    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    if (first < 0 || last <= first) return null;
    s = s.slice(first, last + 1);
  }

  let obj: Record<string, unknown> | null = null;
  for (const candidate of [s, s.replace(/,\s*([}\]])/g, "$1")]) {
    try {
      obj = asObject(JSON.parse(candidate));
      if (obj) break;
    } catch {
      /* try the next repair */
    }
  }
  if (!obj) return null;

  const tool = typeof obj.tool === "string" ? obj.tool.trim() : "";
  const args = asObject(obj.arguments);
  // `tool` first: an envelope that names a tool IS a call, and the arguments default to
  // an empty object rather than failing the call on a tool that takes none.
  if (tool && known(tool)) return { kind: "call", tool, args: args ?? {} };
  const answer = typeof obj.answer === "string" ? obj.answer : "";
  if (answer.trim()) return { kind: "answer", answer };
  // A tool nobody declared, or an object with neither key: not an envelope.
  return null;
}

/**
 * The request-body fields that turn the envelope from a request into a guarantee.
 *
 * Verified against the two runtimes this app serves:
 *
 *   llama.cpp  `-j/--json-schema` is a real server option and the same name is read from
 *              the body, where it becomes a GBNF grammar. Real.
 *   mlx-lm     has no response_format, json_schema or grammar field anywhere in its
 *              OpenAI surface (grep its `server.py`: it reads `tools`, `tool_choice`,
 *              `messages`, `max_tokens`, the samplers — and nothing else). Sending it a
 *              field it ignores would be a lie told in JSON, so nothing is sent and the
 *              UI states the weaker guarantee it actually got.
 *   unknown    neither — an Ollama or a hand-configured remote. Nothing is sent.
 */
export function toolConstraintFor(
  kind: EngineKind,
  mode: ToolMode | undefined,
  toolNames: string[],
): { json_schema: Record<string, unknown> } | null {
  if (!isGuided(mode) || !canConstrain(kind)) return null;
  return { json_schema: guidedSchema(toolNames) };
}

/**
 * Put the constraint on an OpenAI-chat request body — the last step before the wire.
 *
 * Kept here rather than inline in the server so that what will be sent is a *tested*
 * artifact: the request body the loop produces can be asserted against a fake backend
 * without a proxy in the middle.
 */
export function applyConstraint(
  body: Record<string, unknown>,
  constraint: { json_schema: Record<string, unknown> } | null | undefined,
): Record<string, unknown> {
  if (constraint) Object.assign(body, constraint);
  return body;
}

/** Can this engine's server constrain decoding at all? (The question the UI asks.) */
export function canConstrain(kind: EngineKind): boolean {
  return kind === "llama.cpp";
}

/** One sentence for the UI: what enforcing guided mode on this engine actually costs. */
export function constraintNote(kind: EngineKind, mode: ToolMode | undefined): string {
  if (mode === "off") return "Tools are off: the model answers in prose and cannot call anything.";
  if (!isGuided(mode)) return "Native tool calls: the model's own tool-call format, with the repair layer behind it.";
  if (kind === "llama.cpp") {
    return "Guided: llama.cpp constrains decoding to the tool-call envelope, so a malformed call or an invented tool name cannot be generated.";
  }
  if (kind === "mlx") {
    return "Guided (requested): mlx-lm has no grammar or JSON-schema field, so the envelope is asked for in the prompt and checked on arrival — weaker than the llama.cpp path, and worth knowing before blaming the model.";
  }
  return "Guided (requested): this server's engine is unknown, so the envelope is asked for in the prompt and checked on arrival.";
}
