import { Router } from "express";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { config, isSupportedVideo, SUPPORTED_VIDEO_EXTS } from "../config.js";
import { extractFrameJpeg, getDuration } from "../ffmpeg.js";
import { scheduleShotlistRebuild } from "../util/shotlist.js";
import { smartCut } from "../smartcut.js";
import { clampSegmentToDuration } from "../util/timeRange.js";
import { appendActivity } from "../util/activity.js";
import { pathToId } from "../util/id.js";
import { stemJobManager } from "../stems/manager.js";

const router = Router();
const LIBRARY_ID_RE = /^[a-f0-9]{16}$/;

router.param("id", (req, res, next, id) => {
  if (!LIBRARY_ID_RE.test(id)) {
    res.status(400).json({ error: "invalid library id" });
    return;
  }
  next();
});

interface LibraryMeta {
  id: string;
  name: string;
  description: string;
  tags: string[];
  characters?: { id: string; name: string }[];
  scenes?: { id: string; name: string }[];
  objects?: { id: string; name: string }[];
  filename: string;
  path: string;
  source?: string;
  sourcePath?: string;
  sourceId?: string;
  sourceCopyPath?: string;
  in?: number;
  out?: number;
  duration?: number;
  mode?: string;
  exportMode?: "clip" | "source" | "bundle";
  details?: string;
  created: number;
}

function metaPath(id: string): string {
  if (!LIBRARY_ID_RE.test(id)) throw new Error("invalid library id");
  return path.join(config.clipMetaDir, `${id}.json`);
}

function isContained(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** Existing, non-symlink-escaped file beneath a trusted root. */
function safeExistingFile(root: string, candidate: unknown): string | null {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) return null;
  try {
    const realRoot = fs.realpathSync(root);
    const realCandidate = fs.realpathSync(candidate);
    if (!isContained(realRoot, realCandidate)) return null;
    return fs.statSync(realCandidate).isFile() ? realCandidate : null;
  } catch {
    return null;
  }
}

/** Clips are intentionally flat; supports missing restore/repair targets too. */
function safeClipTarget(candidate: unknown): string | null {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) return null;
  const resolved = path.resolve(candidate);
  if (path.dirname(resolved) !== path.resolve(config.clipsDir)) return null;
  try {
    const realClips = fs.realpathSync(config.clipsDir);
    const realParent = fs.realpathSync(path.dirname(resolved));
    if (realParent !== realClips) return null;
    if (fs.existsSync(resolved)) {
      const realCandidate = fs.realpathSync(resolved);
      if (path.dirname(realCandidate) !== realClips || !fs.statSync(realCandidate).isFile()) {
        return null;
      }
      return realCandidate;
    }
    return resolved;
  } catch {
    return null;
  }
}

function readMeta(p: string): LibraryMeta | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as LibraryMeta;
  } catch {
    return null;
  }
}

function listMetas(): LibraryMeta[] {
  if (!fs.existsSync(config.clipMetaDir)) return [];
  const items: LibraryMeta[] = [];
  for (const name of fs.readdirSync(config.clipMetaDir)) {
    if (!name.endsWith(".json")) continue;
    const sidecarId = name.slice(0, -5);
    if (!LIBRARY_ID_RE.test(sidecarId)) continue;
    const m = readMeta(path.join(config.clipMetaDir, name));
    // Keep entries even when the underlying file is gone so the Library tab
    // can surface missing-file clips. Callers filter on `fs.existsSync(m.path)`
    // when they need only "real" media.
    if (m && m.id === sidecarId) items.push(m);
  }
  items.sort((a, b) => b.created - a.created);
  return items;
}

