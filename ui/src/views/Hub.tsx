import { useEffect, useRef, useState } from "react";
import { ArrowLeft, BadgeCheck, Download, Link2, Search, Shapes, Sparkles, ThumbsUp, TrendingUp, X } from "lucide-react";
import { api } from "../lib/api";
import type { HubModel, HubRepo, LocalModel, SystemResponse } from "../lib/types";
import { Badge, Button, Card, CardHead, Empty, Field, Spinner, useToast } from "../components/ui";
import { bytes, num } from "../lib/format";
import type { EventBus } from "../App";
import type { ViewId } from "../App";

/** The hubs Discover searches. "all" runs them in parallel and interleaves. */
const HUB_SOURCES = [
  { id: "all", label: "All sources" },
  { id: "huggingface", label: "Hugging Face" },
  { id: "modelscope", label: "ModelScope" },
  { id: "civitai", label: "CivitAI" },
  { id: "ollama", label: "Ollama" },
] as const;

/* ------------------------------------------------------------------ *
 * Provider logos. Official brand marks are inlined as small SVG paths
 * (24x24 boxes) so Discover shows an instant visual cue per row and in
 * the filter — no network, no assets, no vendor branding in the chrome.
 * A mark we do not have falls back to a neutral glyph.
 * ------------------------------------------------------------------ */

/** Official marks: Hugging Face 🤗, a generic Ollama llama (lucide shapes),
 *  CivitAI's "C", ModelScope's "M", and a link glyph for direct URLs. */
const PROVIDER: Record<string, { label: string; kind: string; path?: string; fill?: boolean; mono?: boolean }> = {
  huggingface: {
    label: "Hugging Face",
    kind: "huggingface",
    // A plain face: two eyes and a smile, drawn in ink over the yellow disc
    // that the CSS paints behind it — legible at 15-18px where the full
    // hand-wave mark turns to mush.
    path:
      "M8.4 9.2a1.35 1.35 0 1 1 0 2.7 1.35 1.35 0 0 1 0-2.7z" +
      "M15.6 9.2a1.35 1.35 0 1 1 0 2.7 1.35 1.35 0 0 1 0-2.7z" +
      "M7.4 14.1a.95.95 0 0 1 1.32-.24c.9.63 2 .95 3.28.95s2.38-.32 3.28-.95a.95.95 0 1 1 1.08 1.56C15.14 16.22 13.7 16.6 12 16.6s-3.14-.38-4.36-1.18a.95.95 0 0 1-.24-1.32z",
    fill: true,
  },
  modelscope: { label: "ModelScope", kind: "modelscope" },
  civitai: { label: "CivitAI", kind: "civitai" },
  ollama: { label: "Ollama", kind: "ollama", mono: true },
  url: { label: "Direct link", kind: "url", mono: true },
};

/**
 * One provider mark. Hugging Face renders its real emoji-shaped mark; the
 * others are set in the app's own type so nothing off-brand leaks in.
 */
function ProviderLogo({ source, size = 16, title }: { source?: string; size?: number; title?: boolean }) {
  const p = PROVIDER[source ?? "huggingface"] ?? PROVIDER.huggingface!;
  return (
    <span className={`plogo plogo-${p.kind}`} style={{ width: size, height: size }} title={title ? p.label : undefined} aria-label={p.label}>
      {p.path ? (
        <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
          <path d={p.path} fill="currentColor" />
        </svg>
      ) : p.kind === "ollama" ? (
        <Shapes size={size} strokeWidth={1.7} aria-hidden="true" />
      ) : p.kind === "url" ? (
        <Link2 size={size} strokeWidth={1.9} aria-hidden="true" />
      ) : (
        <span className="plogo-letter" aria-hidden="true">{(p.label[0] ?? "?").toUpperCase()}</span>
      )}
    </span>
  );
}

/**
 * Discover, as a section of the Models page.
 *
 * It used to be its own view, one nav hop away from the library — but finding a
 * model and having it are the same job, and the split meant a download finished on
 * a page that could not show you what you had just fetched. `onInstalled` lets the
 * library above refresh the moment a download lands, and the "go to the library"
 * button died with the split because there is nothing left to navigate to.
 */
