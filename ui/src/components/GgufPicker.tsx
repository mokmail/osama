import { useEffect, useMemo, useState } from "react";
import { ArrowUp, FileBox, Folder, Home, Library, Search, Server as ServerIcon } from "lucide-react";
import { api } from "../lib/api";
import type { BrowseEntry, BrowseResponse, GgufHit, LocalModel } from "../lib/types";
import { Badge, Button, Modal, Spinner, useToast } from "./ui";
import { bytes, shortPath } from "../lib/format";

/**
 * Choose a GGUF: from the model library, or straight off the disk.
 *
 * A library-only dropdown is a dead end for the common case — the file you want
 * to quantize is sitting in ~/Downloads and was never imported. So this modal
 * does both: the library list at the top (one click), and a real folder browser
 * below it with a bounded search for `.gguf` files so a model can be found
 * without knowing its exact path. Picking a file off the disk offers to add it
 * to the library, so the next form (and the Library view) can see it too.
 */
export function GgufPicker({
  models,
  value,
  onPick,
  onClose,
}: {
  models: LocalModel[];
  value?: string;
  /** `addToLibrary` is the user's choice — the caller registers the file. */
  onPick: (path: string, opts: { addToLibrary: boolean }) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [dir, setDir] = useState<string>("");
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [modelsDir, setModelsDir] = useState<string>("");
  const [workspace, setWorkspace] = useState<string>("");
  const [home, setHome] = useState<string>("");
  const [filter, setFilter] = useState("");
  const [found, setFound] = useState<GgufHit[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [picked, setPicked] = useState<string>(value ?? "");
  const [addToLibrary, setAddToLibrary] = useState(false);

  const folderOf = (p: string) => (p.includes("/") ? p.replace(/\/[^/]*$/, "") || "/" : "/");

  function apply(r: BrowseResponse) {
    setDir(r.path);
    setParent(r.parent);
    setEntries(r.entries);
    if (r.modelsDir) setModelsDir(r.modelsDir);
    if (r.workspace) setWorkspace(r.workspace);
    if (r.home) setHome(r.home);
  }

  async function open(path: string) {
    setBusy(true);
    setNote(null);
    setFound(null);
    try {
      apply(await api.browse(path, ["gguf"]));
    } catch (e) {
      // A hand-typed path — or a sample value being tried out — often does not
      // exist. Land on the model library folder instead of an empty dialog.
      if (path !== "@models") {
        try {
          apply(await api.browse("@models", ["gguf"]));
          setNote(`${(e as Error).message} — showing the model library folder.`);
          return;
        } catch {
          /* fall through to the error below */
        }
      }
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    // Start where the already-chosen file lives, else in the model library.
    void open(value ? folderOf(value) : "@models");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function search() {
    setBusy(true);
    setNote(null);
    try {
      const r = await api.findGgufs(dir, { depth: 3, max: 300 });
      if (!r.ok) {
        setNote(r.error ?? "search failed");
        setFound(null);
      } else {
        setFound(r.files ?? []);
        setTruncated(Boolean(r.truncated));
      }
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const inLibrary = useMemo(() => new Set(models.map((m) => m.file)), [models]);
  const pickedInLibrary = picked !== "" && inLibrary.has(picked);
  const dirs = entries.filter((e) => !e.file);
  const files = entries.filter((e) => e.file);
  const match = (n: string) => !filter.trim() || n.toLowerCase().includes(filter.trim().toLowerCase());

  return (
    <Modal title="Choose a GGUF" onClose={onClose} width="min(860px, 94vw)">
      <div className="modal-note">
        Pick a model from the library, or browse the disk. Searching inside a folder walks up to
        three levels down and stops at 300 files.
      </div>

      <div className="hr" />

      <div className="small muted" style={{ fontWeight: 600, marginBottom: 8 }}>
        Model library · {models.length}
      </div>
      {models.length === 0 ? (
        <div className="modal-note">
          Nothing imported yet — browse below and tick “add to the model library” to register what you pick.
        </div>
      ) : (
        <div className="row wrap" style={{ gap: 6 }}>
          {models.map((m) => (
            <button
              key={m.id}
              className={`gpick-chip ${picked === m.file ? "active" : ""}`}
              title={m.file}
              onClick={() => {
                setPicked(m.file);
                setAddToLibrary(false);
              }}
            >
              <FileBox size={12} />
              <span className="gpick-chip-name">{m.name}</span>
              <span className="gpick-chip-meta">
                {m.card?.quantization ?? "?"} · {bytes(m.sizeBytes)}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="hr" />

      <div className="row wrap" style={{ gap: 6, marginBottom: 8 }}>
        <Button size="sm" variant="ghost" onClick={() => open("@models")} disabled={busy}>
          <Library size={13} /> Model library folder
        </Button>
        <Button size="sm" variant="ghost" onClick={() => open("@workspace")} disabled={busy}>
          <ServerIcon size={13} /> Workspace
        </Button>
        <Button size="sm" variant="ghost" onClick={() => open("@home")} disabled={busy}>
          <Home size={13} /> Home
        </Button>
        <Button size="sm" variant="ghost" onClick={() => parent && open(parent)} disabled={busy || !parent}>
          <ArrowUp size={13} /> Up
        </Button>
      </div>

      <div className="row" style={{ gap: 8, marginBottom: 10 }}>
        <div className="search">
          <Folder size={14} />
          <input
            className="input"
            value={dir}
            spellCheck={false}
            onChange={(e) => setDir(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && open(dir)}
            placeholder="/Users/you/models"
          />
        </div>
        <Button size="sm" onClick={() => open(dir)} disabled={busy}>Open</Button>
        <Button size="sm" variant="ghost" onClick={search} disabled={busy || !dir}>
          <Search size={13} /> Search here
        </Button>
      </div>

      <div className="row" style={{ gap: 8, marginBottom: 8 }}>
        <div className="search">
          <Search size={14} />
          <input
            className="input"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter by name…"
          />
        </div>
        {busy && <Spinner />}
        {truncated && <Badge kind="warn">search truncated at 300 files</Badge>}
      </div>

      <div className="gpick-list">
        {found ? (
          found.length === 0 ? (
            <div className="gpick-empty">No .gguf files in this folder (three levels down).</div>
          ) : (
            found.filter((f) => match(f.name)).map((f) => (
              <div
                key={f.path}
                className={`rparticle wide gpick-row ${picked === f.path ? "active" : ""}`}
                onClick={() => {
                  setPicked(f.path);
                  setAddToLibrary(!f.inLibrary);
                }}
                title={f.path}
              >
                <FileBox size={13} />
                <span className="rparticle-name">{f.name}</span>
                {f.inLibrary && <Badge kind="ok">in library</Badge>}
                <span className="rparticle-at">{bytes(f.sizeBytes)}</span>
              </div>
            ))
          )
        ) : (
          <>
            {dirs.filter((d) => match(d.name)).map((d) => (
              <div key={d.path} className="rparticle wide gpick-row" onClick={() => open(d.path)} title={d.path}>
                <Folder size={13} />
                <span className="rparticle-name">{d.name}/</span>
                <span className="rparticle-at">open</span>
              </div>
            ))}
            {files.filter((f) => match(f.name)).map((f) => (
              <div
                key={f.path}
                className={`rparticle wide gpick-row ${picked === f.path ? "active" : ""}`}
                onClick={() => {
                  setPicked(f.path);
                  setAddToLibrary(!inLibrary.has(f.path));
                }}
                title={f.path}
              >
                <FileBox size={13} />
                <span className="rparticle-name">{f.name}</span>
                {inLibrary.has(f.path) && <Badge kind="ok">in library</Badge>}
                <span className="rparticle-at">{f.size ? bytes(f.size) : ""}</span>
              </div>
            ))}
            {dirs.filter((d) => match(d.name)).length === 0 && files.filter((f) => match(f.name)).length === 0 && (
              <div className="gpick-empty">
                No folders and no .gguf file matching “{filter}” in {shortPath(dir, 48)}.
              </div>
            )}
          </>
        )}
      </div>

      {note && <div className="wspick-error" style={{ marginTop: 10 }}>{note}</div>}

      <div className="hr" />

      <div className="row wrap" style={{ gap: 10, alignItems: "center" }}>
        <span className="mono small" style={{ minWidth: 0, flex: 1, wordBreak: "break-all" }} title={picked}>
          {picked ? picked : <span className="faint">no file chosen yet</span>}
        </span>
        {picked !== "" && !pickedInLibrary && (
          <label className="check" title="Register this file in the Library view so it can be served and quantized later.">
            <input type="checkbox" checked={addToLibrary} onChange={(e) => setAddToLibrary(e.target.checked)} />
            Add to the model library
          </label>
        )}
        {pickedInLibrary && <Badge kind="ok">already in the library</Badge>}
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          disabled={!picked}
          onClick={() => {
            if (!picked) return;
            if (addToLibrary && !pickedInLibrary) toast.push("info", "Adding to the library…");
            onPick(picked, { addToLibrary: addToLibrary && !pickedInLibrary });
          }}
        >
          Use this file
        </Button>
      </div>
    </Modal>
  );
}
