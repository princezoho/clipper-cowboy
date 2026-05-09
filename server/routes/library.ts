import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { config, isSupportedVideo } from "../config.js";
import { extractFrameJpeg, getDuration } from "../ffmpeg.js";
import { scheduleShotlistRebuild } from "../util/shotlist.js";

const router = Router();

interface LibraryMeta {
  id: string;
  name: string;
  description: string;
  tags: string[];
  characters?: { id: string; name: string }[];
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
  return path.join(config.clipMetaDir, `${id}.json`);
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
    const m = readMeta(path.join(config.clipMetaDir, name));
    if (m && fs.existsSync(m.path)) items.push(m);
  }
  items.sort((a, b) => b.created - a.created);
  return items;
}

const idToFile = new Map<string, string>();
const idToSource = new Map<string, string>();

function pickSourcePath(m: LibraryMeta): string | null {
  if (m.sourceCopyPath && fs.existsSync(m.sourceCopyPath)) return m.sourceCopyPath;
  if (m.sourcePath && fs.existsSync(m.sourcePath)) return m.sourcePath;
  return null;
}

function refreshIndex() {
  idToFile.clear();
  idToSource.clear();
  for (const m of listMetas()) {
    idToFile.set(m.id, m.path);
    const src = pickSourcePath(m);
    if (src) idToSource.set(m.id, src);
  }
}

router.get("/library", async (_req, res) => {
  const metas = listMetas();
  refreshIndex();
  const items = metas.map((m) => {
    const sourceAvailable = pickSourcePath(m) !== null;
    return {
      ...m,
      thumbUrl: `/api/library/${m.id}/thumb`,
      videoUrl: `/api/library/${m.id}/video`,
      sourceVideoUrl: sourceAvailable
        ? `/api/library/${m.id}/source-video`
        : undefined,
      sourceAvailable,
    };
  });
  res.json({ items, libraryDir: config.clipsDir });
});

router.patch("/library/:id", (req, res) => {
  const mp = metaPath(req.params.id);
  if (!fs.existsSync(mp)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const Schema = z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    characters: z
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
  const updated: LibraryMeta = { ...meta, ...parsed.data };
  fs.writeFileSync(mp, JSON.stringify(updated, null, 2));
  scheduleShotlistRebuild();
  res.json(updated);
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
  for (const p of [meta.path, meta.sourceCopyPath]) {
    if (!p) continue;
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      // ignore
    }
  }
  fs.unlinkSync(mp);
  scheduleShotlistRebuild();
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

export default router;
