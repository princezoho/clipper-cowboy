import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { appendActivity } from "../util/activity.js";
import { validateStemStudioInstallation } from "./installation.js";
import { StemMcpClient } from "./mcpClient.js";
import type {
  StemJobSummary,
  StemQuality,
  StemStudioStatus,
} from "./types.js";

interface StoredStemJob extends StemJobSummary {
  inputPath: string;
  finalDir: string;
  sourceSize: number;
  sourceMtimeMs: number;
  sourceDev: number;
  sourceIno: number;
}

interface SetupReport {
  ready?: boolean;
  device?: string;
  message?: string;
}

interface ProbeReport {
  has_video?: boolean;
}

interface InnerJob {
  job_id?: string;
  status?: string;
  stage?: string | null;
  percent?: number;
  detail?: string | null;
  result?: SeparationResult | null;
  error?: string | null;
}

interface SeparationResult {
  output_dir?: string;
  stems?: {
    dialogue?: string;
    music?: string;
    sfx?: string;
  };
  married?: string;
  multitrack_video?: string | null;
}

interface ActiveRuntime {
  outerId: string;
  client: StemMcpClient;
  innerId?: string;
}

const JOBS_PATH = path.join(config.internalDir, "stem-jobs.json");
const TERMINAL = new Set(["done", "error", "cancelled", "interrupted"]);
const STAGE_BASE: Record<string, number> = {
  extracting: 0,
  setup: 0,
  loading: 10,
  separating: 20,
  polishing: 80,
  writing: 85,
  remuxing: 95,
  publishing: 99,
  done: 100,
};
const STAGE_SPAN: Record<string, number> = {
  extracting: 10,
  setup: 10,
  loading: 10,
  separating: 60,
  polishing: 5,
  writing: 10,
  remuxing: 4,
  publishing: 1,
  done: 0,
};

