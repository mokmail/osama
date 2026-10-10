import { useEffect, useState } from "react";
import { Check, Cpu, Download, HardDrive, RefreshCw, Sparkles, Trash2, Zap } from "lucide-react";
import { api } from "../lib/api";
import type { EnginePlan, InstalledEngine, ReleaseInfo, SystemResponse } from "../lib/types";
import { Badge, Button, Card, CardHead, Console, Empty, Spinner, usePoll, useToast } from "../components/ui";
import { bytes, timeAgo } from "../lib/format";
import type { EventBus } from "../App";

export function EngineView({ system, bus }: { system: SystemResponse | null; bus: EventBus }) {
  const toast = useToast();
  const [engines, setEngines] = useState<InstalledEngine[]>([]);
  const [activeTag, setActiveTag] = useState<string | undefined>();
  const [plan, setPlan] = useState<EnginePlan | null>(null);
  const [releases, setReleases] = useState<ReleaseInfo[]>([]);
  const [selectedAccel, setSelectedAccel] = useState<string>("");
  const [selectedRelease, setSelectedRelease] = useState<string>("");
  const [busy, setBusy] = useState(false);
  /** Set when the release list is a cached one because GitHub said no. */
  const [releaseNote, setReleaseNote] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = () => {
    api.engine().then((r) => {
      setEngines(r.engines);
      setActiveTag(r.activeTag);
    }).catch(() => {});
  };
  usePoll(load, 5000);

  useEffect(() => {
    api.releases(6).then((r) => { setReleases(r.releases); setReleaseNote(r.note ?? null); }).catch((e) => toast.push("err", e.message));
    api.enginePlan().then((p) => {
      setPlan(p);
      const rec = system?.recommendedAcceleration;
      setSelectedAccel(rec && p.variants.some((v) => v.acceleration === rec) ? rec : (p.variants.find((v) => v.available)?.acceleration ?? ""));
      setSelectedRelease(p.tag);
    }).catch((e) => toast.push("err", `Could not load build plan: ${e.message}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const installProgress = bus.events.filter((e) => e.type === "install").slice(-1)[0];

  async function install() {
    setBusy(true);
    try {
      await api.installEngine({ tag: selectedRelease || undefined, acceleration: selectedAccel || undefined });
      toast.push("info", "Install started — progress streams below and to the dashboard.");
    } catch (e) {
      toast.push("err", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <Card className="card-pad">
        <CardHead
          title="llama.cpp engine"
          sub="Osama downloads official ggml-org release binaries and runs every tool from the installed build."
          right={<Button size="sm" variant="ghost" onClick={load}><RefreshCw size={14} /> Refresh</Button>}
        />

        {system && (
          <div className="row wrap" style={{ gap: 8, marginBottom: 14 }}>
            <Badge kind="accent"><Cpu size={12} /> {system.system.os}/{system.system.arch}</Badge>
            <Badge kind={system.gpu.discrete ? "ok" : ""}>{system.gpu.discrete ? <Zap size={12} /> : <Cpu size={12} />} {system.gpu.name}</Badge>
            <Badge>recommended: {system.recommendedAcceleration}</Badge>
          </div>
        )}

        <div className="grid-2" style={{ marginBottom: 14 }}>
          <div className="field">
            <label>Release</label>
            <select className="select" value={selectedRelease} onChange={(e) => setSelectedRelease(e.target.value)}>
              {releases.map((r) => (
                <option key={r.tag} value={r.tag}>
                  {r.tag} · {new Date(r.publishedAt).toLocaleDateString()}
                </option>
              ))}
            </select>
            <span className="help">llama.cpp publishes a new build roughly every hour; pick the latest stable tag.</span>
          </div>
          <div className="field">
            <label>Backend / acceleration</label>
            <select className="select" value={selectedAccel} onChange={(e) => setSelectedAccel(e.target.value)}>
              {(plan?.variants ?? []).map((v) => (
                <option key={v.acceleration} value={v.acceleration} disabled={!v.available}>
                  {v.acceleration}{v.available ? ` — ${bytes(v.size)}` : " — not available for this OS/arch"}
                </option>
              ))}
            </select>
            <span className="help">
              {system?.system.os === "macos"
                ? "Metal is compiled into every macOS build — no separate GPU download needed."
                : "Match this to your GPU. CPU works everywhere; Vulkan is a good cross-vendor fallback."}
            </span>
          </div>
        </div>

        <div className="row">
          <Button variant="primary" onClick={install} disabled={busy || !selectedRelease}>
            {busy ? <Spinner /> : <Download size={15} />} Install llama.cpp {selectedRelease}
          </Button>
          {plan && (
            <span className="faint small">
              {plan.variants.find((v) => v.acceleration === selectedAccel)?.asset ?? ""}
            </span>
          )}
        </div>

        {installProgress && (
          <div style={{ marginTop: 14 }}>
            <div className="small muted" style={{ marginBottom: 6 }}>
              {installProgress.data.stage}
              {installProgress.data.progress?.percent != null && ` — ${(installProgress.data.progress.percent * 100).toFixed(1)}%`}
            </div>
            <div className="progress">
              <i style={{ width: `${Math.round((installProgress.data.progress?.percent ?? 0.03) * 100)}%` }} />
            </div>
            {installProgress.data.error && <div className="small" style={{ color: "var(--danger)", marginTop: 6 }}>{installProgress.data.error}</div>}
          </div>
        )}
      </Card>

      <Card className="card-pad">
        <CardHead title="Installed engines" sub={`${engines.length} build${engines.length === 1 ? "" : "s"} under ${system?.paths.llamaBin ?? ".osama/bin/llama"}`} />
        {engines.length === 0 ? (
          <Empty icon={<HardDrive size={28} />} title="No engine installed yet" sub="Choose a backend above and install — it takes a few seconds for macOS/Linux CPU+Metal builds." />
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            {engines.map((e) => (
              <div key={`${e.tag}-${e.acceleration}`} className="tile" style={{ cursor: "default" }}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <div className="row" style={{ gap: 9 }}>
                    <span style={{ fontWeight: 600 }}>{e.tag}</span>
                    <Badge kind="accent">{e.acceleration}</Badge>
                    {activeTag === e.tag && <Badge kind="ok"><Check size={12} /> active</Badge>}
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    {activeTag !== e.tag && (
                      <Button size="sm" onClick={async () => { await api.activateEngine(e.tag); load(); }}>
                        <Sparkles size={13} /> Activate
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setExpanded(expanded === e.tag ? null : e.tag)}>
                      {Object.keys(e.tools).length} tools
                    </Button>
                    <Button size="sm" variant="danger" onClick={async () => {
                      if (!confirm(`Remove ${e.tag} (${e.acceleration})? The binaries will be deleted.`)) return;
                      await api.removeEngine(e.tag);
                      toast.push("ok", `Removed ${e.tag}`);
                      load();
                    }}>
                      <Trash2 size={13} />
                    </Button>
                  </div>
                </div>
                <div className="faint small">
                  {e.os}/{e.arch} · installed {timeAgo(e.installedAt)} · {e.dir}
                </div>
                {expanded === e.tag && (
                  <div className="console" style={{ marginTop: 4 }}>
                    {Object.entries(e.tools).map(([name, p]) => (
                      <div key={name}>{name} → {p}</div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="card-pad">
        <CardHead
          title="Recent releases"
          sub={releaseNote ? "showing a cached list" : "From github.com/ggml-org/llama.cpp"}
          right={
            releaseNote ? undefined : (
              <span className="faint small">unauthenticated GitHub API — 60 requests an hour</span>
            )
          }
        />
        {releaseNote && <div className="help" style={{ marginBottom: 8 }}>{releaseNote}</div>}
        <div className="stack" style={{ gap: 6 }}>
          {releases.map((r) => (
            <div key={r.tag} className="row" style={{ justifyContent: "space-between" }}>
              <span className="mono small">{r.tag}</span>
              <span className="faint small">{timeAgo(r.publishedAt)} · {r.assets.length} assets</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