function listOrphans(metas: LibraryMeta[]): {
  filename: string;
  size: number;
  mtime: number;
  path: string;
}[] {
  if (!fs.existsSync(config.clipsDir)) return [];
  const knownPaths = new Set<string>();
  for (const m of metas) {
    const clip = safeClipTarget(m.path);
    const sourceCopy = safeClipTarget(m.sourceCopyPath);
    if (clip) knownPaths.add(clip);
    if (sourceCopy) knownPaths.add(sourceCopy);
  }
  const out: { filename: string; size: number; mtime: number; path: string }[] = [];
  for (const name of fs.readdirSync(config.clipsDir)) {
    if (name.startsWith(".")) continue;
    if (!SUPPORTED_VIDEO_EXTS.has(path.extname(name).toLowerCase())) continue;
    const full = path.join(config.clipsDir, name);
    if (knownPaths.has(full)) continue;
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      out.push({
        filename: name,
        size: st.size,
        mtime: st.mtimeMs,
        path: full,
      });
      if (out.length >= 20) break;
    } catch {
      // ignore unreadable files
    }
  }
  return out;
}

const idToFile = new Map<string, string>();
const idToSource = new Map<string, string>();

function pickSourcePath(m: LibraryMeta): string | null {
  const sourceCopy = safeExistingFile(config.clipsDir, m.sourceCopyPath);
  if (sourceCopy) return sourceCopy;
  const source = safeExistingFile(config.projectDir, m.sourcePath);
  if (source) return source;
  return null;
}

function refreshIndex() {
  idToFile.clear();
  idToSource.clear();
  for (const m of listMetas()) {
    const clip = safeExistingFile(config.clipsDir, m.path);
    if (clip) idToFile.set(m.id, clip);
    const src = pickSourcePath(m);
    if (src) idToSource.set(m.id, src);
  }
}

router.get("/library", async (_req, res) => {
  const metas = listMetas();
  refreshIndex();
  let missingCount = 0;
  const items = metas.map((m) => {
    const sourceAvailable = pickSourcePath(m) !== null;
    const safePath = safeClipTarget(m.path);
    const missing = !safePath || !fs.existsSync(safePath);
    if (missing) missingCount += 1;
    return {
      ...m,
      path: safePath ?? "",
      thumbUrl: `/api/library/${m.id}/thumb`,
      videoUrl: `/api/library/${m.id}/video`,
      sourceVideoUrl: sourceAvailable
        ? `/api/library/${m.id}/source-video`
        : undefined,
      sourceAvailable,
      ...(missing ? { missing: true } : {}),
      ...(!safePath && m.path ? { unsafePathRejected: true } : {}),
    };
  });
  const orphans = listOrphans(metas);
  res.json({ items, libraryDir: config.clipsDir, missingCount, orphans });
});

router.patch("/library/:id", (req, res) => {
  const mp = metaPath(req.params.id);
  if (!fs.existsSync(mp)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const Schema = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(5_000).optional(),
    tags: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
    characters: z
      .array(z.object({ id: z.string(), name: z.string() }))
      .optional(),
    scenes: z
      .array(z.object({ id: z.string(), name: z.string() }))
      .optional(),
    objects: z
      .array(z.object({ id: z.string(), name: z.string() }))
      .optional(),
  });
  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const meta = readMeta(mp);
  if (!meta) {
    res.status(500).json({ error: "could not read meta" });
    return;
  }
  const clipPath = safeClipTarget(meta.path);
  if (!clipPath) {
    res.status(409).json({ error: "unsafe clip path in sidecar" });
    return;
  }
  const updated: LibraryMeta = { ...meta, path: clipPath, ...parsed.data };
  fs.writeFileSync(mp, JSON.stringify(updated, null, 2));
  scheduleShotlistRebuild();
  res.json(updated);
});

/**
 * Re-export a library clip in place. Smart-cuts the (possibly new) [in, out]
 * range from the original source into a sibling temp file, then atomically
 * renames over the existing clip path so the URL/filename never changes. The
 * sidecar is updated with the new metadata + cut details.
 */
