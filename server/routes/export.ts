import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { config } from "../config.js";
import { resolvePoolId } from "./pool.js";
import { smartCut } from "../smartcut.js";
import { safeFilename } from "../util/id.js";
import { cloneOrCopy } from "../util/clone.js";
import { getDuration } from "../ffmpeg.js";
import { clampSegmentToDuration } from "../util/timeRange.js";
import { scheduleShotlistRebuild } from "../util/shotlist.js";
import { appendActivity } from "../util/activity.js";

const router = Router();

const Body = z.object({
  sourceId: z.string(),
  in: z.number().min(0),
  out: z.number().min(0),
  name: z.string().min(1),
  description: z.string().default(""),
  tags: z.array(z.string()).default([]),
  characters: z
    .array(z.object({ id: z.string(), name: z.string() }))
    .default([]),
  scenes: z
    .array(z.object({ id: z.string(), name: z.string() }))
    .default([]),
  objects: z
    .array(z.object({ id: z.string(), name: z.string() }))
    .default([]),
  mode: z.enum(["clip", "source", "bundle"]).default("clip"),
});

function uniqueOutputPath(dir: string, base: string, ext: string): string {
  let candidate = path.join(dir, `${base}${ext}`);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}_${n}${ext}`);
    n += 1;
  }
  return candidate;
}

router.post("/export", async (req, res) => {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const {
    sourceId,
    in: inT,
    out: outT,
    name,
    description,
    tags,
    characters,
    scenes,
    objects,
    mode,
  } = parsed.data;
  const source = resolvePoolId(sourceId);
  if (!source) {
    res.status(404).json({ error: "source not found" });
    return;
  }

  const fileDur = await safeDuration(source);
  let inAdj = inT;
  let outAdj = outT;
  if (fileDur != null && fileDur > 0) {
    const c = clampSegmentToDuration(inT, outT, fileDur);
    inAdj = c.inT;
    outAdj = c.outT;
  }

  if (mode !== "source" && outAdj - inAdj < 0.1) {
    res.status(400).json({ error: "selection too short" });
    return;
  }

  const ext = path.extname(source).toLowerCase();
  const base = safeFilename(name);
  const id = crypto.randomBytes(8).toString("hex");

  const cleanupOnFail: string[] = [];

  try {
    let clipPath: string | null = null;
    let sourceCopyPath: string | null = null;
    let cutMode = "source-copy";
    let details = "Whole source montage cloned into library.";

    if (mode === "clip" || mode === "bundle") {
      clipPath = uniqueOutputPath(config.clipsDir, base, ext);
      cleanupOnFail.push(clipPath);
      const result = await smartCut(source, inAdj, outAdj, clipPath);
      cutMode = result.mode;
      details = result.details;
    }

    if (mode === "source" || mode === "bundle") {
      const sourceBase = mode === "source" ? base : `${base}.source`;
      sourceCopyPath = uniqueOutputPath(config.clipsDir, sourceBase, ext);
      cleanupOnFail.push(sourceCopyPath);
      const kind = await cloneOrCopy(source, sourceCopyPath);
      if (mode === "source") {
        details = `Source ${kind}d into library.`;
      } else {
        details = `${details}; source ${kind}d as ${path.basename(
          sourceCopyPath
        )}`;
      }
    }

    const primaryPath = clipPath ?? sourceCopyPath!;
    const sourceDuration =
      mode === "source" ? await safeDuration(source) : undefined;

    const meta = {
      id,
      name,
      description,
      tags,
      characters,
      scenes,
      objects,
      filename: path.basename(primaryPath),
      path: primaryPath,
      source: path.basename(source),
      sourcePath: source,
      sourceId,
      sourceCopyPath: sourceCopyPath ?? undefined,
      in: inAdj,
      out: outAdj,
      duration: mode === "source" ? sourceDuration : outAdj - inAdj,
      mode: cutMode,
      exportMode: mode,
      details,
      created: Date.now(),
    };
    fs.writeFileSync(
      path.join(config.clipMetaDir, `${id}.json`),
      JSON.stringify(meta, null, 2)
    );

    scheduleShotlistRebuild();
    appendActivity("clip_exported", {
      id,
      name,
      sourceId,
      mode: cutMode,
      durationSec: meta.duration,
    });
    res.json(meta);
  } catch (err) {
    for (const f of cleanupOnFail) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        // ignore
      }
    }
    res.status(500).json({ error: String(err) });
  }
});

async function safeDuration(p: string): Promise<number | undefined> {
  try {
    return await getDuration(p);
  } catch {
    return undefined;
  }
}

export default router;
