import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { api } from "../lib/api";
import type { ManagedProcess } from "../lib/types";
import { Badge, Button, Spinner } from "./ui";
import { phaseLabel, phaseProgress, scanLines, errorLines, type LoadPhase } from "../lib/llamaLog";

/**
 * Track whether a llama-server is ready to serve. `core.startProcess` marks a
 * process `running` the moment it spawns, so process status cannot tell a
 * loaded model from one still reading weights — the server's own /health can,
 * and it only answers ok once the model is in memory.
 */
export function useServerReady(baseUrl?: string, intervalMs = 1200): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!baseUrl) {
      setReady(false);
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const h = await api.serverHealth(baseUrl);
        if (!cancelled) setReady(!!h.ok);
      } catch {
        if (!cancelled) setReady(false);
      }
      if (!cancelled) timer = window.setTimeout(tick, intervalMs);
    };
    setReady(false);
    tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [baseUrl, intervalMs]);
  return ready;
}

/**
 * Did the last server attempt die instead of loading? Returns the most recent
 * llama-server in a terminal failure state, so a load that never reaches /health
 * can be reported instead of silently disappearing.
 */
export function useLoadFailure(procs: ManagedProcess[]): { proc: ManagedProcess; since: number } | null {
  return useMemo(() => {
    const failed = procs
      .filter((p) => p.tool.includes("llama-server") && p.status === "failed")
      .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))[0];
    return failed ? { proc: failed, since: failed.endedAt ?? failed.startedAt } : null;
  }, [procs]);
}

