import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, ArrowUp, ChevronRight, Copy, ExternalLink, FileCode2, FileText, FolderOpen,
  FolderTree, Image as ImageIcon, RefreshCw, Search, Trash2,
} from "lucide-react";
import { agentApi } from "../lib/api";
import type { ArtifactFile, ArtifactPreview, DirEntry, DirListing } from "../lib/types";
import { bytes } from "../lib/format";

/**
 * The artifact page: every file the agent wrote, on the left, and a real file
 * browser on the right.
 *
 * The design rule is that a row is a *place*, not a download. Clicking a file
 * selects it — previews it, and opens its folder in the browser pane beside it —
 * while the two OS hand-offs (Open, Reveal) stay explicit buttons, because
 * handing a path to the Finder should be a deliberate act with a visible target
 * rather than a side effect of reading a row.
 *
 * The browser pane is jailed on the server exactly like the file tools: "up"
 * stops at the root that contains the current directory, never at `/`, and a
 * path outside every root is listed but inert so an escape is visible rather
 * than silent. The pane does not assume the list is accurate — it re-lists on
 * every hop, so a file deleted a second ago disappears instead of 404-ing a
 * click.
 *
 * Search is two-layered on purpose: the left column filters what the agent
 * *produced*, the browser's query searches a whole directory's *contents*, so
 * "which file mentions the quantize fix" is answerable without a shell.
 */

