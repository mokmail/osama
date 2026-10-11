import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Check, Cpu, Download as DownloadIc, HardDrive, RefreshCw, Sparkles } from "lucide-react";
import { api, mlxApi } from "../lib/api";
import type { Recommendation, RecommendationOffer } from "../lib/types";
import { Badge, Button, Card, CardHead, Spinner, useToast } from "./ui";
import { bytes } from "../lib/format";
import type { EventBus } from "../App";
import type { ViewId } from "../App";

/**
 * The first-run offer: a small model that actually suits this machine.
 *
 * Osama ships no weights, so a fresh install opens on an empty library. This
 * card is the honest answer to "so what do I download?" — the pick comes from
 * `GET /api/recommend` (core decides, never this file), every size shown was
 * read from the app's own plan endpoint, and the download reuses the ordinary
 * `POST /api/downloads` / `POST /api/mlx/download` machinery so progress lands
 * on the same SSE bus as everything else. When the bytes are down, the card
 * turns into the way onward: start the server and open Chat.
 *
 * It vanishes the moment a model exists, and "Not now" is remembered in
 * localStorage — but it is re-offerable, from the Dashboard's own empty state.
 */

/** Dismissal is remembered; re-offering clears it (see the Dashboard hero). */
export const FIRST_RUN_DISMISS_KEY = "osama.firstRun.dismissed";

const SERVER_DEFAULTS = { host: "127.0.0.1", port: 8080, gpuLayers: 999, parallel: 4, jinja: true, metrics: true };
const MLX_DEFAULTS = { host: "127.0.0.1", port: 8082 };

