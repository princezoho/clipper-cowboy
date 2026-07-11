import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { stemJobManager } from "../stems/manager.js";
import { stemSetupManager } from "../stems/setup.js";

const router = Router();
const Id = z.string().regex(/^[a-f0-9]{16}$/);
const Options = z.object({ quality: z.enum(["fast", "high", "max"]) });

router.get("/stem-studio/status", async (_req, res) => {
  res.json(await stemJobManager.inspectStudio());
});

router.get("/stem-studio/setup", (_req, res) => {
  res.json(
    stemSetupManager.inspect() ?? {
      status: "complete",
      message: "No local helper setup is running.",
      updatedAt: Date.now(),
    }
  );
});

router.post("/stem-studio/finish-setup", async (_req, res) => {
  const status = await stemJobManager.inspectStudio();
  if (!status.configured || !status.helperSetupRequired) {
    res.status(409).json({
      error: "Stem Studio's local helper is not awaiting setup. Choose a valid Stem Studio folder first.",
    });
    return;
  }
  res.status(202).json(stemSetupManager.start());
});

router.get("/stem-jobs", (_req, res) => {
  res.json({ items: stemJobManager.list() });
});

router.get("/stem-jobs/:id", (req, res) => {
  const job = stemJobManager.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "stem job not found" });
    return;
  }
  res.json(job);
});

router.post("/stem-jobs/:id/cancel", async (req, res) => {
  const job = await stemJobManager.cancel(req.params.id);
  if (!job) {
    res.status(404).json({ error: "stem job not found" });
    return;
  }
  res.json(job);
});

router.post("/library/:id/stems", (req, res) => {
  const parsedId = Id.safeParse(req.params.id);
  const parsedOptions = Options.safeParse(req.body);
  if (!parsedId.success || !parsedOptions.success) {
    res.status(400).json({ error: "invalid clip ID or stem options" });
    return;
  }
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(config.clipMetaDir, `${parsedId.data}.json`), "utf8")
    ) as { id?: string; name?: string; path?: string; exportMode?: string };
    if (raw.id !== parsedId.data || typeof raw.path !== "string") {
      res.status(404).json({ error: "clip not found" });
      return;
    }
    if (raw.exportMode === "source") {
      res.status(409).json({
        error: "stem separation is available for trimmed clips, not source-only clones",
      });
      return;
    }
    const job = stemJobManager.enqueue({
      clipId: parsedId.data,
      clipName: raw.name || path.basename(raw.path),
      clipPath: raw.path,
      quality: parsedOptions.data.quality,
    });
    res.status(job.status === "error" ? 409 : 202).json(job);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      res.status(404).json({ error: "clip not found" });
    } else {
      res.status(500).json({ error: "could not queue stem separation" });
    }
  }
});

export default router;
