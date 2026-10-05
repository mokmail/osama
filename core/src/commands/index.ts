/**
 * `@osama/core`'s command catalogue, split into a spec module and the
 * catalogue+builder. Everything the rest of the codebase imported from
 * `commands.js` is re-exported here, so no call site had to move.
 */
export * from "./spec.js";
export * from "./tools.js";
