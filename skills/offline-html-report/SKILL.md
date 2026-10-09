---
name: offline-html-report
description: "Export results as one offline self-contained HTML report."
version: "1.0.0"
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: "html, export, report, offline, single-file, svg, charts, escaping"
    related_skills: "web-app-change-verification, document-reader-app, frontend-ui-audit, elegant-reports"
---

# Self-contained offline HTML report export

## When to Use

- The user asks to export results "not only in PDF but also in HTML", wants a "shareable"
  or "stunning" summary, or needs the output to be viewed **offline**.
- Turning computed results (a scored run, a comparison, a benchmark) into one file a
  recipient can open with no server, no build step and no network.

Not for: PDF from markdown (a different pipeline), or an in-app print stylesheet alone —
`window.print()` is not an export, and it will not survive being emailed.

Keep the generator separate from the in-app report component: the component renders live
data with a charting library, the export renders a string with inline SVG. Sharing the
*derived numbers* (via an importable module) is right; sharing the rendering is not.

## Rules that apply every time

1. **One file, zero network.** No `<script src>`, no `<link rel=stylesheet>`, no `@import`,
   no webfonts, no CDN charts. Every byte the page needs is inlined. Assert this in tests
   rather than trusting yourself to remember.
2. **Generate the charts yourself as inline SVG / CSS bars.** A charting library in an
   "offline" file breaks the exact guarantee you are selling, and needs a runtime to
   measure a DOM it may not have. SVG with a `viewBox` also scales to any width or print size.
3. **Treat every string that came from a model or a dataset as untrusted.** Escape it for
   both text and attribute contexts. Model ids, option text and raw model replies all end up
   in the markup.
4. **Escape `<` inside any embedded JSON payload** and assert the payload cannot terminate
   its own `<script>` tag.
5. **Embed the summary numbers, never the per-item rows.** A results export with tens of
   thousands of rows per entity balloons the file for data the report does not render.
6. **Derive every headline number from the results themselves**, not from an optional
   precomputed object passed alongside them.
7. **Write for a reader who did not run it.** Methodology, the definition of every score,
   what the axis directions mean, and a short "how to read this report" list. This is what
   makes the export worth sending.
8. **Report the artifact, not the click** — filename and byte size, as the UI quoted them.

## Procedure

1. **Find the existing export/report path first.** There is usually already a report
   component and a print button; extend that surface rather than inventing a second one.
2. **Write the generator as a pure string function** in its own module:
   `build(input) -> html`. No React, no DOM, no `document`. Pure functions are unit-testable
   in plain Node, which is how you test every rule above cheaply.
3. **Read the real result shape before rendering it.** Grep the scoring/aggregation module
   for every field you intend to show (totals, per-context splits, per-category maps,
   per-entity counts, cost/diagnostic fields) so you neither invent a field nor silently
   render `undefined`.
4. **Wire the UI action:** build a `Blob`, `URL.createObjectURL`, click a temporary
   `<a download>` appended to the body, then revoke the URL **on a later tick**. Yield once
   (`await` a 0 ms timeout) before the synchronous build so the button can paint its
   "building" state — a large report blocks the main thread, and a button that looks inert
   for a second reads as broken. Track an `exporting` flag and disable the button while it
   is set, and surface the outcome in the DOM (`Saved <filename> (<N> KB) — opens offline`)
   rather than in a console log.
5. **Assemble the sections in this order** (works for any results report): hero stating
   what/when/how much → at-a-glance KPI tiles → summarised risk/category counts → ranked
   leaderboard table → per-dimension charts → the 2-D diagnostic scatter → composition
   breakdown → full metrics table → per-category tables → the specialised diagnostic →
   methodology + score definitions → "how to read this report" → item-level appendix.
6. **Make the appendix selective.** Cap per entity, and order the informative rows first
   (incorrect / unexpected / flagged) so the reader sees the interesting cases, not a
   random sample. Say in the caption that it is a sample and what the ordering is.
