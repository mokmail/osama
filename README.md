# Osama — a local llama.cpp studio

Osama runs GGUF models with llama.cpp entirely on your machine: install an
engine build, pull models from the Hugging Face hub, serve them, and chat — with
an agentic mode that can read files, run commands, and work inside a workspace
you choose.

## Design language

Editorial monochrome developer-tool aesthetic: near-black neutral surfaces,
one white "ink" accent for the single primary action, hairlines instead of
shadows, small radii, monospace for anything copyable. Section labels are
uppercase mono with wide tracking; numbers are light and large with tabular
figures. Light mode follows the OS using the same tokens. No vendor branding.

## Views

| View | What it does |
|---|---|
| Dashboard | Live stats: library totals, engines, machine, activity, sparklines |
| Chat | Chat plus agentic mode; a collapsible insight sidebar on the right |
| Library | Local GGUF models; scan, add, remove, inspect cards |
| Discover | Hugging Face hub search and trending |
| Server | Start/stop llama-server with full parameter control |
| Processes | Managed processes, logs, lifecycle |
| Run CLI | llama-cli / llama-completion / llama-mtmd-cli / tts front-ends |
| Quantize | llama-quantize, llama-imatrix, llama-gguf-split |
| Edit GGUF | Change metadata (name, chat template, context length…) and resave, verified |
| Merge LoRA | Fold LoRA adapters into a base model and resave a standalone GGUF |
| Evaluate | llama-bench, llama-batched-bench, llama-perplexity |
| Inspect | llama-tokenize, llama-fit-params |

## Engine API

The engine (`npm start`, default `http://127.0.0.1:5178`) serves the UI and:

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | liveness + version |
| `GET /api/system` | machine, GPU probe, paths |
| `GET /api/engine`, `/api/engine/plan`, `/api/engine/install`, `/api/engine/activate` | llama.cpp release management |
| `GET /api/models`, `/api/models/scan`, `/api/models/add`, `DELETE /api/models/:id` | the local library |
| `GET /api/models/:id/metadata`, `POST /api/models/edit`, `POST /api/gguf/inspect` | GGUF metadata editing |
| `GET /api/lora/inspect`, `POST /api/lora/merge` | LoRA adapters: inspect and merge |
| `GET /api/hub/search`, `/api/hub/trending`, `/api/hub/repo` | model discovery (HF, ModelScope, CivitAI, Ollama, direct URL) |
| `GET /api/downloads`, `POST /api/downloads`, `POST /api/downloads/:id/cancel` | GGUF downloads |
| `POST /api/chat` | OpenAI-style proxy to the running llama-server |
| `GET /api/tools`, `POST /api/command/preview`, `POST /api/run` | llama.cpp binary front-ends |
| `GET /api/processes`, `POST /api/processes`, `POST /api/processes/:id/stop`, `GET /api/processes/:id/log` | process lifecycle |
| `GET /api/stats`, `/api/stats/series`, `/api/server/metrics` | dashboard aggregates |
| `GET /api/agent/tools` | the agentic tool registry |
| `GET /api/agent/context`, `POST /api/agent/context` | exact context-window measurement via the model's own tokenizer |
| `GET /api/agent/skills`, `GET /api/agent/memory`, `GET /api/agent/todos`, `GET /api/agent/artifacts` | agent state the sidebar shows |
| `POST /api/agent` | one agentic turn over SSE (tools, approvals, questions) |
| `POST /api/agent/approve/:id`, `POST /api/agent/answer/:id`, `POST /api/agent/steer/:id` | resume a parked turn |
| `GET /api/sessions`, `/api/sessions/:id`, `DELETE /api/sessions/:id` | durable session logs |
| `GET /api/workspaces`, `POST /api/workspaces` | the folder the agent works inside |
| `GET /api/events` | SSE event stream (downloads, logs, approvals, questions) |

The routes live in `server/src/routes/` (one module per area, wired in
`routes/index.ts`); the server entry is a thin transport shell.

## Artifacts

The **Artifacts** page (`#artifacts` in the URL) is the browser for everything
the agent wrote. It has three parts: the files, the folders they landed in, and
a jailed folder browser beside them.

- **Folders come first**, because a folder is the shortest route to the file
  manager — and a folder still exists when every file in it has been deleted.
- **Clicking a file** selects it: it previews inline and its folder opens in the
  browser pane. The two OS hand-offs stay explicit buttons:
  **Reveal** shows the file (or its folder) in Finder, **Open** hands it to the
  default app.
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

## Agentic mode

Turned on per chat session. 31 tools: files, shell, web (search/fetch/crawl/raw HTTP/download), memory, soul, skills (load/list/create/install), todos, sessions, jobs, context. The server runs the loop: model request → tool
calls → execution → results fed back, streamed over SSE and rendered as a
collapsible trace in the transcript (12-step cap). Filesystem tools are jailed
to the chosen workspace plus Osama's own home; any shell command needs explicit
approval (`ask` mode is the default). Context, memory, skills and artifacts are
live in the right-hand sidebar.

## The agent's soul and memory

The chat page is an agent, not a text box. Two pieces make that explicit, and
both are inspectable rather than implicit:

**The soul** (`SOUL.md`, in the app home) is slot #1 of the system prompt and
**replaces** the default identity instead of adding to it — that is what makes
it load-bearing. It is seeded on first boot, editable from the Soul panel (or by
the agent's own `update_soul` tool), and a prompt-injection hit is reported as a
warning rather than silently loaded. A **personality** is the session-level
overlay Hermes calls `/personality`: a temporary mode shift layered on the
durable soul, chosen per conversation.

**Memory** is two stores, because the split is the useful part:

| store | holds | scope |
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
and shows each section's weight. `GET /api/agent/soul`, `GET|POST
/api/agent/prompt`, and `GET /api/agent/memory` back the panels.

## Development

```sh
npm install
npm start            # engine on :5178, serving ui/dist
npm run build        # core + server + ui
npm run typecheck    # workspace-wide tsc
```

## Verifying

Three checks, in rising order of strength:

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

State lives under `.osama/` (models, engines, logs, sessions, memory, skills,
workspace choice). Override with `OSAMA_HOME`.

See `AUDIT.md` for the bugs found and fixed, and `overview.md` for the design
principles.