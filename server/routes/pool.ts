import { Router } from "express";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  config,
  isSupportedVideo,
  POOL_CACHE_DIR,
  RESERVED_PROJECT_DIRS,
} from "../config.js";
import { extractFrameJpeg, getDuration } from "../ffmpeg.js";
import { pathToId } from "../util/id.js";
import { loadAllDrafts } from "./drafts.js";
import { appendActivity } from "../util/activity.js";

export interface PoolItem {
  id: string;
  filename: string;
  path: string;
  /** POSIX-separated rel path under PROJECT_DIR; "" for root. */
  folder: string;
  size: number;
  mtime: number;
  duration: number;
  thumbUrl: string;
  clipCount: number;
}

const idToPath = new Map<string, string>();

export function resolvePoolId(id: string): string | null {
  const p = idToPath.get(id);
  if (p && fs.existsSync(p)) return p;
  return null;
}

// Folder name segment validator — mirrors images.ts.
const FOLDER_SEGMENT_RE = /^[A-Za-z0-9 _\-]+$/;

/**
 * POSIX-separated relative directory under poolDir for an absolute video path,
 * or "" when the file lives at the project root.
 */
function relFolder(absoluteFile: string): string {
  const rel = path.relative(config.poolDir, path.dirname(absoluteFile));
  if (!rel || rel === ".") return "";
  return rel.split(path.sep).join("/");
}

/**
 * Resolve a user-supplied relative folder path to an absolute path under
 * PROJECT_DIR. Throws on traversal, absolute paths, or invalid segments.
 * Refuses to resolve to a reserved subdir (clips/, images/, etc.).
 */
function resolveFolder(rawRelPath: string): string {
  const cleaned = (rawRelPath ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!cleaned) return config.poolDir;
  if (path.isAbsolute(cleaned) || /^[A-Za-z]:/.test(cleaned)) {
    throw new Error("absolute paths are not allowed");
  }
  const parts = cleaned.split("/");
  for (const seg of parts) {
    if (!seg || seg === "." || seg === "..") {
      throw new Error("invalid folder segment");
    }
    if (!FOLDER_SEGMENT_RE.test(seg)) {
      throw new Error(
        `invalid folder name "${seg}" — use letters, numbers, spaces, _ or -`
      );
    }
  }
  if (RESERVED_PROJECT_DIRS.has(parts[0])) {
    throw new Error(`"${parts[0]}" is reserved for app use`);
  }
  const abs = path.resolve(config.poolDir, parts.join(path.sep));
  const rootWithSep = config.poolDir.endsWith(path.sep)
    ? config.poolDir
    : config.poolDir + path.sep;
  if (abs !== config.poolDir && !abs.startsWith(rootWithSep)) {
    throw new Error("path escapes project directory");
  }
  return abs;
}

/**
 * Recursive walk of PROJECT_DIR for video files. Skips RESERVED_PROJECT_DIRS
 * at any depth and any directory whose name starts with ".".
 */
function walkPoolFiles(): string[] {
  const out: string[] = [];
  if (!fs.existsSync(config.poolDir)) return out;
  const stack: string[] = [config.poolDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      // Reserved dirs only matter at the project root — nested folders called
      // "clips" inside a user folder are user content.
      if (
        e.isDirectory() &&
        dir === config.poolDir &&
        RESERVED_PROJECT_DIRS.has(e.name)
      ) {
        continue;
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile() && isSupportedVideo(e.name)) {
        out.push(full);
      }
    }
  }
  out.sort();
  return out;
}

/** Recursive folder listing under poolDir. POSIX rel paths, sorted. */
function listFolders(): string[] {
  const out: string[] = [];
  if (!fs.existsSync(config.poolDir)) return out;
  const stack: { abs: string; rel: string }[] = [
    { abs: config.poolDir, rel: "" },
  ];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".")) continue;
      if (cur.abs === config.poolDir && RESERVED_PROJECT_DIRS.has(e.name)) {
        continue;
      }
      const rel = cur.rel ? `${cur.rel}/${e.name}` : e.name;
      out.push(rel);
      stack.push({ abs: path.join(cur.abs, e.name), rel });
    }
  }
  out.sort();
  return out;
}

const DURATIONS_PATH = config.durationsPath;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface DurationEntry {
  duration: number;
  size: number;
  mtime: number;
}

