import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { POOL_CACHE_DIR } from "../config.js";
import { extractFrameJpeg } from "../ffmpeg.js";
import { resolvePoolId } from "./pool.js";
import { captionFromFrames } from "../openai.js";

const router = Router();

const Body = z.object({
  sourceId: z.string(),
  in: z.number(),
  out: z.number(),
});

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
  if (outT <= inT) {
    res.status(400).json({ error: "out must be greater than in" });
    return;
  }

  const span = outT - inT;
  const sampleTimes = [
    inT + span * 0.1,
    inT + span * 0.5,
    inT + span * 0.9,
  ];

  const tmpDir = path.join(POOL_CACHE_DIR, `caption-${sourceId}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const framePaths: string[] = [];
  try {
    for (let i = 0; i < sampleTimes.length; i += 1) {
      const out = path.join(tmpDir, `f${i}.jpg`);
      await extractFrameJpeg(file, sampleTimes[i], out, 512);
      framePaths.push(out);
    }
    const caption = await captionFromFrames(framePaths);
    res.json(caption);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  } finally {
    for (const fp of framePaths) {
      try {
        fs.unlinkSync(fp);
      } catch {
        // ignore
      }
    }
  }
});

export default router;
