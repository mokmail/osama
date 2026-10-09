# Osama — a local llama.cpp studio

Osama runs GGUF models with [llama.cpp](https://github.com/ggml-org/llama.cpp)
entirely on your machine. It installs the official engine builds, pulls models
from the Hugging Face hub, serves them over an OpenAI-compatible API, and chats
with them — including an **agent mode** that can read files, run commands and
work inside a workspace you choose, off by default and one click away.

Nothing is reimplemented and nothing is simulated: Osama downloads the real
release archives and executes the actual binaries, so every flag it shows is a
flag the build accepts, and every number it reports came from a run.

---

## Contents

- [Quick start](#quick-start)
- [Installation](#installation)
- [Getting started](#getting-started)
- [Using Osama](#using-osama)
- [Chat mode and Agent mode](#chat-mode-and-agent-mode)
- [The agent toolkit](#the-agent-toolkit)
- [The agent's soul and memory](#the-agents-soul-and-memory)
- [Artifacts](#artifacts)
- [Configuration](#configuration)
- [Headless CLI](#headless-cli)
- [Engine API](#engine-api)
- [Runs survive a page switch](#runs-survive-a-page-switch)
- [Development](#development)
- [Verifying](#verifying)
- [Roadmap](#roadmap)

---

## Quick start

```sh
git clone https://github.com/mokmail/osama.git
cd osama
./start.sh
```

That is the whole thing: it checks Node, installs dependencies, builds core →
UI → server and serves the app on <http://127.0.0.1:5178>. Open that URL.

Osama ships **no model**. The first run walks you through installing an engine
build and pulling a GGUF — see [Getting started](#getting-started).

```sh
./start.sh --dev          # dev mode: hot reload, no build
./start.sh --check        # install + build + typecheck, then stop
./start.sh --port 5180    # serve elsewhere
./start.sh --host 0.0.0.0 # listen on every interface
./start.sh --clean        # redo node_modules and dist from scratch
./start.sh --no-install   # skip dependency installation
./start.sh --rebuild      # force a build
./start.sh --help
```

On Windows, or from npm, the same script runs as `node scripts/start.mjs` or
`npm run start:osama` — `start.sh` is a thin wrapper that only locates Node and
hands off, so the logic is identical everywhere.

---

## Installation

### Requirements

| | |
|---|---|
| **Node.js** | 20.10 or newer (`node -v`). The engine uses modern ESM and `node:test`. |
| **Disk** | ~200 MB for the app and dependencies, plus your models (a 7B at Q4_K_M is ~4 GB). |
| **OS** | macOS (Apple Silicon or Intel), Linux (x64/arm64), Windows (x64/arm64). |

An NVIDIA/AMD/Intel GPU is optional — Osama probes your hardware and
recommends the matching build. CPU inference works everywhere; it is just
slower.

### One command (recommended)

```sh
git clone https://github.com/mokmail/osama.git
cd osama
./start.sh
```

### Manual

If you would rather drive each step yourself:

```sh
npm install        # or: npm ci   (reproducible, from the lockfile)
npm run build      # core → ui → server
npm start          # engine on http://127.0.0.1:5178, serving ui/dist
```

`npm start` requires a build first: there is no watcher in that path, so the
server runs from `dist/` and an unbuilt tree fails with a module-not-found
error. `scripts/prestart.mjs` checks for the three artifacts and prints exactly
which are missing instead of letting you hit that error.

### Desktop app (Tauri)

The repo also contains a Tauri 2 shell that spawns the engine, hosts the UI and
stops it on close. It needs Rust plus your platform's webview libraries:

```sh
npm run desktop       # build, then tauri dev
npm run tauri:build   # .app/.dmg on macOS, .deb/.AppImage on Linux, .msi/.exe on Windows
```

---

## Getting started

Four steps, in order. The first two happen once; the last two are what you do
every time.

**1. Install a llama.cpp engine build** → the **llama.cpp** page.
Osama probes your machine, lists the official releases and recommends the
accelerator that fits (`metal` on Apple Silicon, `cuda`/`vulkan`/`rocm`/`sycl`/
`openvino`/`cpu` elsewhere). It downloads the archive, extracts it and
discovers the binaries inside. Several builds can coexist; one is *active*.

**2. Get a model** → the **Discover** page.
Search Hugging Face, ModelScope, CivitAI, Ollama or a direct URL, filter to
GGUF, and download. Progress is byte-accurate and resumable — an interrupted
download picks up where it stopped. Downloads land in the **Library**, where
each model gets a card read straight from its header (architecture, context
length, quantisation, tokenizer, chat template) — no guesswork and no extra
network call.

**3. Serve it** → the **Server** page.
Pick the model, set the parameters, start. Osama builds an argv array and
spawns `llama-server`; the process appears in **Processes** with live logs.
When it answers `/health`, the model is ready.

**4. Chat** → the **Chat** page.
Type. Chat mode is a plain chat app by default; flip to **Agent** in the header
when you want a model that can touch files.

### Or do all of it from the terminal

```sh
node scripts/osama.mjs system                     # what hardware is this
node scripts/osama.mjs install --accel cuda       # install the engine
node scripts/osama.mjs pull ggml-org/gemma-3-1b-it-GGUF gemma-3-1b-it-Q4_K_M.gguf
node scripts/osama.mjs models                     # what is in the library
node scripts/osama.mjs run server --set model=…   # start llama-server
```

See [Headless CLI](#headless-cli) for the full command set.

---

## Using Osama

### Views

| Group | View | What it does |
|---|---|---|
| **Start** | Dashboard | Live stats: library totals, engines, machine, activity, sparklines |
| | Chat | Plain chat by default, with an explicit **Chat / Agent** switch and a sidebar for history, context and settings |
| | Artifacts | Everything the agent wrote: files, their folders, and a jailed folder browser |
| **Models** | Library | Local GGUF models — scan, add, remove, inspect cards |
| | Discover | Search and trending across Hugging Face, ModelScope, CivitAI, Ollama, direct URL |
| **Run** | Server | Start/stop `llama-server` with full parameter control |
| | Processes | Managed processes, live logs, lifecycle |
| **Tools** | Run CLI | `llama-cli`, `llama-completion`, `llama-mtmd-cli`, `llama-tts` front-ends |
| | Quantize | `llama-quantize`, `llama-imatrix`, `llama-gguf-split` |
| | Edit GGUF | Change metadata (name, chat template, context length…) and resave, then re-read to prove it landed |
| | Merge LoRA | Fold a LoRA adapter into a base model and resave a standalone GGUF |
| | Evaluate | `llama-bench`, `llama-batched-bench`, `llama-perplexity` |
| | Inspect | `llama-tokenize`, `llama-fit-params` |
| **System** | llama.cpp | Engine builds: releases, install, activate, remove |
| | MCP | Model Context Protocol servers — presets, connect, and the tools they expose |

Every view is linkable: `#chat`, `#artifacts`, `#engine` … in the URL open that
view directly, and reload returns you there.

### The llama.cpp tools

Osama exposes all fourteen binaries the release ships, each generated from one
catalogue (`core/src/commands.ts`) so adding a flag to the catalogue adds it to
the GUI:

| Tool | Binary | Title |
|---|---|---|
| Chat (CLI) | `llama-cli` | Interactive chat / single-shot generation |
| Server | `llama-server` | OpenAI + Anthropic-compatible HTTP API |
| Multimodal chat | `llama-mtmd-cli` | Image / audio input via libmtmd |
| Quantize | `llama-quantize` | Quantise to Q4_K_M, Q8_0, IQ… |
| Benchmark | `llama-bench` | Prompt + generation throughput |
| Batched benchmark | `llama-batched-bench` | Throughput across batch sizes |
| Perplexity | `llama-perplexity` | Quality measurement |
| Importance matrix | `llama-imatrix` | Imatrix for better quants |
| Split / merge GGUF | `llama-gguf-split` | Split a large model, or merge shards |
| Tokenize | `llama-tokenize` | Tokens, ids, counts |
| Completion | `llama-completion` | Raw completion |
| Fit parameters | `llama-fit-params` | Find parameters that fit your memory |
| Text to speech | `llama-tts` | Speech synthesis |
| RPC server | `rpc-server` | Distribute layers over the network |

### Design language

Editorial monochrome developer-tool aesthetic: near-black neutral surfaces,
one white "ink" accent for the single primary action, hairlines instead of
shadows, small radii, monospace for anything copyable. Section labels are
uppercase mono with wide tracking; numbers are light and large with tabular
figures. Light mode follows the OS using the same tokens. No vendor branding.

---

## Chat mode and Agent mode

**Chat is the default.** The header's **Chat / Agent** switch picks how the
current conversation answers, and a new chat always opens in **Chat**.

### Chat mode is a plain chat app

The model gets your messages and whatever files you attach — nothing else. No
tools, no workspace, no grounding: the request carries no tool schemas at all,
and the system prompt is exactly what you set in Settings.

The only extra capability is reading attachments: text files and PDFs are
inlined into your message, and an image is sent as a real image part when the
served model has a vision encoder (otherwise it degrades to a filename rather
than sending bytes the server would reject). The sidebar shows your history and
the context window; the header shows only the provider, the model and the mode.

### Agent mode does work you have to want

It is opted into per conversation because it reads and writes files. Turning it
on gives 37 tools (listed below) and the server runs the loop:

```
model request → tool calls → execution → results fed back
```

streamed over SSE and rendered as a collapsible trace in the transcript.

Filesystem tools are jailed to the chosen workspace plus Osama's own home. Any
shell command needs explicit approval (`ask` is the default policy). The
workspace picker and grounding badge, the soul/personality strip, and the
context, memory, skills, artifacts, scheduler and MCP panels all appear in this
mode, because that is where they mean something.

### The UI shows the work as it happens

Every tool call is announced to the client **the moment it is dispatched**, not
when it returns — so the transcript carries a live line
(`running command · sleep 12 · step 1 · 3.2s`), the trace opens itself and marks
the call in flight, and the top-bar chip names it too, visible from any page.
Read-only calls are dispatched in parallel, so several can be in flight at once
and the line says `+N more`. Between calls it says the model is deciding rather
than leaving a stale tool name on screen. Elapsed time ticks locally and is
replaced by the tool's own reported duration once it finishes.

### Getting a small model to call tools well

The loop assumes nothing about the model and repairs the four failure modes that
actually showed up with a 3B GGUF on a real task ("read the text of the first
page"):

- **A PDF could not be read at all**, so the model invented a URL.
  `read_document` extracts a workspace PDF's text with pdf.js, page by page, and
  `page:` reads a single page.
- **It invented a path and repeated the failing call.** The working rules now
  say outright: never invent a path or URL; file tools take paths while only
  `web_search`/`web_fetch` take URLs; and a "does not exist" result means that
  path is wrong — list the directory instead.
- **It called a tool on every turn** — for "hi" it asked the user their own
  question through `ask_user_question` and blocked for two minutes. The rules
  now say a tool-free turn is normal and `ask_user_question` is only for a
  detail only the user has.
- **It serialised arguments wrongly**, e.g. `options: "['4', '5']"` where the
  schema wants an array. Arguments are coerced to their declared JSON type
  before dispatch. Sampling is clamped too: an agent turn runs at ≤ 0.3, since
  the chat slider exists for wording, not for tool correctness.

An empty final answer is retried once at temperature 0 rather than surfaced as
"the model finished without saying anything".

> Honest note: these rules and repairs make a small model *more* reliable, but
> they do not make it good. A 3B model still over-calls tools. Use the largest
> model your machine comfortably runs.

---

## The agent toolkit

37 tools, registered in `core/src/tools.ts` and listed live at
`GET /api/agent/tools`. Every one runs on your machine, so the jail is the
security boundary for the whole subsystem.

### Files

| Tool | What it does |
|---|---|
| `read_file` | Read a UTF-8 text file, with numbered lines; `offset`/`limit` for large files |
| `read_document` | Extract a PDF (or text) page by page, marked `--- page N ---`; `page:` for one page |
| `write_file` | Create or overwrite a file; parent directories are created |
| `edit_file` | Targeted edit: replace one exact string, or insert next to an anchor. Fails loudly if ambiguous |
| `replace_in_files` | Find and replace a literal string across many files, with a dry run first |
| `manage_file` | Copy, move/rename, delete, make a directory |
| `list_dir` | Entries of a directory, with sizes |
| `glob` | Find files by pattern, e.g. `**/*.ts` |
| `tree` | Directory structure as an indented tree |
| `file_info` | Size, line count, kind, content hash, first lines |
| `grep` | Search file contents by regex, returning `file:line` matches |
| `write_script` | Create an executable script and return exactly how to run it |

### Execution

| Tool | What it does |
|---|---|
| `run_command` | Run a shell command, returning stdout/stderr and exit code. **Requires approval.** |

### Web

| Tool | What it does |
|---|---|
| `web_search` | Ranked results with title, URL and snippet |
| `web_fetch` | Readable text of a page by URL, HTML stripped |
| `http_request` | Raw HTTP: any method, custom headers, JSON body |
| `web_crawl` | Crawl a site from a start URL, following links, up to N pages |
| `web_download` | Download a file straight into the workspace, binary-safe |

### Memory and identity

| Tool | What it does |
|---|---|
| `save_memory` | Save a durable fact for future sessions |
| `update_memory` | Add, replace and remove several memories atomically |
| `recall_memory` | Search memories and the user profile |
| `forget_memory` | Delete a memory by id or matching text; `all` clears a store |
| `update_soul` | Rewrite the agent's own identity (SOUL.md) |

### Skills

| Tool | What it does |
|---|---|
| `load_skill` | Load a skill's full instructions before acting on a matching task |
| `list_skills` | List available skills with one-line descriptions |
| `create_skill` | Author a new SKILL.md and save it under `.osama/skills` |

**Seven skills ship in the repo**, under `skills/` — the catalogue is scanned
from there, so they are available on a fresh clone with nothing to install. They
are language- and platform-neutral, and each is a `SKILL.md` with supporting
files where it needs them:

| Skill | Use it when |
|---|---|
| `systematic-debugging` | A bug needs a root cause, not a guess — four phases, understand before fixing |
| `spike` | Validating an idea with a throwaway experiment before committing to a build |
| `simplify-code` | Cleaning up recent changes across several files at once |
| `blocked-page-recovery` | A fetch fails: 403/429, a paywall, a WAF or bot wall |
| `humanizer` | Text reads as machine-written and needs a real voice |
| `plain-language-rewrite` | Rewriting a document at a simpler reading level, in full |
| `offline-html-report` | Exporting results as one self-contained HTML file |

They use the same SKILL.md convention as the rest of the ecosystem (frontmatter
with `name` and `description`), so skills authored for other agents work here
unchanged. The **Skills** panel can also install one from a GitHub source into
`.osama/skills`, which is scanned alongside the repo directory; a skill in
`.osama/skills` overrides one of the same id in the repo.

### Sessions and context

| Tool | What it does |
|---|---|
| `session_search` | Find which earlier conversation discussed something |
| `session_events` | Read an earlier session's events in order |
| `context_status` | How full the context window is, and what is taking the space |

### Scheduling

| Tool | What it does |
|---|---|
| `list_jobs` | List scheduled recurring prompts, with cadence and policy |
| `create_job` | Schedule a recurring prompt |
| `set_job` | Rename, re-prompt, re-cadence, enable/disable, change approval policy |
| `delete_job` | Remove a job |
| `job_history` | What a job produced and when |

### Coordination

| Tool | What it does |
|---|---|
| `ask_user_question` | Ask the user a question and wait — a choice, a confirmation, missing input |
| `write_todo` | Record and update a task list to plan multi-step work |
| `delegate_task` | Hand a self-contained subtask to an isolated subagent, returning only its report |

MCP servers you connect add their own tools to this same registry, namespaced
by server.

---

## The agent's soul and memory

The chat page is an agent, not a text box. Two pieces make that explicit, and
both are inspectable rather than implicit.

**The soul** (`SOUL.md`, in the app home) is slot #1 of the system prompt and
**replaces** the default identity instead of adding to it — that is what makes
it load-bearing. It is seeded on first boot, editable from the Soul panel (or by
the agent's own `update_soul` tool), and a prompt-injection hit is reported as a
warning rather than silently loaded. A **personality** is the session-level
overlay: a temporary mode shift layered on the durable soul, chosen per
conversation.

**Memory** is two stores, because the split is the useful part:

| Store | Holds | Scope |
|---|---|---|
| agent notes | environment facts, conventions, lessons | global **and per-workspace** |
| user profile | who the user is, how they want to be answered | always global |

Both are bounded, and a write that would overflow **refuses** with the current
entries so the agent consolidates in the same turn. Consolidation is atomic:
`update_memory` applies additions, replacements and removals as one operation, so
a full store can be pruned and refilled without a half-applied edit destroying a
fact. The rendered block reports its own fill level, so the model can see it is
at 90% before it is full.

The **prompt inspector** (Soul panel) assembles the system prompt exactly as the
agent would — identity → tool rules → memory → skills → workspace → scheduler —
and shows each section's weight.

---

## Artifacts

The **Artifacts** page (`#artifacts` in the URL) is the browser for everything
the agent wrote. It has three parts: the files, the folders they landed in, and
a jailed folder browser beside them.

- **Folders come first**, because a folder is the shortest route to the file
  manager — and a folder still exists when every file in it has been deleted.
- **Clicking a file** selects it: it previews inline and its folder opens in the
  browser pane. The two OS hand-offs stay explicit buttons: **Reveal** shows the
  file (or its folder) in Finder, **Open** hands it to the default app.
- **The folder pane is jailed** the same way the file tools are: "up" stops at
  the root that contains the directory, never at `/`, and a symlink pointing
  outside is skipped. Its search looks at file *contents* as well as names, so
  "which file mentions the quantize fix" is answerable without a shell.

Opening a path hands it to the operating system, so that endpoint uses a
two-part test: the path must be inside the current jail **or** be a path this
server itself recorded as an artifact. The second half is what makes the page
usable — an artifact written while a different workspace was active fails the
current jail, and refusing it would mean the files you most want to open are
exactly the ones you cannot. It is still not an arbitrary-file-opener: the path
must already be in this server's own session log, so the caller cannot name
`/etc` and have it opened.

---

## Configuration

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `OSAMA_HOME` | `<repo>/.osama` | Where all state lives: models, engines, logs, sessions, memory, skills |
| `OSAMA_PORT` | `5178` | Engine API port |
| `OSAMA_HOST` | `127.0.0.1` | Engine bind address |
| `OSAMA_WORKSPACE` | last chosen | Workspace the agent treats as current |
| `OSAMA_AGENT_ROOTS` | workspace | Extra roots the file tools may read beyond it |
| `OSAMA_SKILL_ROOTS` | — | Extra directories to discover skills from |
| `OSAMA_OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama endpoint, to read and pull its models |
| `OSAMA_BASE` | `http://127.0.0.1:5178` | Base URL used by the headless scripts |

`OSAMA_AGENT` is set to `1` in the environment of subagents the agent spawns;
it is not a switch you set to turn agent mode on. Agent mode is chosen per
conversation in the UI.

### State directory

Everything Osama owns lives under a single overridable home, so the app is easy
to inspect, reset or relocate:

```
.osama/
├── bin/llama/       installed engine builds, one directory per build
├── models/          downloaded GGUFs
├── downloads/       partial (.part) downloads, resumable
├── logs/            engine and process logs
├── sessions/        durable conversation logs (one JSON per session)
├── skills/          SKILL.md files
├── memory/          agent notes and the user profile
├── jobs/            scheduled jobs
├── registry.json    installed-engine registry
├── mcp.json         configured MCP servers
├── workspace.json   the currently chosen workspace
└── SOUL.md          the agent's identity
```

Deleting `.osama/` resets Osama completely. Nothing is written anywhere else
except your chosen workspace.

---

## Headless CLI

`scripts/osama.mjs` drives the same engine from the terminal — useful for
automation, CI, and verifying the engine end to end.

```sh
node scripts/osama.mjs system                    # machine, GPU probe, paths
node scripts/osama.mjs releases                  # available llama.cpp builds
node scripts/osama.mjs install --accel cuda      # install one (cpu|metal|cuda|vulkan|rocm)
node scripts/osama.mjs engines                   # what is installed
node scripts/osama.mjs search "qwen3" --limit 10 # search the hub
node scripts/osama.mjs repo <user/model>         # list a repo's GGUF files
node scripts/osama.mjs pull <user/model> <file.gguf>
node scripts/osama.mjs models                    # the local library
node scripts/osama.mjs card <path/to/model.gguf> # read a model's header
node scripts/osama.mjs cmd <tool> --set key=value …   # print the argv
node scripts/osama.mjs run <tool> --set key=value …   # run it, streaming
```

It is also exposed as `npm run osama -- <command>`.

---

## Engine API

The engine (`npm start`, default `http://127.0.0.1:5178`) serves the UI and 106
route registrations. The routes live in `server/src/routes/` — one module per
area, wired in `routes/index.ts`; the server entry is a thin transport shell.

### Core

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | liveness + version |
| `GET /api/system` | machine, GPU probe, paths |
| `GET /api/events` | SSE stream: downloads, logs, approvals, questions, processes |
| `GET /api/logs` | engine log tail |
| `GET /api/browse` | jailed directory listing |

### Engine builds

| Endpoint | Purpose |
|---|---|
| `GET /api/engine` | installed builds + which is active |
| `GET /api/engine/releases` | official releases available |
| `GET /api/engine/plan` · `GET /api/engine/version` | what would be installed, and the active version |
| `POST /api/engine/install` · `POST /api/engine/activate` | install / switch |
| `DELETE /api/engine/:tag` | remove a build |

### Models

| Endpoint | Purpose |
|---|---|
| `GET /api/models` · `POST /api/models/scan` · `POST /api/models/add` | the local library |
| `GET /api/models/:id/card` · `GET /api/models/:id/metadata` | header-derived facts |
| `POST /api/models/edit` · `POST /api/gguf/inspect` | GGUF metadata editing |
| `DELETE /api/models/:id` | remove |
| `POST /api/extract/pdf` | PDF text extraction (used by attachments) |

### Discovery and downloads

| Endpoint | Purpose |
|---|---|
| `GET /api/hub/sources` · `/api/hub/search` · `/api/hub/trending` · `/api/hub/repo` | HF, ModelScope, CivitAI, Ollama, direct URL |
| `GET /api/ollama/status` · `/api/ollama/models` · `/api/ollama/show` | read a local Ollama install |
| `GET /api/downloads` · `POST /api/downloads` · `POST /api/downloads/:id/cancel` | resumable GGUF downloads |

### Running

| Endpoint | Purpose |
|---|---|
| `POST /api/processes` · `GET /api/processes` | start / list managed processes |
| `GET /api/processes/:id/log` · `POST /api/processes/:id/stop` · `POST /api/processes/prune` | logs, stop, clean up |
| `GET /api/tools` · `POST /api/command/preview` · `POST /api/run` · `GET /api/run/:id` | the binary front-ends |
| `POST /api/chat` | OpenAI-style proxy to the running llama-server |
| `GET /api/server/health` · `/api/server/props` · `/api/server/metrics` | the served model's capabilities and stats |
| `GET /api/stats` · `GET /api/stats/series` | dashboard aggregates |
| `GET /api/lora/inspect` · `POST /api/lora/merge` | LoRA adapters: inspect and merge |

### Agent

| Endpoint | Purpose |
|---|---|
| `POST /api/agent` | one agentic turn over SSE (tools, approvals, questions) |
| `POST /api/agent/attach` | replay a live run's buffer, then continue |
| `GET /api/agent/status` · `POST /api/agent/stop` · `POST /api/agent/steer/:id` | run control |
| `POST /api/agent/approve/:id` · `POST /api/agent/answer/:id` | resume a parked turn |
| `POST /api/agent/compact` | compact the context on demand |
| `GET /api/agent/tools` | the tool registry |
| `GET|POST /api/agent/context` | exact context-window measurement via the model's own tokenizer |
| `GET /api/agent/todos` · `/api/agent/artifacts` · `/api/agent/skills` | agent state the sidebar shows |
| `GET /api/agent/artifacts/preview` · `/dir` · `POST …/open` · `POST …/reveal` | the Artifacts browser |
| `GET|POST /api/agent/soul` · `POST /api/agent/soul/reset` | the identity |
| `GET|POST /api/agent/prompt` | the assembled prompt, section by section |
| `GET /api/agent/memory` · `POST …/save` · `/batch` · `/replace` · `/forget` | memory |

### State, skills, scheduler, MCP

| Endpoint | Purpose |
|---|---|
| `GET /api/sessions` · `GET /api/sessions/:id` · `DELETE /api/sessions/:id` | durable session logs |
| `GET /api/workspaces` · `POST /api/workspaces` | the folder the agent works inside |
| `GET /api/workspace/files` · `/file` · `/snapshot` | workspace contents |
| `GET /api/skills/store` · `POST /api/skills/install` · `POST /api/skills/remove` | skills |
| `GET|POST /api/scheduler/config` · `GET|POST /api/scheduler/jobs` | recurring jobs |
| `PATCH|DELETE /api/scheduler/jobs/:id` · `POST …/run` · `GET …/history` | one job |
| `GET /api/mcp/presets` · `/api/mcp/servers` · `/api/mcp/tools` | MCP servers and their tools |
| `POST /api/mcp/servers` · `POST /api/mcp/servers/:id/connect` · `/disconnect` · `POST /api/mcp/connect-all` | MCP lifecycle |
| `DELETE /api/mcp/servers/:id` | remove |

---

## Runs survive a page switch

A turn is a **user-level activity, not a view-level one**. Leaving the chat used
to unmount the view, which aborted the request and discarded the answer —
switching to the Dashboard mid-reply killed it. Two pieces fix that:

- **The server owns the turn.** `POST /api/agent` starts a run keyed by a
  client-supplied `runId`; the loop does *not* abort when the SSE request closes.
  It buffers every event and ends only on an explicit stop. `POST
  /api/agent/attach?runId=…` replays the buffer and then continues live, so a
  client that comes back gets the whole turn in order. `GET /api/agent/status`
  says what is alive and whether it is parked on the user.
- **The client keeps the run outside React.** `ui/src/lib/runStore.ts` is a
  module singleton holding the transcript, the live status and the stream, so
  remounting the view re-subscribes instead of restarting. The chat reads from it
  rather than owning it.

A **RunIndicator** in the top bar shows a live run from any page — including when
the turn is parked on an approval or a question — and is the way back to it.

Reload is a *different* case and is handled honestly: an SSE stream cannot be
resumed from a process that is gone, so a reload does not pretend the answer
arrived. The chat marks the turn interrupted and offers to retry it, rather than
showing a half-finished reply as if it were complete.

---

## Development

The repo is three npm workspaces plus a desktop shell:

```
osama/
├── core/          @osama/core   — platform, engine, downloads, GGUF, hub, processes, commands, agent loop
├── server/        @osama/server — HTTP + SSE API on 127.0.0.1:5178
├── ui/            @osama/ui     — React + Vite views
├── src-tauri/     Tauri 2 shell — spawns the engine, hosts the UI, stops it on close
├── scripts/       start.mjs (setup/run), osama.mjs (headless CLI), prestart.mjs, smoke.mjs,
│                  check-flags.mjs, probe-flags.mjs, shot.mjs
└── start.sh       one-command wrapper around scripts/start.mjs
```

```sh
npm run dev          # engine + Vite with hot reload (concurrently)
npm run build        # core + server + ui
npm run typecheck    # workspace-wide tsc
npm run start:osama  # the guided setup/run script
```

Design principles, and why they are load-bearing:

1. **Drive the real binaries.** Osama downloads official release archives and
   executes the actual tools. Nothing is reimplemented; nothing is simulated.
2. **One source of truth for flags.** `core/src/commands.ts` declares every
   option Osama exposes; the UI *is* generated from it. Adding a flag to the
   catalogue adds it to the GUI.
3. **argv, never shell.** Commands are spawned as argument arrays, so a path
   with spaces or a `;` can never be interpreted as shell syntax.
4. **Honest, portable state.** All data lives under a single overridable home,
   so the app is easy to inspect, reset or relocate.
5. **Calm UI.** Dark, high-contrast, no vendor branding, monospace only where
   the user copies text.

---

## Verifying

Four checks, in rising order of strength:

```sh
npm run typecheck        # types across all three workspaces
npm run check:flags      # the catalogue vs the installed build's --help
npm run probe:flags      # decisive: run each binary and prove the parser accepts the flag
npm run smoke            # end-to-end against a live engine + a real model
```

`probe:flags` is the one that matters for this app: it builds the argv the UI
would actually emit and runs the real binary with a bad model path, so a flag
the build rejects — or a positional in the wrong slot — fails loudly instead of
silently at the user's first quantize.

`npm run shots` renders every view headlessly to PNGs for a visual check.

See `AUDIT.md` for the bugs found and fixed, and `overview.md` for the design
principles and the verified end-to-end run.

---

## Roadmap

### Shipped

- **Engine management** — install, activate and remove official llama.cpp
  builds; hardware probe and accelerator recommendation.
- **Model library** — hub search across five sources, resumable downloads, and
  GGUF cards read straight from the header.
- **All fourteen binaries** — every tool the release ships has a front-end
  generated from the single flag catalogue, plus GGUF metadata editing and LoRA
  merging with verification.
- **Chat and Agent modes** — a plain chat app by default; an agent that reads,
  writes and runs commands inside a jailed workspace, with approvals and a live
  view of what it is doing.
- **Agentic state** — soul, two-store bounded memory, skills, todos, durable
  sessions, scheduled jobs, MCP servers, subagents.
- **Desktop shell** — Tauri 2 configuration for macOS, Linux and Windows.

### Next

- **A model on first run.** Osama ships no weights and makes you find them.
  A guided first-run that offers a small recommended model for your hardware
  would close the biggest gap between "installed" and "answering".
- **Tool calling beyond small models.** The reliability work in
  [Chat mode and Agent mode](#chat-mode-and-agent-mode) papers over the real
  issue: a 3B model over-calls tools. Grammar-constrained tool calls, or a
  guided/JSON-schema mode, would make small models dependable instead of merely
  survivable.
- **Finish splitting `core/src/tools.ts`.** `commands.ts` was already split into
  `core/src/commands/` (`spec.ts`, `tools.ts`, `index.ts`); the 2000-line tool
  registry has not been, and it is the last large single file in `core`.

### Later

- **Training.** llama.cpp release binaries ship no trainer. "Finetune" today
  means producing or merging a LoRA adapter locally; actual training needs
  `llama-finetune`/unsloth outside this build. Wiring an optional external
  trainer is the honest way to offer it.
- **Multi-user / remote.** The engine binds to localhost and trusts the caller.
  Serving it beyond your machine needs authentication and per-user state.
- **Plugin API.** Skills and MCP already extend the agent; a documented plugin
  surface for UI views would let the front-end grow the same way.
