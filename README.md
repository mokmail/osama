# Osama — a local llama.cpp studio

Osama runs GGUF models with llama.cpp entirely on your machine: install an
engine build, pull models from the Hugging Face hub, serve them, and chat — with
an **agent mode** that can read files, run commands, and work inside a workspace
you choose — off by default, one click away in the chat header.

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
| Chat | Plain chat by default — attachments only, no tools; an explicit **Chat / Agent** switch, and a sidebar with history, context and settings |
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
| `GET /api/agent/tools` | the agent tool registry |
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

## Agent mode

**Chat is the default.** The header's Chat / Agent switch picks how the current
conversation answers, and a new chat always opens in **Chat**.

**Chat mode is a plain chat app.** The model gets your messages and whatever
files you attach — nothing else. No tools, no workspace, no grounding: the
request carries no tool schemas at all, and the system prompt is exactly what
you set in Settings. The only extra capability is reading attachments: text
files and PDFs are inlined into your message, and an image is sent as a real
image part when the served model has a vision encoder (otherwise it degrades to
a filename rather than sending bytes the server would reject). The sidebar shows
your history and the context window; the header shows only the provider, the
model and the mode.

**Agent mode** is opted into per conversation because it does work you have to
want: it reads and writes files. Turning it on gives 37 tools: files (including
`read_document` for PDFs), shell, web
(search/fetch/crawl/raw HTTP/download), memory, soul, skills
(load/list/create/install/update), todos, sessions, jobs, context. The server runs the
loop: model request → tool
calls → execution → results fed back, streamed over SSE and rendered as a
collapsible trace in the transcript.

**The UI shows the work as it happens.** Every tool call is announced to the
client the moment it is dispatched — not when it returns — so the transcript
carries a live line ("running command · sleep 12 · step 1 · 3.2s"), the trace
opens itself and marks the call in flight, and the top-bar chip names it too,
visible from any page. Read-only calls are dispatched in parallel, so several can
be in flight at once and the line says `+N more`. Between calls it says the model
is deciding rather than leaving a stale tool name on screen. Elapsed time ticks
locally and is replaced by the tool's own reported duration once it finishes.
Filesystem tools are jailed
to the chosen workspace plus Osama's own home; any shell command needs explicit
approval (`ask` mode is the default). The workspace picker and grounding badge,
the soul/personality strip, and the context, memory, skills, artifacts,
scheduler and MCP panels all appear in this mode, because that is where they
mean something.

**Getting a small model to call tools well.** The loop assumes nothing about the
model and repairs the four failure modes that actually showed up with a 3B GGUF
on a real task ("read the text of the first page"):

- *A PDF could not be read at all.* No tool could, so the model invented a URL.
  `read_document` extracts a workspace PDF's text with pdf.js, page by page,
  and `page:` reads a single page.
- *It invented a path and repeated the failing call.* The working rules now say
  outright: never invent a path or URL, file tools take paths while only
  `web_search`/`web_fetch` take URLs, and a "does not exist" result means that
  path is wrong — list the directory instead.
- *It called a tool on every turn* — for "hi" it asked the user their own
  question through `ask_user_question` and blocked for two minutes. The rules
  now say a tool-free turn is normal and `ask_user_question` is only for a detail
  only the user has.
- *It serialised arguments wrongly*, e.g. `options: "['4', '5']"` where the
  schema wants an array. Arguments are coerced to their declared JSON type
  before dispatch. Sampling is clamped too: an agent turn runs at ≤ 0.3, since
  the chat slider exists for wording, not for tool correctness.

An empty final answer is retried once at temperature 0 rather than surfaced as
"the model finished without saying anything".

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

**One command from a fresh clone:**

```sh
git clone https://github.com/mokmail/osama.git
cd osama
./start.sh
```

`start.sh` checks Node (≥ 20.10), installs dependencies, builds core → ui →
server, and serves the UI on <http://127.0.0.1:5178>. It stops with a clear
message if a port is taken or the tree is not built, instead of failing
opaquely. The logic is in `scripts/start.mjs`, so it works on Windows too
(`node scripts/start.mjs`) and under npm (`npm run start:osama`).

```sh
./start.sh --dev        # dev mode: hot reload, no build
./start.sh --check      # install + build + typecheck, then stop
./start.sh --port 5180  # serve elsewhere
./start.sh --clean      # redo node_modules and dist from scratch
./start.sh --help
```

Osama ships no model: after it starts, install an engine build and pull a GGUF
from the llama.cpp / Discover pages. An engine with no model answers nothing.

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
- **The client keeps the run outside React.** `ui/src/lib/runStore.ts` is a module
  singleton holding the transcript, the live status and the stream, so remounting
  the view re-subscribes instead of restarting. The chat reads from it rather than
  owning it.

A **RunIndicator** in the top bar shows a live run from any page — including when
the turn is parked on an approval or a question — and is the way back to it.

Reload is a *different* case and is handled honestly: an SSE stream cannot be
resumed from a process that is gone, so a reload does not pretend the answer
arrived. The chat marks the turn interrupted and offers to retry it, rather than
showing a half-finished reply as if it were complete.

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