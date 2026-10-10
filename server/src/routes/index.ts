import * as core from "@osama/core";
import { agentRoutes } from "./agent.js";
import { eventRoutes } from "./events.js";
import { hubRoutes } from "./hub.js";
import { identityRoutes } from "./identity.js";
import { mcpRoutes } from "./mcp.js";
import { mlxRoutes } from "./mlx.js";
import { modelRoutes } from "./models.js";
import { ollamaRoutes } from "./ollama.js";
import { skillRoutes } from "./skills.js";
import { systemRoutes } from "./system.js";
import type { RouteDeps, RouteModule } from "../http.js";

/**
 * The route table, assembled from the modules.
 *
 * Adding an endpoint means adding it to a module here — the server entry stays
 * a transport shell (listen, dispatch, reap children) and never grows a new
 * route inline. Order matters only in that routes are tried in sequence; keep
 * literal paths before parameterised ones if two could match.
 */
export const MODULES: RouteModule[] = [
  systemRoutes,
  identityRoutes,
  modelRoutes,
  hubRoutes,
  ollamaRoutes,
  mlxRoutes,
  mcpRoutes,
  agentRoutes,
  skillRoutes,
  eventRoutes,
];

export function buildRoutes(deps: RouteDeps) {
  return MODULES.flatMap((m) => m(deps));
}
