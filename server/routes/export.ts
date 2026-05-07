import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { config, LIBRARY_META_DIR } from "../config.js";
import { resolvePoolId } from "./pool.js";
import { smartCut } from "../smartcut.js";
import { safeFilename } from "../util/id.js";

const router = Router();

const Body = z.object({
  sourceId: z.string(),
  in: z.number().min(0),
  out: z.number().min(0),
  name: z.string().min(1),
  description: z.string().default(""),
  tags: z.array(z.string()).default([]),
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
  const { sourceId, in: inT, out: outT, name, description, tags } = parsed.data;
  const source = resolvePoolId(sourceId);
  if (!source) {
    res.status(404).json({ error: "source not found" });
    return;
  }
  if (outT - inT < 0.1) {
    res.status(400).json({ error: "selection too short" });
    return;
  }

  const ext = path.extname(source).toLowerCase();
  const base = safeFilename(name);
  const outputPath = uniqueOutputPath(config.libraryDir, base, ext);
  const id = crypto.randomBytes(8).toString("hex");

  try {
    const result = await smartCut(source, inT, outT, outputPath);

    const meta = {
      id,
      name,
      description,
      tags,
      filename: path.basename(outputPath),
      path: outputPath,
      source: path.basename(source),
      sourcePath: source,
      sourceId,
      in: inT,
      out: outT,
      duration: outT - inT,
      mode: result.mode,
      details: result.details,
      created: Date.now(),
    };
    fs.writeFileSync(
      path.join(LIBRARY_META_DIR, `${id}.json`),
      JSON.stringify(meta, null, 2)
    );

    res.json(meta);
  } catch (err) {
    try {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch {
      // ignore
    }
    res.status(500).json({ error: String(err) });
  }
});

export default router;
