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
| Run CLI / Create / Evaluate / Inspect | llama.cpp tool front-ends |

## Engine API

The engine (`npm start`, default `http://127.0.0.1:5178`) serves the UI and:

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | liveness + version |
| `GET /api/system` | machine, GPU probe, paths |
| `GET /api/engine`, `/api/engine/plan`, `/api/engine/install`, `/api/engine/activate` | llama.cpp release management |
| `GET /api/models`, `/api/models/scan`, `/api/models/add`, `DELETE /api/models/:id` | the local library |
| `GET /api/hub/search`, `/api/hub/trending`, `/api/hub/repo` | Hugging Face discovery |
| `GET /api/downloads`, `POST /api/downloads`, `POST /api/downloads/:id/cancel` | GGUF downloads |
| `POST /api/chat` | OpenAI-style proxy to the running llama-server |
| `GET /api/tools`, `POST /api/command/preview`, `POST /api/run` | llama.cpp binary front-ends |
| `GET /api/processes`, `POST /api/processes`, `POST /api/processes/:id/stop`, `GET /api/processes/:id/log` | process lifecycle |
| `GET /api/stats`, `/api/stats/series`, `/api/server/metrics` | dashboard aggregates |
| `GET /api/agent/tools` | the agentic tool registry (23 tools) |
| `GET /api/agent/context`, `POST /api/agent/context` | exact context-window measurement via the model's own tokenizer |
| `GET /api/agent/skills`, `GET /api/agent/memory`, `GET /api/agent/todos`, `GET /api/agent/artifacts` | agent state the sidebar shows |
| `POST /api/agent` | one agentic turn over SSE (tools, approvals, questions) |
| `POST /api/agent/approve/:id`, `POST /api/agent/answer/:id` | resume a parked turn |
| `GET /api/sessions`, `/api/sessions/:id`, `DELETE /api/sessions/:id` | durable session logs |
| `GET /api/workspaces`, `POST /api/workspaces` | the folder the agent works inside |
| `GET /api/events` | SSE event stream (downloads, logs, approvals, questions) |

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

State lives under `.osama/` (models, engines, logs, sessions, memory, skills,
workspace choice). Override with `OSAMA_HOME`.