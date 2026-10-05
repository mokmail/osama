import fs from "node:fs";
import path from "node:path";
import { osamaHome } from "./paths.js";
import { logger } from "./logger.js";

/**
 * Soul: the agent's identity, and the voice overlays it can wear.
 *
 * This follows Hermes' design, where `SOUL.md` is the *first* thing in the
 * system prompt — slot #1, replacing the hardcoded default identity — rather
 * than another additive context block. Two rules make that work and both are
 * deliberate here:
 *
 *  - It is loaded from the app home (`OSAMA_HOME`) and nowhere else. A persona
 *    file discovered from whatever directory the app happened to launch in would
 *    change the agent's character per project, which is not identity.
 *  - An empty or missing file falls back to a built-in default rather than
 *    leaving slot #1 blank.
 *
 * Personality presets are the session-level overlay Hermes calls `/personality`:
 * a temporary mode shift layered on top of the durable soul, not a replacement
 * for it.
 *
 * Honest note on one deliberate difference: Hermes treats a user's own SOUL.md
 * as trusted (it is a file they wrote) and only *warns* on a prompt-injection hit
 * instead of blocking. Osama cannot offer that guarantee — chat models run
 * locally with tools that act on the user's machine, and the soul file may well
 * have been authored by a model — so a hit here is reported, not silently loaded.
 * `soulReport()` returns the findings and the caller decides.
 */

const log = logger("soul");

/** Character cap on the identity block, matching the context-file discipline. */
export const SOUL_MAX_CHARS = 20_000;

/** The built-in identity, used when the soul file is missing or empty. */
export const DEFAULT_SOUL = `You are Osama, a local assistant running entirely on the user's machine, driving llama.cpp.

Be direct and useful: answer what was asked, in the length the question deserves. State uncertainty plainly rather than padding. When you use a tool, use its real result — never describe a step as done without evidence it happened.

You work inside a workspace the user chose. Prefer the smallest change that solves the problem, and say what you did in terms of what actually changed.`;

export interface SoulReport {
  /** Where the identity came from. */
  source: "file" | "default";
  file: string;
  /** The text placed in slot #1 of the system prompt. */
  text: string;
  chars: number;
  /** True when a prompt-injection pattern was found. */
  flagged: boolean;
  /** The pattern names that matched (never the matched text itself). */
  findings: string[];
  /** True when the file was longer than the cap and had to be truncated. */
  truncated: boolean;
}

/* ----------------------------------------------------------------- patterns */

/**
 * Prompt-injection heuristics, in the same spirit as Hermes' scanner: they look
 * for instructions that try to escape the file's role as personality text.
 * Deliberately conservative — a false positive means a warning, a false negative
 * means a poisoned identity, and the warning is cheap.
 */
const INJECTION_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "instruction_override", re: /\b(ignore|disregard|forget)\b[^.\n]{0,30}\b(previous|prior|earlier|above|all)\b[^.\n]{0,20}\b(instruction|rule|prompt|direction)/i },
  { name: "system_prompt_override", re: /\bsystem\s*prompt\s*(override|replace|inject)/i },
  { name: "deception", re: /\b(do\s+not|don't|never)\s+(tell|inform|mention|reveal)[^.\n]{0,20}\b(the\s+)?user\b/i },
  { name: "credential_exfiltration", re: /\b(curl|wget|fetch|post|upload)\b[^\n]{0,80}(\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD)|\.env\b)/i },
  { name: "secret_file_access", re: /\b(cat|read|open|exfiltrate)\b[^\n]{0,30}(\.env|credentials|id_rsa|\.ssh\/)/i },
  { name: "hidden_markup", re: /<!--[\s\S]{0,200}(ignore|instruction|prompt)/i },
  { name: "invisible_unicode", re: /[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/ },
];

export interface ScanResult {
  flagged: boolean;
  findings: string[];
}

/** Scan personality text for injection patterns. Returns pattern NAMES only. */
export function scanSoul(text: string): ScanResult {
  const findings: string[] = [];
  for (const p of INJECTION_PATTERNS) {
    if (p.re.test(text)) findings.push(p.name);
  }
  return { flagged: findings.length > 0, findings };
}

/* -------------------------------------------------------------------- file */

export function soulFile(): string {
  return path.join(osamaHome(), "SOUL.md");
}

/** Write the starter soul if none exists. Never overwrites a real one. */
export function ensureSoulFile(): string {
  const file = soulFile();
  try {
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `# Soul\n\n${DEFAULT_SOUL}\n`, "utf8");
      log.info(`seeded a default SOUL.md at ${file}`);
    }
  } catch (e) {
    log.warn(`could not seed SOUL.md: ${(e as Error).message}`);
  }
  return file;
}

/**
 * Read the identity for slot #1.
 *
 * Empty, missing, or unreadable all fall back to the built-in default — the
 * identity slot is never left blank, because a blank slot is what lets an
 * arbitrary "you are a helpful assistant" from the caller take over.
 */
