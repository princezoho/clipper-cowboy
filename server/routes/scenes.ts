import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { detectScenes, getDuration } from "../ffmpeg.js";
import { resolvePoolId } from "./pool.js";

export interface SceneSegment {
  start: number;
  end: number;
}

const router = Router();

function cachePath(id: string): string {
  return path.join(config.sceneCacheDir, `${id}.scenes.json`);
}

router.get("/scenes/:id", async (req, res) => {
  const file = resolvePoolId(req.params.id);
  if (!file) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const cp = cachePath(req.params.id);
  if (fs.existsSync(cp)) {
    try {
      const data = JSON.parse(fs.readFileSync(cp, "utf8"));
      res.json(data);
      return;
    } catch {
      // re-detect
    }
  }
  res.status(404).json({ error: "no cached scenes; POST to detect" });
});

router.post("/scenes/:id", async (req, res) => {
  const file = resolvePoolId(req.params.id);
  if (!file) {
    res.status(404).json({ error: "not found" });
    return;
  }
  try {
    const threshold = Number(req.body?.threshold ?? 0.4);
    const cuts = await detectScenes(file, threshold);
    const duration = await getDuration(file);

    const boundaries = [0, ...cuts.map((c) => c.time), duration]
      .filter((t, i, a) => i === 0 || t > a[i - 1] + 0.05)
      .sort((a, b) => a - b);

    const segments: SceneSegment[] = [];
    for (let i = 0; i < boundaries.length - 1; i += 1) {
      const start = boundaries[i];
      const end = boundaries[i + 1];
      if (end - start >= 0.4) segments.push({ start, end });
    }
    if (segments.length === 0 && duration > 0) {
      segments.push({ start: 0, end: duration });
    }

    const data = { duration, segments, threshold, cachedAt: Date.now() };
    fs.writeFileSync(cachePath(req.params.id), JSON.stringify(data, null, 2));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