7. **Format numbers for scanning**: a real minus sign (−) on signed scores, fixed decimals,
   tabular numerals, a placeholder em-dash for missing values. Never let `NaN` or
   `undefined` reach the page — that is the class of defect a markup assertion catches.
8. **Provide a print variant** (`@media print`) that flips a dark theme to light, and hide
   the interactive controls in it. Many recipients will still print to PDF.
9. **Test and verify** (next section), then confirm the downloaded file on disk.

## Pitfalls

- **A headline tile read from an optional precomputed object silently shows its fallback.**
  `insights?.range?.spread ?? 0` renders a confident `0.0%` for a real spread whenever the
  caller did not supply that object — a wrong number with no error anywhere. Derive from the
  results; accept the precomputed value only as an override.
- **Scatter/point labels overprint when the data clusters.** Well-behaved results cluster
  near the origin, so the default "label to the right of each dot" stacks several names on
  top of each other. Place each label by trying candidate offsets and keeping the first that
  clears every already-placed box — and register the **markers** as obstacles too, or a label
  lands on a neighbouring dot.
- **Revoking the object URL synchronously cancels the download** in some browsers before it
  has read the blob. Revoke on a timer.
- **Asserting an expected filename proves nothing if the download directory is not empty.**
  Snapshot the directory listing before the click and diff it after, then stat the new file.
- **A fixed-pixel SVG does not scale.** Use `viewBox` plus `width:100%` in CSS; a hard-coded
  `width`/`height` clips at narrow widths and in print.
- **A stacked-bar segment with a tiny share disappears** — skip zero-width segments rather
  than emitting a `style="width:0%"` sliver, and put the real numbers in the `title`.
- **Long entity names break table layouts.** Truncate in the cell, keep the full value in a
  `title` attribute, and use a horizontal-scroll wrapper for wide tables.
- **The export drifts from the in-app report** when both compute their own derived values.
  Derive once, in a module both can import.

## Verification

Assert these on the generated string (all cheap, all catch a real defect):

- No external dependency: no `<script src`, no `<link rel=stylesheet`, no `@import`, no
  remote `<img src`, no `fetch(`/`XMLHttpRequest`, no webfont host.
- It is a complete document: doctype, `<html lang>`, `<meta charset>`, an inline `<style>`,
  and a closing `</html>`.
- Charts are inline `<svg>` (count them).
- Each headline metric and each diagnostic section actually appears in the output — assert on
  the formatted string, not on the field name.
- Hostile input is escaped: feed a model id, context, question and option containing
  `<script>`/`<img onerror>` and assert none of them survive unescaped.
- The embedded JSON parses back, holds exactly one data block, and cannot break out of its
  script tag.
- Per-item rows are absent from the embedded JSON.
- Empty input yields a valid page with a clear "nothing was recorded" state, not a crash.
- Missing optional fields render placeholders, not `NaN`.
- Clustered labels produce non-overlapping boxes (compute the boxes in the test).
- The filename is timestamped and filesystem-safe.

Then verify in the real app and in a real browser per `web-app-change-verification`: click
**the actual button** and confirm the file lands on disk (its download-behaviour recipe), and
render the produced file with the network blocked to prove the offline claim. Finish by
looking at the rendered pages with vision — programmatic assertions pass happily on an ugly
or colliding page.

Vision over the rendered export is not decoration; it is what found the two most visible
defects. Walk the *whole* document, not just the top: screenshot the full page at a tall
window (`--window-size=1280,7000` plus `captureBeyondViewport`), then re-shoot individual
regions at full resolution to read small text — a downscaled full-page shot cannot show
whether axis labels or table cells actually collide. Confirm every labelled section renders
with real numbers and that no column is cut off.

## Related

- `web-app-change-verification` — the evidence ladder for the change that adds the export,
  including the headless download check and the offline (network-blocked) probe.
- `references/inline-charts-and-embedding.md` — ready-made inline SVG chart shapes and the
  escaping/embedding rules that keep the file self-contained.
- `document-reader-app` — the same "one file, opens offline" principle applied to reading a
  long document rather than reporting results.
- `frontend-ui-audit` — use it to judge the visual quality of the export in a real browser.
