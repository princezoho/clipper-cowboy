import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Router } from "express";
import { z } from "zod";
import { appendActivity } from "../util/activity.js";
import { publicError } from "../util/publicError.js";
import {
  executeUniversalPackage,
  planUniversalPackage,
  type UniversalPlan,
} from "../util/universalClipper.js";
import {
  buildPremierePackageManifest,
  findUniversalPackage,
  listUniversalPackages,
  readPremiereImportAcknowledgement,
  writePremiereImportAcknowledgement,
} from "../util/universalPackageStore.js";
import { universalStemManager } from "../stems/universalManager.js";
import {
  clearStemMcpEntry,
  saveStemMcpEntry,
} from "../stems/connectorSettings.js";

const router = Router();
const ID_RE = /^[a-f0-9]{16}$/;
const RequestBody = z.object({
  ids: z.array(z.string().regex(ID_RE)).min(1).max(500),
  name: z.string().trim().min(1).max(120).default("premiere-handoff"),
});
const PackageBody = RequestBody;
const PackageId = z.string().uuid();
const ConnectorConfigBody = z.object({
  entry: z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .refine((value) => !/[\0\r\n]/.test(value), "entry must be one path"),
});
const StemRequest = z
  .object({
    quality: z.enum(["high", "max"]).default("high"),
    confirmedModelExecution: z.literal(true),
    confirmedMaxLicense: z.literal(true).optional(),
  })
  .superRefine((value, context) => {
    if (value.quality === "max" && value.confirmedMaxLicense !== true) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confirmedMaxLicense"],
        message: "Max requires explicit licensing confirmation",
      });
    }
  });
const ImportAckBody = z.object({
  projectGuid: z.string().trim().min(1).max(256),
  entries: z
    .array(
      z.object({
        assetId: z.string().min(1).max(512),
        projectItemId: z.string().min(1).max(512),
        status: z.enum(["existing", "imported"]),
      })
    )
    .max(1_000),
});

type JobStatus = "queued" | "running" | "done" | "cancelled" | "error";

interface PackageJob {
  id: string;
  status: JobStatus;
  stage: string;
  percent: number;
  completed: number;
  total: number;
  plan: UniversalPlan;
  folder?: string;
  manifestPath?: string;
  packageId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  cancelRequested: boolean;
}

function publicJob(job: PackageJob) {
  const { cancelRequested: _cancelRequested, ...result } = job;
  return result;
}

class UniversalClipperJobs {
  private jobs = new Map<string, PackageJob>();
  private pumping = false;

  preview(ids: string[], name: string): UniversalPlan {
    return planUniversalPackage(ids, name);
  }

  enqueue(ids: string[], name: string) {
    const plan = this.preview(ids, name);
    const now = Date.now();
    const job: PackageJob = {
      id: crypto.randomUUID(),
      status: "queued",
      stage: "Waiting for package worker",
      percent: 0,
      completed: 0,
      total: plan.sourceCount + plan.selectedClipCount,
      plan,
      createdAt: now,
      updatedAt: now,
      cancelRequested: false,
    };
    this.jobs.set(job.id, job);
    this.schedule();
    return publicJob(job);
  }

  get(id: string) {
    const job = this.jobs.get(id);
    return job ? publicJob(job) : undefined;
  }

