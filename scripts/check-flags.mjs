#!/usr/bin/env node
/**
 * Flag contract checker — one catalogue, two engines.
 *
 * Osama's whole value proposition is that it drives the REAL tools, and that only
 * holds if every flag in `core/src/commands/` (the one source of truth for the UI) is
 * actually accepted by the tool that will run it. So each spec is asked the question
 * in its own engine's language:
 *
 *   llamacpp  the installed llama.cpp build — `spec.binary` is a path in its tools map.
 *   mlx       Osama's own mlx-lm environment — `spec.binary` is a console script in
 *             `<osama>/mlx/venv/bin`, and the answer comes from that script's `--help`.
 *
 * A flag that is absent is printed as FAIL: those are the ones that silently break a
 * command at runtime. Two statuses are deliberately NOT failures, because neither one
 * is evidence about the flag:
 *
 *   SKIP          the tool cannot be asked here (another OS, no MLX runtime, a binary
 *                 the installed llama.cpp build does not ship).
 *   UNVERIFIABLE  the script cannot start at all — `mlx_lm.evaluate` needs mlx-lm's
 *                 `evaluate` extra, and without it dies on `import lm_eval` before it
 *                 parses a single argument. The installed package's own source is
 *                 checked instead, and the output says so.
 *
 *   node scripts/check-flags.mjs                 # active llama.cpp engine + MLX
 *   node scripts/check-flags.mjs --tag b11398    # a specific llama.cpp build
 *   node scripts/check-flags.mjs --json
 *
 * Exit code is non-zero when any declared flag is missing, so it can gate CI.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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

/** Run a tool for its usage text. A tool that writes it to stderr and exits non-zero
 *  (or one that cannot start) is still read — only the text matters here. */
function helpOutput(cmd, argv = ["--help"], timeout = 60_000) {
  const r = spawnSync(cmd, argv, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout });
  return { text: `${r.stdout ?? ""}${r.stderr ?? ""}`, failed: Boolean(r.error) };
}