router.post("/library/:id/reexport", async (req, res) => {
  const mp = metaPath(req.params.id);
  if (!fs.existsSync(mp)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const meta = readMeta(mp);
  if (!meta) {
    res.status(500).json({ error: "could not read meta" });
    return;
  }
  if (meta.exportMode === "source") {
    res.status(400).json({ error: "cannot re-export a source clone" });
    return;
  }
  const Schema = z.object({
    in: z.number().min(0),
    out: z.number().min(0),
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    characters: z
      .array(z.object({ id: z.string(), name: z.string() }))
      .optional(),
    scenes: z
      .array(z.object({ id: z.string(), name: z.string() }))
      .optional(),
    objects: z
      .array(z.object({ id: z.string(), name: z.string() }))
      .optional(),
    stems: z
      .object({ quality: z.literal("fast") })
      .optional(),
  });
  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const source = pickSourcePath(meta);
  const clipPath = safeExistingFile(config.clipsDir, meta.path);
  if (!clipPath) {
    res.status(409).json({ error: "unsafe or missing clip path in sidecar" });
    return;
  }
  if (!source) {
    res.status(400).json({ error: "original source no longer available" });
    return;
  }
  let { in: inT, out: outT } = parsed.data;
  try {
    const dur = await getDuration(source);
    if (dur > 0) {
      const c = clampSegmentToDuration(inT, outT, dur);
      inT = c.inT;
      outT = c.outT;
    }
  } catch {
    // best-effort clamp
  }
  if (outT - inT < 0.1) {
    res.status(400).json({ error: "selection too short" });
    return;
  }
  const ext = path.extname(clipPath);
  const tempPath = path.join(
    path.dirname(clipPath),
    `.reexport-${req.params.id}${ext}`
  );
  try {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    const cut = await smartCut(source, inT, outT, tempPath);
    fs.renameSync(tempPath, clipPath);
    const updated: LibraryMeta = {
      ...meta,
      path: clipPath,
      ...parsed.data,
      in: inT,
      out: outT,
      duration: outT - inT,
      mode: cut.mode,
      details: cut.details,
    };
    fs.writeFileSync(mp, JSON.stringify(updated, null, 2));
    // Bust the thumbnail cache so the strip refreshes after the in-place rewrite.
    const thumb = path.join(config.thumbCacheDir, `lib-${req.params.id}.jpg`);
    try {
      if (fs.existsSync(thumb)) fs.unlinkSync(thumb);
    } catch {
      // ignore
    }
    scheduleShotlistRebuild();
    appendActivity("clip_reexported", {
      id: req.params.id,
      name: updated.name,
      durationSec: updated.duration,
    });
    let stemJob;
    if (parsed.data.stems) {
      try {
        stemJob = stemJobManager.enqueue({
          clipId: req.params.id,
          clipName: updated.name,
          clipPath,
          quality: parsed.data.stems.quality,
        });
      } catch {
        // The re-export is already valid. A queue failure must not undo it.
        appendActivity("stems_failed", {
          clipId: req.params.id,
          clipName: updated.name,
          quality: parsed.data.stems.quality,
          error: "background stem queue could not start",
        });
      }
    }
    res.json({ ...updated, ...(stemJob ? { stemJob } : {}) });
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // ignore
    }
    res.status(500).json({ error: String(err) });
  }
});

router.delete("/library/:id", (req, res) => {
  const mp = metaPath(req.params.id);
  if (!fs.existsSync(mp)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const meta = readMeta(mp);
  if (!meta) {
    res.status(500).json({ error: "could not read meta" });
    return;
  }
  const paths: string[] = [];
  for (const candidate of [meta.path, meta.sourceCopyPath]) {
    if (!candidate) continue;
    const target = safeClipTarget(candidate);
    if (!target) {
      res.status(409).json({ error: "unsafe media path in sidecar; nothing was deleted" });
      return;
    }
    if (fs.existsSync(target)) {
      const existing = safeExistingFile(config.clipsDir, target);
      if (!existing) {
        res.status(409).json({ error: "unsafe media symlink in sidecar; nothing was deleted" });
        return;
      }
      paths.push(existing);
    }
  }
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      // ignore
    }
  }
  fs.unlinkSync(mp);
  scheduleShotlistRebuild();
  appendActivity("clip_deleted", { id: req.params.id, name: meta.name });
  res.json({ ok: true });
});

