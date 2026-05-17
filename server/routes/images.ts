import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import Busboy from "busboy";
import {
  config,
  isSupportedImage,
  SUPPORTED_IMAGE_EXTS,
} from "../config.js";
import { ffmpeg } from "../ffmpeg.js";
import { pathToId, safeFilename } from "../util/id.js";
import { derivePromptString, readPngInfo } from "../util/pngInfo.js";

const router = Router();

const CATEGORIES = [
  "",
  "storyboard",
  "shot",
  "character-ref",
  "object-ref",
  "background",
] as const;

type Category = (typeof CATEGORIES)[number];

interface NamedRef {
  id: string;
  name: string;
}

interface ImageMeta {
  id: string;
  name: string;
  description: string;
  prompt: string;
  category: Category;
  tags: string[];
  characters: NamedRef[];
  scenes: NamedRef[];
  objects: NamedRef[];
  /** Absolute path on disk. Persisted so we can repair if the dir is renamed. */
  path: string;
  /** mtimeMs at time the prompt was first extracted — for invalidation hooks. */
  promptExtractedAtMtime?: number;
  width?: number;
  height?: number;
  created: number;
  updated: number;
}

interface ListedImage extends ImageMeta {
  filename: string;
  /** POSIX-separated path relative to IMAGES_DIR; "" for the root. */
  folder: string;
  sizeBytes: number;
  mtimeMs: number;
  thumbUrl: string;
  fullUrl: string;
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

// 50 MB per file, 500 MB per request.
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_REQUEST_BYTES = 500 * 1024 * 1024;
// Folder name segment validator — no slashes, no emoji, ASCII-only for v1.
const FOLDER_SEGMENT_RE = /^[A-Za-z0-9 _\-]+$/;

function metaPathFor(id: string): string {
  return path.join(config.imageMetaDir, `${id}.json`);
}

function thumbPathFor(id: string): string {
  return path.join(config.imageThumbsDir, `${id}.jpg`);
}

function readMeta(id: string): ImageMeta | null {
  try {
    const raw = fs.readFileSync(metaPathFor(id), "utf8");
    return JSON.parse(raw) as ImageMeta;
  } catch {
    return null;
  }
}

function writeMeta(meta: ImageMeta) {
  fs.writeFileSync(metaPathFor(meta.id), JSON.stringify(meta, null, 2));
}

function defaultName(file: string): string {
  return path.basename(file, path.extname(file));
}

/** POSIX-separated relative directory under IMAGES_DIR, "" for root. */
function relFolder(absoluteFile: string): string {
  const rel = path.relative(config.imagesDir, path.dirname(absoluteFile));
  if (!rel || rel === ".") return "";
  return rel.split(path.sep).join("/");
}

/**
 * Resolve a user-supplied relative folder path to an absolute path inside
 * IMAGES_DIR. Throws on traversal, absolute paths, or invalid segments.
 */
function resolveFolder(rawRelPath: string): string {
  const cleaned = (rawRelPath ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!cleaned) return config.imagesDir;
  // Disallow Windows-drive prefixes and absolute Unix paths.
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
  const abs = path.resolve(config.imagesDir, parts.join(path.sep));
  // Defensive: make sure resolved path stays inside IMAGES_DIR.
  const rootWithSep = config.imagesDir.endsWith(path.sep)
    ? config.imagesDir
    : config.imagesDir + path.sep;
  if (abs !== config.imagesDir && !abs.startsWith(rootWithSep)) {
    throw new Error("path escapes images directory");
  }
  return abs;
}

/** Recursive directory walk for images. Skips dotfiles and obvious junk. */
function walkImages(root: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(root)) return out;
  const stack: string[] = [root];
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
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile() && isSupportedImage(e.name)) {
        out.push(full);
      }
    }
  }
  out.sort();
  return out;
}

/** Recursive folder listing — relative POSIX paths, alphabetically sorted. */
function listFolders(root: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(root)) return out;
  const stack: { abs: string; rel: string }[] = [{ abs: root, rel: "" }];
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
      const rel = cur.rel ? `${cur.rel}/${e.name}` : e.name;
      out.push(rel);
      stack.push({ abs: path.join(cur.abs, e.name), rel });
    }
  }
  out.sort();
  return out;
}

async function pLimitAll<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }
  );
  await Promise.all(workers);
  return out;
}

