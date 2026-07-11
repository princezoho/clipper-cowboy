import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Router, type Response } from "express";
import { z } from "zod";
import { audioEngineManager } from "../audio/engine.js";
import { config } from "../config.js";
import { stemJobManager } from "../stems/manager.js";

const router = Router();
const Id = z.string().regex(/^[a-f0-9]{16}$/);
const StemJobId = z.string().uuid();
const Options = z.object({ quality: z.enum(["fast", "high"]) });

function openStemFolder(folder: string): void {
  const command =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "explorer" :
    "xdg-open";
  const child = spawn(command, [folder], { stdio: "ignore", detached: true });
  child.on("error", () => {
    // Opening a local folder is best-effort after safety validation.
  });
  child.unref();
}

function revealStemFolder(folder: string, res: Response): void {
  try {
    openStemFolder(folder);
    res.json({ ok: true });
  } catch {
    res.status(503).json({ error: "could not open the stems folder" });
  }
}

router.get("/audio-engine/status", (_req, res) => res.json(audioEngineManager.inspect()));
router.get("/audio-engine/install", (_req, res) => {
  res.json(audioEngineManager.inspectInstall() ?? {
    status: "complete", message: "No audio engine installation is running.", updatedAt: Date.now(),
  });
});
router.post("/audio-engine/install", (_req, res) => res.status(202).json(audioEngineManager.startInstall()));

router.get("/stem-jobs", (_req, res) => res.json({ items: stemJobManager.list() }));
router.get("/stem-jobs/:id", (req, res) => {
  const job = stemJobManager.get(req.params.id);
  if (!job) return res.status(404).json({ error: "audio splitting job not found" });
  res.json(job);
});
router.post("/stem-jobs/:id/cancel", async (req, res) => {
  const job = await stemJobManager.cancel(req.params.id);
  if (!job) return res.status(404).json({ error: "audio splitting job not found" });
  res.json(job);
});

router.post("/stem-jobs/:id/reveal", (req, res) => {
  const parsedId = StemJobId.safeParse(req.params.id);
  if (!parsedId.success) {
    return res.status(404).json({ error: "audio splitting job not found" });
  }
  const job = stemJobManager.get(parsedId.data);
  if (!job) return res.status(404).json({ error: "audio splitting job not found" });
  if (job.status !== "done") {
    return res.status(409).json({ error: "stems are not ready yet" });
  }
  const folder = stemJobManager.completedOutputDir(parsedId.data);
  if (!folder) return res.status(410).json({ error: "completed stems folder is unavailable" });
  revealStemFolder(folder, res);
});

router.post("/stem-jobs/reveal-root", (_req, res) => {
  if (!stemJobManager.hasCompletedJobs()) {
    return res.status(409).json({ error: "no completed stems are available yet" });
  }
  try {
    const folder = fs.realpathSync(config.stemsDir);
    if (!fs.statSync(folder).isDirectory()) throw new Error("missing stems root");
    revealStemFolder(folder, res);
  } catch {
    res.status(410).json({ error: "audio stems folder is unavailable" });
  }
});

router.post("/library/:id/stems", (req, res) => {
  const parsedId = Id.safeParse(req.params.id);
  const parsedOptions = Options.safeParse(req.body);
  if (!parsedId.success || !parsedOptions.success) {
    return res.status(400).json({ error: "invalid clip ID or audio splitting options" });
  }
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(config.clipMetaDir, `${parsedId.data}.json`), "utf8")) as {
      id?: string; name?: string; path?: string; exportMode?: string;
    };
    if (raw.id !== parsedId.data || typeof raw.path !== "string") return res.status(404).json({ error: "clip not found" });
    if (raw.exportMode === "source") return res.status(409).json({ error: "audio splitting is available for trimmed clips, not source-only clones" });
    const job = stemJobManager.enqueue({
      clipId: parsedId.data, clipName: raw.name || path.basename(raw.path), clipPath: raw.path, quality: parsedOptions.data.quality,
    });
    res.status(job.status === "error" ? 409 : 202).json(job);
  } catch {
    res.status(500).json({ error: "could not queue audio splitting" });
  }
});

export default router;
