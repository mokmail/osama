#!/usr/bin/env node
/**
 * Preflight guard. Run before `start` / `smoke` so a missing build produces an
 * actionable message instead of a confusing module-not-found error.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Are we even at the project root?
if (!fs.existsSync(path.join(ROOT, "package.json")) || !fs.existsSync(path.join(ROOT, "core"))) {
  console.error(`\n  Not inside the Osama project root.\n  Looked in: ${ROOT}\n`);
  process.exit(1);
}

const need = [
  ["core/dist/index.js", "core"],
  ["server/dist/index.js", "server"],
  ["ui/dist/index.html", "ui"],
];

const missing = need.filter(([rel]) => !fs.existsSync(path.join(ROOT, rel)));

if (missing.length) {
  const cwd = process.cwd();
  console.error(`
  Osama is not built yet — missing: ${missing.map(([rel]) => rel).join(", ")}

  Run these from the project root (${ROOT}):
    npm install
    npm run build
    npm start
${cwd !== ROOT ? `\n  Note: your shell is in ${cwd}\n  cd to the root first:  cd ${ROOT}\n` : ""}`);
  process.exit(1);
}