/**
 * Build (or load) a sidecar for `file`. On first sight, runs the PNG metadata
 * reader and persists the derived prompt so we never re-extract for the same
 * file. Sidecar name uses `pathToId(absolutePath)` — same hashing convention
 * the rest of the app uses.
 */
function ensureMeta(file: string, mtimeMs: number): ImageMeta {
  const id = pathToId(file);
  const existing = readMeta(id);
  if (existing) {
    if (existing.path !== file) {
      const updated: ImageMeta = { ...existing, path: file };
      writeMeta(updated);
      return updated;
    }
    return existing;
  }
  let prompt = "";
  let width: number | undefined;
  let height: number | undefined;
  if (path.extname(file).toLowerCase() === ".png") {
    const info = readPngInfo(file);
    prompt = derivePromptString(info.text);
    width = info.width;
    height = info.height;
  }
  const now = Date.now();
  const meta: ImageMeta = {
    id,
    name: defaultName(file),
    description: "",
    prompt,
    category: "",
    tags: [],
    characters: [],
    scenes: [],
    objects: [],
    path: file,
    promptExtractedAtMtime: mtimeMs,
    width,
    height,
    created: now,
    updated: now,
  };
  writeMeta(meta);
  return meta;
}

function listedFor(meta: ImageMeta, stat: fs.Stats): ListedImage {
  return {
    ...meta,
    filename: path.basename(meta.path),
    folder: relFolder(meta.path),
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    thumbUrl: `/api/images/thumb/${meta.id}`,
    fullUrl: `/api/images/full/${meta.id}`,
  };
}

router.get("/images", async (_req, res) => {
  const root = config.imagesDir;
  const files = walkImages(root);
  const items = await pLimitAll(files, 6, async (file) => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return null;
    }
    const meta = ensureMeta(file, stat.mtimeMs);
    return listedFor(meta, stat);
  });
  const out = items.filter((x): x is ListedImage => x !== null);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  res.json({ items: out, imagesDir: root });
});

// ---- Folder management ----------------------------------------------------

router.get("/images/folders", (_req, res) => {
  res.json({ folders: listFolders(config.imagesDir) });
});

const FolderBodySchema = z.object({ path: z.string().min(0) });

router.post("/images/folders", (req, res) => {
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
      .json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (abs === config.imagesDir) {
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
      .relative(config.imagesDir, abs)
      .split(path.sep)
      .join("/"),
  });
});

