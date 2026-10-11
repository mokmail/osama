import * as core from "@osama/core";
import { json, q, route, type RouteModule } from "../http.js";

/**
 * First-run recommendations.
 *
 * One thin route over `core.firstRunRecommendation()`: the decision (which
 * engine, which model, how big) lives in core and is testable without a
 * browser; this only turns a query string into an argument and the answer into
 * JSON. `needed` is read live, so the card disappears the moment the first
 * model lands — it never nags a machine that already has one.
 */
export const recommendRoutes: RouteModule = (_deps) => [
  route("GET", "/api/recommend", async ({ res, url }) => {
    const refresh = q(url, "refresh") === "1";
    json(res, 200, await core.firstRunRecommendation({ refresh }));
  }),
];
