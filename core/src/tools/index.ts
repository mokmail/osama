/**
 * `@osama/core`'s agent-tool subsystem, split by concern.
 *
 * `tools.ts` was one 2000-line file holding four different jobs: the declarations the
 * model is handed (`spec`), the jail and the file plumbing every family shares
 * (`jail`), the executors themselves (`fs`, `net`, `state`, `scheduler`) and the
 * dispatch between them (`dispatch`). Everything that imported `./tools.js` — agent,
 * artifacts, mcp, prompt — keeps importing exactly that, because this file re-exports
 * the same surface the single file did.
 */
export * from "./spec.js";
export * from "./jail.js";
export * from "./state.js";
export * from "./scheduler.js";
export * from "./dispatch.js";
export * from "./fs.js";
export * from "./net.js";