export function DiscoverPanel({
  bus,
  onNavigate,
  onInstalled,
}: {
  bus: EventBus;
  onNavigate: (v: ViewId) => void;
  /** called when a download finishes, so the library above can re-read itself */
  onInstalled?: () => void;
}) {
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<string>(() => localStorage.getItem("osama.hubSource") ?? "all");
  const [models, setModels] = useState<HubModel[]>([]);
  const [searchErrors, setSearchErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [repo, setRepo] = useState<HubRepo | null>(null);
  const [system, setSystem] = useState<SystemResponse | null>(null);
  /** Hub repos already in the library (from each model's `repo`), so a row can
   *  be marked installed and the list filtered by install state. */
  const [installedRepos, setInstalledRepos] = useState<Set<string>>(new Set());
  const [installFilter, setInstallFilter] = useState<"all" | "installed" | "available">(
    () => (localStorage.getItem("osama.hubInstallFilter") as "all" | "installed" | "available") ?? "all",
  );

  useEffect(() => {
    api.system().then(setSystem).catch(() => {});
    api.models()
      .then((r) => setInstalledRepos(new Set(r.models.map((m: LocalModel) => m.repo).filter(Boolean) as string[])))
      .catch(() => {});
    loadTrending();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { localStorage.setItem("osama.hubInstallFilter", installFilter); }, [installFilter]);


  useEffect(() => { localStorage.setItem("osama.hubSource", source); }, [source]);

  /** Generation counter: only the LATEST search may render (a slow mount load must not overwrite it). */
  const searchGen = useRef(0);

  async function loadTrending() {
    const gen = ++searchGen.current;
    setLoading(true);
    try {
      const r = await api.hubTrending(24, source === "all" ? undefined : source);
      if (gen !== searchGen.current) return;
      setModels(r.models as HubModel[]);
      setSearchErrors((r as { errors?: string[] }).errors ?? []);
    } catch (e) {
      if (gen === searchGen.current) toast.push("err", `Search failed: ${(e as Error).message}`);
    } finally {
      if (gen === searchGen.current) setLoading(false);
    }
  }

  async function search(e?: React.FormEvent) {
    e?.preventDefault();
    const gen = ++searchGen.current;
    setLoading(true);
    try {
      const srcParam = source === "all" ? undefined : source;
      const r = query.trim() ? await api.hubSearch(query, 30, "downloads", srcParam) : await api.hubTrending(24, srcParam);
      if (gen !== searchGen.current) return;
      setModels(r.models as HubModel[]);
      setSearchErrors((r as { errors?: string[] }).errors ?? []);
    } catch (err) {
      if (gen === searchGen.current) toast.push("err", (err as Error).message);
    } finally {
      if (gen === searchGen.current) setLoading(false);
    }
  }

  async function openRepo(id: string, srcOverride?: string) {
    try {
      const src = srcOverride ?? (/^https?:\/\//.test(id) ? "url" : source === "all" ? "huggingface" : source);
      const r = await api.hubRepo(id, src);
      if (!r.hasGguf) {
        toast.push("err", `${id} has no .gguf files — it may need conversion first.`);
      }
      setRepo(r);
    } catch (e) {
      toast.push("err", (e as Error).message);
    }
  }

  // A hub row is "installed" when the library holds a model whose recorded repo
  // matches. HF/ModelScope ids are owner/repo; Ollama refs are name:tag — both
  // compare directly against LocalModel.repo.
  const isInstalled = (m: HubModel) => installedRepos.has(m.id);

  const visibleModels = models.filter((m) => {
    if (installFilter === "installed") return isInstalled(m);
    if (installFilter === "available") return !isInstalled(m);
    return true;
  });
  const installedShown = models.filter(isInstalled).length;

  const downloads = bus.events.filter((e) => e.type === "download").slice(-8).reverse();
  /** A finished download is the moment the library above is out of date. */
  const lastInstalled = useRef<string | null>(null);
  useEffect(() => {
    const done = downloads.filter((d) => d.data?.stage === "done").slice(-1)[0];
    const key = done ? `${done.data.repo ?? ""}:${done.data.file ?? ""}:${done.data.total ?? 0}` : null;
    if (key && key !== lastInstalled.current) {
      lastInstalled.current = key;
      onInstalled?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloads.length]);

  if (repo) {
    return <RepoDetail repo={repo} onBack={() => setRepo(null)} totalMem={system?.system.totalMemBytes ?? 0} />;
  }

  return (
    <>
      <div className="stack" id="discover" style={{ scrollMarginTop: 12 }}>
      <Card className="card-pad">
        <CardHead
          title="Discover models"
          sub="Search every source for ready-to-run GGUF models — or paste a direct .gguf link."
        />
        <form className="row" onSubmit={search} style={{ gap: 10 }}>
          <span className="row" style={{ gap: 8, alignItems: "center" }}>
            {source !== "all" && <ProviderLogo source={source} size={18} title />}
            <select className="select" style={{ maxWidth: 180 }} value={source} onChange={(e) => setSource(e.target.value)} aria-label="Model source">
              {HUB_SOURCES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </span>
          <div className="search">
            <Search />
            <input
              className="input"
              placeholder={source === "all" ? "Search every source — e.g. Qwen3, Llama, gemma…" : "e.g. Qwen3, Llama, gemma, deepseek, mistral…"}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
          </div>
          <Button variant="primary" onClick={() => search()}>
            {loading ? <Spinner /> : <Search size={15} />} Search
          </Button>
          {query && (
            <Button variant="ghost" onClick={() => { setQuery(""); loadTrending(); }}>
              <X size={15} />
            </Button>
          )}
        </form>
        <div className="faint small" style={{ marginTop: 6 }}>
          A direct .gguf link also works — paste it and press Search (covers LM Studio links, personal CDNs, any host).
        </div>
        {searchErrors.length > 0 && (
          <div className="small" style={{ color: "var(--warn)", marginTop: 6 }}>
            {searchErrors.join(" · ")}
          </div>
        )}

        {downloads.length > 0 && (
          <div style={{ marginTop: 14 }}>
            {downloads.map((d, i) => {
              const pct = d.data.total ? Math.round((d.data.received / d.data.total) * 100) : null;
              const done = d.data.stage === "done";
              const err = d.data.stage === "error";
              return (
                <div className="dl-row" key={i}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="small mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.data.file}</div>
                    {!done && !err && <div className="progress" style={{ marginTop: 5 }}><i style={{ width: `${pct ?? 8}%` }} /></div>}
                    {err && <div className="small" style={{ color: "var(--danger)" }}>{d.data.error}</div>}
                  </div>
                  <div className="row" style={{ gap: 8 }}>
                    <span className="faint small">
                      {done ? bytes(d.data.total ?? 0) : d.data.total ? `${bytes(d.data.received)} / ${bytes(d.data.total)} ${pct != null ? `· ${pct}%` : ""}` : bytes(d.data.received)}
                    </span>
                    {done && <Badge kind="ok">done</Badge>}
                    {err && <Badge kind="danger">error</Badge>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card className="card-pad">
        <CardHead
          title={query ? `Results for “${query}”` : "Most downloaded GGUF models"}
          sub={`${visibleModels.length} of ${models.length} models${installedShown ? ` · ${installedShown} installed` : ""}`}
          right={!query ? <Badge kind="accent"><TrendingUp size={12} /> trending</Badge> : undefined}
        />
        <div className="hub-filter" role="tablist" aria-label="Filter by install state">
          {([
            ["all", "All", models.length],
            ["installed", "Installed", installedShown],
            ["available", "Not installed", models.length - installedShown],
          ] as const).map(([id, label, count]) => (
            <button
              key={id}
              role="tab"
              aria-selected={installFilter === id}
              className={`hub-filter-btn ${installFilter === id ? "on" : ""}`}
              onClick={() => setInstallFilter(id)}
            >
              {label} <span className="faint">{count}</span>
            </button>
          ))}
        </div>
        {visibleModels.length === 0 && !loading ? (
          <Empty
            icon={<Search size={28} />}
            title={installFilter === "installed" ? "Nothing here is installed yet" : models.length ? "No models match this filter" : "No models found"}
            sub={installFilter === "installed" ? "Open a model and download a file to add it to the library." : "Try a different search term or filter."}
          />
        ) : (
          <div className="stack" style={{ gap: 8 }} key={visibleModels.map((m) => `${m.source ?? "hf"}:${m.id}`).join("|")}>
            {visibleModels.map((m) => {
              const installed = isInstalled(m);
              return (
              <div key={`${m.source ?? "hf"}:${m.id}`} className={`tile ${installed ? "installed" : ""}`} onClick={() => openRepo(m.id, m.source)}>
                <div className="row" style={{ justifyContent: "space-between", gap: 10 }}>
                  <span className="row" style={{ gap: 8, minWidth: 0 }}>
                    <ProviderLogo source={m.source} size={17} title />
                    <span className="title mono" title={m.id}>{m.id}</span>
                  </span>
                  <div className="row" style={{ gap: 8, flex: "none" }}>
                    {installed && <Badge kind="ok"><BadgeCheck size={12} /> installed</Badge>}
                    {m.instruct && <Badge kind="info">instruct</Badge>}
                    {m.gated && <Badge kind="warn">gated</Badge>}
                  </div>
                </div>
                <div className="sub">
                  <span className="row" style={{ gap: 4 }}><Download size={12} /> {num(m.downloads)}</span>
                  <span className="row" style={{ gap: 4 }}><ThumbsUp size={12} /> {num(m.likes)}</span>
                  {m.tags.slice(0, 3).map((t) => <Badge key={t}>{t}</Badge>)}
                </div>
              </div>
              );
            })}
          </div>
        )}
      </Card>
      </div>
    </>
  );
}

function RepoDetail({ repo, onBack, totalMem }: { repo: HubRepo; onBack: () => void; totalMem: number }) {
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const mains = repo.files.filter((f) => f.isMain);
  const mmproj = repo.files.filter((f) => f.isMmproj);

  const toggle = (path: string) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });
  };

  async function download() {
    const files = [...selected];
    if (files.length === 0) return;
    for (const file of files) {
      try {
        await api.startDownload({ repo: repo.ref ?? repo.id, file, source: repo.source ?? "huggingface" });
      } catch (e) {
        toast.push("err", (e as Error).message);
      }
    }
    toast.push("info", `Queued ${files.length} file(s) — progress shows under Discover and on the Dashboard.`);
    setSelected(new Set());
  }

  const selectedBytes = mains.concat(mmproj).filter((f) => selected.has(f.path)).reduce((s, f) => s + f.size, 0);

  return (
    <div className="stack">
      <div className="row">
        <Button variant="ghost" onClick={onBack}><ArrowLeft size={15} /> Back to search</Button>
      </div>

      <Card className="card-pad">
        <CardHead
          title={repo.id}
          sub={`${mains.length} weight file(s)${mmproj.length ? ` · ${mmproj.length} projector file(s)` : ""}`}
          right={
            <div className="row" style={{ gap: 8 }}>
              <span className="row small faint" style={{ gap: 4 }}><Download size={12} /> {num(repo.downloads)}</span>
              <span className="row small faint" style={{ gap: 4 }}><ThumbsUp size={12} /> {num(repo.likes)}</span>
            </div>
          }
        />

        <QuantHint totalMem={totalMem} available={mains} />

        <div className="hr" />
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
          <span className="small muted" style={{ fontWeight: 600 }}>Choose what to download</span>
          {selected.size > 0 && <span className="small faint">{selected.size} selected · {bytes(selectedBytes)}</span>}
        </div>

        <div className="stack" style={{ gap: 5 }}>
          {mains.map((f) => (
            <FileRow key={f.path} path={f.path} size={f.size} quant={f.quant} selected={selected.has(f.path)} onToggle={() => toggle(f.path)} />
          ))}
          {mmproj.length > 0 && (
            <>
              <div className="faint small" style={{ marginTop: 6 }}>Multimodal projectors (needed for image/audio input)</div>
              {mmproj.map((f) => (
                <FileRow key={f.path} path={f.path} size={f.size} selected={selected.has(f.path)} onToggle={() => toggle(f.path)} />
              ))}
            </>
          )}
        </div>

        <div className="row" style={{ marginTop: 16 }}>
          <Button variant="primary" onClick={download} disabled={selected.size === 0}>
            <Download size={15} /> Download {selected.size || ""} {selected.size === 1 ? "file" : "files"}
          </Button>

        </div>
      </Card>
    </div>
  );
}

function FileRow({ path, size, quant, selected, onToggle }: { path: string; size: number; quant?: string; selected: boolean; onToggle: () => void }) {
  return (
    <label className="tile" style={{ flexDirection: "row", alignItems: "center", gap: 12, cursor: "pointer" }}>
      <input type="checkbox" checked={selected} onChange={onToggle} style={{ width: 16, height: 16, accentColor: "var(--accent)" }} />
      <span className="mono small" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={path}>{path}</span>
      {quant && <Badge kind="accent">{quant}</Badge>}
      <span className="faint small" style={{ flex: "none" }}>{bytes(size)}</span>
    </label>
  );
}

function QuantHint({ totalMem, available }: { totalMem: number; available: Array<{ size: number; quant?: string; path: string }> }) {
  const q4 = available.find((f) => /q4_k_m/i.test(f.path)) ?? available.find((f) => /q4/i.test(f.path));
  const baseline = q4?.size ?? available[Math.floor(available.length / 2)]?.size ?? 0;
  if (!baseline || !totalMem) return null;
  const gb = totalMem / 1024 ** 3;
  const fits = baseline * 1.25 < totalMem; // weights + KV/context headroom
  return (
    <div className="row" style={{ gap: 8, marginTop: 4 }}>
      <Badge kind={fits ? "ok" : "warn"}>
        <Sparkles size={12} /> {gb.toFixed(0)} GB RAM
      </Badge>
      <span className="faint small">
        {fits
          ? `Q4_K_M (~${bytes(baseline)}) should fit comfortably.`
          : `Even the smallest quant is tight for ${gb.toFixed(0)} GB — consider a smaller model.`}
      </span>
    </div>
  );
}