router.get("/library/:id/thumb", async (req, res) => {
  refreshIndex();
  const file = idToFile.get(req.params.id);
  if (!file || !fs.existsSync(file)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (!isSupportedVideo(file)) {
    res.status(400).json({ error: "not a video" });
    return;
  }
  const cachePath = path.join(config.thumbCacheDir, `lib-${req.params.id}.jpg`);
  if (!fs.existsSync(cachePath)) {
    try {
      const dur = await getDuration(file);
      const t = Math.max(0.05, Math.min(dur / 2, 30));
      await extractFrameJpeg(file, t, cachePath, 360);
    } catch (err) {
      res.status(500).json({ error: String(err) });
      return;
    }
  }
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.sendFile(cachePath);
});

const VIDEO_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
};

function streamVideo(
  file: string,
  req: import("express").Request,
  res: import("express").Response
) {
  const stat = fs.statSync(file);
  const ext = path.extname(file).toLowerCase();
  const mime = VIDEO_MIME[ext] ?? "application/octet-stream";

  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (!m) {
      res.status(416).end();
      return;
    }
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Number(m[2]) : stat.size - 1;
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", String(end - start + 1));
    res.setHeader("Content-Type", mime);
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Content-Type", mime);
    res.setHeader("Accept-Ranges", "bytes");
    fs.createReadStream(file).pipe(res);
  }
}

router.get("/library/:id/video", (req, res) => {
  refreshIndex();
  const file = idToFile.get(req.params.id);
  if (!file || !fs.existsSync(file)) {
    res.status(404).end("not found");
    return;
  }
  streamVideo(file, req, res);
});

router.get("/library/:id/source-video", (req, res) => {
  refreshIndex();
  const file = idToSource.get(req.params.id);
  if (!file || !fs.existsSync(file)) {
    res.status(404).end("source not found");
    return;
  }
  streamVideo(file, req, res);
});

// ---- integrity / housekeeping ---------------------------------------------

function spawnReveal(targetPath: string): void {
  // Fire-and-forget; Finder is fast and we don't need the exit code.
  const child = spawn("open", ["-R", targetPath], {
    stdio: "ignore",
    detached: true,
  });
  child.on("error", () => {
    // ignore — caller already returned ok
  });
  child.unref();
}

router.post("/library/:id/reveal", (req, res) => {
  const mp = metaPath(req.params.id);
  if (!fs.existsSync(mp)) {
    res.status(404).json({ error: "sidecar not found" });
    return;
  }
  const meta = readMeta(mp);
  if (!meta) {
    res.status(500).json({ error: "could not read sidecar" });
    return;
  }
  const clipPath = safeExistingFile(config.clipsDir, meta.path);
  if (!clipPath) {
    res.status(410).json({ error: "clip file missing" });
    return;
  }
  spawnReveal(clipPath);
  res.json({ ok: true });
});

router.post("/reveal", (req, res) => {
  const Schema = z.object({ path: z.string().min(1) });
  // Allow path through ?path=... too so the frontend doesn't have to JSON-stringify.
  const candidate =
    typeof req.body?.path === "string"
      ? req.body.path
      : typeof req.query.path === "string"
        ? (req.query.path as string)
        : "";
  const parsed = Schema.safeParse({ path: candidate });
  if (!parsed.success || !path.isAbsolute(parsed.data.path)) {
    res.status(400).json({ error: "absolute path required" });
    return;
  }
  const revealPath = safeExistingFile(config.projectDir, parsed.data.path);
  let safeDirectory: string | null = null;
  try {
    const realProject = fs.realpathSync(config.projectDir);
    const realCandidate = fs.realpathSync(parsed.data.path);
    if (isContained(realProject, realCandidate) && fs.statSync(realCandidate).isDirectory()) {
      safeDirectory = realCandidate;
    }
  } catch {
    // handled below
  }
  if (!revealPath && !safeDirectory) {
    res.status(410).json({ error: "path not found" });
    return;
  }
  spawnReveal(revealPath ?? safeDirectory!);
  res.json({ ok: true });
});

