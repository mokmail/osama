#!/usr/bin/env node
/**
 * Osama — one-command setup and run.
 *
 *   ./start.sh                    install → build → serve
 *   ./start.sh --dev              install → dev mode (hot reload, no build)
 *   ./start.sh --port 8080        use another port
 *   ./start.sh --host 0.0.0.0     listen on every interface
 *   ./start.sh --no-install       skip npm install (deps already there)
 *   ./start.sh --rebuild          force a build even if one exists
 *   ./start.sh --clean            remove node_modules and dist first
 *   ./start.sh --check            install + build + typecheck, then stop
 *   ./start.sh --help
 *
 * Fresh clone:
 *   git clone https://github.com/mokmail/osama.git && cd osama && ./start.sh
 *
 * What it does, and why each step is not optional:
 *   1. verifies Node >= 20.10 (the engine uses modern ESM + node:test APIs)
 *   2. installs dependencies (falls back to `npm install` if the lockfile and
 *      package.json have drifted, which `npm ci` refuses to do)
 *   3. builds core → ui → server. There is no watcher in `npm start`, so the
 *      server runs from `dist/` — an unbuilt tree produces a module-not-found
 *      error rather than a running engine.
 *   4. serves the UI from the engine itself on http://127.0.0.1:5178
 *
 * Osama does NOT ship a model. After it is up, open the UI, go to Discover or
 * the llama.cpp page, install an engine build and pull a GGUF — an engine with
 * no model loaded can answer nothing.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IS_WIN = process.platform === "win32";

/* ------------------------------------------------------------------ output */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = c("1");
const dim = c("2");
const red = c("31");
const green = c("32");
const yellow = c("33");
const cyan = c("36");

const step = (n, total, msg) => console.log(`\n${bold(`[${n}/${total}]`)} ${bold(msg)}`);
const info = (msg) => console.log(`  ${msg}`);
const ok = (msg) => console.log(`  ${green("✓")} ${msg}`);
const warn = (msg) => console.log(`  ${yellow("!")} ${msg}`);
const die = (msg, hint) => {
  console.error(`\n${red("✗")} ${msg}`);
  if (hint) console.error(`\n${hint}\n`);
  process.exit(1);
};

/* ------------------------------------------------------------------- usage */

const USAGE = `
${bold("Osama — setup and run in one command")}

  ${cyan("./start.sh")}                 install, build, then serve
  ${cyan("./start.sh --dev")}           run in dev mode (hot reload, no build)
  ${cyan("./start.sh --check")}         install + build + typecheck, then stop

${bold("Options")}
  --port <n>        port to serve on                ${dim("(default: 5178, env OSAMA_PORT)")}
  --host <addr>     address to bind                 ${dim("(default: 127.0.0.1, env OSAMA_HOST)")}
  --no-install      skip dependency installation
  --rebuild         build even if dist/ already exists
  --clean           delete node_modules and dist/ before installing
  -h, --help        show this help

${bold("After it starts")}
  Open ${cyan("http://127.0.0.1:5178")}. No model ships with Osama — install an
  engine build and pull a GGUF from the llama.cpp / Discover pages first.
`;

/* --------------------------------------------------------------------- args */

const args = process.argv.slice(2);
const has = (...names) => names.some((n) => args.includes(n));
const valueOf = (name, fallback) => {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const v = args[i + 1];
  if (!v || v.startsWith("-")) die(`${name} needs a value`);
  return v;
};

if (has("-h", "--help")) {
  console.log(USAGE);
  process.exit(0);
}

const DEV = has("--dev");
const CHECK_ONLY = has("--check");
const NO_INSTALL = has("--no-install");
const REBUILD = has("--rebuild");
const CLEAN = has("--clean");

const PORT = Number(valueOf("--port", process.env.OSAMA_PORT ?? "5178"));
const HOST = valueOf("--host", process.env.OSAMA_HOST ?? "127.0.0.1");
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) die(`invalid port: ${PORT}`);

if (DEV && REBUILD) warn("--dev serves from source; --rebuild is ignored in dev mode.");

/* -------------------------------------------------------------------- shell */

/** Run a command in the foreground, streaming its output. Throws on non-zero. */
function run(cmd, argv, extraEnv = {}) {
  const res = spawnSync(cmd, argv, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
    shell: IS_WIN, // npm/npx are .cmd shims on Windows
  });
  if (res.error) die(`could not run ${cmd}: ${res.error.message}`);
  if (res.status !== 0) die(`\`${cmd} ${argv.join(" ")}\` failed with exit code ${res.status}`);
}

/* ---------------------------------------------------------------- preflight */

// We are at the project root only if the workspaces are here. Running this from
// a subdirectory would install and build the wrong thing.
if (!fs.existsSync(path.join(ROOT, "package.json")) || !fs.existsSync(path.join(ROOT, "core"))) {
  die(`this does not look like the Osama project root (looked in ${ROOT})`);
}

console.log(bold("\n  Osama") + dim("  ·  local LLM studio"));
console.log(dim(`  ${ROOT}`));

