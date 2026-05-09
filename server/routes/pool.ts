import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import {
  config,
  isSupportedVideo,
  POOL_CACHE_DIR,
  RESERVED_PROJECT_DIRS,
} from "../config.js";
import { extractFrameJpeg, getDuration } from "../ffmpeg.js";
import { pathToId } from "../util/id.js";
import { loadState as loadAutoCutState } from "../util/autocut.js";

export interface PoolItem {
  id: string;
  filename: string;
  path: string;
  size: number;
  mtime: number;
  duration: number;
  thumbUrl: string;
  clipCount: number;
  autoCutStatus: "idle" | "detecting" | "captioning" | "complete" | "error";
  autoCutDone: number;
  autoCutTotal: number;
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
    if (e.isDirectory() && RESERVED_PROJECT_DIRS.has(e.name)) continue;
    if (e.isFile() && !e.name.startsWith(".") && isSupportedVideo(e.name)) {
      files.push(path.join(config.poolDir, e.name));
    }
  }
  return files.sort();
}

const DURATIONS_PATH = config.durationsPath;

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
  const files = listPoolFiles();
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
    const ac = loadAutoCutState(id);
    return {
      id,
      filename: path.basename(file),
      path: file,
      size: stat.size,
      mtime: stat.mtimeMs,
      duration,
      thumbUrl: `/api/thumb/${id}?t=1`,
      clipCount: clipCounts.get(id) ?? 0,
      autoCutStatus: ac.status,
      autoCutDone: ac.done,
      autoCutTotal: ac.total,
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

export default router;
