import { useEffect, useId, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { Check, Code2, Copy, Download, ExternalLink, Eye } from "lucide-react";
import {
  csvDelimiter, htmlShell, isHtmlDoc, parseDelimited, splitBlocks, tryPrettyJson,
} from "../lib/richText";

marked.setOptions({ breaks: true, gfm: true });

/* Links in a model answer must never hijack the desktop shell. */
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noreferrer noopener");
  }
  if (node.tagName === "IMG") node.setAttribute("loading", "lazy");
});

const PREVIEWABLE = new Set(["html", "htm", "svg", "mermaid", "xml"]);
const SVG_PROFILE = { USE_PROFILES: { svg: true, svgFilters: true } };
const sanitizeSvg = (svg: string) => DOMPurify.sanitize(svg, SVG_PROFILE as any);

function download(name: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ------------------------------------------------- optional renderers (CDN) */

type Mermaid = { render: (id: string, src: string) => Promise<{ svg: string }> };
let mermaidP: Promise<Mermaid> | null = null;
function loadMermaid(): Promise<Mermaid> {
  // Resolved at runtime from a CDN; the app stays offline-capable and falls
  // back to source. The variable is how Vite/tsc skip bundling a remote module.
  if (!mermaidP) {
    const url = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
    mermaidP = (async () => {
      const mod: any = await import(/* @vite-ignore */ url);
      const mermaid: Mermaid = mod.default ?? mod;
      (mermaid as any).initialize?.({ startOnLoad: false, securityLevel: "strict", theme: "neutral" });
      return mermaid;
    })().catch((e) => {
      mermaidP = null;
      throw e;
    });
  }
  return mermaidP;
}

type Katex = { renderToString: (tex: string, opts: Record<string, unknown>) => string };
let katexP: Promise<Katex> | null = null;
function loadKatex(): Promise<Katex> {
  if (!katexP) {
    const url = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.mjs";
    katexP = (async () => {
      if (!document.querySelector("link[data-katex]")) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.dataset.katex = "1";
        link.href = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css";
        document.head.appendChild(link);
      }
      const mod: any = await import(/* @vite-ignore */ url);
      return mod.default ?? mod;
    })().catch((e) => {
      katexP = null;
      throw e;
    });
  }
  return katexP;
}

/**
 * Mermaid draws node labels inside <foreignObject>, which an SVG sanitiser must
 * strip (it is an HTML injection point). Fold those labels into real <text>
 * nodes first so the diagram survives sanitisation with its labels intact.
 */
function mermaidToPlainSvg(svg: string): string {
  try {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    doc.querySelectorAll("foreignObject").forEach((fo) => {
      const x = Number(fo.getAttribute("x") ?? 0);
      const y = Number(fo.getAttribute("y") ?? 0);
      const w = Number(fo.getAttribute("width") ?? 0);
      const h = Number(fo.getAttribute("height") ?? 0);
      const t = doc.createElementNS("http://www.w3.org/2000/svg", "text");
      t.setAttribute("x", String(x + w / 2));
      t.setAttribute("y", String(y + h / 2));
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("dominant-baseline", "middle");
      t.setAttribute("font-size", "14");
      t.setAttribute("font-family", "system-ui, sans-serif");
      t.setAttribute("fill", "#111111");
      t.textContent = (fo.textContent ?? "").replace(/\s+/g, " ").trim();
      fo.replaceWith(t);
    });
    return new XMLSerializer().serializeToString(doc.documentElement);
  } catch {
    return svg;
  }
}

/* --------------------------------------------------------------- code block */

function CodeBlock({ lang, code, open }: { lang: string; code: string; open: boolean }) {
  const [mode, setMode] = useState<"code" | "preview">("code");
  const [copied, setCopied] = useState(false);
  const pretty = useMemo(() => (lang === "json" || !lang ? tryPrettyJson(code) : null), [lang, code]);
  const delimiter = useMemo(() => csvDelimiter(code, lang), [code, lang]);
  const rows = useMemo(() => (delimiter ? parseDelimited(code, delimiter) : null), [delimiter, code]);
  const tabular = !!rows && rows.length > 1 && (lang === "csv" || lang === "tsv" || lang === "psv" || rows[0]!.length > 1);
  const isHtml = lang === "html" || lang === "htm" || isHtmlDoc(code);

  const copy = () =>
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });

  return (
    <figure className="codeblock">
      <div className="cb-head">
        <span className="cb-lang">{lang || "text"}{open ? " · streaming" : ""}</span>
        <div className="spacer" style={{ flex: 1 }} />
        {PREVIEWABLE.has(lang) && (
          <button className="cb-act" onClick={() => setMode((m) => (m === "preview" ? "code" : "preview"))} title="Toggle preview">
            {mode === "preview" ? <Code2 size={12} /> : <Eye size={12} />}
            {mode === "preview" ? "code" : "preview"}
          </button>
        )}
        {isHtml && (
          <>
            <button className="cb-act" onClick={() => download("result.html", htmlShell(code), "text/html")} title="Download as .html">
              <Download size={12} />
            </button>
            <button
              className="cb-act"
              onClick={() => window.open(URL.createObjectURL(new Blob([htmlShell(code)], { type: "text/html" })), "_blank")}
              title="Open in a new tab"
            >
              <ExternalLink size={12} />
            </button>
          </>
        )}
        <button className="cb-act" onClick={copy} title="Copy">
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "copied" : "copy"}
        </button>
      </div>

      {mode === "preview" ? (
        lang === "svg" ? (
          <div className="cb-svg" dangerouslySetInnerHTML={{ __html: sanitizeSvg(code) }} />
        ) : (
          <HtmlPreview code={code} />
        )
      ) : lang === "mermaid" ? (
        <MermaidBlock code={code} />
      ) : (
        <>
          {pretty && pretty !== code && (
            <div className="cb-note">JSON formatted — <button className="cb-link" onClick={() => download("data.json", pretty, "application/json")}>download .json</button></div>
          )}
          {tabular && rows && (
            <div className="cb-table">
              <table>
                <thead>
                  <tr>{rows[0]!.map((h, i) => <th key={i}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {rows.slice(1, 60).map((r, i) => (
                    <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
                  ))}
                </tbody>
              </table>
              {rows.length > 61 && <div className="cb-note">showing 60 of {rows.length - 1} rows</div>}
            </div>
          )}
          {/* The table already shows delimited data — don't print it twice. */}
          {!tabular && <pre className="cb-body"><code>{pretty ?? code}</code></pre>}
        </>
      )}
    </figure>
  );
}