function isContained(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeMessage(error: unknown): string {
  let raw = error instanceof Error ? error.message : String(error);
  for (const [value, replacement] of [
    [config.projectDir, "<project>"],
    [config.stemStudioRoot, "<stem-studio>"],
    [config.stemStudioPython, "<stem-python>"],
    [config.stemStudioCache, "<stem-cache>"],
  ] as Array<[string | undefined, string]>) {
    if (value) raw = raw.split(value).join(replacement);
  }
  return raw.replace(/[\r\n]+/g, " ").slice(0, 1000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function overallPercent(stage: string | null | undefined, percent: number): number {
  if (!stage) return Math.max(0, Math.min(99, Math.round(percent || 0)));
  const base = STAGE_BASE[stage] ?? 0;
  const span = STAGE_SPAN[stage] ?? 0;
  return Math.max(
    0,
    Math.min(100, Math.round(base + (Math.max(0, Math.min(100, percent)) / 100) * span))
  );
}

export function safeStemFolderName(filename: string, clipId: string): string {
  const ext = path.extname(filename);
  const raw = path.basename(filename, ext);
  const safe = raw
    .normalize("NFKC")
    .replace(/[\\/\0]/g, "_")
    .replace(/^\.+$/, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 160);
  return safe || `clip-${clipId}`;
}

function publicJob(job: StoredStemJob): StemJobSummary {
  const {
    inputPath: _inputPath,
    finalDir: _finalDir,
    sourceSize: _sourceSize,
    sourceMtimeMs: _sourceMtimeMs,
    sourceDev: _sourceDev,
    sourceIno: _sourceIno,
    ...summary
  } = job;
  return summary;
}

function recommendedQuality(device: string | undefined): StemQuality {
  // Max invokes an additional model with separate upstream licensing, so it
  // remains an explicit choice rather than an automatic recommendation.
  if (device === "cuda" || device === "mps") return "high";
  return "fast";
}

function readJobs(): StoredStemJob[] {
  try {
    const stat = fs.statSync(JOBS_PATH);
    if (stat.size > 5 * 1024 * 1024) return [];
    const parsed = JSON.parse(fs.readFileSync(JOBS_PATH, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (job): job is StoredStemJob =>
        job &&
        typeof job.id === "string" &&
        typeof job.clipId === "string" &&
        typeof job.inputPath === "string" &&
        typeof job.finalDir === "string"
    );
  } catch {
    return [];
  }
}

export class StemJobManager {
  private jobs = new Map<string, StoredStemJob>();
  private active: ActiveRuntime | null = null;
  private cancelled = new Set<string>();
  private pumping = false;
  private shuttingDown = false;

  constructor() {
    for (const loaded of readJobs().slice(-200)) {
      if (loaded.status === "queued" || loaded.status === "running") {
        loaded.status = "interrupted";
        loaded.stage = "interrupted";
        loaded.error = "Clipper Cowboy stopped before this stem job finished.";
        loaded.updatedAt = Date.now();
      }
      this.jobs.set(loaded.id, loaded);
    }
    this.cleanStaleStages();
    this.persist();
  }

  list(): StemJobSummary[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 200)
      .map(publicJob);
  }

  get(id: string): StemJobSummary | undefined {
    const job = this.jobs.get(id);
    return job ? publicJob(job) : undefined;
  }

  async inspectStudio(): Promise<StemStudioStatus> {
    if (!config.stemStudioConfigured) {
      return {
        configured: false,
        ready: false,
        message:
          "Stem Studio is not connected. Add its cloned folder in Settings, then restart Clipper Cowboy.",
      };
    }
    try {
      validateStemStudioInstallation(config.stemStudioRoot ?? "");
    } catch {
      return {
        configured: false,
        ready: false,
        message: "Choose the Stem Studio folder—the one containing package.json and an mcp folder.",
      };
    }
    let client: StemMcpClient | null = null;
    try {
      client = await StemMcpClient.connect();
      const report = await client.callTool<SetupReport>("setup_status", {}, 60_000);
      const device =
        report.device === "cpu" || report.device === "mps" || report.device === "cuda"
          ? report.device
          : undefined;
      return {
        configured: true,
        ready: report.ready === true,
        ...(device ? { device } : {}),
        recommendedQuality: recommendedQuality(device),
        message: report.ready
          ? "Stem Studio is ready."
          : "Stem Studio is connected, but its local Python environment is not ready. Finish setup in Stem Studio first.",
      };
    } catch (error) {
      return {
        configured: true,
        ready: false,
        message: safeMessage(error),
      };
    } finally {
      if (client) await client.close();
    }
  }

  enqueue(input: {
    clipId: string;
    clipName: string;
    clipPath: string;
    quality: StemQuality;
  }): StemJobSummary {
    const duplicate = [...this.jobs.values()].find(
      (job) => job.clipId === input.clipId && !TERMINAL.has(job.status)
    );
    if (duplicate) return publicJob(duplicate);

    const now = Date.now();
    const id = crypto.randomUUID();
    const folder = safeStemFolderName(path.basename(input.clipPath), input.clipId);
    let finalDir = path.resolve(config.stemsDir, folder);
    let canonicalInput = path.resolve(input.clipPath);
    let sourceSize = 0;
    let sourceMtimeMs = 0;
    let sourceDev = 0;
    let sourceIno = 0;
    let immediateError: string | undefined;

    try {
      const clipsRoot = fs.realpathSync(config.clipsDir);
      const sourceLstat = fs.lstatSync(input.clipPath);
      if (sourceLstat.isSymbolicLink() || !sourceLstat.isFile()) {
        throw new Error("The exported clip is not a regular local file.");
      }
      canonicalInput = fs.realpathSync(input.clipPath);
      if (!isContained(clipsRoot, canonicalInput) || canonicalInput === clipsRoot) {
        throw new Error("The exported clip is outside the project's clips folder.");
      }
      const stemsRoot = fs.realpathSync(config.stemsDir);
      finalDir = path.join(stemsRoot, folder);
      if (!isContained(stemsRoot, finalDir) || finalDir === stemsRoot) {
        throw new Error("The derived stem destination is unsafe.");
      }
      if (fs.existsSync(finalDir)) {
        throw new Error(
          `Stem outputs already exist for ${path.basename(input.clipPath)}. Remove them before retrying.`
        );
      }
      const stat = fs.statSync(canonicalInput);
      sourceSize = stat.size;
      sourceMtimeMs = stat.mtimeMs;
      sourceDev = stat.dev;
      sourceIno = stat.ino;
      const activeCount = [...this.jobs.values()].filter(
        (existing) =>
          existing.status === "queued" || existing.status === "running"
      ).length;
      if (activeCount >= 10) {
        throw new Error("The stem queue is full. Wait for an active job to finish.");
      }
      if (!config.stemStudioConfigured) {
        throw new Error(
          "Stem Studio is not connected. Add its cloned folder in Settings and restart Clipper Cowboy."
        );
      }
    } catch (error) {
      immediateError = safeMessage(error);
    }

    const job: StoredStemJob = {
      id,
      clipId: input.clipId,
      clipName: input.clipName,
      quality: input.quality,
      status: immediateError ? "error" : "queued",
      stage: immediateError ? "not_started" : "queued",
      percent: 0,
      ...(immediateError ? { error: immediateError } : {}),
      createdAt: now,
      updatedAt: now,
      inputPath: canonicalInput,
      finalDir,
      sourceSize,
      sourceMtimeMs,
      sourceDev,
      sourceIno,
    };
    this.jobs.set(job.id, job);
    this.persist();
    appendActivity(immediateError ? "stems_failed" : "stems_queued", {
      jobId: job.id,
      clipId: job.clipId,
      clipName: job.clipName,
      quality: job.quality,
      ...(immediateError ? { error: immediateError } : {}),
    });
    if (!immediateError) this.schedulePump();
    return publicJob(job);
  }

  async cancel(id: string): Promise<StemJobSummary | undefined> {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (TERMINAL.has(job.status)) return publicJob(job);
    this.cancelled.add(id);
    if (job.status === "queued") {
      this.update(job, {
        status: "cancelled",
        stage: "cancelled",
        error: undefined,
      });
      return publicJob(job);
    }
    const runtime = this.active?.outerId === id ? this.active : null;
    if (runtime) {
      await this.cancelRuntime(runtime);
    }
    return publicJob(job);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.active) {
      this.cancelled.add(this.active.outerId);
      await this.cancelRuntime(this.active);
    }
  }

  private schedulePump(): void {
    if (this.pumping || this.shuttingDown) return;
    this.pumping = true;
    queueMicrotask(() => void this.pump());
  }

  private async pump(): Promise<void> {
    try {
      while (!this.shuttingDown) {
        const next = [...this.jobs.values()]
          .filter((job) => job.status === "queued")
          .sort((a, b) => a.createdAt - b.createdAt)[0];
        if (!next) break;
        await this.run(next);
      }
    } finally {
      this.pumping = false;
      if (
        !this.shuttingDown &&
        [...this.jobs.values()].some((job) => job.status === "queued")
      ) {
        this.schedulePump();
      }
    }
  }

  private async run(job: StoredStemJob): Promise<void> {
    let client: StemMcpClient | null = null;
    let stageDir: string | null = null;
    let innerFinished = false;
    try {
      this.update(job, { status: "running", stage: "connecting", percent: 0 });
      stageDir = this.createStage(job.id);
      client = await StemMcpClient.connect();
      this.active = { outerId: job.id, client };
      this.throwIfCancelled(job.id);

      this.update(job, { stage: "setup", percent: 1 });
      const setup = await client.callTool<SetupReport>("setup_status", {}, 60_000);
      if (!setup.ready) {
        throw new Error(
          setup.message ||
            "Stem Studio's Python environment is not ready. Finish setup in Stem Studio first."
        );
      }
      this.throwIfCancelled(job.id);

      this.update(job, { stage: "probing", percent: 2 });
      const probe = await client.callTool<ProbeReport>(
        "probe_media",
        { path: job.inputPath },
        30_000
      );
      this.throwIfCancelled(job.id);

      const started = await client.callTool<InnerJob>(
        "separate_stems",
        {
          input_path: job.inputPath,
          output_dir: stageDir,
          quality: job.quality,
          multitrack_video: true,
          polish_dialogue: false,
          wait: false,
        },
        30_000
      );
      if (!started.job_id) {
        throw new Error("Stem Studio did not return a background job ID.");
      }
      this.active.innerId = started.job_id;

      const deadline = Date.now() + config.stemTimeoutMinutes * 60_000;
      let result: SeparationResult | null = null;
      while (!result) {
        this.throwIfCancelled(job.id);
        if (Date.now() > deadline) {
          throw new Error(
            `Stem separation exceeded the ${config.stemTimeoutMinutes}-minute safety timeout.`
          );
        }
        await delay(1_500);
        this.throwIfCancelled(job.id);
        const snapshot = await client.callTool<InnerJob>(
          "check_job",
          { job_id: started.job_id },
          30_000
        );
        const stage = snapshot.stage ?? "separating";
        this.update(job, {
          stage,
          percent: overallPercent(stage, snapshot.percent ?? 0),
        });
        if (snapshot.status === "done") {
          result = snapshot.result ?? null;
          if (!result) throw new Error("Stem Studio completed without output metadata.");
          innerFinished = true;
        } else if (snapshot.status === "error") {
          throw new Error(snapshot.error || "Stem Studio separation failed.");
        } else if (snapshot.status === "cancelled") {
          this.cancelled.add(job.id);
          this.throwIfCancelled(job.id);
        }
      }

      // Stop the producer before validating any returned path, closing the
      // replacement window between validation and atomic publication.
      await client.close(true);
      client = null;
      this.active = null;
      this.update(job, { stage: "publishing", percent: 99 });
      const files = this.validateOutputs(stageDir, result, probe.has_video === true);
      const sourceNow = fs.lstatSync(job.inputPath);
      if (
        sourceNow.isSymbolicLink() ||
        !sourceNow.isFile() ||
        sourceNow.dev !== job.sourceDev ||
        sourceNow.ino !== job.sourceIno ||
        sourceNow.size !== job.sourceSize ||
        Math.abs(sourceNow.mtimeMs - job.sourceMtimeMs) > 1
      ) {
        throw new Error("The exported clip changed while its stems were processing.");
      }
      if (fs.existsSync(job.finalDir)) {
        throw new Error("The final stem folder appeared while this job was running.");
      }
      fs.writeFileSync(
        path.join(stageDir, "manifest.json"),
        JSON.stringify(
          {
            version: 1,
            clipId: job.clipId,
            clipName: job.clipName,
            clipFilename: path.basename(job.inputPath),
            quality: job.quality,
            createdAt: Date.now(),
            files: files.map((file) => path.basename(file)),
          },
          null,
          2
        ) + "\n",
        { mode: 0o600 }
      );
      fs.renameSync(stageDir, job.finalDir);
      stageDir = null;
      this.update(job, {
        status: "done",
        stage: "done",
        percent: 100,
        outputDir: job.finalDir,
        error: undefined,
      });
      appendActivity("stems_completed", {
        jobId: job.id,
        clipId: job.clipId,
        clipName: job.clipName,
        quality: job.quality,
        outputDir: job.finalDir,
      });
    } catch (error) {
      if (this.cancelled.has(job.id)) {
        this.update(job, {
          status: "cancelled",
          stage: "cancelled",
          error: undefined,
        });
      } else {
        const message = safeMessage(error);
        this.update(job, {
          status: "error",
          stage: "failed",
          error: message,
        });
        appendActivity("stems_failed", {
          jobId: job.id,
          clipId: job.clipId,
          clipName: job.clipName,
          quality: job.quality,
          error: message,
        });
      }
    } finally {
      if (client) {
        const runtime = this.active?.outerId === job.id ? this.active : null;
        if (runtime?.innerId && !innerFinished) {
          await this.cancelRuntime(runtime);
        } else {
          await client.close(true);
        }
      }
      if (stageDir) fs.rmSync(stageDir, { recursive: true, force: true });
      this.cancelled.delete(job.id);
      if (this.active?.outerId === job.id) this.active = null;
    }
  }

  private createStage(id: string): string {
    const stemsRoot = fs.realpathSync(config.stemsDir);
    const jobsRoot = path.join(config.stemsDir, ".jobs");
    fs.mkdirSync(jobsRoot, { recursive: true, mode: 0o700 });
    const jobsReal = fs.realpathSync(jobsRoot);
    if (!isContained(stemsRoot, jobsReal) || jobsReal === stemsRoot) {
      throw new Error("The private stem-job staging folder is unsafe.");
    }
    const stage = path.join(jobsReal, id);
    fs.mkdirSync(stage, { recursive: false, mode: 0o700 });
    return fs.realpathSync(stage);
  }

  private validateOutputs(
    stageDir: string,
    result: SeparationResult,
    expectVideo: boolean
  ): string[] {
    const candidates: Array<[string, string | undefined | null]> = [
      ["_DIALOGUE.wav", result.stems?.dialogue],
      ["_MUSIC.wav", result.stems?.music],
      ["_SFX.wav", result.stems?.sfx],
      ["_MARRIED.wav", result.married],
      ...(expectVideo
        ? ([['_STEMS.mov', result.multitrack_video]] as Array<[
            string,
            string | undefined | null
          ]>)
        : []),
    ];
    if (!path.isAbsolute(stageDir)) {
      throw new Error("The private stem staging folder is not absolute.");
    }
    const stageStat = fs.lstatSync(stageDir);
    if (stageStat.isSymbolicLink() || !stageStat.isDirectory()) {
      throw new Error("The private stem staging folder changed unexpectedly.");
    }
    const stageReal = fs.realpathSync(stageDir);
    const files: string[] = [];
    for (const [suffix, candidate] of candidates) {
      if (!candidate || !path.basename(candidate).endsWith(suffix)) {
        throw new Error(`Stem Studio did not return the expected ${suffix} output.`);
      }
      if (!path.isAbsolute(candidate)) {
        throw new Error(`Stem Studio returned a non-absolute ${suffix} output.`);
      }
      const lexical = path.resolve(candidate);
      if (!isContained(stageReal, lexical) || lexical === stageReal) {
        throw new Error("Stem Studio returned an output outside the private staging folder.");
      }
      const lst = fs.lstatSync(candidate);
      if (lst.isSymbolicLink() || !lst.isFile() || lst.size <= 0) {
        throw new Error(`Stem Studio returned an invalid ${suffix} output.`);
      }
      const real = fs.realpathSync(candidate);
      if (!isContained(stageReal, real) || real === stageReal) {
        throw new Error("Stem Studio returned an output outside the private staging folder.");
      }
      files.push(real);
    }
    const allowed = new Set(files.map((file) => path.basename(file)));
    for (const entry of fs.readdirSync(stageReal, { withFileTypes: true })) {
      if (!entry.isFile() || !allowed.has(entry.name)) {
        throw new Error(
          "Stem Studio left an unexpected entry in the private staging folder."
        );
      }
    }
    return files;
  }

  private async cancelRuntime(runtime: ActiveRuntime): Promise<void> {
    if (runtime.innerId) {
      try {
        await runtime.client.callTool(
          "cancel_job",
          { job_id: runtime.innerId },
          3_000
        );
      } catch {
        // A broken protocol can prevent cooperative cancellation. Closing the
        // MCP bridge is still useful, but is not advertised as a guarantee.
      }
    }
    await runtime.client.close(true);
  }

  private cleanStaleStages(): void {
    try {
      const stemsRoot = fs.realpathSync(config.stemsDir);
      const jobsRoot = path.join(stemsRoot, ".jobs");
      if (!fs.existsSync(jobsRoot)) return;
      const stat = fs.lstatSync(jobsRoot);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return;
      const realJobs = fs.realpathSync(jobsRoot);
      if (!isContained(stemsRoot, realJobs)) return;
      for (const entry of fs.readdirSync(realJobs, { withFileTypes: true })) {
        if (/^[0-9a-f-]{36}$/i.test(entry.name)) {
          fs.rmSync(path.join(realJobs, entry.name), {
            recursive: true,
            force: true,
          });
        }
      }
    } catch {
      // Best effort; stale cleanup must never block app startup.
    }
  }

  private throwIfCancelled(id: string): void {
    if (this.cancelled.has(id)) throw new Error("Cancelled");
  }

  private update(
    job: StoredStemJob,
    patch: Partial<Pick<StoredStemJob, "status" | "stage" | "percent" | "outputDir" | "error">>
  ): void {
    Object.assign(job, patch, { updatedAt: Date.now() });
    if (patch.error === undefined && "error" in patch) delete job.error;
    this.persist();
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(JOBS_PATH), { recursive: true });
      const tmp = `${JOBS_PATH}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify([...this.jobs.values()].slice(-200), null, 2), {
        mode: 0o600,
      });
      fs.renameSync(tmp, JOBS_PATH);
    } catch {
      // A status persistence failure must not invalidate the exported clip.
    }
  }
}

export const stemJobManager = new StemJobManager();
