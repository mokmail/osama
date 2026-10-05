#!/usr/bin/env node
/**
 * Catalogue-driven flag contract test.
 *
 * For every parameter in `core/src/commands.ts` this builds the argv Osama
 * would actually emit (via `buildArgv`) and runs the real binary with a bad
 * model path. The argument parser runs BEFORE any model is opened, so
 *   - "unknown argument / invalid option / invalid ftype" => the flag is WRONG
 *   - anything else (model load error, …)                  => the flag is fine
 *
 * This is the test that catches a flag the way the app actually uses it, so it
 * also proves positional placement (e.g. llama-quantize's trailing nthreads).
 *
 *   node scripts/probe-flags.mjs
 *   node scripts/probe-flags.mjs --json
 */
import { spawnSync } from "node:child_process";
import * as core from "../core/dist/index.js";

const argv = process.argv.slice(2);
const AS_JSON = argv.includes("--json");

const BAD_MODEL = "/nonexistent/osama-probe.gguf";
const BAD_OUT = "/tmp/osama-probe-out.gguf";

const engine = core.getActiveEngine();
if (!engine) {
  console.error("no llama.cpp engine installed — install one first");
  process.exit(2);
}

/** A plausible value for a param, typed from its spec. */
function sampleValue(p) {
  if (p.type === "bool") return true;
  if (p.type === "number") return 4;
  if (p.type === "enum") return p.enum?.[0] ?? "auto";
  if (p.key === "input" || p.key === "model") return BAD_MODEL;
  if (p.key === "output") return BAD_OUT;
  return "osama-probe";
}

/** Fill every positional the tool needs so the parser reaches the flag. */
function baseValues(spec) {
  const v = {};
  for (const p of spec.params) {
    if (p.positional && p.type !== "bool") v[p.key] = sampleValue(p);
  }
  return v;
}

function rejected(binary, args) {
  const r = spawnSync(binary, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 25000 });
  const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  // Match the tools' OWN argument-parser complaints only. A bare /invalid/
  // would also hit llama.cpp's benign "tensor API disabled ..." init line and
  // report a false failure.
  //  - "unknown argument" / "invalid argument" / "invalid option"  → cli parser
  //  - "invalid ftype"                                             → quantize
  //    telling us a positional landed in the wrong slot, which is exactly the
  //    class of bug this test exists to catch.
  return /unknown argument|invalid argument|unrecognized arguments|invalid option|error: unrecognized|invalid ftype|too many positional/i.test(text);
}

const results = [];
for (const spec of core.allTools()) {
  const binary = engine.tools[spec.binary];
  if (!binary) {
    results.push({ tool: spec.id, param: "*", status: "skip", detail: "binary not in this build" });
    continue;
  }
  for (const p of spec.params) {
    if (p.hidden) continue;
    if (!p.flag && !p.positional) continue;
    const values = { ...baseValues(spec), [p.key]: sampleValue(p) };
    // A positional already gets a good value above; only re-test it if the
    // tool has more than one of the same type (split in/out).
    const args = core.buildArgv(spec.id, values);
    const bad = rejected(binary, args);
    results.push({
      tool: spec.id,
      param: p.key,
      flag: p.flag || "(positional)",
      argv: args,
      status: bad ? "reject" : "ok",
    });
  }
}

const rejects = results.filter((r) => r.status === "reject");

if (AS_JSON) {
  console.log(JSON.stringify({ engine: engine.tag, rejects, results }, null, 2));
} else {
  console.log(`\nFlag contract → engine ${engine.tag} (${engine.acceleration}), ${results.length} params\n`);
  for (const r of rejects) {
    console.log(`  \x1b[31mREJECT\x1b[0m  ${r.tool.padEnd(12)} ${r.param.padEnd(20)} ${r.flag}`);
    console.log(`          ${r.argv.map((a) => (a === BAD_MODEL ? "<bad>" : a)).join(" ")}`);
  }
  const ok = results.length - rejects.length;
  console.log(`\n  ${ok}/${results.length} parameters accepted by the real build` +
    (rejects.length ? `, \x1b[31m${rejects.length} rejected\x1b[0m` : "") + "\n");
}
process.exit(rejects.length ? 1 : 0);