export function ArtifactsView({ bus }: { bus?: unknown }) {
  void bus;
  const [data, setData] = useState<{ artifacts: ArtifactFile[]; total: number; truncated: boolean } | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ArtifactFile | null>(null);
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [showDir, setShowDir] = useState(true);
  const [previewOpen, setPreviewOpen] = useState(false);

  const pull = useCallback(async () => {
    try {
      setData(await agentApi.artifacts(300));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    pull();
    const t = setInterval(pull, 8000);
    return () => clearInterval(t);
  }, [pull]);

  // Preview the selection. Kept separate from the browser pane: one reads a
  // file, the other lists a folder, and a slow preview must not block browsing.
  useEffect(() => {
    if (!selected) {
      setPreview(null);
      return;
    }
    let live = true;
    setPreviewBusy(true);
    agentApi
      .previewArtifact(selected.abs)
      .then((p) => live && setPreview(p))
      .catch((e) => live && setError((e as Error).message))
      .finally(() => live && setPreviewBusy(false));
    return () => {
      live = false;
    };
  }, [selected]);

  const rows = useMemo(() => {
    const all = data?.artifacts ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((a) => `${a.file} ${a.name} ${a.dir} ${a.ext} ${a.op}`.toLowerCase().includes(q));
  }, [data, query]);

  async function reveal(a: ArtifactFile) {
    setError("");
    setNote("");
    setBusy(true);
    try {
      const r = await agentApi.revealArtifact(a.abs);
      setNote(r.command ? `Opened the folder — ${r.command}` : "Opened the folder.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function openFile(a: ArtifactFile) {
    setError("");
    setNote("");
    setBusy(true);
    try {
      const r = await agentApi.openArtifact(a.abs);
      setNote(r.command ? `Opened with the system default — ${r.command}` : "Opened.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copyPath(p: string) {
    try {
      await navigator.clipboard.writeText(p);
      setNote("Path copied.");
    } catch {
      setNote(p);
    }
  }

  const total = data?.total ?? 0;
  const missing = (data?.artifacts ?? []).filter((a) => !a.exists).length;

  // The distinct folders the agent wrote into, most-written first. This is the
  // fastest route to "open the folder": a deleted file is still a place, and a
  // folder with eight artifacts is one click away from the Finder.
  const folders = useMemo(() => {
    const by = new Map<string, { dir: string; count: number; latest: string; jailed: boolean }>();
    for (const a of data?.artifacts ?? []) {
      const cur = by.get(a.dir);
      if (cur) {
        cur.count += 1;
        if (a.at > cur.latest) cur.latest = a.at;
        cur.jailed = cur.jailed && a.jailed;
      } else {
        by.set(a.dir, { dir: a.dir, count: 1, latest: a.at, jailed: a.jailed });
      }
    }
    return [...by.values()].sort((a, b) => b.count - a.count || b.latest.localeCompare(a.latest));
  }, [data]);

  async function revealDir(dir: string) {
    setError("");
    setNote("");
    setBusy(true);
    try {
      // Reveal the folder itself — the server opens the directory when the path
      // is one, so no file needs to still exist.
      const r = await agentApi.revealArtifact(dir);
      setNote(r.command ? `Opened ${dir} — ${r.command}` : `Opened ${dir}.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack artpage" style={{ gap: 12 }}>
      <div className="row wrap" style={{ gap: 8, alignItems: "center" }}>
        <FileCode2 size={15} />
        <span className="artpage-title">artifacts</span>
        <span className="idhint">
          {total} file{total === 1 ? "" : "s"} the agent wrote
          {missing > 0 && ` · ${missing} no longer on disk`}
          {data?.truncated && " · list truncated"}
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={() => setShowDir((v) => !v)} title="Toggle the folder pane">
          <FolderTree size={13} /> {showDir ? "Hide" : "Show"} folders
        </button>
        <button className="btn ghost sm" onClick={() => pull()} title="Refresh">
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      <div className={`artpage-body ${showDir ? "with-dir" : ""}`}>
        {/* ------------------------------------------------ the artifact list */}
        <div className="artpage-col">
          {/* Folders first: the shortest path from "what did it write" to the Finder. */}
          {folders.length > 0 && (
            <>
              <div className="rpsection">folders the agent wrote into</div>
              <div className="dirfolders">
                {folders.map((f) => (
                  <FolderRow
                    key={f.dir}
                    dir={f.dir}
                    busy={busy}
                    onReveal={() => revealDir(f.dir)}
                    onSearch={() => {
                      setQuery(shortenDir(f.dir, 3));
                    }}
                  />
                ))}
              </div>
            </>
          )}

          <div className="rpsection">files</div>
          <div className="wspick-custom">
            <input
              className="input"
              placeholder="filter by name, folder or type…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {error && <div className="wspick-error">{error}</div>}
          {note && <div className="idok">{note}</div>}

          {rows.length === 0 ? (
            <div className="idhint">
              {total === 0
                ? "nothing written yet — files the agent creates appear here"
                : "no artifact matches that filter"}
            </div>
          ) : (
            <div className="artlist">
              {rows.map((a) => (
                <ArtifactRow
                  key={a.abs}
                  a={a}
                  selected={selected?.abs === a.abs}
                  busy={busy}
                  onSelect={() => {
                    setSelected(a);
                    setPreviewOpen(true);
                  }}
                  onOpen={() => openFile(a)}
                  onReveal={() => reveal(a)}
                  onCopy={() => copyPath(a.abs)}
                />
              ))}
            </div>
          )}
        </div>

        {/* ------------------------------------------------- the folder browser */}
        {showDir && (
          <div className="artpage-pane">
            <DirBrowser
              // Browse the selected file's folder whenever we have one. The file
              // may be gone; the folder is still the place you want to see.
              startPath={selected?.dir}
              highlight={selected?.abs ?? null}
              onPick={(p) => {
                // Selecting a file inside the browser previews it too, so the
                // two panes never disagree about what is open.
                const match = (data?.artifacts ?? []).find((a) => a.abs === p);
                if (match) {
                  setSelected(match);
                  setPreviewOpen(true);
                }
              }}
              onReveal={(p) => agentApi.revealArtifact(p).then(() => setNote("Opened the folder.")).catch((e) => setError((e as Error).message))}
            />
          </div>
        )}
      </div>

      {/* --------------------------------------------------------- the preview */}
      {selected && previewOpen && (
        <div className="artpreview">
          <div className="artpreview-head">
            <FileCode2 size={13} />
            <span className="artpreview-name" title={selected.abs}>
              {selected.abs}
            </span>
            <span className="spacer" style={{ flex: 1 }} />
            {preview && (
              <span className="idhint">
                {bytes(preview.size)}
                {preview.lines ? ` · ${preview.lines} lines` : ""}
                {preview.truncated ? " · truncated" : ""}
              </span>
            )}
            <button className="btn ghost sm" onClick={() => openFile(selected)} disabled={busy || selected.jailed || !selected.exists}>
              <ExternalLink size={12} /> Open
            </button>
            <button className="btn ghost sm" onClick={() => reveal(selected)} disabled={busy || selected.jailed}>
              <FolderOpen size={12} /> Reveal
            </button>
            <button className="btn ghost sm" onClick={() => setPreviewOpen(false)}>
              Close
            </button>
          </div>
          {previewBusy ? (
            <div className="idhint" style={{ padding: 9 }}>reading…</div>
          ) : preview?.binary ? (
            <div className="idhint" style={{ padding: 9 }}>
              <ImageIcon size={12} /> binary file — {bytes(preview.size)}. Use Open or Reveal to view it properly.
            </div>
          ) : preview?.error ? (
            <div className="wspick-error" style={{ margin: 9 }}>{preview.error}</div>
          ) : preview?.text !== undefined ? (
            <pre className="artpreview-body">{preview.text || "(empty file)"}</pre>
          ) : null}
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- list row */

/**
 * Which OS actions a row actually supports.
 *
 * Mirrors the server's trust model exactly. Every row here came out of this
 * server's own artifact log, so the server accepts it by provenance even when
 * the path sits outside the *current* workspace — which is why `jailed` is a
 * warning to display, not a reason to disable the buttons. Disabling on it would
 * grey out the rows whose workspace has since changed, i.e. most of the ones you
 * want to open.
 *
 * Reveal needs the *folder*, so it is offered as long as we have a path at all —
 * the file itself may be long gone and its folder still worth opening. Open needs
 * the file, so a missing file is not openable. A folder that has itself been
 * deleted is a real failure, and the server says so when the button is pressed
 * rather than being pre-guessed here.
 */
function actionsFor(a: ArtifactFile) {
  return { canReveal: true, canOpen: a.exists };
}

function ArtifactRow({
  a,
  selected,
  busy,
  onSelect,
  onOpen,
  onReveal,
  onCopy,
}: {
  a: ArtifactFile;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onReveal: () => void;
  onCopy: () => void;
}) {
  const { canReveal, canOpen } = actionsFor(a);
  const inert = !canReveal && !canOpen;
  return (
    <div className={`artrow ${selected ? "open" : ""} ${inert ? "inert" : ""}`}>
      <button className="artrow-main" onClick={onSelect} title={a.abs}>
        <ChevronRight size={12} className={`artrow-caret ${selected ? "open" : ""}`} />
        <FileIcon ext={a.ext} />
        <span className="artrow-name">{a.name}</span>
        <span className="artrow-dir" title={a.dir}>{shortenDir(a.dir)}</span>
        {a.writes > 1 && <span className="rptag" title={`written ${a.writes} times`}>×{a.writes}</span>}
        <span className={`artrow-op ${a.op === "edit_file" ? "edit" : ""}`}>{a.op === "edit_file" ? "edit" : "write"}</span>
        {a.jailed && (
          <span className="artrow-warn" title="outside the workspace, and not a recorded artifact — cannot be opened">
            <AlertTriangle size={11} />
          </span>
        )}
        {!a.exists && <span className="artrow-gone" title="the file is gone — its folder can still be opened"><Trash2 size={11} /></span>}
        <span className="artrow-at">{relTime(a.at)}</span>
      </button>

      {/* The actions live outside the select button so one click does one thing. */}
      <div className="artrow-actions">
        <button
          className="artrow-act"
          onClick={onReveal}
          disabled={busy || !canReveal}
          title={canReveal ? `Reveal in ${parentLabel(a.dir)}` : "outside the allowed roots"}
        >
          <FolderOpen size={13} />
        </button>
        <button className="artrow-act" onClick={onOpen} disabled={busy || !canOpen} title={canOpen ? "Open with the system default app" : "the file is gone"}>
          <ExternalLink size={13} />
        </button>
        <button className="artrow-act" onClick={onCopy} title="Copy the full path">
          <Copy size={13} />
        </button>
      </div>
    </div>
  );
}

/** A folder the agent wrote into, offered as one-click Reveal even if every file in it is gone. */
function FolderRow({ dir, busy, onReveal, onSearch }: { dir: string; busy: boolean; onReveal: () => void; onSearch: () => void }) {
  return (
    <div className="dirrow">
      <button className="dirrow-main" onClick={onSearch} title={`Browse ${dir}`}>
        <FolderTree size={13} className="dirow-icon dir" />
        <span className="dirow-name">{shortenDir(dir, 3)}</span>
      </button>
      <button className="artrow-act" onClick={onReveal} disabled={busy} title={`Open ${parentLabel(dir)} in the file manager`}>
        <FolderOpen size={13} />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------ dir browser */

/**
 * A jailed folder browser.
 *
 * It keeps its own path state and re-lists on every navigation — never
 * rendering from a cached listing — so a file that vanished shows up as gone
 * instead of as a click that fails. `highlight` marks the artifact currently
 * selected on the left, which is what ties the two panes together.
 */
function DirBrowser({
  startPath,
  highlight,
  onPick,
  onReveal,
}: {
  startPath?: string;
  highlight: string | null;
  onPick: (path: string) => void;
  onReveal: (path: string) => void;
}) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [path, setPath] = useState<string | undefined>(startPath);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const lastStart = useRef<string | undefined>(undefined);

  const load = useCallback(
    async (p?: string, query = "") => {
      if (!p) return;
      setLoading(true);
      setError("");
      try {
        const r = await agentApi.artifactDir(p, query);
        setListing(r);
        setPath(r.path ?? p);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Follow the selection's folder when it changes — but only then, so browsing
  // away by hand is not yanked back on the next poll.
  useEffect(() => {
    if (startPath && startPath !== lastStart.current) {
      lastStart.current = startPath;
      load(startPath, "");
      setQ("");
    }
  }, [startPath, load]);

  const entries = listing?.entries ?? [];

  return (
    <div className="dirbrowser">
      <div className="dirbar">
        <button
          className="artrow-act"
          disabled={!listing?.parent}
          title={listing?.parent ? `Up to ${listing.parent}` : "Top of the allowed root"}
          onClick={() => listing?.parent && load(listing.parent, q)}
        >
          <ArrowUp size={13} />
        </button>
        <span className="dirbar-path" title={path ?? listing?.path ?? ""}>
          {listing?.path ? shortenDir(listing.path, 3) : "(no folder selected)"}
        </span>
        <button className="artrow-act" title="Refresh this folder" onClick={() => path && load(path, q)}>
          <RefreshCw size={12} />
        </button>
      </div>

      <div className="wspick-custom">
        <Search size={12} className="dirbar-search" />
        <input
          className="input"
          placeholder="search names and contents…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            // Debounce-free: the query is cheap on the server and the pane is
            // small, so a keystroke-triggered reload is honest and immediate.
            if (path) load(path, e.target.value);
          }}
        />
      </div>

      {listing?.root && (
        <div className="idhint" title={listing.root}>
          inside {shortenDir(listing.root, 2)} — browsing stops here
        </div>
      )}
      {error && <div className="wspick-error">{error}</div>}
      {listing && q && <div className="idhint">{listing.matchCount ?? 0} match(es) in this folder</div>}
      {loading && <div className="idhint">listing…</div>}

      {listing?.ok && entries.length === 0 && !loading && (
        <div className="idhint">{q ? "nothing here matches" : "this folder is empty"}</div>
      )}

      <div className="diritems">
        {entries.map((e) => (
          <DirRow
            key={e.path}
            e={e}
            hl={highlight === e.path}
            onOpen={() => (e.dir ? load(e.path, q) : onPick(e.path))}
            onReveal={() => onReveal(e.path)}
          />
        ))}
      </div>
    </div>
  );
}

function DirRow({ e, hl, onOpen, onReveal }: { e: DirEntry; hl: boolean; onOpen: () => void; onReveal: () => void }) {
  return (
    <div className={`dirow ${hl ? "hl" : ""}`}>
      <button className="dirow-main" onClick={onOpen} title={e.path}>
        {e.dir ? <FolderOpen size={13} className="dirow-icon dir" /> : <FileIcon ext={e.name.split(".").pop()?.toLowerCase() ?? ""} />}
        <span className="dirow-name">{e.name}</span>
        {e.matches ? <span className="rptag" title="matched inside the file">in file</span> : null}
        <span className="spacer" style={{ flex: 1 }} />
        {!e.dir && <span className="dirow-size">{bytes(e.size)}</span>}
      </button>
      {!e.dir && (
        <button className="artrow-act" onClick={onReveal} title="Reveal this file">
          <FolderOpen size={12} />
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ bits */

function FileIcon({ ext }: { ext: string }) {
  if (/^(png|jpe?g|gif|webp|svg|bmp|ico|tiff?)$/.test(ext)) return <ImageIcon size={13} className="artrow-icon" />;
  if (/^(gguf|bin|safetensors|pt|pth|onnx)$/.test(ext)) return <FileCode2 size={13} className="artrow-icon" />;
  return <FileText size={13} className="artrow-icon" />;
}

/** Collapse a long path to its last segments — enough to place it, not to swamp the row. */
function shortenDir(dir: string, keep = 2): string {
  const parts = dir.split("/").filter(Boolean);
  if (parts.length <= keep) return dir;
  return `…/${parts.slice(-keep).join("/")}`;
}

function parentLabel(dir: string): string {
  return dir.split("/").filter(Boolean).pop() ?? "the folder";
}

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  const days = Math.round(secs / 86400);
  return days < 30 ? `${days}d ago` : new Date(iso).toLocaleDateString();
}
