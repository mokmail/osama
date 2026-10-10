import type { ManagedProcess } from "./types";

/**
 * Is this process one of the model servers Osama manages?
 *
 * There are two now. llama.cpp runs `llama-server`; MLX runs the `mlx_lm.server`
 * console script, or `python -m mlx_lm server` when it is driving a system
 * interpreter. Checking the binary name alone would leave an MLX server invisible
 * to Chat, the Dashboard, the Library and the Server view — the model would be
 * loading, answering, and nowhere to be seen.
 */
export function isModelServer(p: Pick<ManagedProcess, "tool"> & { argv?: string[] }): boolean {
  const line = `${p.tool} ${(p.argv ?? []).join(" ")}`;
  return /llama-server|mlx_lm\.server|mlx_lm\s+server/.test(line);
}

/** True when the server in question is the MLX one. */
export function isMlxServer(p: Pick<ManagedProcess, "tool"> & { argv?: string[] }): boolean {
  return /mlx_lm/.test(`${p.tool} ${(p.argv ?? []).join(" ")}`);
}

/**
 * The model path a running server was started with.
 *
 * `--model` is checked first and deliberately: MLX servers launched as
 * `python -m mlx_lm server --model …` also contain a bare `-m`, which points at
 * the *module*, so reading `-m` first would report the model as "mlx_lm".
 */
export function servedModelPath(p: { argv?: string[] }): string | undefined {
  const argv = p.argv ?? [];
  const long = argv.findIndex((a) => a === "--model" || (a === "-m" && argv[argv.indexOf("-m") + 1] !== "mlx_lm"));
  const i = argv.indexOf("--model") >= 0 ? argv.indexOf("--model") : long;
  // Absolute in both engines: llama.cpp gets the library path, and mlx-lm
  // requires an absolute path inside its working directory.
  return i >= 0 ? argv[i + 1] : undefined;
}