function loadDurationCache(): Record<string, DurationEntry> {
  try {
    return JSON.parse(fs.readFileSync(DURATIONS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveDurationCache(cache: Record<string, DurationEntry>) {
  try {
    fs.writeFileSync(DURATIONS_PATH, JSON.stringify(cache));
  } catch {
    // ignore
  }
}

async function pLimitAll<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

const router = Router();

function countClipsBySourceId(): Map<string, number> {
  const out = new Map<string, number>();
  if (!fs.existsSync(config.clipMetaDir)) return out;
  for (const name of fs.readdirSync(config.clipMetaDir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const meta = JSON.parse(
        fs.readFileSync(path.join(config.clipMetaDir, name), "utf8")
      ) as { sourceId?: string };
      if (meta.sourceId) {
        out.set(meta.sourceId, (out.get(meta.sourceId) ?? 0) + 1);
      }
    } catch {
      // skip
    }
  }
  return out;
}

router.get("/pool", (_req, res) => {
  const files = walkPoolFiles();
  const cache = loadDurationCache();
  const clipCounts = countClipsBySourceId();

  const items: PoolItem[] = files.map((file) => {
    const id = pathToId(file);
    idToPath.set(id, file);
    const stat = fs.statSync(file);
    const cached = cache[id];
    const duration =
      cached && cached.size === stat.size && cached.mtime === stat.mtimeMs
        ? cached.duration
        : 0;
    return {
      id,
      filename: path.basename(file),
      path: file,
      folder: relFolder(file),
      size: stat.size,
      mtime: stat.mtimeMs,
      duration,
      thumbUrl: `/api/thumb/${id}?t=1`,
      clipCount: clipCounts.get(id) ?? 0,
    };
  });

  res.json({ items, poolDir: config.poolDir });

  warmDurationsAsync(items, cache).catch(() => {});
});

let warmInFlight = false;
async function warmDurationsAsync(
  items: PoolItem[],
  cache: Record<string, DurationEntry>
) {
  if (warmInFlight) return;
  warmInFlight = true;
  try {
    const stale = items.filter((it) => !it.duration);
    if (stale.length === 0) return;
    let changed = false;
    await pLimitAll(stale, 4, async (it) => {
      try {
        const d = await getDuration(it.path);
        cache[it.id] = { duration: d, size: it.size, mtime: it.mtime };
        changed = true;
      } catch {
        // ignore
      }
    });
    if (changed) saveDurationCache(cache);
  } finally {
    warmInFlight = false;
  }
}

// ---- Folder management ----------------------------------------------------

router.get("/pool/folders", (_req, res) => {
  res.json({ folders: listFolders() });
});

const FolderBodySchema = z.object({ path: z.string().min(0) });

router.post("/pool/folders", (req, res) => {
  const parsed = FolderBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  let abs: string;
  try {
    abs = resolveFolder(parsed.data.path);
  } catch (err) {
    res
      .status(400)
      .json({ error: errorMessage(err) });
    return;
  }
  if (abs === config.poolDir) {
    res.status(400).json({ error: "cannot create root folder" });
    return;
  }
  try {
    fs.mkdirSync(abs, { recursive: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
    return;
  }
  res.json({
    ok: true,
    folder: path
      .relative(config.poolDir, abs)
      .split(path.sep)
      .join("/"),
  });
});

router.delete("/pool/folders", (req, res) => {
  const parsed = FolderBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  let abs: string;
  try {
    abs = resolveFolder(parsed.data.path);
  } catch (err) {
    res
      .status(400)
      .json({ error: errorMessage(err) });
    return;
  }
  if (abs === config.poolDir) {
    res.status(400).json({ error: "cannot delete root folder" });
    return;
  }
  if (!fs.existsSync(abs)) {
    res.status(404).json({ error: "folder not found" });
    return;
  }
  let entries: string[];
  try {
    entries = fs
      .readdirSync(abs)
      .filter((n) => !n.startsWith("."));
  } catch (err) {
    res.status(500).json({ error: String(err) });
    return;
  }
  if (entries.length > 0) {
    res.status(409).json({
      error: `folder is not empty (${entries.length} item${entries.length === 1 ? "" : "s"} inside) — move or delete its contents first`,
    });
    return;
  }
  try {
    fs.rmdirSync(abs);
  } catch (err) {
    res.status(500).json({ error: String(err) });
    return;
  }
  res.json({ ok: true });
});

/**
 * One-shot batch index of every source's clip ranges + merged-coverage seconds.
 * Used by the Pool grid so 72 cards can render the yellow coverage strip with a
 * single fetch instead of one-per-card. Reads all sidecars on each call (still
 * cheap — a few hundred small JSON files) so the response is always fresh.
 *
 * NOTE: Must be registered BEFORE the `/pool/:id/clips` route below or Express
 * will treat "clips-summary" as an `:id` param and call the per-source handler.
 */
router.get("/pool/clips-summary", (_req, res) => {
  const dir = config.clipMetaDir;
  type Range = { id: string; in: number; out: number; name: string };
  const bySource = new Map<string, Range[]>();
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const meta = JSON.parse(
          fs.readFileSync(path.join(dir, name), "utf8")
        ) as {
          id: string;
          name: string;
          sourceId?: string;
          in?: number;
          out?: number;
          path?: string;
          exportMode?: string;
        };
        if (!meta.sourceId) continue;
        if (meta.exportMode === "source") continue;
        if (meta.in == null || meta.out == null) continue;
        if (meta.path && !fs.existsSync(meta.path)) continue;
        const arr = bySource.get(meta.sourceId) ?? [];
        arr.push({ id: meta.id, name: meta.name, in: meta.in, out: meta.out });
        bySource.set(meta.sourceId, arr);
      } catch {
        // skip malformed
      }
    }
  }
  const drafts = loadAllDrafts();
  const out: Record<
    string,
    {
      clips: Range[];
      coveredSec: number;
      draft?: { in: number; out: number; updatedAt: number };
    }
  > = {};
  const sourceIds = new Set<string>([...bySource.keys(), ...Object.keys(drafts)]);
  for (const sid of sourceIds) {
    const arr = bySource.get(sid) ?? [];
    arr.sort((a, b) => a.in - b.in);
    let covered = 0;
    let curIn = -1;
    let curOut = -1;
    for (const r of arr) {
      if (r.out <= r.in) continue;
      if (curIn < 0) {
        curIn = r.in;
        curOut = r.out;
        continue;
      }
      if (r.in <= curOut) {
        curOut = Math.max(curOut, r.out);
      } else {
        covered += curOut - curIn;
        curIn = r.in;
        curOut = r.out;
      }
    }
    if (curIn >= 0) covered += curOut - curIn;
    const entry: {
      clips: Range[];
      coveredSec: number;
      draft?: { in: number; out: number; updatedAt: number };
    } = { clips: arr, coveredSec: Number(covered.toFixed(3)) };
    const d = drafts[sid];
    if (d) {
      entry.draft = { in: d.in, out: d.out, updatedAt: d.updatedAt };
    }
    out[sid] = entry;
  }
  res.json(out);
});

/**
 * Lightweight per-source clip index used by the editor timeline to render
 * "already-clipped" bands over the current source. Reads sidecars directly
 * each call — cheap (a dozen JSON files) and always fresh after a re-export.
 */
router.get("/pool/:id/clips", (req, res) => {
  const sourceId = req.params.id;
  const dir = config.clipMetaDir;
  const items: { id: string; name: string; in: number; out: number; duration: number }[] = [];
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const meta = JSON.parse(
          fs.readFileSync(path.join(dir, name), "utf8")
        ) as {
          id: string;
          name: string;
          sourceId?: string;
          in?: number;
          out?: number;
          duration?: number;
          path?: string;
          exportMode?: string;
        };
        if (meta.sourceId !== sourceId) continue;
        if (meta.exportMode === "source") continue;
        if (meta.in == null || meta.out == null) continue;
        if (meta.path && !fs.existsSync(meta.path)) continue;
        items.push({
          id: meta.id,
          name: meta.name,
          in: meta.in,
          out: meta.out,
          duration: meta.duration ?? meta.out - meta.in,
        });
      } catch {
        // skip malformed
      }
    }
  }
  items.sort((a, b) => a.in - b.in);
  res.json({ items });
});

