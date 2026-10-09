---
name: plain-language-rewrite
description: "Rewrite a document at a simpler reading level, in full."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [writing, plain-language, easy-read, leichte-sprache, einfache-sprache, volksschule, simplification, accessibility]
    category: productivity
    related_skills: [pdf, humanizer, docx]
---

# Plain-language rewrite

Take an existing document (usually long and technical) and re-author it at a simpler reading level the user names — "auf dem Niveau von Volksschule", "einfach erklärt", "plain language", "Easy Read", "Leichte Sprache", "für Laien", "for a 12-year-old".

**The deliverable is the whole document in simpler words, in the source language.** Not a summary, not an excerpt, not a translation. Every section of the source must be present, with the same names, numbers and facts.

Read `references/reading-levels.md` for the level ladder and the concrete conventions per level before writing.

## When to use

- "Rewrite this at the level of an elementary school pupil", "explain it simply", "make it readable for non-experts".
- Accessibility work: Leichte Sprache / Easy Read versions of reports, forms, instructions.
- Condensing jargon for a general audience while keeping the document complete.
- NOT for shortening or abstracting a document (that is a summary task), and NOT for removing AI writing tells alone (that is `humanizer`).

## Procedure

1. **Locate and read the entire source before writing a word.** When the path the user gives does not resolve, search the filesystem for the basename (`find / -iname '*<basename>*'`) instead of reporting the file as unreachable; the same document usually sits in several homes (Downloads, an output folder, an upload directory), and the one the user named is the one to use. Confirm it is the right file via page count / metadata.
2. **Extract the full text and read all of it.** Long technical PDFs are frequently two-column InDesign layouts, where `pdftotext -layout` and pdfplumber `--text` emit the two columns interleaved line by line — gibberish that still looks like prose. Detect it (alternating half-width lines in the extract, or `pdfinfo` reporting an unusually wide page such as ~1200 pt) and extract per column via coordinates instead: pymupdf `page.get_text("dict")`, assign each line to a column by its x-midpoint, then sort by (column, y). Never read or rewrite interleaved text. A 50-page report is roughly 2,500 lines of extracted text — read it in paged chunks, not one view.
3. **Pin the register down before writing.** Turn the user's phrase into concrete rules (sentence length, vocabulary, whether each technical term is explained, formal or informal address). `references/reading-levels.md` has the ladder. Say nothing about the level choice; just apply it.
4. **Write in parts, one file per chapter group**, in the scratch directory (`scratch/part1.md`, `part2.md`, …), then merge with `cat part*.md > final.md`. One giant write call gets truncated or times out, and parts make the job resumable; the merge is also the only place you control the blank lines between parts.
5. **Keep coverage and facts verbatim.** Walk the source's table of contents as a checklist: every chapter, every section, every heading. Proper names, numbers, dates, project titles, law references, unit values and organisation names stay exactly as in the source. Add nothing: no new facts, no invented comparisons, no "improvements". Simplification is a change of words, not of content.
6. **Handle terms, not by deleting them.** Explain each technical term in one plain sentence at first use, then keep using the term (consistency beats synonym cycling). Spell abbreviations out at first mention. Gloss foreign-language terms. Convert figures into spoken form (`100 %` → "100 Prozent", `10⁻¹⁷` → "eine Zahl mit 17 Nullen nach dem Komma" plus what it means) and add an everyday scale for big or tiny numbers.
7. **Handle what cannot be translated.** Charts, tables, diagrams and photos do not survive into prose: turn the numbers the reader needs into a short list or plain sentences. Image captions and photo credits may be dropped or kept as a plain line. Never invent values that were only visible in a graphic — if a chart's numbers are not in the text, say the graphic was omitted rather than guessing.
8. **Verify mechanically.** After merging, grep the output for each section title from the source TOC and for author names (`for s in ...; do grep -c "$s" file; done`) and check the word count is in the right ballpark (a full rewrite is usually 60–100 % of the source word count; a summary is far less — a low count means you summarised instead of rewriting). Spot-check numbers against the source text.
9. **Write the file where the user asked for it**, with the ownership that directory needs. If the target directory belongs to another user or another container home, write it through that environment rather than leaving the copy only on the host.
10. **Report short:** the path, the size, which sections are covered, what you changed in style, and one offer for a follow-up (a shorter version, a version for younger readers). Do not re-summarise the document in the reply — the file is the answer.

## Register rules (apply at every level)

- One idea per sentence. Short main clauses. No nested subordinate clauses, no nominal style.
- Active voice; name who does what. Avoid the passive and avoid subjectless fragments.
- Everyday words over Latinate ones. If a word would need a dictionary, explain it or replace it.
- Explain, do not omit: the reader must not lose information, only the difficulty.
- No metaphors, no idioms, no wordplay — these are exactly what plain-language readers cannot decode.
- Define before use, and keep the defined word stable for the rest of the document.
- Never restate a heading in the sentence below it; start with content (see `humanizer` pattern 29).
- Lists stay short, parallel and complete where possible.

## Pitfalls

- **Answering in the wrong language.** The output language is the source language and the language the user wrote in. A German document stays German even when the conversation is in English, and even when the requested level is phrased in English.
- **Summarising.** "Rewrite at level X" is not "summarise". A short reply with bullet points is the failure mode; the check in step 8 catches it.
- **Dropping sections silently.** Sections that feel unimportant (imprint, author list, foreword, statistics) are still part of the document. Missing them is a defect the user notices immediately.
- **Renaming things while simplifying.** Do not paraphrase official titles, project acronyms or institution names into "plain" equivalents; keep them and explain them.
- **One giant write call.** It truncates. Parts, then merge.
- **Trusting a chart's meaning from its caption.** Read the source text for the numbers; if they are only in the graphic, do not fabricate them.

## Verification

- Coverage grep over every TOC heading and author name returns ≥ 1 hit each.
- Word count of the rewrite is a substantial fraction of the source, not a fraction of a fraction.
- A sample of the hardest paragraph reads correctly aloud at the requested level.
- The file exists at the exact requested path and is non-empty.