function trashDir(): string {
  return path.join(os.homedir(), ".Trash");
}

router.post("/library/:id/restore", (req, res) => {
  const mp = metaPath(req.params.id);
  if (!fs.existsSync(mp)) {
    res.status(404).json({ error: "sidecar not found" });
    return;
  }
  const meta = readMeta(mp);
  if (!meta || !meta.path) {
    res.status(500).json({ error: "could not read sidecar" });
    return;
  }
  const targetPath = safeClipTarget(meta.path);
  if (!targetPath) {
    res.status(409).json({ error: "unsafe restore path in sidecar" });
    return;
  }
  if (fs.existsSync(targetPath)) {
    res.json({ ok: true, path: targetPath, note: "already present" });
    return;
  }
  const target = path.basename(targetPath).toLowerCase();
  const trash = trashDir();
  let candidate: string | null = null;
  try {
    for (const name of fs.readdirSync(trash)) {
      if (name.toLowerCase() === target) {
        candidate = path.join(trash, name);
        break;
      }
    }
  } catch {
    // ignore
  }
  if (!candidate) {
    // Sidecar was unlinked on delete — best-effort: if the meta JSON is also
    // missing, recreate it once we relocate a file. For now just report 404.
    res.status(404).json({ error: "no matching file in Trash" });
    return;
  }
  try {
    fs.renameSync(candidate, targetPath);
  } catch (err) {
    res.status(500).json({ error: String(err) });
    return;
  }
  // Best-effort: ensure the sidecar exists with the meta we already have.
  try {
    fs.writeFileSync(mp, JSON.stringify(meta, null, 2));
  } catch {
    // sidecar already exists, ignore
  }
  scheduleShotlistRebuild();
  appendActivity("clip_restored", { id: req.params.id, name: meta.name });
  res.json({ ok: true, path: targetPath });
});

router.post("/library/repair-missing", async (_req, res) => {
  const metas = listMetas();
  const missing = metas.filter((m) => {
    const target = safeClipTarget(m.path);
    return !target || !fs.existsSync(target);
  });
  const errors: { id: string; error: string }[] = [];
  let repaired = 0;
  for (const meta of missing) {
    const targetPath = safeClipTarget(meta.path);
    if (!targetPath) {
      errors.push({ id: meta.id, error: "unsafe clip path in sidecar" });
      continue;
    }
    const source = pickSourcePath(meta);
    if (!source) {
      errors.push({ id: meta.id, error: "source not available" });
      continue;
    }
    const inT = typeof meta.in === "number" ? meta.in : 0;
    const outT =
      typeof meta.out === "number" && meta.out > inT
        ? meta.out
        : inT + (meta.duration ?? 0);
    if (!(outT > inT)) {
      errors.push({ id: meta.id, error: "no valid in/out on sidecar" });
      continue;
    }
    const ext = path.extname(targetPath);
    const tempPath = path.join(
      path.dirname(targetPath),
      `.repair-${meta.id}${ext}`
    );
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      const cut = await smartCut(source, inT, outT, tempPath);
      fs.renameSync(tempPath, targetPath);
      const updated: LibraryMeta = {
        ...meta,
        path: targetPath,
        in: inT,
        out: outT,
        duration: outT - inT,
        mode: cut.mode,
        details: cut.details,
      };
      fs.writeFileSync(metaPath(meta.id), JSON.stringify(updated, null, 2));
      const thumb = path.join(config.thumbCacheDir, `lib-${meta.id}.jpg`);
      try {
        if (fs.existsSync(thumb)) fs.unlinkSync(thumb);
      } catch {
        // ignore
      }
      repaired += 1;
    } catch (err) {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        // ignore
      }
      errors.push({ id: meta.id, error: String(err) });
    }
  }
  if (repaired > 0) scheduleShotlistRebuild();
  appendActivity("missing_repaired", { repaired, errors: errors.length });
  res.json({ repaired, errors });
});