  cancel(id: string) {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.status === "queued") {
      job.cancelRequested = true;
      this.update(job, {
        status: "cancelled",
        stage: "Cancelled before package creation",
      });
    } else if (job.status === "running") {
      job.cancelRequested = true;
      this.update(job, {
        stage: "Cancelling after current file",
      });
    }
    return publicJob(job);
  }

  completedFolder(id: string): string | null {
    const job = this.jobs.get(id);
    if (!job?.folder || (job.status !== "done" && job.status !== "cancelled")) return null;
    try {
      const folder = fs.realpathSync(job.folder);
      return fs.statSync(folder).isDirectory() ? folder : null;
    } catch {
      return null;
    }
  }

  private update(job: PackageJob, patch: Partial<PackageJob>) {
    Object.assign(job, patch, { updatedAt: Date.now() });
  }

  private schedule() {
    if (this.pumping) return;
    this.pumping = true;
    queueMicrotask(() => void this.pump());
  }

  private async pump() {
    try {
      while (true) {
        const job = [...this.jobs.values()].find((candidate) => candidate.status === "queued");
        if (!job) return;
        await this.run(job);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async run(job: PackageJob) {
    this.update(job, { status: "running", stage: "Creating collision-safe package" });
    try {
      const result = await executeUniversalPackage(
        job.plan.sources.flatMap((source) => source.clips.map((clip) => clip.clipId)),
        job.plan.packageName,
        {
          confirmedStemHandoff: true,
          isCancelled: () => job.cancelRequested,
          onProgress: (completed, total, stage) => {
            this.update(job, {
              completed,
              total,
              stage,
              percent: Math.round((completed / Math.max(total, 1)) * 100),
            });
          },
        }
      );
      const status: JobStatus = result.incomplete ? "cancelled" : "done";
      this.update(job, {
        status,
        stage: result.incomplete
          ? "Cancelled; partial package and manifest retained"
          : "Ready to reveal in Finder",
        percent: result.incomplete ? job.percent : 100,
        folder: result.folder,
        manifestPath: path.join(result.folder, "clip-sheet.json"),
        packageId: result.sheet.packageId,
      });
      appendActivity("universal_package_created", {
        jobId: job.id,
        status,
        folder: result.folder,
        clips: result.sheet.clips.length,
        sources: result.sheet.sources.length,
      });
    } catch (error) {
      this.update(job, {
        status: "error",
        stage: "Package failed",
        error: publicError(error, "universal-clipper:package"),
      });
    }
  }
}

const jobs = new UniversalClipperJobs();

router.get("/universal-clipper/packages", (req, res) => {
  const rawLimit = Number(req.query.limit ?? 50);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(250, Math.floor(rawLimit)))
    : 50;
  const items = listUniversalPackages(limit).map((location) => {
    const manifest = buildPremierePackageManifest(location);
    return {
      packageId: manifest.packageId,
      packageName: manifest.packageName,
      createdAt: manifest.createdAt,
      packageStatus: manifest.packageStatus,
      premiereReady: manifest.premiereReady,
      stemExecution: manifest.stemExecution,
      counts: manifest.counts,
    };
  });
  res.json({ items });
});

router.get("/universal-clipper/packages/:packageId", (req, res) => {
  const parsed = PackageId.safeParse(req.params.packageId);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid package ID" });
    return;
  }
  const location = findUniversalPackage(parsed.data);
  if (!location) {
    res.status(404).json({ error: "package not found" });
    return;
  }
  const manifest = buildPremierePackageManifest(location);
  const projectGuid =
    typeof req.query.projectGuid === "string"
      ? req.query.projectGuid.trim().slice(0, 256)
      : "";
  res.json({
    ...manifest,
    importAcknowledgements: projectGuid
      ? readPremiereImportAcknowledgement(parsed.data, projectGuid)
      : [],
  });
});

router.post(
  "/universal-clipper/packages/:packageId/import-ack",
  (req, res) => {
    const parsedId = PackageId.safeParse(req.params.packageId);
    const parsedBody = ImportAckBody.safeParse(req.body);
    if (!parsedId.success || !parsedBody.success) {
      res.status(400).json({ error: "invalid package import acknowledgement" });
      return;
    }
    try {
      const entries = writePremiereImportAcknowledgement(
        parsedId.data,
        parsedBody.data.projectGuid,
        parsedBody.data.entries
      );
      res.json({ ok: true, entries });
    } catch (error) {
      res
        .status(409)
        .json({ error: publicError(error, "universal-clipper:import-ack") });
    }
  }
);

router.get("/universal-clipper/stem-connector/status", async (_req, res) => {
  res.json(await universalStemManager.inspectConnector());
});