export function FailedLoad({ proc, onDismiss }: { proc: ManagedProcess; onDismiss: () => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  // The log holds the reason; fetch it so the user sees llama.cpp's own words.
  useEffect(() => {
    let cancelled = false;
    api
      .processLog(proc.id)
      .then((r) => !cancelled && setLines(r.lines.slice(-400)))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [proc.id]);

  const reasons = useMemo(() => errorLines(lines), [lines]);
  const hint = useMemo(() => diagnose(reasons, lines), [reasons, lines]);

  const copyLog = () => {
    navigator.clipboard.writeText(lines.slice(-80).join("\n")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="card card-pad" style={{ borderColor: "color-mix(in srgb, var(--danger) 45%, transparent)" }}>
      <div className="row" style={{ gap: 12, alignItems: "flex-start" }}>
        <span style={{ marginTop: 1, color: "var(--danger)" }}><AlertTriangle size={17} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 400, fontSize: 13.5 }}>
            Model failed to load <span className="faint">· {proc.label.split(" · ").pop()}</span>
          </div>
          <div className="faint small" style={{ marginTop: 3 }}>
            llama-server exited (code {String(proc.exitCode ?? "?")}) before the model finished loading.
            {hint ? ` ${hint}` : ""}
          </div>

          {reasons.length > 0 && (
            <div className="load-log mono" style={{ marginTop: 10 }}>
              {reasons.map((l: string, i: number) => (
                <div key={i} className={/\b(error|failed|abort|assert)\b/i.test(l) ? "ln-err" : ""}>{l}</div>
              ))}
            </div>
          )}

          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <Button size="sm" onClick={copyLog}>{copied ? "Copied" : "Copy log"}</Button>
            <Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Map the failure text onto an actionable sentence, when we recognise it. */
function diagnose(reasons: string[], all: string[]): string {
  const text = [...reasons, ...all.slice(-40)].join("\n");
  if (/insufficient memory|out of memory|kIOGPUCommandBuffer|failed to allocate|CUDA error.*memory/i.test(text)) {
    return "The accelerator ran out of memory — try a smaller quantization, a smaller context, or a lower GPU-layer count.";
  }
  if (/unknown model architecture|unsupported.*arch/i.test(text)) {
    return "This build does not recognise the model's architecture.";
  }
  if (/failed to open|no such file|not found/i.test(text)) {
    return "The model file could not be opened — it may have been moved or deleted.";
  }
  if (/invalid magic|bad magic|unknown file|version/i.test(text)) {
    return "The file does not look like a valid GGUF.";
  }
  if (/context.*exceed|n_ctx|kv cache/i.test(text)) {
    return "The requested context size is too large for this model or machine.";
  }
  return "";
}


/**
 * Full-width banner shown while a llama-server is starting or loading a model.
 * It reads the process's own log, so the user sees which stage the load is in
 * and only gets a chat box once the server is actually ready.
 */
export function ModelLoading({
  processId, modelName, startedAt, url, onReady, onError,
}: {
  processId?: string;
  modelName?: string;
  startedAt?: number;
  /** The server's base URL — readiness is read from its /health, not the log. */
  url?: string;
  onReady?: () => void;
  onError?: (message: string) => void;
}) {
  const ready = useServerReady(url);
  const [lines, setLines] = useState<string[]>([]);
  const [phase, setPhase] = useState<LoadPhase>("starting");
  const [elapsed, setElapsed] = useState(() => (startedAt ? Date.now() - startedAt : 0));
  const readyFired = useRef(false);
  const errorFired = useRef(false);

  // Poll the process log for stage/progress flavour.
  useEffect(() => {
    if (!processId) return;
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const r = await api.processLog(processId);
        if (cancelled) return;
        setLines(r.lines);
        setPhase((p) => scanLines(r.lines, p).phase);
      } catch {
        /* the process may already be gone */
      }
      if (!cancelled) timer = window.setTimeout(tick, 900);
    };
    setLines([]);
    setPhase("starting");
    tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [processId]);

  // Elapsed clock, so a long 30B load visibly ticks rather than looking hung.
  useEffect(() => {
    if (!startedAt) return;
    const t = window.setInterval(() => setElapsed(Date.now() - startedAt), 500);
    return () => window.clearInterval(t);
  }, [startedAt]);

  // /health is the source of truth for readiness.
  useEffect(() => {
    if (!ready || readyFired.current) return;
    readyFired.current = true;
    setPhase("ready");
    onReady?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  useEffect(() => {
    if (phase !== "error" || errorFired.current) return;
    errorFired.current = true;
    onError?.(scanLines(lines, "starting").last ?? "llama-server reported an error");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const effective: LoadPhase = ready ? "ready" : phase;
  const pct = Math.round((effective === "error" || effective === "ready" ? 1 : Math.min(phaseProgress(effective), 0.95)) * 100);
  const recent = useMemo(() => lines.slice(-5), [lines]);

  return (
    <Cardish tone={effective === "error" ? "danger" : "info"}>
      <div className="row" style={{ gap: 12, alignItems: "flex-start" }}>
        <span style={{ marginTop: 1, color: effective === "error" ? "var(--danger)" : "var(--info)" }}>
          {effective === "error" ? <AlertTriangle size={17} /> : <Spinner />}
        </span>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row" style={{ justifyContent: "space-between", gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 400, fontSize: 13.5 }}>
                {effective === "error" ? "Model failed to load" : "Loading model"}
                {modelName && <span className="faint"> · {modelName}</span>}
              </div>
              <div className="mono small faint" style={{ marginTop: 2 }}>{phaseLabel(effective)} · {(elapsed / 1000).toFixed(0)}s</div>
            </div>
            <div className="row" style={{ gap: 8, flex: "none" }}>
              <Badge kind={effective === "error" ? "danger" : "info"}>{pct}%</Badge>
            </div>
          </div>

          <div className="progress" style={{ marginTop: 10 }}>
            <i
              style={{
                width: `${pct}%`,
                background: effective === "error" ? "var(--danger)" : "var(--text)",
                transition: "width .4s ease",
              }}
            />
          </div>

          {recent.length > 0 && (
            <div className="load-log mono">
              {recent.map((l, i) => (
                <div key={i} className={/error|failed/i.test(l) ? "ln-err" : ""}>{l}</div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Cardish>
  );
}

function Cardish({ tone, children }: { tone: "info" | "danger"; children: React.ReactNode }) {
  const color = tone === "danger" ? "var(--danger)" : "var(--info)";
  return (
    <div
      className="card card-pad"
      style={{ borderColor: `color-mix(in srgb, ${color} 45%, transparent)`, background: "var(--surface)" }}
    >
      {children}
    </div>
  );
}
