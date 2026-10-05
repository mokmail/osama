#!/usr/bin/env node
/**
 * Osama headless CLI — drive the same engine the GUI uses, from the terminal.
 * Useful for automation, CI, and verifying the engine end to end.
 *
 *   node scripts/osama.mjs system
 *   node scripts/osama.mjs releases
 *   node scripts/osama.mjs install --accel cpu|metal|cuda|vulkan|rocm
 *   node scripts/osama.mjs engines
 *   node scripts/osama.mjs search "qwen3" [--limit 10]
 *   node scripts/osama.mjs repo <user/model>
 *   node scripts/osama.mjs pull <user/model> <file.gguf>
 *   node scripts/osama.mjs models
 *   node scripts/osama.mjs card <path/to/model.gguf>
 *   node scripts/osama.mjs cmd <tool> --set key=value ...
 *   node scripts/osama.mjs run <tool> --set key=value ...
 */
import * as core from "../core/dist/index.js";

const argv = process.argv.slice(2);
const cmd = argv[0];

function flag(name, def) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

function sets() {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--set" && argv[i + 1]) {
      const [k, ...rest] = argv[i + 1].split("=");
      const raw = rest.join("=");
      values[k] = raw === "true" ? true : raw === "false" ? false : raw !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
      i++;
    }
  }
  return values;
}

const fmt = (n) => core.paths && n;

async function main() {
  switch (cmd) {
    case "system": {
      const info = core.systemInfo();
      const gpu = await core.probeGpu();
      console.log(JSON.stringify({ ...info, gpu, recommended: gpu.acceleration, home: core.paths().home }, null, 2));
      break;
    }
    case "paths":
      console.log(JSON.stringify(core.paths(), null, 2));
      break;
    case "releases": {
      const rel = await core.listReleases(Number(flag("limit", 5)));
      for (const r of rel) console.log(`${r.tag}  ${r.publishedAt}  ${r.assets.length} assets`);
      break;
    }
    case "install": {
      const accel = flag("accel", undefined);
      const engine = await core.installEngine({
        acceleration: accel,
        onProgress: (stage, p) => {
          if (p) process.stderr.write(`\r${stage} ${(p.percent ? (p.percent * 100).toFixed(1) : "?")}%   `);
          else process.stderr.write(`\n${stage}\n`);
        },
      });
      process.stderr.write("\n");
      console.log(JSON.stringify({ tag: engine.tag, acceleration: engine.acceleration, dir: engine.dir, tools: Object.keys(engine.tools) }, null, 2));
      break;
    }
    case "engines": {
      const engines = core.listInstalled();
      const active = core.getActiveEngine();
      console.log(JSON.stringify({ active: active?.tag, engines }, null, 2));
      break;
    }
    case "search": {
      const q = argv[1] ?? "";
      const models = q ? await core.searchModels(q, { limit: Number(flag("limit", 15)) }) : await core.trendingModels(Number(flag("limit", 15)));
      for (const m of models) console.log(`${m.id}  ↓${m.downloads ?? 0}  ♥${m.likes ?? 0}`);
      break;
    }
    case "repo": {
      const repo = argv[1];
      if (!repo) throw new Error("usage: osama repo <user/model>");
      const r = await core.repoFiles(repo);
      console.log(`${r.id} — ${r.files.length} gguf files, total ${(r.totalSize / 1024 ** 3).toFixed(2)} GB`);
      for (const f of r.files) console.log(`  ${f.isMmproj ? "mmproj " : "       "}${(f.size / 1024 ** 2).toFixed(0).padStart(6)} MB  ${f.quant ?? "-"}  ${f.path}`);
      break;
    }
    case "pull": {
      const [repo, file] = [argv[1], argv[2]];
      if (!repo || !file) throw new Error("usage: osama pull <user/model> <file.gguf>");
      const model = await core.downloadModel({
        repo,
        file,
        onProgress: (rec) => {
          const pct = rec.total ? ((rec.received / rec.total) * 100).toFixed(1) : "?";
          process.stderr.write(`\r${pct}%  ${(rec.received / 1024 ** 2).toFixed(0)}/${rec.total ? (rec.total / 1024 ** 2).toFixed(0) : "?"} MB   `);
        },
      });
      process.stderr.write("\n");
      console.log(JSON.stringify(model, null, 2));
      break;
    }
    case "models": {
      const models = core.scanModelsDir();
      for (const m of models) console.log(`${m.card?.quantization ?? "?"}  ${(m.sizeBytes / 1024 ** 2).toFixed(0).padStart(6)} MB  ${m.name}  ${m.file}`);
      break;
    }
    case "card": {
      const file = argv[1];
      if (!file) throw new Error("usage: osama card <model.gguf>");
      console.log(JSON.stringify(core.describeModel(file), null, 2));
      break;
    }
    case "cmd": {
      const tool = argv[1];
      if (!tool) throw new Error("usage: osama cmd <tool> --set key=value");
      const spec = core.toolSpec(tool);
      const bin = core.resolveTool(spec.binary);
      const args = core.buildArgv(tool, sets());
      console.log(core.renderCommand(bin, args));
      break;
    }
    case "run": {
      const tool = argv[1];
      if (!tool) throw new Error("usage: osama run <tool> --set key=value");
      const spec = core.toolSpec(tool);
      const bin = core.resolveTool(spec.binary);
      const args = core.buildArgv(tool, sets());
      console.log(`$ ${core.renderCommand(spec.binary, args)}\n`);
      const res = await core.runToCompletion(bin, args, { onLine: (l) => console.log(l) });
      console.log(`\n[exit ${res.code} in ${(res.durationMs / 1000).toFixed(1)}s]`);
      process.exitCode = res.code ?? 1;
      break;
    }
    case "tools":
      for (const t of core.allTools()) console.log(`${t.id.padEnd(15)} ${t.group.padEnd(11)} ${t.mode.padEnd(8)} ${t.binary}`);
      break;
    default:
      console.log(`Osama CLI

  system                        machine + GPU probe
  paths                         where Osama keeps its data
  tools                         list the llama.cpp tools Osama can drive
  releases [--limit N]          recent llama.cpp releases
  install [--accel cpu|metal|cuda|vulkan|rocm|sycl|openvino]
  engines                       installed llama.cpp builds
  search <query> [--limit N]    search the Hugging Face Hub
  repo <user/model>             GGUF files in a repo
  pull <user/model> <file>      download a GGUF into the library
  models                        scan + list the local library
  card <path.gguf>              read a GGUF's metadata
  cmd <tool> --set k=v …        print the exact command
  run <tool> --set k=v …        run a tool to completion`);
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