router.get("/pool/duration/:id", async (req, res) => {
  const file = resolvePoolId(req.params.id);
  if (!file) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const stat = fs.statSync(file);
  const cache = loadDurationCache();
  const cached = cache[req.params.id];
  if (cached && cached.size === stat.size && cached.mtime === stat.mtimeMs) {
    res.json({ duration: cached.duration });
    return;
  }
  try {
    const d = await getDuration(file);
    cache[req.params.id] = { duration: d, size: stat.size, mtime: stat.mtimeMs };
    saveDurationCache(cache);
    res.json({ duration: d });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get("/thumb/:id", async (req, res) => {
  const file = resolvePoolId(req.params.id);
  if (!file) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const t = Number(req.query.t ?? 1);
  const w = Number(req.query.w ?? 320);
  const cacheKey = `pool-${req.params.id}_${t.toFixed(2)}_${w}.jpg`;
  const cachePath = path.join(POOL_CACHE_DIR, cacheKey);
  if (!fs.existsSync(cachePath)) {
    try {
      await extractFrameJpeg(file, t, cachePath, w);
    } catch (err) {
      res.status(500).json({ error: String(err) });
      return;
    }
  }
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.sendFile(cachePath);
});

// ---- Move -----------------------------------------------------------------

interface MoveResult {
  oldId: string;
  newId: string;
  oldPath: string;
  newPath: string;
  folder: string;
  filename: string;
  sidecarsUpdated: number;
  draftsRekeyed: number;
}

/** Append `-2`, `-3`, … before the extension until the dest path is free. */
function uniqueDestPath(folderAbs: string, basename: string): string {
  const ext = path.extname(basename);
  const stem = path.basename(basename, ext);
  let candidate = path.join(folderAbs, `${stem}${ext}`);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(folderAbs, `${stem}-${n}${ext}`);
    n += 1;
  }
  return candidate;
}

/**
 * Rewrite every clip-meta sidecar that referenced `oldId` so it points at
 * the new id + path. Returns how many sidecars were touched.
 */
function rewriteClipSidecars(
  oldId: string,
  newId: string,
  newPath: string,
  newFilename: string
): number {
  const dir = config.clipMetaDir;
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const p = path.join(dir, name);
    let raw: string;
    try {
      raw = fs.readFileSync(p, "utf8");
    } catch {
      continue;
    }
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(raw);
    } catch {
      continue;
    }
    if (meta.sourceId !== oldId) continue;
    meta.sourceId = newId;
    meta.sourcePath = newPath;
    meta.source = newFilename;
    try {
      fs.writeFileSync(p, JSON.stringify(meta, null, 2));
      n += 1;
    } catch {
      // best-effort; skip
    }
  }
  return n;
}

