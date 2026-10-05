import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { x as tarExtract } from "tar";
import yauzl from "yauzl";

const run = promisify(execFile);

/**
 * Extract a .tar.gz archive into `destDir`.
 *
 * llama.cpp's release archives contain *relative* symlinks such as
 * `libllama-common.so.0 -> libllama-common.so.0.5.0`. Some JS tar
 * implementations rewrite those to absolute paths, which break the moment the
 * temp extraction directory is removed — so we prefer the system `tar` (which
 * preserves them verbatim) and repair any absolute links afterwards.
 */
export async function extractTarGz(archive: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  try {
    await run("tar", ["-xzf", archive, "-C", destDir], { maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    // No system tar (or it failed) — fall back to the bundled extractor.
    try {
      await pipeline(
        fs.createReadStream(archive),
        createGunzip(),
        tarExtract({ cwd: destDir, preservePaths: false, strict: false }),
      );
    } catch (err2) {
      throw new Error(`could not extract ${path.basename(archive)}: ${(err2 as Error).message ?? (err as Error).message}`);
    }
  }
  repairSymlinks(destDir);
}

/** Rewrite absolute symlinks that point outside `dir` back to relative ones. */
export function repairSymlinks(dir: string): number {
  let fixed = 0;
  const root = path.resolve(dir);
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        let target: string;
        try {
          target = fs.readlinkSync(full);
        } catch {
          continue;
        }
        if (path.isAbsolute(target) && !target.startsWith(root + path.sep) && !fs.existsSync(target)) {
          const rel = path.basename(target);
          if (fs.existsSync(path.join(d, rel))) {
            fs.unlinkSync(full);
            fs.symlinkSync(rel, full);
            fixed++;
          }
        }
      } else if (stat.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(root);
  return fixed;
}

/** Strip a leading directory (common when archives wrap everything in a folder). */
export function stripCommonRoot(dir: string): string[] {
  const entries = fs.readdirSync(dir);
  if (entries.length === 1) {
    const only = path.join(dir, entries[0]!);
    if (fs.statSync(only).isDirectory()) return [only];
  }
  return entries.map((e) => path.join(dir, e));
}

/** Extract a .zip archive into `destDir`. */
export function extractZip(archive: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  const root = path.resolve(destDir);
  return new Promise((resolve, reject) => {
    yauzl.open(archive, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(err ?? new Error("cannot open zip"));
      zipfile.on("error", reject);
      zipfile.readEntry();
      zipfile.on("entry", (entry: yauzl.Entry) => {
        const target = path.resolve(root, entry.fileName);
        // zip-slip protection
        if (!target.startsWith(root + path.sep) && target !== root) {
          zipfile.close();
          return reject(new Error(`unsafe path in zip: ${entry.fileName}`));
        }
        if (/\/$/.test(entry.fileName)) {
          fs.mkdirSync(target, { recursive: true });
          return zipfile.readEntry();
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        zipfile.openReadStream(entry, (e2, rs) => {
          if (e2 || !rs) return reject(e2 ?? new Error("cannot read zip entry"));
          const ws = fs.createWriteStream(target);
          rs.on("error", reject);
          ws.on("error", reject);
          ws.on("close", () => {
            // preserve the executable bit when the zip records it
            const mode = (entry.externalFileAttributes >>> 16) & 0o777;
            if (mode) {
              try {
                fs.chmodSync(target, mode);
              } catch {
                /* best effort */
              }
            }
            zipfile.readEntry();
          });
          rs.pipe(ws);
        });
      });
      zipfile.on("end", () => resolve());
    });
  });
}

export async function extractArchive(archive: string, destDir: string): Promise<void> {
  if (archive.endsWith(".zip")) await extractZip(archive, destDir);
  else await extractTarGz(archive, destDir);
}
