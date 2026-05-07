import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { config, isSupportedVideo, POOL_CACHE_DIR } from "../config.js";
import { extractFrameJpeg, getDuration } from "../ffmpeg.js";
import { pathToId } from "../util/id.js";

export interface PoolItem {
  id: string;
  filename: string;
  path: string;
  size: number;
  mtime: number;
  duration: number;
  thumbUrl: string;
}

const idToPath = new Map<string, string>();

export function resolvePoolId(id: string): string | null {
  const p = idToPath.get(id);
  if (p && fs.existsSync(p)) return p;
  return null;
}

function listPoolFiles(): string[] {
  const entries = fs.readdirSync(config.poolDir, { withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    if (e.isFile() && !e.name.startsWith(".") && isSupportedVideo(e.name)) {
      files.push(path.join(config.poolDir, e.name));
    }
  }
  return files.sort();
}

const router = Router();

router.get("/pool", async (_req, res) => {
  const files = listPoolFiles();
  const items: PoolItem[] = [];
  for (const file of files) {
    const id = pathToId(file);
    idToPath.set(id, file);
    const stat = fs.statSync(file);
    let duration = 0;
    try {
      duration = await getDuration(file);
    } catch {
      // ignore
    }
    items.push({
      id,
      filename: path.basename(file),
      path: file,
      size: stat.size,
      mtime: stat.mtimeMs,
      duration,
      thumbUrl: `/api/thumb/${id}?t=${Math.max(0.1, Math.min(duration / 2, 60))}`,
    });
  }
  res.json({ items, poolDir: config.poolDir });
});

router.get("/thumb/:id", async (req, res) => {
  const file = resolvePoolId(req.params.id);
  if (!file) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const t = Number(req.query.t ?? 1);
  const w = Number(req.query.w ?? 320);
  const cacheKey = `${req.params.id}_${t.toFixed(2)}_${w}.jpg`;
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

export default router;