const OrphanPaths = z.object({ paths: z.array(z.string().min(1)).min(1) });

router.post("/library/orphans/adopt", async (req, res) => {
  const parsed = OrphanPaths.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const ids: string[] = [];
  let adopted = 0;
  for (const requestedPath of parsed.data.paths) {
    const p = safeExistingFile(config.clipsDir, requestedPath);
    if (!p || !isSupportedVideo(p)) continue;
    let duration = 0;
    try {
      duration = await getDuration(p);
    } catch {
      duration = 0;
    }
    const id = crypto.randomBytes(8).toString("hex");
    const name = path.basename(p, path.extname(p));
    const meta: LibraryMeta = {
      id,
      name,
      description: "",
      tags: [],
      characters: [],
      scenes: [],
      objects: [],
      filename: path.basename(p),
      path: p,
      in: 0,
      out: duration,
      duration,
      mode: "adopted",
      details: "Adopted from orphan file (no re-encode).",
      exportMode: "clip",
      created: Date.now(),
    };
    try {
      fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));
      ids.push(id);
      adopted += 1;
    } catch {
      // skip on write failure
    }
  }
  if (adopted > 0) scheduleShotlistRebuild();
  appendActivity("orphans_adopted", { adopted, ids });
  res.json({ adopted, ids });
});

router.post("/library/orphans/trash", (req, res) => {
  const parsed = OrphanPaths.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const trash = trashDir();
  let trashed = 0;
  for (const requestedPath of parsed.data.paths) {
    const p = safeExistingFile(config.clipsDir, requestedPath);
    if (!p) continue;
    let dest = path.join(trash, path.basename(p));
    let n = 2;
    while (fs.existsSync(dest)) {
      const ext = path.extname(p);
      const base = path.basename(p, ext);
      dest = path.join(trash, `${base} ${n}${ext}`);
      n += 1;
    }
    try {
      fs.renameSync(p, dest);
      trashed += 1;
    } catch {
      // skip on failure
    }
  }
  appendActivity("orphans_trashed", { trashed });
  res.json({ trashed });
});

// ---- Rename ----------------------------------------------------------------
// Rename the on-disk MP4 (and re-key its sidecar) without touching trim or
// re-encoding. The id changes because ids are pathToId(absPath); callers must
// use the returned `item.id` going forward.
const RenameBody = z.object({
  name: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9 _\-]+$/),
});

function buildLibraryItem(meta: LibraryMeta) {
  const sourceAvailable = pickSourcePath(meta) !== null;
  const safePath = safeClipTarget(meta.path);
  const missing = !safePath || !fs.existsSync(safePath);
  return {
    ...meta,
    path: safePath ?? "",
    thumbUrl: `/api/library/${meta.id}/thumb`,
    videoUrl: `/api/library/${meta.id}/video`,
    sourceVideoUrl: sourceAvailable
      ? `/api/library/${meta.id}/source-video`
      : undefined,
    sourceAvailable,
    ...(missing ? { missing: true } : {}),
  };
}