router.delete("/images/folders", (req, res) => {
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
      .json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (abs === config.imagesDir) {
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
      // Tolerate macOS .DS_Store as "still empty".
      .filter((n) => !n.startsWith("."));
  } catch (err) {
    res.status(500).json({ error: String(err) });
    return;
  }
  if (entries.length > 0) {
    res
      .status(409)
      .json({
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

// ---- Upload (multipart) ---------------------------------------------------

/**
 * Append `-2`, `-3`, … before the extension until the destination path is free.
 * Mirrors macOS Finder's "filename 2.ext" pattern but uses a hyphen so the
 * sidecar id can stay alphanumeric-ish.
 */
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

async function generateThumbBestEffort(meta: ImageMeta) {
  try {
    const cachePath = thumbPathFor(meta.id);
    const r = await ffmpeg([
      "-i",
      meta.path,
      "-frames:v",
      "1",
      "-vf",
      "scale=320:-2",
      "-q:v",
      "4",
      cachePath,
    ]);
    if (r.code !== 0) {
      // Best-effort: caller can still hit /thumb later which retries on demand.
    }
  } catch {
    // ignore
  }
}

router.post("/images/upload", (req, res) => {
  let bb: ReturnType<typeof Busboy>;
  try {
    bb = Busboy({
      headers: req.headers,
      limits: {
        fileSize: MAX_FILE_BYTES,
        // Defensive total cap. Busboy doesn't enforce a cumulative byte
        // budget; we track it manually below as well.
        files: 200,
      },
    });
  } catch (err) {
    res
      .status(400)
      .json({ error: `multipart parse failed: ${String(err)}` });
    return;
  }

  let folderRel = "";
  let totalBytes = 0;
  let aborted = false;
  const written: { abs: string; originalName: string }[] = [];
  const rejected: { name: string; reason: string }[] = [];
  const writePromises: Promise<void>[] = [];

  function abort(status: number, message: string) {
    if (aborted) return;
    aborted = true;
    // Best-effort: clean up any files already on disk so a partial upload
    // doesn't leak orphans into the user's images/ folder.
    for (const w of written) {
      try {
        fs.unlinkSync(w.abs);
      } catch {
        // ignore
      }
    }
    if (!res.headersSent) {
      res.status(status).json({ error: message });
    }
    try {
      req.unpipe(bb);
    } catch {
      // ignore
    }
  }

  bb.on("field", (name, value) => {
    if (name === "folder") folderRel = value;
  });

  bb.on("file", (fieldName, fileStream, info) => {
    if (aborted) {
      fileStream.resume();
      return;
    }
    if (fieldName !== "files") {
      fileStream.resume();
      return;
    }
    const original = info.filename || "upload";
    const ext = path.extname(original).toLowerCase();
    if (!SUPPORTED_IMAGE_EXTS.has(ext)) {
      rejected.push({
        name: original,
        reason: `unsupported extension "${ext || "(none)"}"`,
      });
      fileStream.resume();
      return;
    }

    let folderAbs: string;
    try {
      folderAbs = resolveFolder(folderRel);
    } catch (err) {
      abort(400, err instanceof Error ? err.message : String(err));
      fileStream.resume();
      return;
    }
    try {
      fs.mkdirSync(folderAbs, { recursive: true });
    } catch (err) {
      abort(500, `mkdir failed: ${String(err)}`);
      fileStream.resume();
      return;
    }

    const safe = safeFilename(path.basename(original, ext)) + ext;
    const destAbs = uniqueDestPath(folderAbs, safe);
    const tmpAbs = destAbs + ".part";
    const out = fs.createWriteStream(tmpAbs);
    let fileBytes = 0;
    let truncated = false;

    fileStream.on("data", (chunk: Buffer) => {
      if (aborted) return;
      fileBytes += chunk.length;
      totalBytes += chunk.length;
      if (totalBytes > MAX_REQUEST_BYTES) {
        abort(413, `request exceeded ${MAX_REQUEST_BYTES} bytes total`);
      }
    });
    // Busboy's per-file truncation event.
    fileStream.on("limit", () => {
      truncated = true;
      abort(413, `file "${original}" exceeded ${MAX_FILE_BYTES} bytes`);
    });

    const p = new Promise<void>((resolve) => {
      out.on("error", () => {
        rejected.push({ name: original, reason: "disk write failed" });
        try {
          fs.unlinkSync(tmpAbs);
        } catch {
          // ignore
        }
        resolve();
      });
      out.on("finish", () => {
        if (aborted || truncated) {
          try {
            fs.unlinkSync(tmpAbs);
          } catch {
            // ignore
          }
          resolve();
          return;
        }
        try {
          fs.renameSync(tmpAbs, destAbs);
          written.push({ abs: destAbs, originalName: original });
        } catch (err) {
          rejected.push({
            name: original,
            reason: `rename failed: ${String(err)}`,
          });
          try {
            fs.unlinkSync(tmpAbs);
          } catch {
            // ignore
          }
        }
        resolve();
      });
    });
    writePromises.push(p);
    fileStream.pipe(out);
  });

  bb.on("error", (err: unknown) => {
    abort(400, `upload error: ${String(err)}`);
  });

  bb.on("close", async () => {
    await Promise.all(writePromises);
    if (aborted) return;
    // Build sidecars + thumbs for everything that landed.
    const items: ListedImage[] = [];
    for (const w of written) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(w.abs);
      } catch {
        continue;
      }
      const meta = ensureMeta(w.abs, stat.mtimeMs);
      // Eager thumb so the grid renders without a flash of placeholder.
      await generateThumbBestEffort(meta);
      items.push(listedFor(meta, stat));
    }
    if (items.length === 0 && rejected.length > 0) {
      res
        .status(400)
        .json({ error: "no valid image files in upload", rejected, items: [] });
      return;
    }
    res.json({ items, rejected });
  });

  req.pipe(bb);
});

// ---- Move -----------------------------------------------------------------

const MoveBodySchema = z.object({ folder: z.string().min(0) });

function moveOne(meta: ImageMeta, folderAbs: string): ListedImage {
  if (!fs.existsSync(meta.path)) {
    throw new Error("source file no longer on disk");
  }
  fs.mkdirSync(folderAbs, { recursive: true });
  const destAbs = uniqueDestPath(folderAbs, path.basename(meta.path));
  if (path.resolve(destAbs) === path.resolve(meta.path)) {
    // No-op: file is already in the target folder under the same name.
    const stat = fs.statSync(meta.path);
    return listedFor(meta, stat);
  }
  fs.renameSync(meta.path, destAbs);
  // Re-id under the new path.
  const newId = pathToId(destAbs);
  const oldId = meta.id;
  // Best-effort: relocate the cached thumb so the user doesn't see a flash.
  try {
    const oldThumb = thumbPathFor(oldId);
    if (fs.existsSync(oldThumb)) {
      fs.renameSync(oldThumb, thumbPathFor(newId));
    }
  } catch {
    // ignore
  }
  // Remove old sidecar; write new one.
  try {
    fs.unlinkSync(metaPathFor(oldId));
  } catch {
    // ignore
  }
  const updated: ImageMeta = {
    ...meta,
    id: newId,
    path: destAbs,
    updated: Date.now(),
  };
  writeMeta(updated);
  const stat = fs.statSync(destAbs);
  return listedFor(updated, stat);
}

router.post("/images/move", (req, res) => {
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
      .json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const items: ListedImage[] = [];
  const errors: { id: string; error: string }[] = [];
  for (const id of parsed.data.ids) {
    const meta = readMeta(id);
    if (!meta) {
      errors.push({ id, error: "not found" });
      continue;
    }
    try {
      items.push(moveOne(meta, folderAbs));
    } catch (err) {
      errors.push({
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  res.json({ items, errors });
});

router.post("/images/:id/move", (req, res) => {
  const parsed = MoveBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const meta = readMeta(req.params.id);
  if (!meta) {
    res.status(404).json({ error: "not found" });
    return;
  }
  let folderAbs: string;
  try {
    folderAbs = resolveFolder(parsed.data.folder);
  } catch (err) {
    res
      .status(400)
      .json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  try {
    const item = moveOne(meta, folderAbs);
    res.json(item);
  } catch (err) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- Thumb / full / patch (unchanged from v1) -----------------------------

router.get("/images/thumb/:id", async (req, res) => {
  const meta = readMeta(req.params.id);
  if (!meta || !meta.path || !fs.existsSync(meta.path)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  let srcStat: fs.Stats;
  try {
    srcStat = fs.statSync(meta.path);
  } catch {
    res.status(404).json({ error: "not found" });
    return;
  }
  const cachePath = thumbPathFor(req.params.id);
  let cached = false;
  try {
    const cs = fs.statSync(cachePath);
    cached = cs.mtimeMs >= srcStat.mtimeMs;
  } catch {
    cached = false;
  }
  if (!cached) {
    try {
      const r = await ffmpeg([
        "-i",
        meta.path,
        "-frames:v",
        "1",
        "-vf",
        "scale=320:-2",
        "-q:v",
        "4",
        cachePath,
      ]);
      if (r.code !== 0) {
        res.status(500).json({ error: r.stderr || "thumb generation failed" });
        return;
      }
    } catch (err) {
      res.status(500).json({ error: String(err) });
      return;
    }
  }
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.sendFile(cachePath);
});

router.get("/images/full/:id", (req, res) => {
  const meta = readMeta(req.params.id);
  if (!meta || !meta.path || !fs.existsSync(meta.path)) {
    res.status(404).end("not found");
    return;
  }
  const ext = path.extname(meta.path).toLowerCase();
  const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
  res.setHeader("Content-Type", mime);
  res.setHeader("Cache-Control", "public, max-age=3600");
  fs.createReadStream(meta.path).pipe(res);
});

const PatchSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  prompt: z.string().optional(),
  category: z.enum(CATEGORIES).optional(),
  tags: z.array(z.string()).optional(),
  characters: z
    .array(z.object({ id: z.string(), name: z.string() }))
    .optional(),
  scenes: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
  objects: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
});

router.patch("/images/:id", (req, res) => {
  const meta = readMeta(req.params.id);
  if (!meta) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const parsed = PatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const updated: ImageMeta = {
    ...meta,
    ...parsed.data,
    updated: Date.now(),
  };
  writeMeta(updated);
  res.json(updated);
});

export { CATEGORIES, SUPPORTED_IMAGE_EXTS };
export default router;
