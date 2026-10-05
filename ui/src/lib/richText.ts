/**
 * Pure, DOM-free parsing for the chat transcript. Kept out of the React/DOM
 * module so it can be unit-tested and reasoned about in isolation.
 */

export type Block =
  | { kind: "code"; lang: string; code: string; open: boolean }
  | { kind: "math"; tex: string }
  | { kind: "text"; text: string };

/**
 * Split an answer into prose, fenced code and display math. Line-based on
 * purpose: it has to behave while a response is still streaming (an
 * unterminated fence stays a code block instead of dumping its body into the
 * markdown renderer).
 */
export function splitBlocks(src: string): Block[] {
  const lines = src.split("\n");
  const out: Block[] = [];
  let prose: string[] = [];
  let code: string[] | null = null;
  let math: string[] | null = null;
  let lang = "";
  const flushProse = () => {
    const text = prose.join("\n");
    if (text.trim()) out.push({ kind: "text", text });
    prose = [];
  };
  for (const line of lines) {
    const fence = /^[ \t]*```(.*)$/.exec(line);
    if (fence && math === null) {
      if (code === null) {
        flushProse();
        lang = (fence[1] ?? "").trim().split(/[\s{]/)[0]!.toLowerCase();
        code = [];
      } else {
        out.push({ kind: "code", lang, code: code.join("\n"), open: false });
        code = null;
        lang = "";
      }
      continue;
    }
    if (/^[ \t]*\$\$[ \t]*$/.test(line) && code === null) {
      if (math === null) {
        flushProse();
        math = [];
      } else {
        const tex = math.join("\n").trim();
        if (tex) out.push({ kind: "math", tex });
        math = null;
      }
      continue;
    }
    if (code !== null) code.push(line);
    else if (math !== null) math.push(line);
    else prose.push(line);
  }
  if (code !== null) out.push({ kind: "code", lang, code: code.join("\n"), open: true });
  if (math !== null) {
    const tex = math.join("\n").trim();
    if (tex) out.push({ kind: "math", tex });
  }
  flushProse();
  return out;
}

/** RFC-4180-ish CSV/TSV splitter: handles quotes, embedded delimiters and CRLF. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/**
 * Pick a delimiter, or null when the block is not tabular. Requiring a
 * consistent column count is what keeps a Python snippet's commas from looking
 * like a CSV.
 */
export function csvDelimiter(code: string, lang: string): string | null {
  const explicit = lang === "csv" || lang === "tsv" || lang === "psv";
  const head = code.split("\n").slice(0, 4).join("\n");
  const tabs = (head.match(/\t/g) ?? []).length;
  const commas = (head.match(/,/g) ?? []).length;
  const semis = (head.match(/;/g) ?? []).length;
  const max = Math.max(tabs, commas, semis);
  if (max < 2 && !explicit) return null;
  const delim = tabs === max && tabs > 0 ? "\t" : commas === max && commas > 0 ? "," : semis > 0 ? ";" : ",";
  if (!explicit) {
    const probe = parseDelimited(code, delim).slice(0, 6);
    if (probe.length < 2) return null;
    const cols = probe[0]!.length;
    if (cols < 2) return null;
    if (!probe.every((r) => Math.abs(r.length - cols) <= 1)) return null;
    if (/^\s*(def |class |import |from |function |const |let |var |#|\/\/)/m.test(code)) return null;
  }
  return delim;
}

export function isHtmlDoc(s: string): boolean {
  return /^\s*(<!doctype html|<html[\s>])/i.test(s);
}

/** A fragment still needs a document shell so it renders with sane defaults. */
export function htmlShell(fragment: string): string {
  if (isHtmlDoc(fragment)) return fragment;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{color-scheme:light dark}
  body{margin:16px;font:14px/1.55 -apple-system,Inter,Segoe UI,Roboto,sans-serif;color:#141414;background:#fff}
  @media (prefers-color-scheme:dark){body{color:#eaeaea;background:#101010}}
  a{color:inherit}
  table{border-collapse:collapse}th,td{border:1px solid #8886;padding:4px 8px;text-align:left}
  img{max-width:100%;height:auto}pre{overflow:auto;background:#8881;padding:10px;border-radius:6px}
</style></head><body>${fragment}</body></html>`;
}

/** Pretty-print a JSON block, or null when it is not JSON. */
export function tryPrettyJson(code: string): string | null {
  const t = code.trim();
  if (!/^[[{]/.test(t)) return null;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null;
  }
}
