import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";

/* ------------------------------------------------------------------ toasts */

export type ToastKind = "ok" | "err" | "info" | "warn";
export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}
interface ToastCtx {
  push: (kind: ToastKind, text: string) => void;
}
const Ctx = createContext<ToastCtx>({ push: () => {} });
export const useToast = () => useContext(Ctx);

let toastId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: ToastKind, text: string) => {
    const id = ++toastId;
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "err" ? 7000 : 4200);
  }, []);
  const value = useMemo(() => ({ push }), [push]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toast-wrap">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind === "err" ? "err" : t.kind === "warn" ? "warn" : ""}`}>
            <div className="row" style={{ alignItems: "flex-start", gap: 9 }}>
              <span style={{ color: t.kind === "err" ? "var(--danger)" : t.kind === "ok" ? "var(--ok)" : t.kind === "warn" ? "var(--warn)" : "var(--info)", marginTop: 1 }}>
                {t.kind === "err" ? <AlertTriangle size={15} /> : t.kind === "ok" ? <CheckCircle2 size={15} /> : t.kind === "warn" ? <AlertTriangle size={15} /> : <Info size={15} />}
              </span>
              <span style={{ flex: 1 }}>{t.text}</span>
              <button className="btn ghost sm icon" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} aria-label="Dismiss">
                <X size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

/* ------------------------------------------------------------------- cards */

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>;
}

export function CardHead({ title, sub, right }: { title: string; sub?: string; right?: ReactNode }) {
  return (
    <div className="card-head">
      <div style={{ minWidth: 0 }}>
        <h2>{title}</h2>
        {sub && <p>{sub}</p>}
      </div>
      <div className="spacer" />
      {right}
    </div>
  );
}

/* ------------------------------------------------------------------ badges */

export function Badge({ kind = "", children }: { kind?: "" | "ok" | "warn" | "danger" | "info" | "accent"; children: ReactNode }) {
  return <span className={`badge ${kind}`}>{children}</span>;
}

export function StatusDot({ status }: { status: string }) {
  const map: Record<string, string> = {
    running: "ok",
    starting: "warn",
    exited: "info",
    stopped: "",
    failed: "danger",
  };
  return (
    <Badge kind={(map[status] as any) ?? ""}>
      <span className="dot" />
      {status}
    </Badge>
  );
}

/* ----------------------------------------------------------------- buttons */

export function Button({
  children,
  onClick,
  variant = "",
  disabled,
  title,
  size,
}: {
  children: ReactNode;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  variant?: "" | "primary" | "ghost" | "danger";
  disabled?: boolean;
  title?: string;
  size?: "sm";
}) {
  return (
    <button className={`btn ${variant} ${size ?? ""}`} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ fields */

export function Field({ label, help, required, children }: { label: string; help?: string; required?: boolean; children: ReactNode }) {
  return (
    <div className="field">
      <label>
        {label}
        {required && <span className="req">required</span>}
      </label>
      {children}
      {help && <span className="help">{help}</span>}
    </div>
  );
}

/* -------------------------------------------------------------------- modal */

/**
 * The app's dialog shell: overlay, hairline card, Escape and click-outside to
 * close. Shared so every modal behaves the same way instead of each view
 * inventing its own.
 */
export function Modal({ title, onClose, children, width }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** CSS width for wide dialogs (the GGUF picker needs room). */
  width?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="qmodal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="qmodal" role="dialog" aria-modal="true" aria-label={title} style={width ? { width } : undefined}>
        <div className="qmodal-head">
          <span className="qmodal-title">{title}</span>
          <button className="qmodal-x" onClick={onClose} aria-label="Close"><X size={14} /></button>
        </div>
        <div className="qmodal-body">{children}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ console */

export function Console({ lines, max }: { lines: string[]; max?: number }) {
  const shown = max ? lines.slice(-max) : lines;
  return (
    <div className="console">
      {shown.length === 0 ? <span className="faint">no output yet</span> : shown.map((l, i) => (
        <div key={i} className={/error|failed|fatal/i.test(l) ? "ln-err" : /warn/i.test(l) ? "ln-warn" : ""}>
          {l}
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- empty state */

export function Empty({ icon, title, sub, action }: { icon?: ReactNode; title: string; sub?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <div style={{ fontWeight: 600, color: "var(--text-dim)" }}>{title}</div>
      {sub && <div className="small" style={{ marginTop: 6 }}>{sub}</div>}
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  );
}

/* ------------------------------------------------------------- misc helpers */

export function Spinner() {
  return <span className="spinner" />;
}

/** Poll an async fn on an interval while mounted. */
export function usePoll(fn: () => void, ms: number, deps: unknown[] = []) {
  useEffect(() => {
    fn();
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
