import fs from "node:fs";

/**
 * PDF text extraction for chat attachments.
 *
 * A PDF is not "not a text file" — it very much is one, just wrapped. The chat
 * refuses binaries, so a PDF arrives as bytes and is turned into text here,
 * server-side, with pdf.js (the same engine Firefox ships). Page markers are
 * kept so the model can cite "page N" when it answers.
 *
 * Text-only models get the extracted text; there is no OCR — a scanned PDF
 * with no text layer yields an honest note rather than silence.
 */

export interface ExtractResult {
  ok: boolean;
  text?: string;
  pages?: number;
  /** True when pages had no extractable text (scanned images). */
  scanned?: boolean;
  truncated?: boolean;
  error?: string;
}

const MAX_PDF_BYTES = 32 * 1024 * 1024;
const MAX_PAGES = 600;
/** Roughly 500k characters is ~125k tokens; well past any local window. */
const MAX_CHARS = 500_000;

interface PageLike {
  getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
}

export async function extractPdfText(data: Buffer | Uint8Array, opts: { page?: number } = {}): Promise<ExtractResult> {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length === 0) return { ok: false, error: "empty file" };
  if (buf.length > MAX_PDF_BYTES) return { ok: false, error: `PDF is larger than ${Math.round(MAX_PDF_BYTES / 1024 / 1024)} MB` };

  // %PDF- at the start, allowing a small preamble (some producers add junk).
  const head = buf.subarray(0, 1024).toString("latin1");
  if (!head.includes("%PDF-")) return { ok: false, error: "this does not look like a PDF" };

  try {
    // The legacy build is the one that runs in Node without a DOM.
    const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as {
      getDocument: (opts: Record<string, unknown>) => { promise: Promise<{ numPages: number; getPage(n: number): Promise<PageLike> }> };
    };
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buf),
      // keep it quiet and dependency-free in Node
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      verbosity: 0,
    }).promise;

    // A single page on request ("read the first page"): read just that one, so a
    // 300-page PDF answers a page-1 question without extracting 300 pages.
    const only = opts.page && opts.page > 0 ? Math.min(opts.page, doc.numPages) : 0;
    const first = only || 1;
    const pages = only ? only : Math.min(doc.numPages, MAX_PAGES);
    const parts: string[] = [];
    let chars = 0;
    let emptyPages = 0;
    let truncated = false;

    for (let i = first; i <= pages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      // pdf.js gives positioned items; join with a space, mark line-ish breaks
      // on large y-gaps is overkill for chat — a space is enough for the model.
      let line = "";
      for (const it of content.items) {
        if (typeof it.str === "string" && it.str) line += (line && !line.endsWith(" ") ? " " : "") + it.str;
      }
      const text = line.replace(/\s+/g, " ").trim();
      if (!text) {
        emptyPages++;
        continue;
      }
      const chunk = `--- page ${i} ---\n${text}`;
      if (chars + chunk.length > MAX_CHARS) {
        parts.push(`--- page ${i} ---\n${text.slice(0, Math.max(0, MAX_CHARS - chars))}…`);
        truncated = true;
        break;
      }
      parts.push(chunk);
      chars += chunk.length;
    }

    const allEmpty = parts.length === 0 && emptyPages > 0;
    const text = allEmpty
      ? `[This PDF has ${doc.numPages} page(s) of images but no text layer — it appears to be scanned. OCR would be needed to read it.]`
      : parts.join("\n\n");

    return { ok: true, text, pages: doc.numPages, scanned: allEmpty, truncated };
  } catch (e) {
    return { ok: false, error: `could not read the PDF: ${(e as Error).message}` };
  }
}

/** Read a file from disk and extract, for the server's file-based route. */
export async function extractPdfFile(file: string, opts: { page?: number } = {}): Promise<ExtractResult> {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { ok: false, error: "not a file" };
  } catch {
    return { ok: false, error: "file does not exist" };
  }
  try {
    return await extractPdfText(fs.readFileSync(file), opts);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
