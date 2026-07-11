import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CAPTION_TMP_DIR } from "../config.js";
import { extractFrameJpeg, getDuration } from "../ffmpeg.js";
import { clampSegmentToDuration } from "../util/timeRange.js";
import { resolvePoolId } from "./pool.js";
import {
  captionFromFrames,
  CharacterContext,
  sendOpenAIClientError,
} from "../openai.js";
import { listCharacters, listRefs } from "../util/characters.js";

const router = Router();

const Body = z.object({
  sourceId: z.string(),
  in: z.number(),
  out: z.number(),
});

const SAMPLE_FRAME_TTL_MS = 60 * 60 * 1000; // 1 hour
const FRAMES_PER_CALL = 3;

function cleanOldCaptionDirs() {
  if (!fs.existsSync(CAPTION_TMP_DIR)) return;
  const cutoff = Date.now() - SAMPLE_FRAME_TTL_MS;
  for (const name of fs.readdirSync(CAPTION_TMP_DIR)) {
    if (!name.startsWith("frames-")) continue;
    const dir = path.join(CAPTION_TMP_DIR, name);
    try {
      const stat = fs.statSync(dir);
      if (stat.mtimeMs < cutoff) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }
}

function loadCharacterContext(): CharacterContext[] {
  const out: CharacterContext[] = [];
  for (const c of listCharacters()) {
    const refs = listRefs(c.id);
    if (refs.length === 0) continue;
    out.push({
      id: c.id,
      name: c.name,
      refPaths: refs.map((r) => r.path),
    });
  }
  return out;
}

router.post("/caption", async (req, res) => {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { sourceId, in: inT, out: outT } = parsed.data;
  const file = resolvePoolId(sourceId);
  if (!file) {
    res.status(404).json({ error: "source not found" });
    return;
  }

  let fileDur = 0;
  try {
    fileDur = await getDuration(file);
  } catch {
    // clampSegment handles dur <= 0
  }
  const { inT: inA, outT: outA } = clampSegmentToDuration(inT, outT, fileDur);
  if (outA <= inA) {
    res.status(400).json({ error: "out must be greater than in" });
    return;
  }

  cleanOldCaptionDirs();

  const span = outA - inA;
  const sampleTimes = [
    inA + span * 0.1,
    inA + span * 0.5,
    inA + span * 0.9,
  ].slice(0, FRAMES_PER_CALL);

  // A stable-ish cacheKey so the frontend can reference the frames after the
  // request returns (e.g. to promote one to a character ref).
  const cacheKey = `frames-${sourceId}-${Math.round(inA * 1000)}-${Math.round(
    outA * 1000
  )}`;
  const dir = path.join(CAPTION_TMP_DIR, cacheKey);
  fs.mkdirSync(dir, { recursive: true });

  const framePaths: string[] = [];
  try {
    for (let i = 0; i < sampleTimes.length; i += 1) {
      const out = path.join(dir, `f${i}.jpg`);
      await extractFrameJpeg(file, sampleTimes[i], out, 512);
      framePaths.push(out);
    }
    const characters = loadCharacterContext();
    const caption = await captionFromFrames(framePaths, characters);
    res.json({
      ...caption,
      sampleFrames: framePaths.map((_, i) => ({
        url: `/api/caption-frames/${cacheKey}/f${i}.jpg`,
        index: i,
        t: sampleTimes[i],
      })),
      cacheKey,
    });
  } catch (err) {
    if (sendOpenAIClientError(res, err)) return;
    res.status(500).json({ error: String(err) });
  }
  // NOTE: deliberately not deleting frames here — they live until
  // cleanOldCaptionDirs() reaps them (1h TTL) so the UI can promote them
  // to character refs after the response returns.
});

router.get("/caption-frames/:cacheKey/:name", (req, res) => {
  const safe = path.basename(req.params.name);
  if (!/^f\d+\.jpg$/.test(safe)) {
    res.status(400).end();
    return;
  }
  const dir = path.basename(req.params.cacheKey);
  if (!dir.startsWith("frames-")) {
    res.status(400).end();
    return;
  }
  const p = path.join(CAPTION_TMP_DIR, dir, safe);
  if (!fs.existsSync(p)) {
    res.status(404).end();
    return;
  }
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.sendFile(p);
});

export default router;
