import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { config, SUPPRESSED_TAGS } from "../config.js";
import { scheduleShotlistRebuild } from "./shotlist.js";

interface LegacyMeta {
  id: string;
  name?: string;
  filename: string;
  path: string;
  source?: string;
  sourcePath?: string;
  sourceCopyPath?: string;
  [k: string]: unknown;
}

const LEGACY_LIBRARIES = [
  path.join(os.homedir(), "ClipCataloger", "library"),
];

function readMetaSafe(p: string): LegacyMeta | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as LegacyMeta;
  } catch {
    return null;
  }
}

function uniqueDest(dir: string, base: string, ext: string): string {
  let candidate = path.join(dir, `${base}${ext}`);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}_${n}${ext}`);
    n += 1;
  }
  return candidate;
}

function moveOrSkip(src: string, dest: string): string {
  // If both source and dest exist (e.g. dest already moved), skip.
  if (!fs.existsSync(src)) return fs.existsSync(dest) ? dest : src;
  fs.renameSync(src, dest);
  return dest;
}

/**
 * One-shot migration of clips from legacy ~/ClipCataloger/library into the
 * current project's <project>/clips/ folder. Skips clips whose id already
 * exists in the new clip-meta dir. Idempotent — safe to run on every boot.
 */
export function migrateLegacyLibrary(): { moved: number; scanned: number } {
  let moved = 0;
  let scanned = 0;

  for (const legacyRoot of LEGACY_LIBRARIES) {
    const legacyMetaDir = path.join(legacyRoot, ".meta");
    if (!fs.existsSync(legacyMetaDir)) continue;

    // Don't migrate if the legacy folder IS the new clips dir (would self-merge).
    if (path.resolve(legacyRoot) === path.resolve(config.clipsDir)) continue;

    for (const name of fs.readdirSync(legacyMetaDir)) {
      if (!name.endsWith(".json")) continue;
      scanned += 1;

      const legacyMetaPath = path.join(legacyMetaDir, name);
      const meta = readMetaSafe(legacyMetaPath);
      if (!meta?.id) continue;

      const newMetaPath = path.join(config.clipMetaDir, `${meta.id}.json`);
      if (fs.existsSync(newMetaPath)) continue; // already migrated

      try {
        // Move the clip file
        const ext = path.extname(meta.path);
        const base = path.basename(meta.path, ext);
        let newClipPath: string;
        if (fs.existsSync(meta.path)) {
          const dest = uniqueDest(config.clipsDir, base, ext);
          newClipPath = moveOrSkip(meta.path, dest);
        } else {
          // Source missing — skip this entry.
          continue;
        }

        // Move the bundled source copy if it exists
        let newSourceCopyPath: string | undefined;
        if (meta.sourceCopyPath && fs.existsSync(meta.sourceCopyPath)) {
          const sext = path.extname(meta.sourceCopyPath);
          const sbase = path.basename(meta.sourceCopyPath, sext);
          const dest = uniqueDest(config.clipsDir, sbase, sext);
          newSourceCopyPath = moveOrSkip(meta.sourceCopyPath, dest);
        } else if (meta.sourceCopyPath) {
          newSourceCopyPath = undefined; // file missing
        }

        const updated: LegacyMeta = {
          ...meta,
          filename: path.basename(newClipPath),
          path: newClipPath,
          sourceCopyPath: newSourceCopyPath,
        };
        fs.writeFileSync(newMetaPath, JSON.stringify(updated, null, 2));
        try {
          fs.unlinkSync(legacyMetaPath);
        } catch {
          // ignore
        }
        moved += 1;
      } catch (err) {
        console.error(`[migrate] failed for ${name}:`, err);
      }
    }

    // Best-effort cleanup of legacy thumbnail cache (will regenerate on demand)
    try {
      const legacyCache = path.join(legacyRoot, ".cache");
      if (fs.existsSync(legacyCache)) {
        fs.rmSync(legacyCache, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }

  if (moved > 0) {
    console.log(
      `[migrate] moved ${moved} legacy clip(s) into ${config.clipsDir}`
    );
    scheduleShotlistRebuild(0);
  } else if (scanned > 0) {
    console.log(`[migrate] scanned ${scanned} legacy clip(s); none needed migration`);
  }
  return { moved, scanned };
}

/**
 * Strip suppressed (style-of-art) tags from every existing sidecar. Runs once
 * at startup so old clips that were captioned before tag suppression existed
 * don't keep showing "animation"/"cartoon" forever. Idempotent.
 */
export function cleanSuppressedTagsInSidecars(): { cleaned: number } {
  if (!fs.existsSync(config.clipMetaDir)) return { cleaned: 0 };
  let cleaned = 0;
  for (const name of fs.readdirSync(config.clipMetaDir)) {
    if (!name.endsWith(".json")) continue;
    const p = path.join(config.clipMetaDir, name);
    let meta: { tags?: string[]; [k: string]: unknown };
    try {
      meta = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      continue;
    }
    if (!Array.isArray(meta.tags)) continue;
    const before = meta.tags.length;
    meta.tags = meta.tags.filter(
      (t) => typeof t === "string" && !SUPPRESSED_TAGS.has(t.toLowerCase().trim())
    );
    if (meta.tags.length !== before) {
      fs.writeFileSync(p, JSON.stringify(meta, null, 2));
      cleaned += 1;
    }
  }
  if (cleaned > 0) {
    console.log(`[migrate] cleaned suppressed tags from ${cleaned} sidecar(s)`);
    scheduleShotlistRebuild(0);
  }
  return { cleaned };
}
