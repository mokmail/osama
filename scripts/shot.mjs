// Render each Osama view headlessly and capture PNGs for a visual check.
// Run:  node scripts/shot.mjs [outdir]
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.OSAMA_BASE ?? "http://127.0.0.1:5178";
const out = process.argv[2] ?? "/home/kmail/.hermes/cache/scratch/osama-shots";
fs.mkdirSync(out, { recursive: true });

const NAV = [
  ["dashboard", "Dashboard"],
  ["chat", "Chat"],
  ["models", "Library"],
  ["hub", "Discover"],
  ["server", "Server"],
  ["run", "Run CLI"],
  ["create", "Create"],
  ["evaluate", "Evaluate"],
  ["inspect", "Inspect"],
  ["engine", "llama.cpp"],
  ["processes", "Processes"],
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 2 });
await page.goto(BASE, { waitUntil: "networkidle" });

for (const [id, label] of NAV) {
  await page.getByRole("button", { name: label, exact: true }).first().click();
  await page.waitForTimeout(1200);
  const file = path.join(out, `${id}.png`);
  await page.screenshot({ path: file });
  console.log("shot:", file);
}

await browser.close();
