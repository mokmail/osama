#!/usr/bin/env node
/**
 * Flag contract checker.
 *
 * Osama's whole value proposition is that it drives the REAL llama.cpp
 * binaries. That only holds if every flag in `core/src/commands.ts` (the one
 * source of truth for the UI) is actually accepted by the installed build.
 *
 * This script asks each installed binary for its `--help` and proves that
 * every flag Osama would emit exists there. Flags that are absent are printed
 * as FAIL — they are the ones that silently break a command at runtime.
 *
 *   node scripts/check-flags.mjs                 # active engine
 *   node scripts/check-flags.mjs --tag b11398    # a specific build
 *   node scripts/check-flags.mjs --json
 *
 * Exit code is non-zero when any declared flag is missing, so it can gate CI.
 */
import * as core from "../core/dist/index.js";

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
};
const AS_JSON = Boolean(flag("json", false));
const TAG = flag("tag", undefined);

import { spawnSync } from "node:child_process";

function flagsOf(binaryPath) {
  // spawnSync (not execFileSync) so a tool that writes usage to stderr and
  // exits non-zero is still read; both streams are always captured.
  const r = spawnSync(binaryPath, ["--help"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const set = new Set();
  // Long flags: --foo-bar ; short flags: -np, -ngl, -c
  for (const m of text.matchAll(/(^|[\s,[|])(--[a-z0-9][a-z0-9-]*)/gi)) set.add(m[2]);
  for (const m of text.matchAll(/(^|[\s,[|])(-[a-zA-Z][a-z0-9-]*)(?=[\s,|<]|$)/g)) set.add(m[2]);
  return set;
}

/** Flags that are universal in llama.cpp's common params (accepted everywhere). */
function main() {
  const engine = TAG ? core.listInstalled().find((e) => e.tag === TAG) : core.getActiveEngine();
  if (!engine) {
    console.error("no llama.cpp engine installed — install one first (npm start → llama.cpp view)");
    process.exit(2);
  }

  const results = [];
  for (const spec of core.allTools()) {
    const binary = engine.tools[spec.binary];
    if (!binary) {
      results.push({ tool: spec.id, binary: spec.binary, status: "missing-binary", missing: [] });
      continue;
    }
    const available = flagsOf(binary);
    const missing = [];
    const seen = new Set();
    for (const p of spec.params) {
      if (!p.flag || p.positional) continue;
      if (seen.has(p.flag)) continue;
      seen.add(p.flag);
      // A param may declare aliases; any one of them being present is enough.
      const candidates = [p.flag, ...(p.aliases ?? [])];
      const ok = candidates.some((c) => available.has(c));
      if (!ok) missing.push(`${p.key} (${p.flag})`);
    }
    results.push({ tool: spec.id, binary: spec.binary, status: missing.length ? "fail" : "ok", missing });
  }

  const failed = results.filter((r) => r.status === "fail");
  const missingBins = results.filter((r) => r.status === "missing-binary");

  if (AS_JSON) {
    console.log(JSON.stringify({ engine: engine.tag, results, failed: failed.length }, null, 2));
  } else {
    console.log(`\nFlag contract check → engine ${engine.tag} (${engine.acceleration})\n`);
    for (const r of results) {
      if (r.status === "ok") console.log(`  \x1b[32mPASS\x1b[0m  ${r.tool.padEnd(14)} ${r.binary}`);
      else if (r.status === "missing-binary") console.log(`  \x1b[2mSKIP\x1b[0m  ${r.tool.padEnd(14)} ${r.binary} (not in this build)`);
      else console.log(`  \x1b[31mFAIL\x1b[0m  ${r.tool.padEnd(14)} ${r.binary}\n        missing: ${r.missing.join(", ")}`);
    }
    console.log(`\n  ${results.length - failed.length - missingBins.length}/${results.length - missingBins.length} tools have a complete flag set` +
      (failed.length ? `, \x1b[31m${failed.length} with missing flags\x1b[0m` : "") + "\n");
  }
  process.exit(failed.length ? 1 : 0);
}

main();