export function FirstRunCard({
  bus,
  onNavigate,
  forceShow,
  onDismissed,
}: {
  bus: EventBus;
  onNavigate: (v: ViewId) => void;
  /** parent-driven override, so the card can be re-offered after a dismissal */
  forceShow: boolean;
  onDismissed: () => void;
}) {
  const toast = useToast();
  const [rec, setRec] = useState<Recommendation | null>(null);
  /** the offer currently downloading */
  const [active, setActive] = useState<string | null>(null);
  /** offers whose bytes are already on disk, keyed by offer id */
  const [done, setDone] = useState<Record<string, { file?: string; dir?: string }>>({});
  const [starting, setStarting] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(FIRST_RUN_DISMISS_KEY) === "1");

  /**
   * Fetching may report `needed: false` once a model has landed; keep the offers
   * we already had so a finished download can still lead onward instead of the
   * card emptying itself.
   */
  const load = (refresh = false) => {
    api
      .recommend(refresh)
      .then((r) => setRec((prev) => (r.offers.length === 0 && prev && prev.offers.length > 0 ? { ...r, offers: prev.offers } : r)))
      .catch(() => {});
  };
  useEffect(() => {
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** A finished (or failed) download for the offer we started. */
  useEffect(() => {
    if (!active || !rec) return;
    const offer = rec.offers.find((o) => o.id === active);
    if (!offer) return;
    const last = bus.events.filter((e) => e.type === "download" && e.data?.repo === offer.ref).slice(-1)[0];
    const stage = last?.data?.stage;
    if (stage === "done") {
      setDone((d) => ({
        ...d,
        [offer.id]: offer.kind === "gguf" ? { file: last.data?.model?.file } : { dir: last.data?.dir },
      }));
      setActive(null);
    } else if (stage === "error") {
      toast.push("err", `Download failed: ${String(last?.data?.error ?? "unknown").slice(0, 200)}`);
      setActive(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bus.events.length, active]);

  /** An MLX runtime that just finished installing changes what can be offered. */
  useEffect(() => {
    if (bus.events.some((e) => e.type === "mlx" && e.data?.stage === "installed")) load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bus.events.length]);

  const progress = useMemo(() => {
    if (!active || !rec) return null;
    const offer = rec.offers.find((o) => o.id === active);
    if (!offer) return null;
    const ev = bus.events.filter((e) => e.type === "download" && e.data?.repo === offer.ref).slice(-1)[0];
    const d = (ev?.data ?? {}) as { file?: string; received?: number; total?: number };
    const pct = d.total ? Math.min(100, Math.round(((d.received ?? 0) / d.total) * 100)) : null;
    return { offer, pct, label: d.file ?? offer.ref, received: d.received ?? 0, total: d.total ?? null };
  }, [bus.events.length, active, rec]);

  const hasDone = Object.keys(done).length > 0;
  if (!rec) return null;
  if (!rec.needed && !hasDone) return null; // a model exists — do not nag
  if (dismissed && !forceShow) return null;

  async function download(o: RecommendationOffer) {
    if (o.kind === "gguf" && !o.file) {
      toast.push("err", "That file's name could not be resolved — open Models to browse the repo.");
      return;
    }
    setActive(o.id);
    try {
      if (o.kind === "gguf") await api.startDownload({ repo: o.ref, file: o.file!, name: o.label, source: "huggingface" });
      else await mlxApi.download(o.ref);
      toast.push("info", `Downloading ${o.label} — progress below.`);
    } catch (e) {
      setActive(null);
      toast.push("err", `Could not start the download: ${(e as Error).message}`);
    }
  }

  /** Start the server on what we just fetched and open Chat on it. */
  async function start(o: RecommendationOffer, at: { file?: string; dir?: string }) {
    setStarting(o.id);
    try {
      let url: string;
      if (o.kind === "mlx") {
        const r = await mlxApi.serve({ model: at.dir, host: MLX_DEFAULTS.host, port: MLX_DEFAULTS.port });
        url = r.process.url ?? `http://${MLX_DEFAULTS.host}:${MLX_DEFAULTS.port}`;
      } else {
        const r = await api.startProcess({
          tool: "server",
          exclusive: true,
          values: {
            model: at.file,
            host: SERVER_DEFAULTS.host,
            port: SERVER_DEFAULTS.port,
            gpuLayers: SERVER_DEFAULTS.gpuLayers,
            parallel: SERVER_DEFAULTS.parallel,
            jinja: SERVER_DEFAULTS.jinja,
            metrics: SERVER_DEFAULTS.metrics,
          },
        });
        url = r.process.url ?? `http://${SERVER_DEFAULTS.host}:${SERVER_DEFAULTS.port}`;
      }
      toast.push("info", `Loading ${o.label}…`);
      // Watch in the background: a load takes minutes and the view must not hold
      // a spinner across it.
      void (async () => {
        const ready = await api.waitForServer(url);
        toast.push(ready ? "ok" : "warn", ready ? `Serving ${o.label} on ${url}` : `${o.label} did not finish loading — see the Models page.`);
        if (ready) onNavigate("chat");
      })();
    } catch (e) {
      toast.push("err", `Could not start the server: ${(e as Error).message}`);
    } finally {
      setStarting(null);
    }
  }

  async function installMlx() {
    try {
      await mlxApi.install();
      toast.push("info", "Building Osama's MLX environment — progress streams on the Models page.");
      onNavigate("models");
    } catch (e) {
      toast.push("err", (e as Error).message);
    }
  }

  function dismiss() {
    localStorage.setItem(FIRST_RUN_DISMISS_KEY, "1");
    setDismissed(true);
    onDismissed();
  }

  const sizeText = (o: RecommendationOffer) =>
    o.sizeBytes ? bytes(o.sizeBytes) : o.sizeNote ? "size unknown" : "reading size…";

  return (
    <Card className="card-pad firstrun">
      <CardHead
        title="Start with a model"
        sub="The library is empty. Here is the smallest thing that suits this machine — a real download, not a placeholder."
        right={
          <div className="row" style={{ gap: 8 }}>
            <Button size="sm" variant="ghost" onClick={() => load(true)} title="Re-read the app's own plan endpoints for the real sizes">
              <RefreshCw size={13} />
            </Button>
            <Button size="sm" variant="ghost" onClick={dismiss}>Not now</Button>
          </div>
        }
      />

      {rec.note && <div className="help" style={{ marginBottom: 12 }}>{rec.note}</div>}

      {rec.needed && (
        <div className="fr-grid">
          {rec.offers.map((o) => {
            const at = done[o.id];
            const isActive = active === o.id;
            const showProgress = isActive && progress?.offer.id === o.id;
            return (
              <div key={o.id} className={`fr-offer ${o.recommended ? "recommended" : ""}`}>
                <div className="fr-offer-head">
                  <div style={{ minWidth: 0 }}>
                    <div className="fr-offer-name" title={o.label}>{o.label}</div>
                    <div className="fr-offer-ref mono" title={o.ref}>{o.ref}</div>
                  </div>
                  {o.recommended && <Badge kind="accent">recommended</Badge>}
                </div>

                <div className="row wrap" style={{ gap: 6 }}>
                  <Badge>{o.engine}{o.kind === "gguf" ? " · GGUF" : " · MLX"}</Badge>
                  <Badge kind="accent">{o.quant}</Badge>
                  <Badge>{o.paramsB}B</Badge>
                </div>

                <div className="small muted">{o.rationale}</div>

                <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                  <span className="mono small" title={o.sizeNote ?? "read from the app's plan endpoint"}>
                    {o.sizeBytes ? sizeText(o) : <span className="faint">{sizeText(o)}</span>}
                  </span>
                  {o.needsEngine && <span className="faint small">needs a llama.cpp build</span>}
                  {o.needsRuntime && <span className="faint small">needs the MLX runtime</span>}
                </div>

                {showProgress ? (
                  <div className="stack" style={{ gap: 7 }}>
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <span className="mono small truncate" title={progress!.label}>{progress!.label}</span>
                      <span className="faint mono small">
                        {bytes(progress!.received)}
                        {progress!.total ? ` / ${bytes(progress!.total)}` : ""}
                        {progress!.pct !== null ? ` · ${progress!.pct}%` : ""}
                      </span>
                    </div>
                    <div className="progress"><i style={{ width: `${progress!.pct ?? 8}%` }} /></div>
                  </div>
                ) : at ? (
                  // The bytes are on disk: lead somewhere real.
                  <div className="row wrap" style={{ gap: 8, alignItems: "center" }}>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={starting === o.id}
                      // Every path out of "downloaded" has to work: without an engine
                      // build, or without the MLX runtime, starting a server is a click
                      // into a failure — send the user to the step that fixes it.
                      onClick={() => {
                        if (o.kind === "mlx" && !rec.mlxReady) return void installMlx();
                        if (o.kind === "gguf" && !rec.engineInstalled) return onNavigate("engine");
                        void start(o, at);
                      }}
                    >
                      {starting === o.id ? (
                        <Spinner />
                      ) : o.kind === "mlx" && !rec.mlxReady ? (
                        <Sparkles size={13} />
                      ) : o.kind === "gguf" && !rec.engineInstalled ? (
                        <HardDrive size={13} />
                      ) : (
                        <ArrowRight size={13} />
                      )}
                      {o.kind === "mlx"
                        ? rec.mlxReady
                          ? "Serve & chat"
                          : "Set up MLX, then chat"
                        : rec.engineInstalled
                          ? "Start & chat"
                          : "Install llama.cpp first"}
                    </Button>
                    <Badge kind="ok"><Check size={11} /> downloaded</Badge>
                    <span className="faint small">
                      {o.kind === "mlx" && !rec.mlxReady
                        ? "the weights are on disk — the runtime is the one step left"
                        : o.kind === "gguf" && !rec.engineInstalled
                          ? "installing a build takes a minute, then come back — the model is already on disk"
                          : "it will appear in the library as soon as the server starts"}
                    </span>
                  </div>
                ) : o.kind === "mlx" && o.needsRuntime && !rec.mlxReady ? (
                  <div className="row wrap" style={{ gap: 8, alignItems: "center" }}>
                    <Button size="sm" variant="ghost" onClick={() => download(o)} disabled={isActive}>
                      <DownloadIc size={13} /> Download first
                    </Button>
                    <Button size="sm" onClick={installMlx}><Sparkles size={13} /> Set up MLX</Button>
                    <span className="faint small">mlx-lm runs these four-bit weights</span>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant={o.recommended ? "primary" : ""}
                    onClick={() => download(o)}
                    disabled={isActive || (o.kind === "gguf" && !o.file)}
                    title={o.kind === "gguf" && !o.file ? "the file name could not be resolved" : undefined}
                  >
                    {isActive ? <Spinner /> : <DownloadIc size={13} />}
                    {o.sizeBytes ? `Download ${sizeText(o)}` : "Download"}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {hasDone && !rec.needed && (
        // The download finished and the library is no longer empty — say so plainly
        // and let the done items above carry the way onward.
        <div className="help" style={{ marginTop: 4 }}>
          A model is in the library now. Start it, then chat with it from the Chat page.
        </div>
      )}

      <div className="hr" />
      <div className="row wrap faint small" style={{ gap: 14 }}>
        <span className="row" style={{ gap: 6, alignItems: "center" }}><Cpu size={12} /> {rec.platform}/{rec.arch} · {bytes(rec.totalMemBytes)} RAM</span>
        <span className="row" style={{ gap: 6, alignItems: "center" }}>
          <HardDrive size={12} /> llama.cpp {rec.engineInstalled ? "installed" : "not installed"}
        </span>
        {rec.mlxSupported && <span className="row" style={{ gap: 6, alignItems: "center" }}><Sparkles size={12} /> MLX {rec.mlxReady ? "ready" : "not set up"}</span>}
        <div className="spacer" style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={() => onNavigate("models")}>Browse all models</button>
      </div>
    </Card>
  );
}
