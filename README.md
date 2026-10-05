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

## Agentic mode

Turned on per chat session. 23 tools: files, shell, web (search/fetch/crawl/raw HTTP/download), memory, skills (load/list/create/install), todos, sessions, context. The server runs the loop: model request → tool
calls → execution → results fed back, streamed over SSE and rendered as a
collapsible trace in the transcript (12-step cap). Filesystem tools are jailed
to the chosen workspace plus Osama's own home; any shell command needs explicit
approval (`ask` mode is the default). Context, memory, skills and artifacts are
live in the right-hand sidebar.

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