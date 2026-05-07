import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  config,
  isSupportedVideo,
  LIBRARY_CACHE_DIR,
  LIBRARY_META_DIR,
} from "../config.js";
import { extractFrameJpeg, getDuration } from "../ffmpeg.js";

const router = Router();

interface LibraryMeta {
  id: string;
  name: string;
  description: string;
  tags: string[];
  filename: string;
  path: string;
  source?: string;
  sourcePath?: string;
  sourceId?: string;
  in?: number;
  out?: number;
  duration?: number;
  mode?: string;
  details?: string;
  created: number;
}

function readMeta(metaPath: string): LibraryMeta | null {
  try {
    const data = JSON.parse(fs.readFileSync(metaPath, "utf8")) as LibraryMeta;
    return data;
  } catch {
    return null;
  }
}

function listMetas(): LibraryMeta[] {
  if (!fs.existsSync(LIBRARY_META_DIR)) return [];
  const items: LibraryMeta[] = [];
  for (const name of fs.readdirSync(LIBRARY_META_DIR)) {
    if (!name.endsWith(".json")) continue;
    const m = readMeta(path.join(LIBRARY_META_DIR, name));
    if (m && fs.existsSync(m.path)) items.push(m);
  }
  items.sort((a, b) => b.created - a.created);
  return items;
}

const idToFile = new Map<string, string>();

function refreshIndex() {
  idToFile.clear();
  for (const m of listMetas()) {
    idToFile.set(m.id, m.path);
  }
}

router.get("/library", async (_req, res) => {
  const metas = listMetas();
  refreshIndex();
  const items = metas.map((m) => ({
    ...m,
    thumbUrl: `/api/library/${m.id}/thumb`,
    videoUrl: `/api/library/${m.id}/video`,
  }));
  res.json({ items, libraryDir: config.libraryDir });
});

router.patch("/library/:id", (req, res) => {
  const metaPath = path.join(LIBRARY_META_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(metaPath)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const Schema = z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
  });
  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const meta = readMeta(metaPath);
  if (!meta) {
    res.status(500).json({ error: "could not read meta" });
    return;
  }
  const updated: LibraryMeta = { ...meta, ...parsed.data };
  fs.writeFileSync(metaPath, JSON.stringify(updated, null, 2));
  res.json(updated);
});

router.delete("/library/:id", (req, res) => {
  const metaPath = path.join(LIBRARY_META_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(metaPath)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const meta = readMeta(metaPath);
  if (!meta) {
    res.status(500).json({ error: "could not read meta" });
    return;
  }
  try {
    if (fs.existsSync(meta.path)) fs.unlinkSync(meta.path);
  } catch {
    // ignore
  }
  fs.unlinkSync(metaPath);
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
  const cachePath = path.join(LIBRARY_CACHE_DIR, `${req.params.id}.jpg`);
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

router.get("/library/:id/video", (req, res) => {
  refreshIndex();
  const file = idToFile.get(req.params.id);
  if (!file || !fs.existsSync(file)) {
    res.status(404).end("not found");
    return;
  }
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
});

export default router;
