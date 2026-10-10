# MLX on macOS — design and plan

Working notes for `feat/mlx-macos`: what MLX support should mean in Osama, what it
touches, and what it deliberately does not do. Facts marked *(verified)* were
checked against the mlx-lm installed on the development machine (0.27.0 / mlx
0.29.0, Apple M4 Pro, macOS 27) rather than recalled.

## 1. Why

MLX is Apple's array framework, and `mlx-lm` is the language-model runtime on top
of it: a Python stack that loads *safetensors* models — mostly the
[mlx-community](https://huggingface.co/mlx-community) conversions — and serves them
over an OpenAI-compatible HTTP API.

What it buys:

- **Apple-silicon speed.** MLX is built for unified memory and Metal; for prompt
  processing and long context it is often faster than llama.cpp's Metal backend.
- **A second model catalogue.** mlx-community publishes ready-quantised 4-bit
  conversions of most popular models; some arrive there before any GGUF does.
- **Training, which llama.cpp cannot do.** `mlx_lm.lora` trains LoRA/DoRA adapters
  and `mlx_lm.fuse` folds them back in; llama.cpp only merges an existing adapter.

What it does not buy:

- **Nothing for the GGUF toolchain.** quantize-with-imatrix, `llama-bench`,
  `llama-perplexity`, GGUF metadata editing, split/merge — none of it exists in
  mlx-lm *(verified: no split/edit/imatrix/tts modules)*. Those views stay
  llama.cpp views.
- **Nothing outside Apple silicon.** MLX targets Metal first; the MLX-LM stack is
  macOS-only in practice. On Linux/Windows Osama keeps doing what it does today.

## 2. The seam, measured

What mlx-lm's server actually offers *(all verified against 0.27.0)*:

| | mlx-lm server | llama-server |
|---|---|---|
| Chat completions | `POST /v1/chat/completions` | same |
| Completions | `POST /v1/completions` | same |
| Models list | `GET /v1/models` | same |
| Health | `GET /health` | `/health` |
| **Tool calling** | yes — `tools` in the body, `tool_calls` out | yes |
| Streaming | yes | yes |
| **`/props`** | **absent** | chat template, ftype, slots, n_ctx |
| Context length | not a flag | `-c` |
| LoRA adapter at serve time | `--adapter-path` | `--lora` |
| Speculative decoding | `--draft-model`, `--num-draft-tokens` | `--model-draft` |

**A constraint that decides the runtime strategy (found by running it).** mlx-lm
0.27.0 — the version a system `python3` may well have — lowercases the model path
inside `load()` and then checks that *lowercased* string against the process's
working directory:

```python
model_path = model_path.lower()          # load()
...
if model_path.exists() and not model_path.is_relative_to(Path.cwd()):
    raise RuntimeError("Local models must be relative to the current working dir.")
```

`Path.cwd()` keeps its case, so on macOS every path under `/Users` fails this
check — as a relative path (no `is_relative_to` match) and as an absolute one
(`/users` vs `/Users`). The error message sends you looking for a path problem
that is not there. **mlx-lm 0.32 dropped the check**, and that is the whole
argument for Osama managing its own environment instead of borrowing the user's
interpreter: `uv` installs a current mlx-lm in seconds, and local models load.
The status card says exactly this when it finds a stale system interpreter.

Two more consequences, and they are the whole difficulty of this port:

1. **Tool calling works**, so the agent loop, the chat client and every OpenAI
   client in the app can point at an MLX server unchanged.
2. **`/props` does not exist.** `core/src/models.ts` and `server/src/routes/agent.ts`
   read `/props` for the chat template, the model alias, `model_ftype`, `total_slots`
   and `n_ctx`. MLX has no twin for any of those. Anything that reads `/props` needs
   a fallback that degrades honestly (model name from `/v1/models`, everything else
   "unknown") instead of showing blanks or zeros.

`models.ts` also assumes `.gguf` is what a model *is*: `addModel` rejects anything
else, the library scan collects GGUFs, the picker searches GGUFs. An MLX model is a
**directory** (`config.json` + `*.safetensors` + tokenizer files), which does not fit
that shape.

## 3. Tiers

**Tier A — MLX as a managed runtime Osama installs and serves.** Osama creates its
own venv under `.osama/mlx/venv` with `uv`, installs `mlx-lm`, discovers MLX model
directories, and starts `mlx_lm server` as a supervised process like any other.
Models are added by pointing at a directory. *This is the plan.*

**Tier B — MLX replaces llama.cpp on Apple silicon.** Same work, plus re-deciding
defaults, docs and the "what engine is this" story for every view. Not worth it:
llama.cpp remains the better answer for GGUF users on macOS.

**Tier C — MLX linked into the app via `mlx-c` / `mlx-swift-lm`.** No Python, no venv,
best startup time. Cost: owning a second inference stack, Metal shader embedding, a
per-platform sidecar, and an ongoing port of a fast-moving upstream. LM Studio does
this with a team. Explicit non-goal.

## 4. Staged plan

**Stage 1 — runtime + models + serve (this branch, first cut).**
- `core/src/mlx.ts`: platform check, runtime detection (managed venv, else a system
  interpreter that already has mlx-lm), `uv`-based venv bootstrap with streamed
  progress, MLX model discovery (`config.json` + `*.safetensors`) with quantisation
  and size read from the model itself, serve argv builder, served-model probe.
- `server/src/routes/mlx.ts`: status, install (streams), models, serve, info.
- UI: an MLX card in the **llama.cpp** view (platform/runtime status, install with
  live log), and MLX models listed in the **Library** next to GGUFs with a badge.
- Fix the one parser that would misread MLX argv: the Library derives the served
  model from `-m`/`--model`, and `python -m mlx_lm server` puts `mlx_lm` where a
  model path is expected. MLX always emits `--model`; the parser prefers it.

**Stage 2 — serve and chat from the UI.** Engine switch on the Server view
(llama.cpp ↔ MLX), MLX-model picker, and the info strip reading `/v1/models`
instead of `/props` (no ftype, no slot count, no context length — say so rather
than invent it).

**Stage 3 — acquire models in-app.** Download an mlx-community repo (config,
tokenizer, sharded safetensors, resumable) into the models dir, reusing the hub
search the app already has with a "MLX" filter, plus "add an MLX folder" for models
already on disk.

**Stage 4 — MLX's own tools.** `mlx_lm.convert` (quantise from an HF or local
safetensors model), `mlx_lm.lora` (train), `mlx_lm.fuse` (merge), each as a tool form
in the existing tools framework — labelled as MLX tools, and gated so a GGUF model
is never offered to them and an MLX model is never offered to `llama-quantize`.
Capability gating belongs to the *model kind*, not to the tool list: the sixteen
llama.cpp tools stay visible and valid regardless of what is being served.

## 5. Non-goals

- No GGUF↔MLX conversion. mlx-lm writes GGUF only as an export target and cannot
  read one *(verified)*; pretending otherwise would mean a lossy second converter.
- No MLX on Linux/Windows. The detection reports why and the UI says so.
- No changes to the llama.cpp engine registry. MLX state lives under `.osama/mlx/`
  and the `registry.json` shape keeps meaning one thing.
- No `/props` emulation layer on the MLX side. Inventing a `total_slots` or a
  `model_ftype` for a runtime that has neither is exactly the kind of number this
  project refuses to show.

## 6. How each stage is verified

- Stage 1 core: a harness against the real mlx-lm — detection reports the version,
  discovery finds a real model directory and reads its quantisation, the argv builder
  emits `--model`/`--host`/`--port` and never a bare `-m`, the probe identifies a
  server that is actually listening.
- Stage 1 end to end: bootstrap the venv with the app's own install path, serve a
  small mlx-community model through `startProcess`, then stream a chat completion
  from the **app's** HTTP API to prove tool calling and streaming survive the port.
- Nothing in these stages is allowed to require a llama.cpp binary, and nothing in
  the llama.cpp paths is allowed to require MLX.
