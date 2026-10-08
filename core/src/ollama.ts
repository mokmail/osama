import process from "node:process";

/**
 * Ollama integration for the chat page.
 *
 * The user's machine may already have Ollama installed and serving models. This
 * module lets Osama *use* that daemon instead of only managing its own
 * llama.cpp processes — but it is deliberately read-only: it never starts,
 * stops or pulls anything. Osama asks Ollama what it has and points the chat at
 * it.
 *
 * Why this is thin: Ollama exposes an OpenAI-compatible
 * `POST /v1/chat/completions`, which is exactly what the existing chat proxy
 * already speaks. So the whole feature reduces to (a) discovering the daemon and
 * its models, and (b) telling the UI the right base URL, model name and window —
 * the streaming path is unchanged.
 */

/** The default Ollama endpoint. Overridable for a non-default port or host. */
export function ollamaBase(): string {
  const fromEnv = process.env.OSAMA_OLLAMA_URL?.trim();
  return (fromEnv || "http://127.0.0.1:11434").replace(/\/$/, "");
}

/**
 * Is this base URL an Ollama daemon?
 *
 * Cheap and offline: a wrong guess only costs a graceful fallback (the chat
 * simply gets a 404 and the caller retries against the real provider), so a
 * port/heuristic check is preferred over a network probe on a hot path.
 */
export function looksLikeOllama(base: string): boolean {
  try {
    const u = new URL(base);
    if (u.port === "11434") return true;
    if (/ollama/i.test(u.hostname)) return true;
  } catch {
    /* not a URL — fall through */
  }
  return false;
}

export interface OllamaModel {
  /** The name used in API calls, e.g. `qwen3:8b`. */
  name: string;
  /** Bytes on disk. */
  size: number;
  modifiedAt: string;
  family?: string;
  families?: string[];
  parameterSize?: string;
  quantization?: string;
  contextLength?: number;
  /** Capability tags Ollama reports, e.g. ["tools", "vision", "thinking"]. */
  capabilities?: string[];
  digest?: string;
}

export interface OllamaStatus {
  /** The daemon answered. */
  reachable: boolean;
  url: string;
  version?: string;
  /** Models on offer, newest first. Empty when unreachable. */
  models: OllamaModel[];
  /** A human reason when unreachable. */
  error?: string;
  /** True when the daemon reports at least one model. */
  hasModels: boolean;
}

interface TagsResponse {
  models?: Array<{
    name?: string;
    model?: string;
    size?: number;
    modified_at?: string;
    digest?: string;
    capabilities?: string[];
    details?: {
      family?: string;
      families?: string[];
      parameter_size?: string;
      quantization_level?: string;
      context_length?: number;
    };
  }>;
}

/** Normalize one `/api/tags` row into the shape the UI consumes. */
function toModel(m: NonNullable<TagsResponse["models"]>[number]): OllamaModel {
  const name = m.name ?? m.model ?? "";
  return {
    name,
    size: Number(m.size ?? 0),
    modifiedAt: m.modified_at ?? "",
    family: m.details?.family,
    families: m.details?.families,
    parameterSize: m.details?.parameter_size,
    quantization: m.details?.quantization_level,
    contextLength: m.details?.context_length,
    capabilities: m.capabilities,
    digest: m.digest,
  };
}

/**
 * Probe the daemon: version + model list in one pass.
 *
 * `/api/version` is the cheapest liveness check (no model enumeration cost on
 * the daemon), and `/api/tags` is the model list. Both are attempted together;
 * if either answers, the daemon is reachable, and a missing list is treated as
 * "reachable, no models" rather than an error.
 */
export async function ollamaStatus(base = ollamaBase(), timeoutMs = 2500): Promise<OllamaStatus> {
  const url = base.replace(/\/$/, "");
  const probe = async <T>(path: string): Promise<T | null> => {
    try {
      const r = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return null;
      return (await r.json()) as T;
    } catch {
      return null;
    }
  };

  const [versionRes, tagsRes] = await Promise.all([
    probe<{ version?: string }>("/api/version"),
    probe<TagsResponse>("/api/tags"),
  ]);

  if (!versionRes && !tagsRes) {
    return {
      reachable: false,
      url,
      models: [],
      hasModels: false,
      error: `no Ollama daemon responded at ${url}`,
    };
  }

  const models = (tagsRes?.models ?? [])
    .map(toModel)
    .filter((m) => m.name)
    .sort((a, b) => (b.modifiedAt || "").localeCompare(a.modifiedAt || ""));

  return {
    reachable: true,
    url,
    version: versionRes?.version,
    models,
    hasModels: models.length > 0,
  };
}

/** Just the model list, or an empty array when the daemon is down. */
export async function ollamaModels(base = ollamaBase()): Promise<OllamaModel[]> {
  return (await ollamaStatus(base)).models;
}

/**
 * Read a model's context window and capabilities without loading it.
 *
 * `/api/show` returns `model_info` (the GGUF metadata) where the context length
 * lives under an architecture-prefixed key (`qwen35.context_length`, etc.), plus
 * a `capabilities` array. Used by the context meter so the pressure readout is
 * honest for an Ollama model rather than the 4096 fallback.
 */
export async function ollamaShow(
  model: string,
  base = ollamaBase(),
  timeoutMs = 4000,
): Promise<{ contextLength?: number; capabilities?: string[] } | null> {
  try {
    const r = await fetch(`${base.replace(/\/$/, "")}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    const body = (await r.json()) as {
      capabilities?: string[];
      model_info?: Record<string, unknown>;
      parameters?: string;
      details?: { context_length?: number };
    };
    let contextLength = body.details?.context_length;
    if (!contextLength && body.model_info) {
      // The key is `<architecture>.context_length`; take the first match.
      for (const [k, v] of Object.entries(body.model_info)) {
        if (/\.context_length$/i.test(k) && typeof v === "number" && v > 0) {
          contextLength = v;
          break;
        }
      }
    }
    if (!contextLength && body.parameters) {
      // Modelfile parameters can pin num_ctx; honour it when present.
      const m = /num_ctx\s+(\d+)/.exec(body.parameters);
      if (m) contextLength = Number(m[1]);
    }
    return { contextLength, capabilities: body.capabilities };
  } catch {
    return null;
  }
}