router.post("/library/:id/rename", (req, res) => {
  const oldId = req.params.id;
  const parsed = RenameBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const oldMp = metaPath(oldId);
  if (!fs.existsSync(oldMp)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const meta = readMeta(oldMp);
  if (!meta || !meta.path) {
    res.status(500).json({ error: "could not read meta" });
    return;
  }
  const oldPath = safeExistingFile(config.clipsDir, meta.path);
  if (!oldPath) {
    res.status(404).json({ error: "clip file missing" });
    return;
  }
  const ext = path.extname(oldPath);
  const newAbs = path.join(config.clipsDir, `${parsed.data.name}${ext}`);
  if (path.resolve(newAbs) === path.resolve(oldPath)) {
    // No-op filename, but still update meta.name in case it drifted.
    const updated: LibraryMeta = { ...meta, name: parsed.data.name };
    fs.writeFileSync(oldMp, JSON.stringify(updated, null, 2));
    res.json({ ok: true, item: buildLibraryItem(updated) });
    return;
  }
  if (fs.existsSync(newAbs)) {
    res.status(409).json({ error: "destination already exists" });
    return;
  }
  try {
    fs.renameSync(oldPath, newAbs);
  } catch (err) {
    res.status(500).json({ error: String(err) });
    return;
  }
  const newId = pathToId(newAbs);
  const oldName = meta.name;
  const newName = parsed.data.name;
  const updated: LibraryMeta = {
    ...meta,
    id: newId,
    name: newName,
    filename: path.basename(newAbs),
    path: newAbs,
  };
  // Best-effort: relocate the cached thumb so the next list-fetch doesn't
  // re-generate.
  try {
    const oldThumb = path.join(config.thumbCacheDir, `lib-${oldId}.jpg`);
    const newThumb = path.join(config.thumbCacheDir, `lib-${newId}.jpg`);
    if (fs.existsSync(oldThumb)) fs.renameSync(oldThumb, newThumb);
  } catch {
    // ignore
  }
  try {
    fs.writeFileSync(metaPath(newId), JSON.stringify(updated, null, 2));
    if (newId !== oldId) {
      try {
        fs.unlinkSync(oldMp);
      } catch {
        // ignore
      }
    }
  } catch (err) {
    res.status(500).json({ error: String(err) });
    return;
  }
  scheduleShotlistRebuild();
  appendActivity("clip_renamed", { oldId, newId, oldName, newName });
  res.json({ ok: true, item: buildLibraryItem(updated) });
});

// ---- Send to Premiere ------------------------------------------------------
// macOS-only: launches Adobe Premiere Pro with the given clip files as args.
// Premiere imports them into the active project. The user's focus jumps to
// Premiere — callers should confirm intent first.
const SendToPremiereBody = z.object({
  ids: z.array(z.string().regex(LIBRARY_ID_RE)).min(1).max(500),
});

function resolveLibraryPaths(ids: string[]): { paths: string[]; missing: string[] } {
  const paths: string[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const mp = metaPath(id);
    if (!fs.existsSync(mp)) {
      missing.push(id);
      continue;
    }
    const meta = readMeta(mp);
    const clipPath = meta ? safeExistingFile(config.clipsDir, meta.path) : null;
    if (!clipPath) {
      missing.push(id);
      continue;
    }
    paths.push(clipPath);
  }
  return { paths, missing };
}

router.post("/library/send-to-premiere", (req, res) => {
  if (process.platform !== "darwin") {
    res.status(501).json({ error: "send-to-premiere is macOS-only" });
    return;
  }
  const parsed = SendToPremiereBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { paths, missing } = resolveLibraryPaths(parsed.data.ids);
  if (paths.length === 0) {
    res.status(404).json({ error: "no resolvable clip files", missing });
    return;
  }
  const child = spawn("open", ["-a", "Adobe Premiere Pro", ...paths], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += String(d)));
  child.on("error", (err) => {
    if (!res.headersSent) {
      res.status(500).json({
        error: "Adobe Premiere Pro doesn't appear to be installed",
        code: "premiere-missing",
        details: String(err),
      });
    }
  });
  child.on("close", (code) => {
    if (res.headersSent) return;
    if (code !== 0) {
      res.status(500).json({
        error: "Adobe Premiere Pro doesn't appear to be installed",
        code: "premiere-missing",
        details: stderr.trim() || `open exited ${code}`,
      });
      return;
    }
    appendActivity("clips_sent_to_premiere", {
      count: paths.length,
      ids: parsed.data.ids,
    });
    res.json({ ok: true, count: paths.length, paths, missing });
  });
});

export default router;
