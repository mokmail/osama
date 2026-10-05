# Osama — audit, bug fixes and modularisation plan

Written after auditing the whole tree *and* exercising the real binaries in
`.osama/bin/llama/b11398-cpu` (see `scripts/check-flags.mjs`,
`scripts/probe-flags.mjs`).

## Verified bugs (reproduced, not guessed)

### Core: the command catalogue emits flags the real build rejects
`llama-quantize` / `llama-server` / `llama-cli` **reject** these today
(reproduced with `node scripts/probe-flags.mjs`):

| Param | Declared flag | Reality |
|---|---|---|
| `quantize.threads` | `-t` | `-t` is **not a flag**; it is treated as a *positional*, so the run aborts with `invalid ftype '<input path>'`. Correct form is a trailing `nthreads` positional. |
| `noMmap` / `mlock` | `--no-mmap`, `--mlock` | Both **rejected** by cli + server + mtmd. Replaced upstream by `--load-mode none\|mlock\|mmap+mlock\|dio`. |
| `outputParams.conversation` | `-cnv` / `--conversation` | **Rejected** — removed upstream. Chat is the default; `-st/--single-turn` remains. |
| `perplexity.pplStr` | `---ppl-str` | Tripled dash — **rejected**. The real flag is `--ppl-stride`. |
| `split.input/output` | `--split`, `--split-file` | Wrong flags on positionals (harmless only because positionals win). |

### Core: catalogue completeness
* `quantize.type` omitted real types (`Q3_K_L`, `Q1_0`, `Q2_0`, `MXFP4_MOE`, `COPY`, …).
* `KNOWN_TOOLS` omits `llama-completion`, although the tool is declared *and* the
  binary ships → `Run CLI → Completion` can never resolve.
* `split` exposes `--split`/`--merge` as two bools (mutually exclusive) instead of one mode.
* `gguf.ts` `FILE_TYPE` is missing `MXFP4_MOE(38)`, `Q1_0(40)`, `Q2_0(41)`.

### Core: dead feature
* `LocalModel.draftOnly` is honoured by the UI and server (a 422 guard) but
  **nothing ever sets it** — speculative-decoding draft heads are never detected.

### Server
* **Path traversal in `serveStatic`**: `path.join(UI_DIST, rel)` then a
  `startsWith` check — a sibling dir sharing the prefix (`ui/dist-x/…`) escapes.
* Scheduler tick mutates a job's JSON file twice on *every* tick (`enabled:false`
  then `true`) just to look busy — corruptible, racy, and writes on a hot path.
* `/api/scheduler/config` returns the API key **in cleartext**.
* `/api/run` `RUNS` map grows unbounded.
* `/api/chat` + `/api/agent` stream without a timeout and leak the upstream error verbatim.

### UI
* `Processes.tsx` imported but never used `useEffect`/hooks fine; several dead imports.
* `Chat.tsx` `regenerate`/`continueReply` use a stale `messages` index after streaming.

## Restructure (make it modular)

* `core/src/tools.ts` (1351 lines) → `core/src/tools/` — registry + one module per family
  (`fs.ts`, `web.ts`, `state.ts`, `scheduler.ts`, `delegate.ts`), index re-exports so
  every existing import keeps working.
* `core/src/commands.ts` → `core/src/commands/` (`spec.ts`, `shared.ts`) with an extended
  `ParamSpec` (`repeat`, `requires`, `hidden`) and a dedicated **GGUF edit** tool.
* `server/src/index.ts` (1495 lines) → `server/src/routes/` (health, engine, models, hub,
  downloads, processes, agent, context, sessions, skills, scheduler, static) behind a tiny
  shared `http.ts` (json/fail/readBody/route matcher).
* New capability modules: `core/src/ggufEdit.ts` (metadata edit + resave + verify) and
  `core/src/lora.ts` (inspect + merge/apply a LoRA and resave).

## New capability (the missing main-feature verbs)

1. **Edit GGUF metadata & resave** — `llama-quantize … COPY` with `--override-kv`
   (type spelling pinned by experiment: `str:` / `int:` / `float:` / `bool:`), then the
   result is re-read with the built-in parser to *prove* the edit landed.
   Verified live: tensor count preserved (340), `general.name` changed, no duplicate keys.
2. **Apply / merge a LoRA** — `llama-export-lora -m base -o out --lora adapter.gguf`.
3. **Prune layers / retype tensors** — expose `--prune-layers`, `--output-tensor-type`,
   `--token-embedding-type`, `--tensor-type`, `--dry-run`, `--max-buffer-size`.

> Honest scope note: llama.cpp release binaries ship **no trainer**. "Finetune" here means
> *produce/merge and resave an adapter locally*; training itself needs
> `llama-finetune`/unsloth outside this build, and the UI says so rather than faking it.

## Verification

```sh
npm run typecheck && npm run build
node scripts/check-flags.mjs      # catalogue vs the installed build
node scripts/probe-flags.mjs      # decisive: does the parser accept each flag
node scripts/smoke.mjs            # end-to-end against a live engine + model
```