/** Every flag a usage text mentions: --long-flag and -short. */
function flagsInText(text) {
  const set = new Set();
  for (const m of text.matchAll(/(^|[\s,[|])(--[a-z0-9][a-z0-9-]*)/gi)) set.add(m[2]);
  for (const m of text.matchAll(/(^|[\s,[|])(-[a-zA-Z][a-z0-9-]*)(?=[\s,|<]|$)/g)) set.add(m[2]);
  return set;
}

/* ------------------------------------------------------------------ llama.cpp */

function checkLlama(spec, engine, results) {
  const binary = engine.tools[spec.binary];
  if (!binary) {
    results.push({ tool: spec.id, engine: "llamacpp", binary: spec.binary, status: "missing-binary", missing: [] });
    return;
  }
  const { text } = helpOutput(binary);
  const available = flagsInText(text);
  const missing = [];
  const seen = new Set();
  for (const p of spec.params) {
    if (!p.flag || p.positional) continue;
    if (seen.has(p.flag)) continue;
    seen.add(p.flag);
    // A param may declare aliases; any one of them being present is enough.
    const candidates = [p.flag, ...(p.aliases ?? [])];
    if (!candidates.some((c) => available.has(c))) missing.push(`${p.key} (${p.flag})`);
  }
  results.push({ tool: spec.id, engine: "llamacpp", binary: spec.binary, status: missing.length ? "fail" : "ok", missing });
}

/* ------------------------------------------------------------------------ MLX */

/** Where the installed mlx-lm package lives — `<venv>/lib/python3.x/site-packages`. */
function mlxSitePackages() {
  const site = path.join(path.dirname(path.dirname(core.mlxPaths().python)), "lib");
  try {
    const pyDir = fs.readdirSync(site).find((d) => /^python3\.\d+$/.test(d));
    return pyDir ? path.join(site, pyDir, "site-packages") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The flags a console script's own module declares, read from the installed source.
 *
 * This is the fallback for a tool that cannot start — the file is what the script
 * would run, so it answers the same question, one level down. The caller says which
 * of the two answers it got.
 */
function flagsFromSource(consoleName) {
  const site = mlxSitePackages();
  if (!site) return undefined;
  const parts = consoleName.split(".");
  if (parts.length !== 2) return undefined;
  const file = path.join(site, parts[0], `${parts[1]}.py`);
  let src;
  try {
    src = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const set = new Set();
  // Both spellings argparse code uses: the flag as the first argument, and the
  // wrapped form where it sits on its own line inside add_argument(…).
  for (const m of src.matchAll(/add_argument\(\s*"(--[A-Za-z0-9][-A-Za-z0-9]*)"/g)) set.add(m[1]);
  for (const m of src.matchAll(/^\s*"(--[A-Za-z0-9][-A-Za-z0-9]*)",?$/gm)) set.add(m[1]);
  return { set, file };
}

function checkMlx(spec, results) {
  const support = core.mlxSupport();
  if (!support.supported) {
    results.push({ tool: spec.id, engine: "mlx", binary: spec.binary, status: "skip", detail: support.reason, missing: [] });
    return;
  }
  const script = path.join(core.mlxPaths().bin, spec.binary);
  if (!fs.existsSync(script)) {
    results.push({ tool: spec.id, engine: "mlx", binary: spec.binary, status: "skip", detail: "no MLX runtime installed", missing: [] });
    return;
  }

  const { text, failed } = helpOutput(script);
  let available = flagsInText(text);
  let via = "its own --help";
  // No usage text at all, or a traceback instead of one: the script never got as far
  // as argparse. Read the module it would have run instead, and say that we did.
  const crashed = !failed && /Traceback \(most recent call last\)/.test(text) && !/^usage:/m.test(text);
  if (crashed || (failed && !/^usage:/m.test(text))) {
    const fallback = flagsFromSource(spec.binary);
    if (!fallback) {
      const line = text.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "no output";
      results.push({ tool: spec.id, engine: "mlx", binary: spec.binary, status: "unavailable", detail: line, missing: [] });
      return;
    }
    available = fallback.set;
    via = `the installed source (${path.relative(mlxSitePackages(), fallback.file)}) — the script cannot start here`;
  }

  const missing = [];
  const seen = new Set();
  for (const p of spec.params) {
    if (!p.flag || p.positional) continue;
    if (seen.has(p.flag)) continue;
    seen.add(p.flag);
    const candidates = [p.flag, ...(p.aliases ?? [])];
    if (!candidates.some((c) => available.has(c))) missing.push(`${p.key} (${p.flag})`);
  }
  results.push({ tool: spec.id, engine: "mlx", binary: spec.binary, status: missing.length ? "fail" : "ok", via, missing });
}

/* ------------------------------------------------------------------------ main */

function main() {
  const engine = TAG ? core.listInstalled().find((e) => e.tag === TAG) : core.getActiveEngine();
  const mlxOk = core.mlxSupport().supported && fs.existsSync(path.join(core.mlxPaths().bin, "mlx_lm.generate"));
  if (!engine && !mlxOk) {
    console.error("nothing to check: no llama.cpp engine installed and no MLX runtime (npm start → Models)");
    process.exit(2);
  }

  const results = [];
  for (const spec of core.allTools()) {
    if ((spec.engine ?? "llamacpp") === "mlx") checkMlx(spec, results);
    else if (engine) checkLlama(spec, engine, results);
    else results.push({ tool: spec.id, engine: "llamacpp", binary: spec.binary, status: "missing-binary", missing: [] });
  }

  const failed = results.filter((r) => r.status === "fail");
  const unchecked = results.filter((r) => r.status !== "ok" && r.status !== "fail");
  const checkable = results.length - unchecked.length;

  if (AS_JSON) {
    console.log(JSON.stringify({ engine: engine?.tag ?? null, results, failed: failed.length }, null, 2));
  } else {
    console.log(
      `\nFlag contract check → ${engine ? `${engine.tag} (${engine.acceleration})` : "no llama.cpp build"}` +
        `${mlxOk ? " + MLX" : ""}\n`,
    );
    for (const r of results) {
      const bin = r.binary.padEnd(20);
      if (r.status === "ok") {
        console.log(`  \x1b[32mPASS\x1b[0m  ${r.tool.padEnd(18)} ${bin}${r.via ? `\x1b[2m(${r.via})\x1b[0m` : ""}`);
      } else if (r.status === "fail") {
        console.log(`  \x1b[31mFAIL\x1b[0m  ${r.tool.padEnd(18)} ${bin}\n        missing: ${r.missing.join(", ")}`);
      } else if (r.status === "unavailable") {
        console.log(`  \x1b[33mNO HELP\x1b[0m ${r.tool.padEnd(18)} ${bin}\n        ${r.detail}`);
      } else if (r.status === "missing-binary") {
        console.log(`  \x1b[2mSKIP\x1b[0m  ${r.tool.padEnd(18)} ${bin}(not in this build)\x1b[0m`);
      } else {
        console.log(`  \x1b[2mSKIP\x1b[0m  ${r.tool.padEnd(18)} ${bin}(${r.detail ?? "not available here"})\x1b[0m`);
      }
    }
    console.log(
      `\n  ${checkable - failed.length}/${checkable} tools have a complete flag set` +
        (failed.length ? `, \x1b[31m${failed.length} with missing flags\x1b[0m` : "") +
        (unchecked.length ? `, ${unchecked.length} not checkable here` : "") +
        "\n",
    );
  }
  process.exit(failed.length ? 1 : 0);
}

main();
