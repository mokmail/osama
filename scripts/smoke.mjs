#!/usr/bin/env node
/**
 * Osama smoke test — exercises the whole engine against the running API and a
 * real llama.cpp build, printing PASS/FAIL per step.
 *
 *   npm start                 # in one terminal (API on :5178)
 *   node scripts/smoke.mjs    # in another
 *
 * Flags:
 *   --port <n>      base API port (default 5178)
 *   --serve-port <n> port for the llama-server test (default 8097)
 *   --no-chat       skip the inference step (fast, no model needed)
 *   --json          machine-readable output
 */
import * as core from "../core/dist/index.js";

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
};
const BASE = `http://127.0.0.1:${flag("port", 5178)}`;
const SERVE_PORT = Number(flag("serve-port", 8097));
const SKIP_CHAT = Boolean(flag("no-chat", false));
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

async function main() {
  if (!AS_JSON) console.log(`\nOsama smoke test → ${BASE}\n`);

  // ---------------------------------------------------------------- API up
  let health;
  try {
    health = await api("/api/health");
  } catch (err) {
    console.error(`\n\x1b[31mThe Osama API is not reachable at ${BASE}\x1b[0m`);
    console.error(`Start it first:  \x1b[1mnpm start\x1b[0m\n`);
    process.exit(2);
  }
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

  // ---------------------------------------------------------------- hub
  try {
    const hub = await api("/api/hub/search?q=qwen3&limit=3");
    record("Hugging Face search", hub.models.length > 0, `${hub.models.length} results`);
  } catch (err) {
    record("Hugging Face search", false, err.message);
  }

  // ---------------------------------------------------------------- models
  const models = await api("/api/models");
  const model = models.models?.find((m) => !m.missing);
  record("Local model library scanned", Array.isArray(models.models), `${models.models?.length ?? 0} model(s)`);

  // ------------------------------------------------------- live inference
  if (active && model && !SKIP_CHAT) {
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
          const content = [...text.matchAll(/"content":"([^"]*)"/g)].map((m) => m[1]).join("");
          record("Chat: streamed completion", content.trim().length > 0, JSON.stringify(content.slice(0, 40)));
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
  } else if (!model) {
    record("Serve + chat (llama-server)", false, "no model in library — run: node scripts/osama.mjs pull ggml-org/gemma-3-1b-it-GGUF gemma-3-1b-it-Q4_K_M.gguf");
  }

  // ---------------------------------------------------------------- report
  if (AS_JSON) {
    console.log(JSON.stringify({ base: BASE, passed: results.length - failed, failed, results }, null, 2));
  } else {
    const ok = results.length - failed;
    console.log(`\n  ${ok}/${results.length} checks passed${failed ? `, \x1b[31m${failed} failed\x1b[0m` : ""}\n`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nsmoke test crashed: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
