import { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  Boxes, Cpu, Download, Gauge, HardDrive, MessagesSquare, Server as ServerIcon, Terminal, Wrench,
} from "lucide-react";
import { agentApi, api } from "../lib/api";
import type { AgentStats, ServerMetrics, SeriesSample, StatsSnapshot, SystemResponse } from "../lib/types";
import { Badge, Button, Card, CardHead, Console, usePoll } from "../components/ui";
import { bytes, compactTokens, num, rate, sinceNow, timeAgo, uptime } from "../lib/format";
import type { EventBus } from "../App";
import type { ViewId } from "../App";

const POLL_MS = 3000;

/** Lets deeply-nested fragments navigate without threading props everywhere. */
const NavContext = createContext<(v: ViewId) => void>(() => {});
const useNav = () => useContext(NavContext);

export function Dashboard({ system, bus, onNavigate }: { system: SystemResponse | null; bus: EventBus; onNavigate: (v: ViewId) => void }) {
  const [stats, setStats] = useState<StatsSnapshot | null>(null);
  const [series, setSeries] = useState<SeriesSample[]>([]);
  const [metrics, setMetrics] = useState<ServerMetrics | null>(null);
  // The agent harness is counted separately from the llama.cpp engine. Both
  // halves have a "tool" count and they are different things, so the dashboard
  // labels them apart instead of showing one ambiguous number.
  const [agent, setAgent] = useState<AgentStats | null>(null);

  const serverProc = stats?.processes.runningNow.find((p) => p.tool.includes("llama-server"));
  const serverUrl = serverProc?.url;
  // The Dashboard shows which model is loaded, so "what is running" is never a
  // guess. Names come from the served path's basename.
  const servedModel = useMemo(() => {
    if (!metrics?.up) return null;
    const p = metrics.model ?? "";
    return { file: p, name: p.split("/").pop() ?? p, quant: metrics.ftype, ctx: metrics.nCtx };
  }, [metrics]);

  const refresh = () => {
    api.stats().then(setStats).catch(() => {});
    api.series().then((r) => setSeries(r.samples)).catch(() => {});
    if (serverUrl) api.serverMetrics(serverUrl).then(setMetrics).catch(() => setMetrics(null));
    else setMetrics(null);
  };

  const refreshAgent = () => {
    agentApi.stats().then(setAgent).catch(() => {});
  };

  usePoll(refresh, POLL_MS, [serverUrl]);
  // The harness inventory only moves when a skill, memory entry, job or MCP
  // server is added — it does not need the live 3 s cadence.
  usePoll(refreshAgent, 15_000);
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bus.events.length]);

  const recentLog = useMemo(
    () => bus.events.filter((e) => e.type === "log").slice(-60).map((e) => e.data.msg as string),
    [bus.events],
  );

  const busy =
    (stats?.downloads.active ?? 0) > 0 ||
    !!bus.events.slice(-40).some((e) => e.type === "install" && e.data?.stage !== "installed" && e.data?.stage !== "error");

  // llama-server reports a decaying average, so remember the best rate seen
  // while the process lives — the honest "how fast did it go" number.
  const peakKey = serverUrl ?? "";
  const [peaks, setPeaks] = useState<Record<string, number>>({});
  const peak = peaks[peakKey] ?? 0;
  useEffect(() => {
    const r = metrics?.predictedTps ?? 0;
    if (!serverUrl || !(r > 0)) return;
    setPeaks((p) => ((p[serverUrl] ?? 0) >= r ? p : { ...p, [serverUrl]: r }));
  }, [metrics?.predictedTps, serverUrl]);

  return (
    <NavContext.Provider value={onNavigate}>
      <div className="stack">
        <Hero stats={stats} serverUrl={serverUrl} onNavigate={onNavigate} />

        <ServingStrip model={servedModel} url={serverUrl} metrics={metrics} />

        <HeadlineRow stats={stats} metrics={metrics} />

        <Section title="Agent" note="the local agent harness — what the model may call, counted apart from the llama.cpp binaries">
          <AgentPanels stats={agent} />
        </Section>

        <Section title="Engine" note="the llama.cpp build Osama drives">
          <EnginePanels stats={stats} />
        </Section>

        <Section title="Library" note="every GGUF reading from its own header">
          <LibraryPanels stats={stats} />
        </Section>

        <Section title="Runtime" note="processes, downloads and live inference">
          <RuntimePanels stats={stats} metrics={metrics} series={series} busy={busy} peak={peak} />
        </Section>

        <Section title="Machine" note="host, memory and disk headroom">
          <MachinePanels stats={stats} system={system} series={series} />
        </Section>

        <Section title="Activity" note="what this session has done">
          <ActivityPanels stats={stats} bus={bus} />
        </Section>

        <Card className="card-pad">
          <CardHead title="Engine log" sub="live output from the Osama backend" />
          <Console lines={recentLog} max={16} />
        </Card>

        <QuickActions onNavigate={onNavigate} />
      </div>
    </NavContext.Provider>
  );
}

