import * as core from "@osama/core";
import { json, q, route, type RouteModule } from "../http.js";

/**
 * The Ollama provider: discovery only.
 *
 * Osama does not manage the user's Ollama daemon — no install, no pull, no
 * stop. It asks what is there so the chat page can offer it as a provider. All
 * of this lives behind `/api/ollama/*` so no other page is affected: the rest
 * of the app still speaks to Osama-managed llama.cpp processes.
 */
export const ollamaRoutes: RouteModule = () => [
  /** Is a daemon there, what version, and which models (newest first)? */
  route("GET", "/api/ollama/status", async ({ res, url }) => {
    const base = q(url, "baseUrl");
    const status = await core.ollamaStatus(base ?? core.ollamaBase());
    json(res, 200, status);
  }),

  /** Just the model list, for the chat's model picker. */
  route("GET", "/api/ollama/models", async ({ res, url }) => {
    const base = q(url, "baseUrl");
    const models = await core.ollamaModels(base ?? core.ollamaBase());
    json(res, 200, { models, url: (base ?? core.ollamaBase()).replace(/\/$/, "") });
  }),

  /**
   * A model's context window + capabilities, read without loading it. The chat
   * uses this for the context meter and to decide whether to send images.
   */
  route("GET", "/api/ollama/show", async ({ res, url }) => {
    const model = q(url, "model");
    if (!model) return json(res, 400, { error: "model is required" });
    const base = q(url, "baseUrl") ?? core.ollamaBase();
    const info = await core.ollamaShow(model, base);
    json(res, 200, { model, url: base.replace(/\/$/, ""), ...(info ?? { contextLength: undefined, capabilities: undefined }) });
  }),
];