export function soulReport(): SoulReport {
  const file = soulFile();
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { source: "default", file, text: DEFAULT_SOUL, chars: DEFAULT_SOUL.length, flagged: false, findings: [], truncated: false };
  }

  // A leading `# Soul` heading is scaffolding, not voice — drop it so it does
  // not eat the first line of the identity.
  const body = raw.replace(/^#\s*Soul\s*\r?\n+/i, "").trim();
  if (!body) {
    return { source: "default", file, text: DEFAULT_SOUL, chars: DEFAULT_SOUL.length, flagged: false, findings: [], truncated: false };
  }

  const truncated = body.length > SOUL_MAX_CHARS;
  // Head-heavy truncation, like a context file: the opening sets the voice.
  const text = truncated ? `${body.slice(0, Math.floor(SOUL_MAX_CHARS * 0.85))}\n\n… [truncated]\n` : body;
  const scan = scanSoul(body);
  return { source: "file", file, text, chars: text.length, flagged: scan.flagged, findings: scan.findings, truncated };
}

/** Just the text, for the prompt builder. */
export function soulText(): string {
  return soulReport().text;
}

export interface WriteSoulResult {
  ok: boolean;
  chars?: number;
  flagged?: boolean;
  findings?: string[];
  error?: string;
}

/**
 * Replace the soul.
 *
 * The write is *not* refused on a scanner hit — the user (or their model) may
 * legitimately be writing *about* injection, and a security note that quotes an
 * attack phrase is a normal thing to keep. The caller gets the findings back and
 * is responsible for surfacing them.
 */
export function writeSoul(text: string): WriteSoulResult {
  const clean = String(text ?? "").trim();
  if (!clean) return { ok: false, error: "the soul cannot be empty — clear it with the default instead" };
  if (clean.length > SOUL_MAX_CHARS * 4) {
    return { ok: false, error: `that is ${clean.length} characters; the soul is capped at ${SOUL_MAX_CHARS}` };
  }
  const file = soulFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `# Soul\n\n${clean}\n`, "utf8");
    fs.renameSync(tmp, file);
  } catch (e) {
    return { ok: false, error: `could not write the soul: ${(e as Error).message}` };
  }
  const scan = scanSoul(clean);
  log.info(`soul updated (${clean.length} chars${scan.flagged ? `, flagged: ${scan.findings.join(", ")}` : ""})`);
  return { ok: true, chars: clean.length, flagged: scan.flagged, findings: scan.findings };
}

/** Restore the built-in identity by deleting the file. */
export function resetSoul(): WriteSoulResult {
  try {
    fs.rmSync(soulFile(), { force: true });
    ensureSoulFile();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/* ------------------------------------------------------------ personalities */

export interface Personality {
  id: string;
  label: string;
  /** One line for the picker. */
  blurb: string;
  /** The overlay appended to slot #1. Empty for `none`. */
  overlay: string;
}

/**
 * Built-in overlays, in the spirit of Hermes' `/personality` presets: a
 * session-level mode shift layered ON TOP of the durable soul, never a
 * replacement for it.
 */
export const PERSONALITIES: Personality[] = [
  { id: "none", label: "Default", blurb: "Just the soul — no overlay.", overlay: "" },
  { id: "concise", label: "Concise", blurb: "Brief, to the point.", overlay: "Be brief. Prefer short replies and skip preamble entirely." },
  { id: "technical", label: "Technical", blurb: "Precise, detailed engineering.", overlay: "Answer as a precise engineer. Include exact commands, flags, paths and numbers. Show your reasoning when it is load-bearing; skip it when it is obvious." },
  { id: "teacher", label: "Teacher", blurb: "Patient, with examples.", overlay: "Teach patiently. Explain the why before the how, use a concrete example, and check understanding rather than dumping facts." },
  { id: "reviewer", label: "Code reviewer", blurb: "Meticulous, finds flaws.", overlay: "Act as a meticulous reviewer. Hunt for bugs, security issues, unhandled edge cases and unclear design. Be specific and constructive; name the line and the failure." },
  { id: "creative", label: "Creative", blurb: "Exploratory, divergent.", overlay: "Think divergently. Offer unexpected options, question the framing, and favour trying something over optimising the obvious." },
  { id: "philosopher", label: "Philosopher", blurb: "Contemplative.", overlay: "Consider the question beneath the question. Be contemplative and precise about what is actually being asked." },
  { id: "hype", label: "Hype", blurb: "Maximum energy.", overlay: "Bring energy! Be enthusiastic and encouraging while staying accurate." },
];

export function personalityById(id: string | undefined): Personality {
  if (!id) return PERSONALITIES[0]!;
  return PERSONALITIES.find((p) => p.id === id) ?? PERSONALITIES[0]!;
}

/**
 * Assemble slot #1: the durable identity, then an optional overlay.
 *
 * The overlay is clearly boxed so a model cannot mistake a temporary mode for
 * part of its permanent character.
 */
export function identityBlock(personality?: string): string {
  const soul = soulText();
  const p = personalityById(personality);
  if (!p.overlay) return soul;
  return `${soul}\n\n<mode name="${p.id}">\n${p.overlay}\n</mode>`;
}