/* ------------------------------------------------------------------ layout */

/**
 * The single most useful dashboard fact: which model is loaded right now.
 * Reads the server's own /props so it reports the model actually in memory,
 * not the one somebody meant to start.
 */
function ServingStrip({
  model, url, metrics,
}: {
  model: { file: string; name: string; quant?: string; ctx?: number } | null;
  url?: string;
  metrics: ServerMetrics | null;
}) {
  const nav = useNav();
  const running = !!url;
  const color = model ? "var(--ok)" : running ? "var(--warn)" : "var(--text-faint)";

  return (
    <div
      className="card"
      style={{
        borderColor: model ? "color-mix(in srgb, var(--ok) 38%, transparent)" : running ? "color-mix(in srgb, var(--warn) 38%, transparent)" : undefined,
        padding: "16px 22px",
      }}
    >
      <div className="row wrap" style={{ gap: 16, alignItems: "center" }}>
        <span className="row" style={{ gap: 9, flex: "none" }}>
          <span className="dot" style={{ color, width: 8, height: 8, background: color, borderRadius: "50%" }} />
          <span className="fig-l" style={{ color: "var(--text-dim)" }}>{(model || running) ? "serving" : "no model running"}</span>
        </span>

        <div style={{ minWidth: 0, flex: 1 }}>
          {model ? (
            <div className="row wrap" style={{ gap: 10 }}>
              <span style={{ fontSize: 16, fontWeight: 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={model.file}>
                {model.name}
              </span>
              {model.quant && <Badge kind="accent">{model.quant}</Badge>}
              {model.ctx ? <Badge>{compactTokens(model.ctx)} ctx</Badge> : null}
              {metrics?.slots ? <Badge>{metrics.slots} slots</Badge> : null}
            </div>
          ) : running ? (
            <span className="muted small">
              A llama-server is up on <span className="mono">{url}</span> but has not reported a model yet — it may still be loading.
            </span>
          ) : (
            <span className="muted small">Nothing is being served. Pick a model in the Library and hit “Chat with this model”.</span>
          )}
        </div>

        <div className="row" style={{ gap: 9, flex: "none" }}>
          {model && metrics?.up && <span className="mono small faint">{rate(metrics.predictedTps)} tok/s</span>}
          {model && url && <span className="mono small faint">{url}</span>}
          <Button size="sm" variant="ghost" onClick={() => nav(model ? "chat" : "models")}>
            {model ? "Open chat" : "Choose a model"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="metric-row">
      <div className="metric-head">
        <h2>{title}</h2>
        {note && <p>{note}</p>}
        <div className="spacer" />
      </div>
      {children}
    </div>
  );
}

function Figure({ value, label, sub, tone }: { value: string; label: string; sub?: React.ReactNode; tone?: "ok" | "warn" | "danger" }) {
  return (
    <div className="figure">
      <div className="fig-v" style={tone === "danger" ? { color: "var(--danger)" } : undefined}>
        {value}
      </div>
      <div className="fig-l">{label}</div>
      {sub && <div className="fig-s">{sub}</div>}
    </div>
  );
}

function Panel({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>{title}</h3>
        <div className="spacer" />
        {right}
      </div>
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------- hero */

function Hero({ stats, serverUrl, onNavigate }: { stats: StatsSnapshot | null; serverUrl?: string; onNavigate: (v: ViewId) => void }) {
  const score = stats?.health.score ?? null;
  const scoreTone = score === null ? "" : score >= 85 ? "ok" : score >= 60 ? "warn" : "danger";
  return (
    <div style={{ paddingTop: 4 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end", gap: 24, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div className="fig-l" style={{ marginBottom: 10 }}>
            {stats ? `${stats.system.hostname} · ${stats.system.os}/${stats.system.arch} · up ${uptime(stats.uptimeMs)}` : "connecting to the engine…"}
          </div>
          <div style={{ fontSize: "clamp(34px, 4.2vw, 60px)", fontWeight: 200, letterSpacing: "-0.04em", lineHeight: 0.95, maxWidth: 640 }}>
            {stats?.engine.installed ? "llama.cpp, under control." : "Set up llama.cpp."}
          </div>
        </div>
        <div className="score">
          <div className="score-n" style={{ color: scoreTone === "danger" ? "var(--danger)" : scoreTone === "warn" ? "var(--warn)" : undefined }}>
            {score === null ? "—" : String(score).padStart(2, "0")}
          </div>
          <div className="stack" style={{ gap: 6 }}>
            <span className="score-l">readiness / 100</span>
            {scoreTone && (
              <Badge kind={scoreTone as any}>
                {scoreTone === "ok" ? "healthy" : scoreTone === "warn" ? "attention" : "action needed"}
              </Badge>
            )}
          </div>
        </div>
      </div>
      <div className="row wrap" style={{ gap: 10, marginTop: 22 }}>
        {serverUrl ? (
          <Badge kind="ok"><span className="dot" /> serving · {serverUrl}</Badge>
        ) : (
          <Badge kind="warn">no server running</Badge>
        )}
        {stats?.engine.installed && <Badge kind="accent">{stats.engine.tag} · {stats.engine.acceleration}</Badge>}
        {stats && <Badge>{stats.library.count} models · {bytes(stats.library.totalBytes)}</Badge>}
        {stats && (stats.downloads.active > 0 ? <Badge kind="info">{stats.downloads.active} downloading</Badge> : <Badge>idle</Badge>)}
        <div className="spacer" style={{ flex: 1 }} />
        <Button size="sm" variant="ghost" onClick={() => onNavigate("processes")}>Processes</Button>
        <Button size="sm" variant="ghost" onClick={() => onNavigate("engine")}>llama.cpp</Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ headline row */

function HeadlineRow({ stats, metrics }: { stats: StatsSnapshot | null; metrics: ServerMetrics | null }) {
  const s = stats;
  return (
    <Section title="At a glance" note={s ? `snapshot taken ${sinceNow(Date.parse(s.generatedAt))}` : undefined}>
      <div className="figures">
        <Figure
          value={s ? String(s.library.count).padStart(2, "0") : "—"}
          label="Models"
          sub={s ? <><span>{bytes(s.library.totalBytes)}</span> · {s.library.servable} servable</> : undefined}
        />
        <Figure
          value={s ? String(s.engine.tools) : "—"}
          label="llama.cpp tools"
          sub={
            s
              ? (
                  <>
                    <span>{s.engine.frontEndsPresent ?? s.engine.tools} of {s.engine.frontEndsTotal ?? s.engine.knownTools} drivable</span>
                    {" · "}{s.engine.tag ?? "no build"}
                  </>
                )
              : undefined
          }
        />
        <Figure
          value={metrics?.up ? "up" : "—"}
          label="Server"
          sub={
            metrics?.up
              ? <><span className="mono">{metrics.ftype ?? "?"}</span> · {metrics.slots ?? "?"} slots</>
              : <span className="faint">not running</span>
          }
          tone={metrics?.up ? "ok" : undefined}
        />
        <Figure
          value={metrics?.up && metrics.predictedTps ? rate(metrics.predictedTps) : s ? `${s.system.memUsedPct}%` : "—"}
          label={metrics?.up && metrics.predictedTps ? "tok/s gen" : "Memory"}
          sub={
            metrics?.up
              ? <span>{num(metrics.tokensPredictedTotal)} tokens generated</span>
              : s ? <span>{bytes(s.system.freeMemBytes)} free of {bytes(s.system.totalMemBytes)}</span> : undefined
          }
        />
        <Figure
          value={s ? String(s.processes.running) : "—"}
          label="Processes"
          sub={s ? <><span>{s.processes.total} tracked</span>{s.processes.failed > 0 && <Badge kind="danger">{s.processes.failed} failed</Badge>}</> : undefined}
        />
        <Figure
          value={s ? String(s.disk.volume?.usedPct ?? "—") + (s.disk.volume ? "%" : "") : "—"}
          label="Volume used"
          sub={s?.disk.volume ? <span>{bytes(s.disk.volume.freeBytes)} free</span> : undefined}
        />
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ engine */

function EnginePanels({ stats }: { stats: StatsSnapshot | null }) {
  const e = stats?.engine;
  const score = stats?.health.checks ?? [];
  return (
    <div className="panel-grid">
      <Panel title="Build" right={e?.installed ? <Badge kind="ok">installed</Badge> : <Badge kind="warn">missing</Badge>}>
        <dl className="kv">
          <dt>Tag</dt><dd className="mono">{e?.tag ?? "—"}</dd>
          <dt>Acceleration</dt><dd>{e?.acceleration ? <Badge kind="accent">{e.acceleration}</Badge> : "—"}</dd>
          <dt>Installed</dt><dd>{e?.installedAt ? timeAgo(e.installedAt) : "—"}</dd>
          <dt>Binaries</dt><dd>{e?.tools ?? 0} of {e?.knownTools ?? 0} shipped by this build</dd>
          <dt>Drivable</dt><dd>{e?.frontEndsTotal ? `${e.frontEndsPresent ?? 0} of ${e.frontEndsTotal}` : "—"} front-ends in the Tools views</dd>
          <dt>On disk</dt><dd>{bytes(e?.sizeBytes ?? 0)}</dd>
          <dt>Builds</dt><dd>{e?.enginesInstalled ?? 0} side-by-side</dd>
        </dl>
      </Panel>

      <Panel title="Tool coverage" right={<span className="faint mono small">{e?.tools ?? 0}/{e?.knownTools ?? 0} shipped</span>}>
        {e && e.toolNames.length > 0 ? (
          <>
            <div className="row wrap" style={{ gap: 6 }}>
              {e.toolNames.map((t) => (
                <Badge key={t}>{t.replace(/^llama-/, "")}</Badge>
              ))}
            </div>
            <div className="hr" />
            <div className="muted small">
              {e.frontEndsPresent ?? 0} of {e.frontEndsTotal ?? 0} can be driven from the Tools views. These are the
              engine's binaries — the tools the <em>model</em> may call are counted in the Agent section.
              {(e.missingTools?.length ?? 0) > 0 && (
                <> This build ships no <span className="mono">{e.missingTools.map((t) => t.replace(/^llama-/, "")).join(", ")}</span>.</>
              )}
            </div>
          </>
        ) : (
          <div className="muted small">Install a llama.cpp build to resolve the tool binaries.</div>
        )}
      </Panel>

      <Panel title="Readiness">
        <div className="checklist">
          {score.map((c) => (
            <div key={c.id} className="check-item">
              <span className={`chk-mark ${c.status}`} />
              <span className="chk-label">{c.label}</span>
              <span className="chk-detail">{c.detail}</span>
            </div>
          ))}
          {score.length === 0 && <div className="muted small">probing…</div>}
        </div>
      </Panel>
    </div>
  );
}

/* ----------------------------------------------------------------- library */

function LibraryPanels({ stats }: { stats: StatsSnapshot | null }) {
  const nav = useNav();
  const lib = stats?.library;
  const recent = stats?.library.recent ?? [];
  return (
    <div className="panel-grid">
      <Panel title="Composition" right={lib && <span className="faint mono small">{lib.count} models</span>}>
        {lib && lib.architectures.length > 0 ? (
          <div className="bars">
            {lib.architectures.slice(0, 6).map((a) => (
              <Bar key={a.name} label={a.name} value={a.bytes} max={lib.maxBytes || lib.totalBytes} suffix={`${a.count}×`} />
            ))}
          </div>
        ) : (
          <div className="muted small">No models yet.</div>
        )}
        {lib && lib.quantizations.length > 0 && (
          <>
            <div className="hr" />
            <div className="row wrap" style={{ gap: 6 }}>
              {lib.quantizations.slice(0, 8).map((q) => (
                <Badge key={q.name} kind="accent">{q.name} · {q.count}</Badge>
              ))}
            </div>
          </>
        )}
      </Panel>

      <Panel title="Totals">
        <div className="figures compact">
          <Figure value={bytes(lib?.totalBytes ?? 0)} label="On disk" sub={lib ? <span>avg {bytes(lib.avgBytes)}</span> : undefined} />
          <Figure value={compactTokens(lib?.contextMax)} label="Max context" sub={lib?.contextTotal ? <span>{compactTokens(lib.contextTotal)} summed</span> : undefined} />
        </div>
        <div className="hr" />
        <div className="act-grid">
          <ActivityStat n={lib?.servable ?? 0} l="servable" />
          <ActivityStat n={lib?.external ?? 0} l="imported" />
          <ActivityStat n={lib?.drafts ?? 0} l="draft heads" />
          <ActivityStat n={lib?.missing ?? 0} l="missing files" />
        </div>
      </Panel>

      <Panel title="Recent" right={<Button size="sm" variant="ghost" onClick={() => nav("models")}>Library</Button>}>
        {recent.length === 0 ? (
          <div className="muted small">Nothing in the library yet — download a GGUF from Discover.</div>
        ) : (
          <div className="timeline">
            {recent.map((m) => (
              <div key={m.id} className="tl-row" onClick={() => nav("models")} style={{ cursor: "pointer" }}>
                <span className="tl-time">{timeAgo(m.addedAt)}</span>
                <span className="tl-kind">{m.quantization ?? "?"}</span>
                <span className="tl-text" title={m.name}>{m.name}</span>
                <span className="tl-time" style={{ textAlign: "right" }}>{bytes(m.sizeBytes)}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

/* ----------------------------------------------------------------- runtime */

function RuntimePanels({
  stats, metrics, series, busy, peak,
}: {
  stats: StatsSnapshot | null; metrics: ServerMetrics | null; series: SeriesSample[]; busy: boolean; peak: number;
}) {
  const procs = stats?.processes.runningNow ?? [];
  const dl = stats?.downloads;
  return (
    <>
      <div className="panel-grid">
        <Panel
          title="Inference server"
          right={metrics?.up ? <Badge kind="ok"><span className="dot" /> live</Badge> : <Badge kind="warn">down</Badge>}
        >
          {metrics?.up ? (
            <div className="figures compact">
              <Figure
                value={rate(metrics.predictedTps)}
                label="tok/s generation"
                sub={peak > 0 ? <span>peak {rate(peak)} this session</span> : undefined}
              />
              <Figure value={rate(metrics.promptTps)} label="tok/s prompt" />
              <Figure value={String(metrics.requestsProcessing ?? 0)} label="inflight" sub={metrics.requestsDeferred ? <Badge kind="warn">{metrics.requestsDeferred} queued</Badge> : undefined} />
              <Figure value={metrics.cacheReusePct === null ? "—" : `${metrics.cacheReusePct}%`} label="prompt cache hit" />
            </div>
          ) : (
            <div className="stack" style={{ gap: 12 }}>
              <div className="muted small">
                No <span className="mono">llama-server</span> is running. Start one to stream live throughput, token totals and cache reuse here.
              </div>
              <div className="row wrap" style={{ gap: 6 }}>
                {stats && <Badge>{stats.library.servable} models ready to serve</Badge>}
                {metrics?.error && <Badge kind="danger">{metrics.error}</Badge>}
              </div>
            </div>
          )}
          {metrics?.up && (
            <>
              <div className="hr" />
              <dl className="kv">
                <dt>Model</dt><dd className="mono small" title={metrics.model}>{metrics.model?.split("/").pop() ?? "—"}</dd>
                <dt>Quantization</dt><dd>{metrics.ftype ?? "—"}</dd>
                <dt>Context</dt><dd>{compactTokens(metrics.nCtx)} × {metrics.slots ?? "?"} slots</dd>
                <dt>Build</dt><dd className="mono small">{metrics.build ?? "—"}</dd>
                <dt>Tokens</dt><dd>{num(metrics.promptTokensTotal)} prompt · {num(metrics.tokensPredictedTotal)} generated</dd>
                <dt>Cache reuse</dt><dd>{metrics.cacheReusePct === null ? "—" : `${metrics.cacheReusePct}%`}</dd>
              </dl>
            </>
          )}
        </Panel>

        <Panel title="Processes" right={<span className="faint mono small">{stats?.processes.running ?? 0} running</span>}>
          {procs.length === 0 ? (
            <div className="muted small">Nothing running. Start a server, a benchmark or a chat.</div>
          ) : (
            procs.map((p) => (
              <div key={p.id} className="uptime">
                <span className="up-name" title={p.label}>{p.label}</span>
                <span className="up-meta">pid {p.pid ?? "—"} · {uptime(p.uptimeMs)}</span>
              </div>
            ))
          )}
          <div className="hr" />
          <div className="act-grid">
            <ActivityStat n={stats?.processes.running ?? 0} l="running" />
            <ActivityStat n={stats?.processes.exited ?? 0} l="exited" />
            <ActivityStat n={stats?.processes.failed ?? 0} l="failed" />
            <ActivityStat n={stats?.processes.stopped ?? 0} l="stopped" />
          </div>
        </Panel>

        <Panel title="Downloads" right={busy ? <Badge kind="info">active</Badge> : <Badge>idle</Badge>}>
          <div className="act-grid" style={{ marginBottom: 16 }}>
            <ActivityStat n={dl?.active ?? 0} l="downloading" />
            <ActivityStat n={dl?.done ?? 0} l="completed" />
            <ActivityStat n={dl?.error ?? 0} l="errored" />
            <ActivityStat n={stats?.disk.partialFiles ?? 0} l="partials" />
          </div>
          {dl && dl.records.length > 0 ? (
            dl.records.map((d) => {
              const pct = d.total ? Math.round((d.received / d.total) * 100) : 0;
              return (
                <div key={d.id} className="dl-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 7 }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span className="mono small truncate" title={d.file}>{d.file}</span>
                    <span className="faint mono small">{bytes(d.received)}{d.total ? ` / ${bytes(d.total)}` : ""}</span>
                  </div>
                  <div className="progress"><i style={{ width: `${d.status === "done" ? 100 : pct}%` }} /></div>
                </div>
              );
            })
          ) : (
            <div className="muted small">No downloads this session.</div>
          )}
        </Panel>
      </div>

      <div style={{ marginTop: 14 }}>
        <Panel title="Live series" right={<span className="faint mono small">5 s sampling · {series.length} points</span>}>
          <div className="panel-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
            <Sparkline samples={series} accessor={(s) => s.memUsedPct} label="memory used %" suffix="%" />
            <Sparkline samples={series} accessor={(s) => s.loadPct} label="cpu load %" suffix="%" />
            <Sparkline samples={series} accessor={(s) => s.runningProcesses} label="running processes" />
          </div>
        </Panel>
      </div>
    </>
  );
}

/* ----------------------------------------------------------------- machine */

function MachinePanels({
  stats, system, series,
}: {
  stats: StatsSnapshot | null; system: SystemResponse | null; series: SeriesSample[];
}) {
  const d = stats?.disk;
  const volume = d?.volume;
  const parts = d
    ? [
        { label: "models", value: d.models.bytes, color: "var(--text)" },
        { label: "engines", value: d.engines.bytes, color: "var(--text-dim)" },
        { label: "logs", value: d.logs.bytes, color: "var(--text-faint)" },
        { label: "partial", value: d.partialBytes, color: "var(--warn)" },
      ].filter((p) => p.value > 0)
    : [];
  const composition = parts.reduce((s, p) => s + p.value, 0) || 1;

  return (
    <div className="panel-grid">
      <Panel title="Host">
        {system ? (
          <dl className="kv">
            <dt>OS</dt><dd>{system.system.os} {system.system.arch} ({system.system.release})</dd>
            <dt>CPU</dt><dd>{system.system.cpuModel}</dd>
            <dt>Cores</dt><dd>{system.system.cpus}</dd>
            <dt>Load</dt><dd>{stats?.system.loadavg.map((l) => l.toFixed(2)).join(" · ") ?? "—"}</dd>
            <dt>Accelerator</dt><dd>{system.gpu.discrete ? system.gpu.name : "none — CPU inference"} {system.gpu.discrete && <Badge kind="accent">{system.gpu.acceleration}</Badge>}</dd>
            <dt>Recommended</dt><dd><Badge kind="accent">{system.recommendedAcceleration}</Badge></dd>
            <dt>Hostname</dt><dd className="mono small">{stats?.system.hostname ?? system.system.hostname}</dd>
          </dl>
        ) : (
          <div className="muted small">probing…</div>
        )}
      </Panel>

      <Panel title="Memory" right={<span className="faint mono small">{stats?.system.memUsedPct ?? 0}%</span>}>
        <div className="bars">
          <Bar label="used" value={stats?.system.usedMemBytes ?? 0} max={stats?.system.totalMemBytes ?? 1} suffix={bytes(stats?.system.usedMemBytes)} />
          <Bar label="free" value={stats?.system.freeMemBytes ?? 0} max={stats?.system.totalMemBytes ?? 1} suffix={bytes(stats?.system.freeMemBytes)} />
        </div>
        <div className="hr" />
        <Sparkline samples={series} accessor={(s) => s.memFreeBytes} label="free memory" formatter={bytes} />
      </Panel>

      <Panel title="Disk" right={volume && <Badge kind={volume.usedPct > 90 ? "danger" : volume.usedPct > 75 ? "warn" : "ok"}>{volume.usedPct}% used</Badge>}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
          <span className="fig-l">volume used</span>
          <span className="mono small">{volume ? `${bytes(volume.totalBytes - volume.freeBytes)} / ${bytes(volume.totalBytes)}` : "—"}</span>
        </div>
        <div className="meter" style={{ height: 4 }}>
          <i style={{ width: `${volume?.usedPct ?? 0}%`, background: "var(--text-dim)" }} />
        </div>

        <div className="hr" />
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
          <span className="fig-l">osama footprint</span>
          <span className="mono small">{bytes(composition)}{volume ? ` · ${((composition / volume.totalBytes) * 100).toFixed(2)}% of volume` : ""}</span>
        </div>
        <div className="meter">
          {parts.map((p) => (
            <i key={p.label} style={{ width: `${(p.value / composition) * 100}%`, background: p.color }} />
          ))}
        </div>
        <div className="meter-legend">
          {parts.map((p) => (
            <span key={p.label} className="lg"><span className="sw" style={{ background: p.color }} />{p.label} {bytes(p.value)}</span>
          ))}
        </div>

        <div className="hr" />
        <dl className="kv">
          <dt>Models</dt><dd>{bytes(d?.models.bytes ?? 0)} <span className="faint">({d?.models.files ?? 0} files)</span></dd>
          <dt>Engines</dt><dd>{bytes(d?.engines.bytes ?? 0)} <span className="faint">({d?.engines.files ?? 0} files)</span></dd>
          <dt>Partial</dt><dd>{bytes(d?.partialBytes ?? 0)} <span className="faint">({d?.partialFiles ?? 0})</span></dd>
          <dt>Volume free</dt><dd>{volume ? bytes(volume.freeBytes) : "—"}</dd>
        </dl>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------- agent */

/**
 * The agent half of the app, rendered next to — and deliberately unlike — the
 * engine half.
 *
 * Every "tool" number on this page means something different, so the labels say
 * which one it is: the Engine section counts llama.cpp binaries on disk, this
 * counts the JSON schemas the model is handed on every agent turn.
 */
function AgentPanels({ stats }: { stats: AgentStats | null }) {
  const nav = useNav();
  if (!stats) {
    return (
      <div className="panel">
        <div className="panel-head">
          <h3>Agent harness</h3>
        </div>
        <div className="muted small">
          reading the agent harness… if this never resolves, the running engine is older than this
          UI — restart Osama.
        </div>
      </div>
    );
  }
  const t = stats.tools;
  const mem = stats.memory;
  return (
    <div className="panel-grid">
      <Panel title="Agent tools" right={<span className="faint mono small">{t.total} the model may call</span>}>
        <div className="figures compact">
          <Figure value={String(t.builtIn)} label="built in" sub={<span>{t.mutating} can change files</span>} />
          <Figure value={String(t.readOnly)} label="read only" sub={<span>never touch state</span>} />
          <Figure
            value={String(t.mcp)}
            label="from MCP"
            sub={
              stats.mcp.servers > 0
                ? <span>{stats.mcp.connected} of {stats.mcp.servers} server(s) connected</span>
                : <span className="faint">no server configured</span>
            }
          />
        </div>
        <div className="hr" />
        <div className="muted small">
          Each of these is a schema sent with every agent turn, so they occupy context even when
          unused. Switch the chat header to <span className="mono">Agent</span> to put them to work.
        </div>
      </Panel>

      <Panel title="Harness state" right={<Badge>{stats.workspace.chosen ? "workspace set" : "default workspace"}</Badge>}>
        <dl className="kv">
          <dt>Workspace</dt><dd className="mono small" title={stats.workspace.path}>{stats.workspace.path}</dd>
          <dt>Skills</dt><dd>{stats.skills.total} installed <span className="faint">· {stats.skills.roots} search root(s)</span></dd>
          <dt>Memory</dt><dd>{mem.entries} entries <span className="faint">· {mem.used} / {mem.budget} chars ({mem.percent}%)</span></dd>
          <dt>Scheduled jobs</dt><dd>{stats.jobs.total} <span className="faint">· {stats.jobs.enabled} enabled</span></dd>
          <dt>Sessions</dt><dd>{stats.sessions.total} logged{stats.sessions.last ? <span className="faint"> · last {timeAgo(stats.sessions.last)}</span> : null}</dd>
        </dl>
        <div className="hr" />
        <div className="row" style={{ gap: 9 }}>
          <Button size="sm" variant="ghost" onClick={() => nav("chat")}>Open agent chat</Button>
          <Button size="sm" variant="ghost" onClick={() => nav("mcp")}>MCP servers</Button>
        </div>
      </Panel>
    </div>
  );
}

/* ---------------------------------------------------------------- activity */

function ActivityPanels({ stats, bus }: { stats: StatsSnapshot | null; bus: EventBus }) {
  const nav = useNav();
  const activity = stats?.activity ?? [];
  const events = bus.events;
  const last = events[events.length - 1];
  const byType = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of events) m.set(e.type, (m.get(e.type) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [events]);

  const kindOf = (t: string) =>
    t === "log" ? "log" : t === "download" ? "download" : t === "process" ? "process" : t === "install" ? "install" : t === "run" ? "run" : t;

  const recent = useMemo(() => events.filter((e) => e.type !== "log" && e.type !== "hello").slice(-14).reverse(), [events]);

  return (
    <div className="panel-grid">
      <Panel title="This session" right={<span className="faint mono small">{events.length} events</span>}>
        <div className="act-grid">
          {byType.slice(0, 8).map(([type, count]) => (
            <ActivityStat key={type} n={count} l={type} />
          ))}
          {byType.length === 0 && <div className="muted small">Waiting for the event stream…</div>}
        </div>
        <div className="hr" />
        <dl className="kv">
          <dt>Server-side</dt><dd>{activity.length} event kinds counted</dd>
          <dt>Last event</dt><dd>{last ? `${kindOf(last.type)} · ${sinceNow(last.ts)}` : "—"}</dd>
        </dl>
      </Panel>

      <Panel title="Event timeline" right={<Button size="sm" variant="ghost" onClick={() => nav("processes")}>{recent.length} recent</Button>}>
        {recent.length === 0 ? (
          <div className="muted small">No process, download or install events yet this session.</div>
        ) : (
          <div className="timeline">
            {recent.map((e, i) => (
              <div key={i} className="tl-row">
                <span className="tl-time">{new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                <span className="tl-kind">{kindOf(e.type)}</span>
                <span className="tl-text" title={JSON.stringify(e.data).slice(0, 240)}>{describeEvent(e)}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function describeEvent(e: { type: string; data: any }): string {
  const d = e.data ?? {};
  switch (e.type) {
    case "download":
      return `${d.stage ?? "?"} · ${d.file ?? d.repo ?? ""}`;
    case "install":
      return `${d.stage ?? "?"}${d.engine?.tag ? ` · ${d.engine.tag}` : ""}${d.error ? ` · ${d.error}` : ""}`;
    case "process":
      return d.stage === "exit" ? `exited · ${d.proc?.label ?? ""}` : `${d.line ?? ""}`;
    case "run":
      return `${d.stage ?? "?"} · ${d.tool ?? ""}${d.command ? ` · ${d.command}` : ""}`;
    default:
      return JSON.stringify(d).slice(0, 120);
  }
}

/* ---------------------------------------------------------------- fragments */

function ActivityStat({ n, l }: { n: number; l: string }) {
  return (
    <div className="act">
      <span className="act-n">{n}</span>
      <span className="act-l">{l}</span>
    </div>
  );
}

function Bar({ label, value, max, suffix }: { label: string; value: number; max: number; suffix: string }) {
  const pct = max > 0 ? Math.max(1, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="bar-row">
      <span className="bar-label" title={label}>{label}</span>
      <span className="bar-track"><span className="bar-fill" style={{ display: "block", width: `${pct}%` }} /></span>
      <span className="bar-val">{suffix}</span>
    </div>
  );
}

function Sparkline({
  samples, accessor, label, suffix, formatter,
}: {
  samples: SeriesSample[];
  accessor: (s: SeriesSample) => number;
  label: string;
  suffix?: string;
  formatter?: (n: number) => string;
}) {
  const W = 300;
  const H = 46;
  const pad = 3;
  const values = samples.map(accessor);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const span = max - min || 1;
  const n = values.length || 1;
  const x = (i: number) => (n === 1 ? W : (i / (n - 1)) * W);
  const y = (v: number) => H - pad - ((v - min) / span) * (H - pad * 2);

  const last = values[values.length - 1];
  const shown = last === undefined ? "—" : formatter ? formatter(last) : `${Math.round(last * 10) / 10}${suffix ?? ""}`;

  const line = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;

  return (
    <div style={{ minWidth: 0 }}>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
        <span className="fig-l">{label}</span>
        <span className="mono small">{shown}</span>
      </div>
      <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
        {values.length > 1 && <path className="area" d={area} />}
        {values.length > 1 && <path className="line" d={line} />}
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------- quick start */

function QuickActions({ onNavigate }: { onNavigate: (v: ViewId) => void }) {
  const items: Array<{ id: ViewId; label: string; icon: React.ReactNode }> = [
    { id: "engine", label: "Install llama.cpp", icon: <HardDrive size={14} /> },
    { id: "hub", label: "Discover models", icon: <Download size={14} /> },
    { id: "chat", label: "Chat", icon: <MessagesSquare size={14} /> },
    { id: "server", label: "Serve an API", icon: <ServerIcon size={14} /> },
    { id: "evaluate", label: "Benchmark", icon: <Gauge size={14} /> },
    { id: "create", label: "Quantize", icon: <Wrench size={14} /> },
    { id: "run", label: "Run CLI", icon: <Terminal size={14} /> },
    { id: "models", label: "Library", icon: <Boxes size={14} /> },
  ];
  return (
    <div className="metric-row">
      <div className="metric-head">
        <h2>Jump to</h2>
        <p>every tool llama.cpp ships, one click away</p>
        <div className="spacer" />
        <span className="faint mono small"><Cpu size={12} /> local only</span>
      </div>
      <div className="row wrap" style={{ gap: 9 }}>
        {items.map((i) => (
          <Button key={i.id} onClick={() => onNavigate(i.id)}>
            {i.icon} {i.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

