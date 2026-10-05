# Osama — overview

A modern desktop GUI for **llama.cpp**: install it, download models, chat, serve an API, quantize,
benchmark — the whole toolbox behind one clean interface.

* **Stage 1 target:** macOS on Apple Silicon (Metal).
* **Stage 2:** Linux + Windows (the engine already models their release assets).
* **Built on:** the official `ggml-org/llama.cpp` release binaries — no forked runtime.
* **Stack:** TypeScript engine (`@osama/core`) → local HTTP/SSE API (`@osama/server`) → React UI (`@osama/ui`)
  → Tauri 2 desktop shell.

## The problem it solves

llama.cpp is the engine that LM Studio, Jan, GPT4All and Ollama all build on — but the moment you go
*to* llama.cpp you lose the GUI, and every existing GUI hides the deeper tools. There is no polished,
open interface that exposes `llama-quantize`, `llama-imatrix`, `llama-gguf-split`, `llama-bench`,
`llama-tokenize`, `llama-fit-params`, `llama-mtmd-cli` and `ggml-rpc-server` alongside the obvious
"download a model and chat" flow.

Osama is that interface.

## Design principles

1. **Drive the real binaries.** Osama downloads official GitHub release archives and executes the actual
   tools. Nothing is reimplemented; nothing is simulated.
2. **One source of truth for flags.** `core/src/commands.ts` declares every option Osama exposes; the UI
   *is generated from it*. Adding a flag to the catalogue adds it to the GUI.
3. **argv, never shell.** Commands are spawned as argument arrays, so a path with spaces or a `;` can never
   be interpreted as shell syntax.
4. **Honest, portable state.** All data lives under a single overridable home (`OSAMA_HOME`), so the app is
   easy to inspect, reset, or relocate.
5. **Calm UI.** Dark, high-contrast, no vendor branding, monospace only where the user copies text.

## Verified working end to end

The following were exercised against a real build (`b11388`) and a real model (`gemma-3-1b-it-Q4_K_M`):

| Step | Evidence |
|------|----------|
| Hardware probe | detected Intel UHD (CPU inference), recommended the CPU build |
| Engine install | downloaded `llama-b11388-bin-ubuntu-x64.tar.gz`, extracted, discovered **14 tool binaries**, fixed the library `RPATH` by keeping `.so` symlinks relative |
| Model download | `gemma-3-1b-it-Q4_K_M.gguf`, 768 MB with byte-accurate progress |
| GGUF card | read `architecture=gemma3`, `context_length=32768`, `file_type=Q4_K_M`, `tokenizer=llama`, chat template present — straight from the header |
| Serve | started `llama-server`, `/health → 200 {"status":"ok"}` |
| Chat | streamed a real completion through Osama's proxy |
| Benchmark | `llama-bench` → `pp32 118.75 t/s`, `tg16 21.01 t/s` on 4 CPU threads |
| Tokenize | `llama-tokenize --ids --show-count` → 9 tokens |

## Repository map

```
osama/
├── core/          @osama/core — platform, engine, downloads, GGUF, hub, processes, commands
├── server/        @osama/server — HTTP + SSE API on 127.0.0.1:5178
├── ui/            @osama/ui — React 18 + Vite views (Dashboard, Chat, Library, Discover, Server, …)
├── src-tauri/     Tauri 2 shell — spawns the engine, hosts the UI, stops it on close
├── scripts/       osama.mjs (headless CLI), shot.mjs (headless screenshots)
└── README.md      full setup, API reference, roadmap
```

## Getting started

```bash
npm install
npm run build
npm start                     # → http://127.0.0.1:5178
```

Or use the CLI for the same engine:

```bash
node scripts/osama.mjs install --accel metal
node scripts/osama.mjs pull ggml-org/gemma-3-1b-it-GGUF gemma-3-1b-it-Q4_K_M.gguf
```

Desktop build (needs Rust + webview libs):

```bash
npm run tauri:build           # .app/.dmg on macOS, .deb/.AppImage on Linux, .msi/.exe on Windows
```

See `README.md` for the API reference and the stage-2 roadmap.