/**
 * Re-key any draft persisted under `oldId` to live under `newId`. Returns
 * the number of drafts moved (0 or 1 in practice).
 */
function rekeyDrafts(oldId: string, newId: string): number {
  const draftsPath = path.join(config.internalDir, "drafts.json");
  if (!fs.existsSync(draftsPath)) return 0;
  let map: Record<string, unknown>;
  try {
    map = JSON.parse(fs.readFileSync(draftsPath, "utf8"));
  } catch {
    return 0;
  }
  if (!map || typeof map !== "object") return 0;
  if (!(oldId in map)) return 0;
  map[newId] = map[oldId];
  delete map[oldId];
  try {
    fs.writeFileSync(draftsPath, JSON.stringify(map, null, 2));
    return 1;
  } catch {
    return 0;
  }
}

/** Re-key the durations cache on move so we don't re-probe after rename. */
function rekeyDurationCache(oldId: string, newId: string) {
  const cache = loadDurationCache();
  if (!(oldId in cache)) return;
  cache[newId] = cache[oldId];
  delete cache[oldId];
  saveDurationCache(cache);
}

/**
 * Re-key any source-meta sidecar (AI tagging) on move so the next analyze
 * pass doesn't re-burn the OpenAI call.
 */
function rekeySourceMetaSidecar(oldId: string, newId: string) {
  const dir = path.join(config.internalDir, "source-meta");
  if (!fs.existsSync(dir)) return;
  const oldP = path.join(dir, `${oldId}.json`);
  const newP = path.join(dir, `${newId}.json`);
  if (!fs.existsSync(oldP)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(oldP, "utf8")) as Record<
      string,
      unknown
    >;
    raw.id = newId;
    fs.writeFileSync(newP, JSON.stringify(raw, null, 2));
    fs.unlinkSync(oldP);
  } catch {
    // ignore
  }
}

