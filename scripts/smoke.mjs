#!/usr/bin/env node
/**
 * Osama smoke test — exercises the whole engine against a real llama.cpp build
 * and a real model, printing PASS/FAIL per step.
 *
 * Self-hosting: if no engine answers on the target port, this starts one
 * (`server/dist/index.js`), runs the checks, and shuts it down again. So it
 * works whether or not you already have `npm start` running, and a single
 * command is enough to prove the app builds and runs.
 *
 *   npm run smoke          # start an engine if needed, test, tear down
 *   npm start              # in one terminal
 *   node scripts/smoke.mjs # in another — reuses the one already running
 *
 * Flags:
 *   --port <n>       base API port (default 5178)
 *   --serve-port <n> port for the llama-server test (default: first free >=8097)
 *   --no-chat        skip the inference step (fast, no model needed)
 *   --no-spawn       never start an engine; fail if none is reachable
 *   --json           machine-readable output
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../core/dist/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
};
const PORT = Number(flag("port", 5178));
const BASE = `http://127.0.0.1:${PORT}`;
const SERVE_PORT_FLAG = flag("serve-port", null);
const SKIP_CHAT = Boolean(flag("no-chat", false));
const NO_SPAWN = Boolean(flag("no-spawn", false));
const AS_JSON = Boolean(flag("json", false));

const results = [];
let failed = 0;

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  if (!AS_JSON) {
    const mark = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
    console.log(`  ${mark}  ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
  }
}

async function api(path, init) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The engine answers? */
async function engineUp() {
  try {
    const h = await api("/api/health");
    return h?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Start the engine ourselves, wait for it, and hand back a stopper. Returns
 * null when the build is missing or the process died — the caller then reports
 * an actionable failure rather than a bare "not reachable".
 */
async function startEngine() {
  const entry = path.join(ROOT, "server", "dist", "index.js");
  if (!(await import("node:fs")).existsSync(entry)) return null;

  const child = spawn(process.execPath, [entry], {
    cwd: ROOT,
    env: { ...process.env, OSAMA_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout?.on("data", (d) => (log += String(d)));
  child.stderr?.on("data", (d) => (log += String(d)));

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await engineUp()) {
      return async () => {
        child.kill("SIGTERM");
        // The engine reaps its own llama.cpp children on SIGTERM; give it a beat.
        await sleep(400);
        if (child.exitCode === null) child.kill("SIGKILL");
      };
    }
    if (child.exitCode !== null) return { error: log.split("\n").slice(-6).join("\n") };
    await sleep(300);
  }
  child.kill("SIGKILL");
  return { error: `the engine did not answer on ${BASE} within 20s\n${log.split("\n").slice(-6).join("\n")}` };
}

async function main() {
  if (!AS_JSON) console.log(`\nOsama smoke test → ${BASE}\n`);

  // ---------------------------------------------------------------- API up
  let stopEngine = null;
  let already = await engineUp();
  if (!already && !NO_SPAWN) {
    if (!AS_JSON) console.log(`  \x1b[2mno engine on ${PORT} — starting one for the test\x1b[0m`);
    const r = await startEngine();
    if (r && typeof r === "function") {
      stopEngine = r;
      already = true;
    } else {
      record("API reachable (/api/health)", false, (r && r.error) || "could not start the engine");
    }
  }

  if (!already) {
    if (!failed) record("API reachable (/api/health)", false, `nothing listening on ${PORT}`);
    return report();
  }

  try {
    await runChecks();
  } finally {
    if (stopEngine) await stopEngine();
  }
  report();
}

function report() {
  if (AS_JSON) {
    console.log(JSON.stringify({ base: BASE, passed: results.length - failed, failed, results }, null, 2));
  } else {
    const ok = results.length - failed;
    console.log(`\n  ${ok}/${results.length} checks passed${failed ? `, \x1b[31m${failed} failed\x1b[0m` : ""}\n`);
  }
  process.exit(failed ? 1 : 0);
}

async function runChecks() {
  const health = await api("/api/health");
  record("API reachable (/api/health)", health?.ok === true, `v${health?.version}`);

  // ---------------------------------------------------------------- system
  const sys = await api("/api/system");
  record("System + GPU probe", Boolean(sys.system?.os && sys.gpu), `${sys.system.os}/${sys.system.arch}, ${sys.gpu.name}`);
  record("Acceleration recommended", typeof sys.recommendedAcceleration === "string", sys.recommendedAcceleration);

  // ---------------------------------------------------------------- engine
  const engine = await api("/api/engine");
  const active = engine.active;
  record("llama.cpp engine installed", Boolean(active), active ? `${active.tag} (${active.acceleration})` : "none — install from the llama.cpp view");
  if (!active) {
    record("Tool binaries present", false, "no engine installed");
  } else {
    const toolCount = Object.keys(active.tools).length;
    record("Tool binaries discovered", toolCount >= 10, `${toolCount} tools`);
  }

  // ---------------------------------------------------------------- tools
  const tools = await api("/api/tools");
  record("Tool catalogue served", tools.tools.length >= 10, `${tools.tools.length} tools`);

  const preview = await api("/api/command/preview", {
    method: "POST",
    body: JSON.stringify({ tool: "server", values: { model: "/tmp/x.gguf", port: 1234, ctx: 4096, gpuLayers: 999 } }),
  });
  record("Command builder produces argv", preview.argv.includes("-m") && preview.argv.includes("-ngl"), preview.command.slice(0, 60) + "…");

  // The GGUF-edit plan is the other argv builder that must not regress: the
  // override type spelling and options-before-positionals order both matter.
  const editPlan = core.planEdit("/tmp/a.gguf", "/tmp/b.gguf", [{ key: "general.name", type: "str", value: "X" }]);
  record(
    "GGUF edit plan builds a valid override",
    editPlan.ok && editPlan.argv.includes("general.name=str:X") && editPlan.argv.at(-1) === "COPY",
    editPlan.overrides?.[0] ?? editPlan.error ?? "",
  );

  // ---------------------------------------------------------------- hub
  try {
    const hub = await api("/api/hub/search?q=qwen3&limit=3");
    record("Hugging Face search", hub.models.length > 0, `${hub.models.length} results`);
  } catch (err) {
    record("Hugging Face search", false, err.message);
  }

  // ---------------------------------------------------------------- models
  const models = await api("/api/models");
  record("Local model library scanned", Array.isArray(models.models), `${models.models?.length ?? 0} model(s)`);

  /**
   * Pick a model to exercise. The newest library entry is not a good default:
   * a build cannot load every architecture (an unrecognised `general.architecture`
   * is refused at load time), and a MoE at an extreme quant can segfault on a
   * CPU-only build. Prefer a small model whose architecture this build is known
   * to handle, and say which one was chosen so a failure is attributable.
   */
  const KNOWN_GOOD = /^(llama|gemma3?|qwen2|qwen3|qwen3moe|phi3|phi4|mistral|deepseek2?|gpt2|mpt|falcon|starcoder2?)$/i;
  const usable = (m) =>
    !m.missing &&
    !m.draftOnly &&
    (m.card?.architecture ? KNOWN_GOOD.test(m.card.architecture) : true);
  const model =
    models.models?.filter((m) => usable(m) && m.sizeBytes < 3 * 1024 ** 3).sort((a, b) => a.sizeBytes - b.sizeBytes)[0] ??
    models.models?.find(usable) ??
    models.models?.find((m) => !m.missing);
  if (model) {
    record("Usable model for inference", true, `${model.name} (${model.card?.architecture ?? "?"})`);
  }

  if (!(active && model && !SKIP_CHAT)) {
    if (!model) record("Serve + chat (llama-server)", false, "no model in library — run: node scripts/osama.mjs pull ggml-org/gemma-3-1b-it-GGUF gemma-3-1b-it-Q4_K_M.gguf");
    return;
  }

  // ------------------------------------------------------- live inference
  // A fixed default port is a coin flip on a busy machine, so take the first
  // free one unless the caller pinned it.
  const SERVE_PORT = SERVE_PORT_FLAG
    ? Number(SERVE_PORT_FLAG)
    : (await core.findFreePort("127.0.0.1", 8097, 8097 + 40)) ?? 8097;

  let procId = null;
  try {
    if (!(await core.isPortFree("127.0.0.1", SERVE_PORT))) {
      record("Serve + chat (llama-server)", false, `port ${SERVE_PORT} busy — pass --serve-port <n>`);
    } else {
      const started = await api("/api/processes", {
        method: "POST",
        body: JSON.stringify({
          tool: "server",
          values: { model: model.file, port: SERVE_PORT, host: "127.0.0.1", gpuLayers: 0, ctx: 2048, jinja: true, parallel: 1 },
        }),
      });
      procId = started.process.id;
      let healthy = false;
      for (let i = 0; i < 60; i++) {
        await sleep(1000);
        const h = await api(`/api/server/health?baseUrl=http://127.0.0.1:${SERVE_PORT}`);
        if (h.ok) {
          healthy = true;
          break;
        }
      }
      record("Serve: llama-server reaches /health", healthy, `http://127.0.0.1:${SERVE_PORT}`);

      if (healthy) {
        const res = await fetch(`${BASE}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            baseUrl: `http://127.0.0.1:${SERVE_PORT}`,
            payload: { messages: [{ role: "user", content: "Reply with exactly: OK" }], stream: true, max_tokens: 12, temperature: 0 },
          }),
        });
        const text = await res.text();
        const content = [...text.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join("");
        // llama-server streams {"error":{...}} WITH HTTP 200 on a compute
        // failure, so a bare "no text" would hide the cause. Surface it.
        const err = /"error":\{[^}]*"message":"([^"]*)"/.exec(text)?.[1];
        if (!content.trim() && err) {
          record("Chat: streamed completion", false, `llama-server: ${err}`);
        } else {
          record("Chat: streamed completion", content.trim().length > 0, JSON.stringify(content.slice(0, 40)));
        }
      }
    }
  } catch (err) {
    record("Serve + chat (llama-server)", false, err.message);
  } finally {
    if (procId) {
      const stopped = await api(`/api/processes/${procId}/stop`, { method: "POST" }).catch(() => ({ ok: false }));
      record("Process stop (SIGTERM)", stopped.ok === true);
    }
  }
}

main().catch((err) => {
  console.error(`\nsmoke test crashed: ${err.stack ?? err.message}\n`);
  process.exit(1);
});

