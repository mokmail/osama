# Inline SVG charts and safe embedding

Everything here assumes a generator that returns an HTML **string**. No framework, no DOM.

## Escaping

One replacer, used on every dynamic value — text and attribute contexts both:

```js
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
```

`esc()` must also coerce `null`/`undefined` to `''` so a missing field cannot print
`undefined` into the page.

Embedded JSON — escape `<` after stringifying, which neutralises `</script>`, `<!--` and
`<script` in one move:

```js
const json = JSON.stringify(payload, (_k, v) => (typeof v === 'symbol' ? undefined : v))
  .replace(/</g, '\\u003c');
dataBlob = `<script type="application/json" id="report-data">${json}</script>`;
```

Two things to remember: a running accumulator kept on a `Symbol` key will make `JSON.stringify`
throw, so drop symbols in the replacer (above); and strip the per-item arrays before
stringifying so the file stays small:

```js
const slim = list.map((result) => {
  const { items: _omitted, ...rest } = result;   // rename to satisfy no-unused-vars
  return rest;
});
```

## Number formatting

Fixed decimals, a real minus sign, and a placeholder instead of a non-number:

```js
const num   = (v, d = 0) => Number.isFinite(Number(v))
  ? Number(v).toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
const score = (v, d = 3) => Number.isFinite(Number(v))
  ? `${Number(v) >= 0 ? '+' : '−'}${Math.abs(Number(v)).toFixed(d)}` : '—';
```

Style value columns with `font-variant-numeric: tabular-nums` so columns align.

## Horizontal bar list (no SVG needed)

Best for ranking by a long-named entity — a vertical chart cannot label long names. Pure
CSS, so it prints and scales for free:

```html
<div class="bars">
  <div class="bar-row">
    <div class="bar-label" title="full name">short name</div>
    <div class="bar-track" style="height:12px">
      <div class="bar-fill" style="width:62.5%;background:linear-gradient(90deg,#22d3ee,#a78bfa)"></div>
    </div>
    <div class="bar-value">62.5%</div>
  </div>
</div>
```

```css
.bar-row   { display:grid; grid-template-columns:200px 1fr 92px; align-items:center; gap:12px }
.bar-track { background:rgba(148,163,184,.14); border-radius:999px; overflow:hidden }
.bar-fill  { height:100%; border-radius:999px }
```

Clamp the width to `0..100%` — a domain minimum below zero (a signed metric) otherwise
produces a negative width.

## Grouped vertical bars (SVG)

The shape that works: compute a `viewBox`, draw gridlines first, then grouped `<rect>`s, then
axis labels. Put the real numbers in a `<title>` on each rect so hovering gives exact values:

```js
const W = 860, H = height, padL = 46, padB = 54, padT = 16;
const chartW = W - padL - 16, chartH = H - padB - padT;
const top = max ?? Math.max(...items.flatMap(i => series.map(s => Number(i[s.key]) || 0)), 1);
const groupW = chartW / items.length;
const barW = Math.min(38, (groupW - 12) / series.length);
```

Return it as `<svg viewBox="0 0 W H" class="chart">` with `.chart { width:100%; height:auto }`.

## Stacked composition (CSS, per-entity percentages)

Skip zero-width segments or they render as visible slivers; carry the values in `title`:

```js
parts = segments.map(s => {
  const v = Number(item[s.key]) || 0, w = (v / total) * 100;
  return w <= 0 ? '' : `<span class="stack-seg" style="width:${w.toFixed(2)}%;background:${esc(s.color)}"
    title="${esc(s.label)}: ${v} (${w.toFixed(1)}%)"></span>`;
}).join('');
```

## Scatter with non-overlapping labels

Two passes. First register every **marker** as an obstacle, then place each label in the
first candidate slot that clears all of them:

```js
const CHAR_W = 6.2, LINE_H = 14;            // rough metrics for ~11.5px text
const boxes = [];
points.forEach(p => { const r = 11;
  boxes.push({ x1: x(p.x) - r, y1: y(p.y) - r, x2: x(p.x) + r, y2: y(p.y) + r }); });
const overlaps = b => boxes.some(o => !(b.x2 < o.x1 || b.x1 > o.x2 || b.y2 < o.y1 || b.y1 > o.y2));

const candidates = [
  { x: cx + 14, y: cy + 4 },            // right of the dot
  { x: cx - 14 - w, y: cy + 4 },        // left
  { x: cx - w / 2, y: cy - 14 },        // above
  { x: cx - w / 2, y: cy + 22 },        // below
];
```

Reject a candidate that leaves the plotting area (`x1 >= 6 && x2 <= W - 6`). If all four
collide, stagger downward from the dot in `LINE_H + 2` steps until a slot is free. Colour the
quadrants and label them in words ("avoids …" / "picks …") so the chart is readable without
the paper it came from.

Test this by extracting the label coordinates from the generated HTML, rebuilding the boxes
in the test, and asserting no two overlap — an eyeball check misses the second collision.

## Base stylesheet skeleton

```css
:root{ --bg:#070b16; --card:rgba(255,255,255,.045); --line:rgba(148,163,184,.18);
       --text:#e8edf7; --muted:#94a3b8; --cyan:#22d3ee; --violet:#a78bfa; }
body{ background:radial-gradient(1200px 600px at 12% -8%, rgba(34,211,238,.16), transparent 60%),
        linear-gradient(180deg, var(--bg) 0%, #0b1220 100%); color:var(--text);
      font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
```

For the print variant, override the tokens to light values (white background, slate text),
neutralise shadows/backdrop-filters, and `display:none` the controls. Note that `<details>`
collapsed on screen stays collapsed when printed unless you expand it:

```css
@media print {
  .controls { display:none }
  details:not([open]) > *:not(summary) { display:revert }
  .section { page-break-inside:avoid }
}
```
