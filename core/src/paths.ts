import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

/**
 * Osama keeps *all* of its runtime state under a single home directory so the
 * app is fully portable and nothing leaks into the user's system dirs.
 *
 *  <OSAMA_HOME>/bin/llama/<tag>/   installed llama.cpp releases (per build)
 *  <OSAMA_HOME>/models/            the local GGUF library
 *  <OSAMA_HOME>/downloads/         partial (.part) downloads
 *  <OSAMA_HOME>/logs/              engine + tool logs
 *  <OSAMA_HOME>/registry.json      installed-engine registry
 *
 * Override with the OSAMA_HOME environment variable.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repo root, independent of cwd (works from core/src and core/dist). */
export const REPO_ROOT = path.resolve(HERE, "..", "..");

export interface OsamaPaths {
  home: string;
  bin: string;
  llamaBin: string;
  models: string;
  downloads: string;
  logs: string;
  registryFile: string;
}

export function osamaHome(): string {
  return process.env.OSAMA_HOME
    ? path.resolve(process.env.OSAMA_HOME)
    : path.join(REPO_ROOT, ".osama");
}

export function paths(): OsamaPaths {
  const home = osamaHome();
  return {
    home,
    bin: path.join(home, "bin"),
    llamaBin: path.join(home, "bin", "llama"),
    models: path.join(home, "models"),
    downloads: path.join(home, "downloads"),
    logs: path.join(home, "logs"),
    registryFile: path.join(home, "registry.json"),
  };
}

export function ensureDirs(): OsamaPaths {
  const p = paths();
  for (const dir of [p.home, p.bin, p.llamaBin, p.models, p.downloads, p.logs]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return p;
}

/** Recursively find files whose basename matches, anywhere under `root`. */
export function findFiles(root: string, predicate: (name: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && predicate(entry.name)) out.push(full);
    }
  };
  walk(root);
  return out;
}