function moveSourceFile(absSrc: string, folderAbs: string): MoveResult {
  if (!fs.existsSync(absSrc)) {
    throw new Error("source file no longer on disk");
  }
  fs.mkdirSync(folderAbs, { recursive: true });
  const filename = path.basename(absSrc);
  const destAbs = uniqueDestPath(folderAbs, filename);
  if (path.resolve(destAbs) === path.resolve(absSrc)) {
    // No-op: file already lives in the target folder under the same name.
    const oldId = pathToId(absSrc);
    return {
      oldId,
      newId: oldId,
      oldPath: absSrc,
      newPath: absSrc,
      folder: relFolder(absSrc),
      filename,
      sidecarsUpdated: 0,
      draftsRekeyed: 0,
    };
  }

  const oldId = pathToId(absSrc);
  fs.renameSync(absSrc, destAbs);
  const newId = pathToId(destAbs);
  const newFilename = path.basename(destAbs);

  let sidecarsUpdated = 0;
  let draftsRekeyed = 0;
  try {
    sidecarsUpdated = rewriteClipSidecars(oldId, newId, destAbs, newFilename);
    draftsRekeyed = rekeyDrafts(oldId, newId);
    rekeyDurationCache(oldId, newId);
    rekeySourceMetaSidecar(oldId, newId);
  } catch (err) {
    // Bookkeeping failed — try to undo the rename so the user isn't left in a
    // half-moved state where Library shows missing-source warnings.
    try {
      fs.renameSync(destAbs, absSrc);
    } catch {
      // ignore — at this point user has to recover manually
    }
    throw err instanceof Error ? err : new Error(String(err));
  }

  // Refresh the in-memory id→path map so subsequent /thumb/:id and
  // /pool/duration/:id requests for the new id resolve immediately, without
  // waiting for the next /api/pool fetch.
  idToPath.delete(oldId);
  idToPath.set(newId, destAbs);

  return {
    oldId,
    newId,
    oldPath: absSrc,
    newPath: destAbs,
    folder: relFolder(destAbs),
    filename: newFilename,
    sidecarsUpdated,
    draftsRekeyed,
  };
}

router.post("/pool/move", (req, res) => {
  const Schema = z.object({
    ids: z.array(z.string().min(1)).min(1),
    folder: z.string().min(0),
  });
  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  let folderAbs: string;
  try {
    folderAbs = resolveFolder(parsed.data.folder);
  } catch (err) {
    res
      .status(400)
      .json({ error: errorMessage(err) });
    return;
  }
  const items: MoveResult[] = [];
  const errors: { id: string; error: string }[] = [];
  for (const id of parsed.data.ids) {
    const file = resolvePoolId(id);
    if (!file) {
      errors.push({ id, error: "not found" });
      continue;
    }
    try {
      const r = moveSourceFile(file, folderAbs);
      items.push(r);
      appendActivity("pool_source_moved", {
        id: r.newId,
        oldId: r.oldId,
        filename: r.filename,
        folder: r.folder,
        sidecarsUpdated: r.sidecarsUpdated,
        draftsRekeyed: r.draftsRekeyed,
      });
    } catch (err) {
      errors.push({
        id,
        error: errorMessage(err),
      });
    }
  }
  res.json({ items, errors });
});

router.post("/pool/:id/move", (req, res) => {
  const Schema = z.object({ folder: z.string().min(0) });
  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const file = resolvePoolId(req.params.id);
  if (!file) {
    res.status(404).json({ error: "not found" });
    return;
  }
  let folderAbs: string;
  try {
    folderAbs = resolveFolder(parsed.data.folder);
  } catch (err) {
    res
      .status(400)
      .json({ error: errorMessage(err) });
    return;
  }
  try {
    const r = moveSourceFile(file, folderAbs);
    appendActivity("pool_source_moved", {
      id: r.newId,
      oldId: r.oldId,
      filename: r.filename,
      folder: r.folder,
      sidecarsUpdated: r.sidecarsUpdated,
      draftsRekeyed: r.draftsRekeyed,
    });
    res.json(r);
  } catch (err) {
    res
      .status(500)
      .json({ error: errorMessage(err) });
  }
});

// ---- Reveal in Finder (folder) -------------------------------------------

router.post("/pool/reveal", (req, res) => {
  const Schema = z.object({ folder: z.string().optional() });
  const parsed = Schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  let abs: string;
  try {
    abs = resolveFolder(parsed.data.folder ?? "");
  } catch (err) {
    res
      .status(400)
      .json({ error: errorMessage(err) });
    return;
  }
  if (!fs.existsSync(abs)) {
    res.status(404).json({ error: "folder not found" });
    return;
  }
  try {
    const child = spawn("open", [abs], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // ignore — best-effort reveal
  }
  res.json({ ok: true, path: abs });
});

export default router;
