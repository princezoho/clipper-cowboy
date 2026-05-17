import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CAPTION_TMP_DIR } from "../config.js";
import {
  addRefFromJpeg,
  createCharacter,
  deleteCharacter,
  deleteRef,
  getCharacter,
  listCharacters,
  listRefs,
  refPath,
  updateCharacter,
} from "../util/characters.js";
import { extractFrameJpeg } from "../ffmpeg.js";
import { resolvePoolId } from "./pool.js";
import { appendActivity } from "../util/activity.js";

const router = Router();

function withRefUrls(c: { id: string }) {
  const refs = listRefs(c.id).map((r) => ({
    name: r.name,
    url: `/api/characters/${c.id}/refs/${encodeURIComponent(r.name)}`,
  }));
  return {
    ...c,
    refs,
    thumbUrl: refs[0]?.url,
  };
}

router.get("/characters", (_req, res) => {
  const items = listCharacters().map(withRefUrls);
  res.json({ items });
});

router.post("/characters", (req, res) => {
  const Schema = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    aliases: z.array(z.string()).optional(),
  });
  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const c = createCharacter(parsed.data);
  appendActivity("character_created", { id: c.id, name: c.name });
  res.json(withRefUrls(c));
});

router.patch("/characters/:id", (req, res) => {
  const Schema = z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    aliases: z.array(z.string()).optional(),
  });
  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const c = updateCharacter(req.params.id, parsed.data);
  if (!c) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(withRefUrls(c));
});

router.delete("/characters/:id", (req, res) => {
  const existing = getCharacter(req.params.id);
  const ok = deleteCharacter(req.params.id);
  if (!ok) {
    res.status(404).json({ error: "not found" });
    return;
  }
  appendActivity("character_deleted", {
    id: req.params.id,
    name: existing?.name ?? "",
  });
  res.json({ ok: true });
});

router.get("/characters/:id/refs/:name", (req, res) => {
  const p = refPath(req.params.id, req.params.name);
  if (!p) {
    res.status(404).end("not found");
    return;
  }
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.sendFile(p);
});

router.delete("/characters/:id/refs/:name", (req, res) => {
  const ok = deleteRef(req.params.id, req.params.name);
  if (!ok) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ ok: true });
});

/**
 * Add a reference image. Supports two modes:
 *   - { sourceId, t }   : extract a frame from a pool video at time `t`
 *   - { cacheKey, frameIndex } : reuse one of the sample frames the captioner
 *                                already extracted (so the user can promote a
 *                                sample frame into a character ref without
 *                                re-extracting).
 */
router.post("/characters/:id/refs", async (req, res) => {
  const exists = getCharacter(req.params.id);
  if (!exists) {
    res.status(404).json({ error: "character not found" });
    return;
  }
  const Schema = z.union([
    z.object({ sourceId: z.string(), t: z.number().min(0) }),
    z.object({ cacheKey: z.string(), frameIndex: z.number().int().min(0) }),
  ]);
  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  let tmpFrame: string | null = null;
  try {
    if ("sourceId" in parsed.data) {
      const file = resolvePoolId(parsed.data.sourceId);
      if (!file) {
        res.status(404).json({ error: "source not found" });
        return;
      }
      tmpFrame = path.join(
        CAPTION_TMP_DIR,
        `ref-${Date.now()}-${process.pid}.jpg`
      );
      await extractFrameJpeg(file, parsed.data.t, tmpFrame, 768);
    } else {
      const cachePath = path.join(
        CAPTION_TMP_DIR,
        parsed.data.cacheKey,
        `f${parsed.data.frameIndex}.jpg`
      );
      if (!fs.existsSync(cachePath)) {
        res.status(404).json({ error: "sample frame not found" });
        return;
      }
      tmpFrame = cachePath;
    }
    const refName = await addRefFromJpeg(req.params.id, tmpFrame);
    const updated = getCharacter(req.params.id);
    if (!updated) {
      res.status(500).json({ error: "character disappeared" });
      return;
    }
    res.json({
      ...withRefUrls(updated),
      addedRef: {
        name: refName,
        url: `/api/characters/${req.params.id}/refs/${encodeURIComponent(refName)}`,
      },
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  } finally {
    // Only delete if we created a one-off temp file (not the cached sample frame).
    if (tmpFrame && tmpFrame.includes("ref-")) {
      try {
        fs.unlinkSync(tmpFrame);
      } catch {
        // ignore
      }
    }
  }
});

export default router;