router.put("/universal-clipper/stem-connector/config", async (req, res) => {
  const parsed = ConnectorConfigBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid Stem Studio MCP entry" });
    return;
  }
  try {
    saveStemMcpEntry(parsed.data.entry);
    res.json(await universalStemManager.inspectConnector());
  } catch (error) {
    res
      .status(400)
      .json({ error: publicError(error, "universal-clipper:connector-config") });
  }
});

router.delete("/universal-clipper/stem-connector/config", async (_req, res) => {
  try {
    clearStemMcpEntry();
    res.json(await universalStemManager.inspectConnector());
  } catch {
    res.status(500).json({ error: "Could not clear Stem Studio MCP settings." });
  }
});

router.post("/universal-clipper/packages/:packageId/stems", (req, res) => {
  const parsedId = PackageId.safeParse(req.params.packageId);
  const parsedBody = StemRequest.safeParse(req.body);
  if (!parsedId.success || !parsedBody.success) {
    res.status(400).json({ error: "invalid stem separation request" });
    return;
  }
  try {
    const job = universalStemManager.enqueue({
      packageId: parsedId.data,
      quality: parsedBody.data.quality,
      confirmedModelExecution: true,
      ...(parsedBody.data.confirmedMaxLicense
        ? { confirmedMaxLicense: true as const }
        : {}),
    });
    res.status(job.status === "setup_required" ? 409 : 202).json(job);
  } catch (error) {
    res
      .status(409)
      .json({ error: publicError(error, "universal-clipper:stems") });
  }
});

router.get("/universal-clipper/stem-jobs/:id", (req, res) => {
  const parsed = PackageId.safeParse(req.params.id);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid stem job ID" });
    return;
  }
  const job = universalStemManager.get(parsed.data);
  if (!job) {
    res.status(404).json({ error: "stem job not found" });
    return;
  }
  res.json(job);
});

router.post("/universal-clipper/stem-jobs/:id/cancel", async (req, res) => {
  const parsed = PackageId.safeParse(req.params.id);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid stem job ID" });
    return;
  }
  const job = await universalStemManager.cancel(parsed.data);
  if (!job) {
    res.status(404).json({ error: "stem job not found" });
    return;
  }
  res.json(job);
});

router.post("/universal-clipper/preview", (req, res) => {
  const parsed = RequestBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    res.json(jobs.preview(parsed.data.ids, parsed.data.name));
  } catch (error) {
    res.status(409).json({ error: publicError(error, "universal-clipper:preview") });
  }
});

router.post("/universal-clipper/packages", (req, res) => {
  const parsed = PackageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    res.status(202).json(jobs.enqueue(parsed.data.ids, parsed.data.name));
  } catch (error) {
    res.status(409).json({ error: publicError(error, "universal-clipper:enqueue") });
  }
});

router.get("/universal-clipper/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "package job not found" });
    return;
  }
  res.json(job);
});

router.post("/universal-clipper/jobs/:id/cancel", (req, res) => {
  const job = jobs.cancel(req.params.id);
  if (!job) {
    res.status(404).json({ error: "package job not found" });
    return;
  }
  res.json(job);
});

router.post("/universal-clipper/jobs/:id/reveal", (req, res) => {
  const folder = jobs.completedFolder(req.params.id);
  if (!folder) {
    res.status(409).json({ error: "package is not ready" });
    return;
  }
  if (process.platform !== "darwin") {
    res.status(501).json({ error: "Reveal in Finder is macOS-only" });
    return;
  }
  const child = spawn("/usr/bin/open", [folder], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
  res.json({ ok: true, folder });
});

router.get("/universal-clipper/jobs/:id/clip-sheet.:format", (req, res) => {
  const folder = jobs.completedFolder(req.params.id);
  if (!folder) {
    res.status(409).json({ error: "package is not ready" });
    return;
  }
  const names: Record<string, string> = {
    json: "clip-sheet.json",
    csv: "clip-sheet.csv",
    html: "README.html",
  };
  const filename = names[req.params.format];
  if (!filename) {
    res.status(404).json({ error: "unknown clip-sheet format" });
    return;
  }
  res.sendFile(path.join(folder, filename));
});

export default router;
