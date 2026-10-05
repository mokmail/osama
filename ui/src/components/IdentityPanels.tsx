import { useEffect, useMemo, useState } from "react";
import { Check, RotateCcw, Save, ShieldAlert, TriangleAlert } from "lucide-react";
import { agentApi } from "../lib/api";
import type { BuiltPrompt, MemoryEntry, MemoryOp, MemoryResponse, Personality, PromptSection, SoulReport } from "../lib/types";

/**
 * The agent's soul, its personality, and its memory — the parts of the chat
 * page that make it an agent rather than a text box.
 *
 * These panels exist so the user can see and correct what the model is told,
 * rather than inferring it from behaviour. Every panel reads the same state the
 * prompt builder reads, and every write goes through the same API the agent's
 * own tools use — there is no second path that could drift.
 *
 * The prompt inspector is the anchor: it renders the assembled system prompt in
 * order, so a change to the soul or a memory fact is visibly a change to what
 * the model receives.
 */

/* ------------------------------------------------------------------- soul */

export function SoulModal() {
  const [soul, setSoul] = useState<SoulReport | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [personality, setPersonality] = useState("none");
  const [prompt, setPrompt] = useState<BuiltPrompt | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);

  useEffect(() => {
    let live = true;
    agentApi
      .soul()
      .then((s) => {
        if (!live) return;
        setSoul(s);
        setDraft(s.text);
      })
      .catch((e) => setError((e as Error).message));
    return () => {
      live = false;
    };
  }, []);

  // Rebuild the preview whenever the personality changes, so the user sees the
  // overlay they are about to apply rather than a description of it.
  useEffect(() => {
    let live = true;
    agentApi
      .prompt({ personality })
      .then((p) => {
        if (live) setPrompt(p);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [personality]);

  async function save() {
    setBusy(true);
    setError("");
    setNote("");
    try {
      const r = await agentApi.saveSoul(draft);
      setSoul(r.soul);
      setNote(
        r.flagged
          ? `Saved — but the text matched: ${(r.findings ?? []).join(", ")}. Review it if you did not intend that phrasing.`
          : "Saved. It applies from the next turn — this conversation keeps the soul it started with.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    setError("");
    try {
      const r = await agentApi.resetSoul();
      setSoul(r.soul);
      setDraft(r.soul.text);
      setNote("Restored the built-in identity.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const dirty = soul !== null && draft.trim() !== soul.text.trim();

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="modal-note">
        The soul is slot&nbsp;#1 of the system prompt — it <strong>replaces</strong> the default identity rather than adding to it.
        It lives in <code>{soul?.file ?? "SOUL.md"}</code> and follows the agent into every future session.
      </div>

      {soul?.flagged && (
        <div className="idwarn">
          <ShieldAlert size={14} />
          <span>
            The saved soul matched prompt-injection heuristic(s): <strong>{soul.findings.join(", ")}</strong>. It is loaded anyway —
            this is a warning, not a block — but check it is what you meant.
          </span>
        </div>
      )}

      <div className="row wrap" style={{ gap: 8, alignItems: "center" }}>
        <span className="idlabel">source</span>
        <span className={`idpill ${soul?.source === "file" ? "on" : ""}`}>{soul?.source ?? "…"}</span>
        <span className="idlabel">chars</span>
        <span className="idpill">{soul?.chars ?? 0}</span>
        {soul?.truncated && <span className="idpill warn">truncated to the cap</span>}
      </div>

      <div className="rpsection">identity</div>
      <textarea
        className="input idtext"
        rows={12}
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Who you are, how you speak, what you care about…"
        disabled={busy}
      />
      <div className="row" style={{ gap: 8, justifyContent: "space-between" }}>
        <span className="idhint">
          {draft.trim().length} / {soul?.maxChars ?? 20000} chars (capped at 4× on write)
        </span>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn ghost sm" onClick={reset} disabled={busy}>
            <RotateCcw size={13} /> Reset to default
          </button>
          <button className="btn sm" onClick={save} disabled={busy || !dirty}>
            <Save size={13} /> Save soul
          </button>
        </div>
      </div>
      {error && <div className="wspick-error">{error}</div>}
      {note && <div className="idok"><Check size={13} /> {note}</div>}

      <div className="rpsection">personality — a temporary overlay, this session only</div>
      <div className="persgrid">
        {(soul?.personalities ?? []).map((p: Personality) => (
          <button
            key={p.id}
            className={`persbtn ${personality === p.id ? "on" : ""}`}
            onClick={() => setPersonality(p.id)}
            title={p.blurb}
          >
            <span className="persbtn-label">{p.label}</span>
            <span className="persbtn-blurb">{p.blurb}</span>
          </button>
        ))}
      </div>

      <div className="rpsection">what the model is actually told</div>
      <PromptInspector prompt={prompt} expanded={showPrompt} onToggle={() => setShowPrompt((v) => !v)} />
    </div>
  );
}

/* -------------------------------------------------------- prompt inspector */

export function PromptInspector({ prompt, expanded, onToggle }: { prompt: BuiltPrompt | null; expanded: boolean; onToggle: () => void }) {
  if (!prompt) return <div className="idhint">assembling…</div>;
  const totalTokens = prompt.sections.reduce((n, s) => n + (s.tokens ?? 0), 0);
  return (
    <>
      <div className="stack" style={{ gap: 4 }}>
        {prompt.sections.map((s: PromptSection, i) => {
          const share = totalTokens ? Math.round(((s.tokens ?? 0) / totalTokens) * 100) : 0;
          return (
            <div className="prow" key={s.name}>
              <span className="prow-n">{i + 1}</span>
              <span className="prow-name">{s.name}</span>
              <span className="prow-bar">
                <span className="prow-fill" style={{ width: `${share}%` }} />
              </span>
              <span className="prow-val">{s.tokens ?? "—"} tok</span>
            </div>
          );
        })}
      </div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="idhint">{prompt.sections.length} sections · ~{totalTokens} tokens</span>
        <button className="btn ghost sm" onClick={onToggle}>{expanded ? "Hide" : "Show"} full prompt</button>
      </div>
      {expanded && <pre className="rpblock idprompt">{prompt.prompt}</pre>}
    </>
  );
}

/* ----------------------------------------------------------------- memory */

/**
 * Both memory stores, side by side, with the consolidation path.
 *
 * The two stores are different in kind: the notes are the agent's own
 * observations, the profile is who the user is. A fact saved to the wrong one
 * is invisible at the moment it is needed, so the panel keeps them distinct
 * rather than merging them into one list.
 */
export function MemoryModal() {
  const [mem, setMem] = useState<MemoryResponse | null>(null);
  const [draft, setDraft] = useState("");
  const [draftTarget, setDraftTarget] = useState<"memory" | "user">("memory");
  const [draftScope, setDraftScope] = useState<"global" | "workspace">("global");
  const [draftTags, setDraftTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [block, setBlock] = useState(false);

  const pull = () =>
    agentApi
      .memory()
      .then((m) => setMem(m))
      .catch(() => {});
  useEffect(() => {
    pull();
  }, []);

  async function save() {
    const text = draft.trim();
    if (!text) return;
    setBusy(true);
    setError("");
    try {
      await agentApi.saveMemory({
        text,
        target: draftTarget,
        scope: draftScope,
        tags: draftTags.split(",").map((t) => t.trim()).filter(Boolean),
      });
      setDraft("");
      setDraftTags("");
      setMem(await agentApi.memory());
    } catch (e) {
      // A full store is the expected failure, not an edge case — say how full.
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function forget(id: string) {
    try {
      await agentApi.forgetMemory({ selector: id });
      setMem(await agentApi.memory());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /** Move an entry between stores by remove + add, applied atomically. */
  async function move(e: MemoryEntry) {
    const toUser = !(mem?.user ?? []).some((u) => u.id === e.id);
    const ops: MemoryOp[] = [
      { action: "remove", old_text: e.text, target: toUser ? "memory" : "user" },
      { action: "add", content: e.text, target: toUser ? "user" : "memory", scope: e.scope, tags: e.tags },
    ];
    try {
      await agentApi.batchMemory(ops);
      setMem(await agentApi.memory());
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const stats = mem?.stats;
  const notes = mem?.entries ?? [];
  const profile = mem?.user ?? [];
  const userIds = useMemo(() => new Set(profile.map((e) => e.id)), [profile]);

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="modal-note">
        What the agent carries between turns. The <strong>notes</strong> are the agent&rsquo;s own (an environment fact, a convention,
        a lesson); the <strong>profile</strong> is who you are. Both are injected into every agentic turn.
      </div>

      <div className="grid-3">
        {(stats?.fills ?? []).map((f) => (
          <div className="stat" key={`${f.target}-${f.scope}`}>
            <span className="l">{f.label}</span>
            <span className="n">{f.chars}/{f.budget}</span>
            <span className={`fill ${f.pressure > 0.9 ? "hot" : f.pressure > 0.7 ? "warm" : ""}`}>
              <span className="fill-bar" style={{ width: `${Math.min(100, Math.round(f.pressure * 100))}%` }} />
            </span>
          </div>
        ))}
      </div>

      <div className="rpsection">add a fact</div>
      <div className="row wrap" style={{ gap: 8 }}>
        <label className="check">
          <input type="radio" checked={draftTarget === "memory"} onChange={() => setDraftTarget("memory")} /> agent notes
        </label>
        <label className="check">
          <input type="radio" checked={draftTarget === "user"} onChange={() => setDraftTarget("user")} /> user profile
        </label>
        {draftTarget === "memory" && (
          <>
            <label className="check">
              <input type="radio" checked={draftScope === "global"} onChange={() => setDraftScope("global")} /> global
            </label>
            <label className="check">
              <input type="radio" checked={draftScope === "workspace"} onChange={() => setDraftScope("workspace")} /> workspace
            </label>
          </>
        )}
      </div>
      <div className="wspick-custom">
        <input
          className="input"
          placeholder={draftTarget === "user" ? "e.g. prefers terse answers, no motivational closings" : "e.g. the NUC is reached over ssh as kmail@192.168.1.57"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              save();
            }
          }}
          disabled={busy}
        />
        <button className="btn ghost sm" onClick={save} disabled={busy || !draft.trim()}>
          Save
        </button>
      </div>
      <div className="row wrap" style={{ gap: 8 }}>
        <input
          className="input"
          style={{ maxWidth: 260 }}
          placeholder="tags (comma-separated)"
          value={draftTags}
          onChange={(e) => setDraftTags(e.target.value)}
        />
      </div>
      {error && <div className="wspick-error">{error}</div>}

      <StoreList
        title={`agent notes — ${notes.length}`}
        entries={notes}
        isUser={(id) => userIds.has(id)}
        onForget={forget}
        onMove={move}
      />
      <StoreList title={`user profile — ${profile.length}`} entries={profile} isUser={() => true} onForget={forget} onMove={move} />

      {mem?.block ? (
        <>
          <div className="rpsection">
            injected into the system prompt
            <button className="btn ghost sm" style={{ marginLeft: 8 }} onClick={() => setBlock((v) => !v)}>
              {block ? "Hide" : "Show"}
            </button>
          </div>
          {block && <pre className="rpblock">{mem.block}</pre>}
        </>
      ) : null}
    </div>
  );
}

function StoreList({
  title,
  entries,
  isUser,
  onForget,
  onMove,
}: {
  title: string;
  entries: MemoryEntry[];
  isUser: (id: string) => boolean;
  onForget: (id: string) => void;
  onMove: (e: MemoryEntry) => void;
}) {
  return (
    <>
      <div className="rpsection">{title}</div>
      {entries.length === 0 ? (
        <div className="idhint">empty — the agent fills this with save_memory when it learns something durable</div>
      ) : (
        entries.map((e) => (
          <div className="rpmem" key={e.id}>
            <span className="rpmem-text" title={`${e.createdAt} · ${e.hits} recalls`}>
              {e.text}
            </span>
            {e.scope === "workspace" && <span className="rptag">ws</span>}
            <button className="rpmem-mv" onClick={() => onMove(e)} title={isUser(e.id) ? "Move to agent notes" : "Move to user profile"}>
              {isUser(e.id) ? "→notes" : "→profile"}
            </button>
            <button className="rpmem-x" onClick={() => onForget(e.id)} title="Forget this">
              ×
            </button>
          </div>
        ))
      )}
    </>
  );
}

/* ------------------------------------------------------------- status chip */

/**
 * A compact strip for the chat header: which personality is active and how full
 * the stores are. Deliberately small — it is a signal, not a control surface.
 */
export function IdentityStrip({ onOpen }: { onOpen: (panel: "soul" | "memory") => void }) {
  const [soul, setSoul] = useState<SoulReport | null>(null);
  const [mem, setMem] = useState<MemoryResponse | null>(null);

  useEffect(() => {
    let live = true;
    const pull = () =>
      Promise.all([agentApi.soul(), agentApi.memory()])
        .then(([s, m]) => {
          if (!live) return;
          setSoul(s);
          setMem(m);
        })
        .catch(() => {});
    pull();
    const t = setInterval(pull, 15000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  const pressure = Math.max(...(mem?.stats?.fills ?? []).map((f) => f.pressure), 0);
  const hot = pressure > 0.85;

  return (
    <div className="idstrip">
      <button className="idstrip-btn" onClick={() => onOpen("soul")} title={soul?.file}>
        <span className="idstrip-dot" />
        {soul?.source === "file" ? "custom soul" : "default soul"}
        {soul?.flagged && <TriangleAlert size={11} className="idstrip-warn" />}
      </button>
      <button className={`idstrip-btn ${hot ? "hot" : ""}`} onClick={() => onOpen("memory")} title="Memory stores">
        {mem?.stats?.total ?? 0} fact(s) · {Math.round(pressure * 100)}%
      </button>
    </div>
  );
}