function MermaidBlock({ code }: { code: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setErr(null);
    setSvg(null);
    loadMermaid()
      .then((m) => m.render(`mmd${id}`, code))
      .then((r) => !cancelled && setSvg(mermaidToPlainSvg(r.svg)))
      .catch((e) => !cancelled && setErr(String(e?.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [code, id]);
  if (err) return <div className="cb-preview"><pre className="cb-body"><code>{code}</code></pre><div className="cb-note">mermaid unavailable — showing source</div></div>;
  if (!svg) return <div className="cb-preview cb-loading">rendering diagram…</div>;
  return <div className="cb-preview cb-svg" dangerouslySetInnerHTML={{ __html: sanitizeSvg(svg) }} />;
}

/* ------------------------------------------------------------------ prose */

function MathBlock({ tex }: { tex: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    loadKatex()
      .then((k) => k.renderToString(tex, { displayMode: true, throwOnError: false }))
      .then((h) => !cancelled && setHtml(DOMPurify.sanitize(h)))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [tex]);
  if (!html) return <pre className="cb-body math-fallback"><code>{tex}</code></pre>;
  return <div className="math-block" dangerouslySetInnerHTML={{ __html: html }} />;
}

function MarkdownText({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => {
    try {
      return DOMPurify.sanitize(marked.parse(text) as string);
    } catch {
      return text.replace(/</g, "&lt;");
    }
  }, [text]);
  return (
    <>
      <div ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
      <InlineMath host={ref} source={text} />
    </>
  );
}

/** Replace inline $…$ in the rendered prose once KaTeX is available. */
function InlineMath({ host, source }: { host: React.RefObject<HTMLElement>; source: string }) {
  const [katex, setKatex] = useState<Katex | null>(null);
  useEffect(() => {
    if (/\$[^$\n]+\$/.test(source)) loadKatex().then(setKatex).catch(() => {});
  }, [source]);

  useEffect(() => {
    const root = host.current;
    if (!katex || !root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const targets: Text[] = [];
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const t = n as Text;
      if (t.parentElement?.closest("pre, code, .katex")) continue;
      if (/\$[^$\n]+\$/.test(t.data)) targets.push(t);
    }
    for (const t of targets) {
      const frag = document.createDocumentFragment();
      let rest = t.data;
      const re = /\$([^$\n]+)\$/;
      let m: RegExpExecArray | null;
      while ((m = re.exec(rest))) {
        frag.appendChild(document.createTextNode(rest.slice(0, m.index)));
        const span = document.createElement("span");
        try {
          span.innerHTML = katex.renderToString(m[1]!, { displayMode: false, throwOnError: false });
        } catch {
          span.textContent = m[0];
        }
        frag.appendChild(span);
        rest = rest.slice(m.index + m[0].length);
      }
      frag.appendChild(document.createTextNode(rest));
      t.parentNode?.replaceChild(frag, t);
    }
  }, [katex, host]);

  return null;
}

/* ------------------------------------------------------------------- entry */

export function RichContent({ content }: { content: string }) {
  const blocks = useMemo(() => splitBlocks(content), [content]);
  return (
    <div className="rich">
      {blocks.map((b, i) =>
        b.kind === "code" ? (
          <CodeBlock key={i} lang={b.lang} code={b.code} open={b.open} />
        ) : b.kind === "math" ? (
          <MathBlock key={i} tex={b.tex} />
        ) : isHtmlDoc(b.text) && b.text.trim().length > 200 ? (
          <HtmlDocBlock key={i} text={b.text} />
        ) : (
          <MarkdownText key={i} text={b.text} />
        ),
      )}
    </div>
  );
}

/** A whole HTML document pasted without fences still gets a live preview. */
function HtmlDocBlock({ text }: { text: string }) {
  const [mode, setMode] = useState<"preview" | "code">("preview");
  return (
    <figure className="codeblock">
      <div className="cb-head">
        <span className="cb-lang">html document</span>
        <div className="spacer" style={{ flex: 1 }} />
        <button className="cb-act" onClick={() => setMode((m) => (m === "preview" ? "code" : "preview"))}>
          {mode === "preview" ? <Code2 size={12} /> : <Eye size={12} />}
          {mode === "preview" ? "code" : "preview"}
        </button>
        <button className="cb-act" onClick={() => download("result.html", text, "text/html")}>
          <Download size={12} />
        </button>
      </div>
      {mode === "preview" ? <HtmlPreview code={text} /> : <pre className="cb-body"><code>{text}</code></pre>}
    </figure>
  );
}

function HtmlPreview({ code }: { code: string }) {
  return (
    <iframe
      className="cb-frame"
      title="HTML result"
      sandbox="allow-scripts allow-forms allow-popups allow-modals"
      srcDoc={htmlShell(code)}
    />
  );
}