step(1, DEV ? 3 : 4, "Checking Node.js");

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 20 || (major === 20 && minor < 10)) {
  die(
    `Node ${process.versions.node} is too old — Osama needs 20.10 or newer.`,
    `  Install a current Node (https://nodejs.org) or, with nvm:\n` +
      `    nvm install 22 && nvm use 22\n`,
  );
}
ok(`Node ${process.versions.node}`);

/* --------------------------------------------------------------- install */

const nodeModules = path.join(ROOT, "node_modules");
const haveLock = fs.existsSync(path.join(ROOT, "package-lock.json"));

if (CLEAN) {
  step(2, DEV ? 3 : 4, "Cleaning previous build");
  for (const rel of ["node_modules", "core/dist", "server/dist", "ui/dist"]) {
    const abs = path.join(ROOT, rel);
    if (fs.existsSync(abs)) {
      fs.rmSync(abs, { recursive: true, force: true });
      info(`removed ${rel}`);
    }
  }
  ok("clean");
}

const needsInstall = CLEAN || !fs.existsSync(nodeModules);
if (needsInstall && !NO_INSTALL) {
  if (!CLEAN) step(2, DEV ? 3 : 4, "Installing dependencies");
  // `npm ci` is reproducible and fails loudly if the lockfile is out of sync
  // with package.json. If it does, fall back to `npm install` rather than
  // making the user diagnose a lockfile drift.
  const useCi = haveLock;
  info(useCi ? "npm ci (from package-lock.json)" : "npm install (no lockfile committed)");
  const first = spawnSync("npm", [useCi ? "ci" : "install", ...(useCi ? ["--no-audit", "--no-fund"] : [])], {
    cwd: ROOT,
    stdio: "inherit",
    shell: IS_WIN,
  });
  if (first.status !== 0) {
    if (!useCi) die("npm install failed");
    warn("npm ci failed (lockfile out of date?) — falling back to npm install");
    run("npm", ["install"]);
  }
  ok("dependencies ready");
} else if (NO_INSTALL && !fs.existsSync(nodeModules)) {
  die("--no-install was passed but node_modules/ does not exist");
} else if (!needsInstall) {
  info(dim("dependencies already installed (use --clean to redo)"));
}

/* ------------------------------------------------------------------- build */

const built = ["core/dist/index.js", "server/dist/index.js", "ui/dist/index.html"].every((rel) =>
  fs.existsSync(path.join(ROOT, rel)),
);

if (!DEV && !CHECK_ONLY) {
  if (built && !REBUILD) {
    info(dim("already built (use --rebuild to force)"));
  } else {
    step(3, 4, "Building core, UI and server");
    run("npm", ["run", "build"]);
    ok("build complete");
  }
}

if (CHECK_ONLY) {
  step(3, 4, "Building core, UI and server");
  run("npm", ["run", "build"]);
  ok("build complete");
  step(4, 4, "Typechecking the workspace");
  run("npm", ["run", "typecheck"]);
  ok("all checks passed");
  console.log(`\n${green("✓")} Checks passed. Run ${cyan("./start.sh")} to serve.\n`);
  process.exit(0);
}

/* -------------------------------------------------------------- port check */

/** True when something already listens on host:port, so we do not fail opaquely. */
async function portInUse(host, port) {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(700);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

if (await portInUse(HOST, PORT)) {
  die(
    `port ${PORT} is already in use on ${HOST}`,
    `  Another Osama (or something else) is listening there.\n` +
      `  Use a different port:  ${cyan(`./start.sh --port ${PORT + 1}`)}\n` +
      `  Or stop the other one:  ${cyan(`lsof -ti :${PORT} | xargs kill`)}\n`,
  );
}

/* -------------------------------------------------------------------- serve */

const url = `http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}`;

if (DEV) {
  step(3, 3, "Starting dev mode");
  info("engine and UI with hot reload (Vite serves the UI on its own port)");
  info(dim("Ctrl-C to stop"));
  console.log(`\n${green("✓")} Osama dev mode starting.\n`);
  // -k so Ctrl-C takes the whole process group down, not just the launcher.
  run("npm", ["run", "dev"], { OSAMA_PORT: String(PORT), OSAMA_HOST: HOST });
} else {
  step(4, 4, "Starting Osama");
  info(`serving on ${cyan(url)}`);
  info(dim("Ctrl-C to stop"));
  console.log(`\n${green("✓")} Osama is starting — open ${cyan(url)}\n`);

  // exec-style: pass the signal straight through so Ctrl-C stops the engine
  // cleanly (it reaps the llama-server children it started) instead of leaving
  // them holding port 8080.
  const child = spawn(process.execPath, [path.join(ROOT, "server", "dist", "index.js")], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, OSAMA_PORT: String(PORT), OSAMA_HOST: HOST },
  });

  const forward = (sig) => () => child.kill(sig);
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));
  child.on("exit", (code, signal) => process.exit(signal ? 0 : code ?? 0));
}
