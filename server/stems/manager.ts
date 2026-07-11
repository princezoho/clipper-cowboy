import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { config } from "../config.js";
import { ffmpeg, probeFile } from "../ffmpeg.js";
import { appendActivity } from "../util/activity.js";
import { audioEngineManager } from "../audio/engine.js";
import type { StemJobSummary, StemQuality, StemStudioStatus } from "./types.js";

interface StoredJob extends StemJobSummary {
  inputPath: string;
  finalDir: string;
  sourceSize: number;
  sourceMtimeMs: number;
}

const JOBS_PATH = path.join(config.internalDir, "stem-jobs.json");
const TERMINAL = new Set(["done", "error", "cancelled", "interrupted"]);

function contained(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/python 3/i.test(raw)) return "Audio splitting needs Python 3 installed on this Mac.";
  return "Audio splitting could not complete. Check the audio engine and try again.";
}

function readJobs(): StoredJob[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(JOBS_PATH, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((job) => job?.id && job.inputPath) : [];
  } catch {
    return [];
  }
}

function publicJob(job: StoredJob): StemJobSummary {
  const { inputPath: _input, finalDir: _dir, sourceSize: _size, sourceMtimeMs: _mtime, ...result } = job;
  return result;
}

function safeFolder(filename: string, clipId: string): string {
  const name = path.basename(filename, path.extname(filename))
    .normalize("NFKC").replace(/[\\/\0]/g, "_").replace(/^\.+/, "").trim().slice(0, 160);
  return name || `clip-${clipId}`;
}

export class StemJobManager {
  private jobs = new Map<string, StoredJob>();
  private current: { id: string; process?: ChildProcess } | null = null;
  private cancelled = new Set<string>();
  private pumping = false;
  private stopping = false;

  constructor() {
    for (const job of readJobs().slice(-200)) {
      if (job.status === "queued" || job.status === "running") {
        job.status = "interrupted";
        job.stage = "interrupted";
        job.error = "Clipper Cowboy stopped before audio splitting finished.";
        job.updatedAt = Date.now();
      }
      this.jobs.set(job.id, job);
    }
    this.persist();
  }

  async inspectStudio(): Promise<StemStudioStatus> {
    return audioEngineManager.inspect();
  }

  list(): StemJobSummary[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(publicJob);
  }

  get(id: string): StemJobSummary | undefined {
    const job = this.jobs.get(id);
    return job && publicJob(job);
  }

  enqueue(input: { clipId: string; clipName: string; clipPath: string; quality: StemQuality }): StemJobSummary {
    const existing = [...this.jobs.values()].find((job) => job.clipId === input.clipId && !TERMINAL.has(job.status));
    if (existing) return publicJob(existing);
    const now = Date.now();
    const id = crypto.randomUUID();
    let error: string | undefined;
    let canonical = "";
    let finalDir = "";
    let stat: fs.Stats | undefined;
    try {
      const clips = fs.realpathSync(config.clipsDir);
      const source = fs.lstatSync(input.clipPath);
      if (source.isSymbolicLink() || !source.isFile()) throw new Error("unsafe input");
      canonical = fs.realpathSync(input.clipPath);
      if (!contained(clips, canonical) || canonical === clips) throw new Error("unsafe input");
      const outputRoot = fs.realpathSync(config.stemsDir);
      finalDir = path.join(outputRoot, safeFolder(path.basename(canonical), input.clipId));
      if (!contained(outputRoot, finalDir) || finalDir === outputRoot || fs.existsSync(finalDir)) throw new Error("unsafe output");
      stat = fs.statSync(canonical);
      const engine = audioEngineManager.inspect();
      if (!engine.ready) throw new Error(engine.message);
    } catch (caught) {
      error = safeMessage(caught);
    }
    const job: StoredJob = {
      id, clipId: input.clipId, clipName: input.clipName, quality: input.quality,
      status: error ? "error" : "queued", stage: error ? "not_started" : "queued",
      percent: 0, ...(error ? { error } : {}), createdAt: now, updatedAt: now,
      inputPath: canonical, finalDir, sourceSize: stat?.size ?? 0, sourceMtimeMs: stat?.mtimeMs ?? 0,
    };
    this.jobs.set(id, job);
    this.persist();
    appendActivity(error ? "stems_failed" : "stems_queued", { jobId: id, clipId: input.clipId, quality: input.quality, ...(error ? { error } : {}) });
    if (!error) this.schedule();
    return publicJob(job);
  }

  async cancel(id: string): Promise<StemJobSummary | undefined> {
    const job = this.jobs.get(id);
    if (!job || TERMINAL.has(job.status)) return job && publicJob(job);
    this.cancelled.add(id);
    if (job.status === "queued") this.update(job, { status: "cancelled", stage: "cancelled", error: undefined });
    if (this.current?.id === id) this.current.process?.kill("SIGTERM");
    return publicJob(job);
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.current) await this.cancel(this.current.id);
  }

  private schedule(): void {
    if (this.pumping || this.stopping) return;
    this.pumping = true;
    queueMicrotask(() => void this.pump());
  }

  private async pump(): Promise<void> {
    try {
      while (!this.stopping) {
        const next = [...this.jobs.values()].find((job) => job.status === "queued");
        if (!next) return;
        await this.run(next);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async run(job: StoredJob): Promise<void> {
    let stage = "";
    try {
      this.update(job, { status: "running", stage: "preparing", percent: 2 });
      stage = this.createStage(job.id);
      const raw = path.join(stage, "raw");
      fs.mkdirSync(raw, { mode: 0o700 });
      this.current = { id: job.id };
      this.update(job, { stage: "separating", percent: 15 });
      await audioEngineManager.separate(job.inputPath, raw, job.quality, (process) => {
        if (this.current?.id === job.id) this.current.process = process;
      }, (stageName, percent) => {
        this.update(job, { stage: stageName, percent: Math.min(80, 15 + Math.round(percent * 0.65)) });
      });
      if (this.cancelled.has(job.id)) throw new Error("cancelled");
      this.update(job, { stage: "writing", percent: 82 });
      await this.normaliseOutputs(job, stage, raw);
      if (this.cancelled.has(job.id)) throw new Error("cancelled");
      const sourceNow = fs.statSync(job.inputPath);
      if (sourceNow.size !== job.sourceSize || Math.abs(sourceNow.mtimeMs - job.sourceMtimeMs) > 1) throw new Error("source changed");
      fs.rmSync(raw, { recursive: true, force: true });
      fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify({
        version: 1, clipId: job.clipId, clipName: job.clipName, quality: job.quality, createdAt: Date.now(),
        files: fs.readdirSync(stage).filter((entry) => entry !== "manifest.json"),
      }, null, 2) + "\n", { mode: 0o600 });
      this.update(job, { stage: "publishing", percent: 99 });
      fs.renameSync(stage, job.finalDir);
      stage = "";
      this.update(job, { status: "done", stage: "done", percent: 100, outputDir: job.finalDir, error: undefined });
      appendActivity("stems_completed", { jobId: job.id, clipId: job.clipId, quality: job.quality });
    } catch (error) {
      if (this.cancelled.has(job.id)) {
        this.update(job, { status: "cancelled", stage: "cancelled", error: undefined });
      } else {
        const message = safeMessage(error);
        this.update(job, { status: "error", stage: "failed", error: message });
        appendActivity("stems_failed", { jobId: job.id, clipId: job.clipId, quality: job.quality, error: message });
      }
    } finally {
      if (stage) fs.rmSync(stage, { recursive: true, force: true });
      this.current = null;
      this.cancelled.delete(job.id);
    }
  }

  private createStage(id: string): string {
    const root = fs.realpathSync(config.stemsDir);
    const jobs = path.join(root, ".jobs");
    fs.mkdirSync(jobs, { recursive: true, mode: 0o700 });
    const realJobs = fs.realpathSync(jobs);
    if (!contained(root, realJobs)) throw new Error("unsafe staging");
    const stage = path.join(realJobs, id);
    fs.mkdirSync(stage, { mode: 0o700 });
    return fs.realpathSync(stage);
  }

  private async normaliseOutputs(job: StoredJob, stage: string, raw: string): Promise<void> {
    const files = this.findRawFiles(raw);
    const dialogue = files.get("dialogue");
    const music = files.get("music");
    const effects = files.get("effects");
    if (!dialogue || !music || !effects) throw new Error("audio engine output incomplete");
    for (const stem of [dialogue, music, effects]) {
      const probe = await probeFile(stem);
      const audio = probe.streams.find((stream) => stream.codec_type === "audio");
      if (!audio || !Number.isFinite(Number(probe.format.duration)) || Number(probe.format.duration) <= 0) {
        throw new Error("audio engine output is not a valid WAV stem");
      }
    }
    const base = safeFolder(path.basename(job.inputPath), job.clipId);
    const write = async (args: string[]) => {
      const result = await ffmpeg(args);
      if (result.code !== 0) throw new Error("audio render failed");
    };
    await write(["-i", dialogue, "-vn", "-c:a", "pcm_s16le", path.join(stage, `${base}_DIALOGUE.wav`)]);
    await write(["-i", music, "-vn", "-c:a", "pcm_s16le", path.join(stage, `${base}_MUSIC.wav`)]);
    await write(["-i", effects, "-vn", "-c:a", "pcm_s16le", path.join(stage, `${base}_SFX.wav`)]);
    await write(["-i", job.inputPath, "-vn", "-c:a", "pcm_s16le", path.join(stage, `${base}_MARRIED.wav`)]);
  }

  private findRawFiles(root: string): Map<string, string> {
    const result = new Map<string, string>();
    const visit = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const candidate = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(candidate);
        else if (entry.isFile() && ["dialogue.wav", "music.wav", "effects.wav"].includes(entry.name)) {
          const real = fs.realpathSync(candidate);
          if (contained(root, real) && fs.statSync(real).size > 0) result.set(path.basename(real, ".wav"), real);
        }
      }
    };
    visit(root);
    return result;
  }

  private update(job: StoredJob, patch: Partial<Pick<StoredJob, "status" | "stage" | "percent" | "outputDir" | "error">>): void {
    Object.assign(job, patch, { updatedAt: Date.now() });
    if ("error" in patch && patch.error === undefined) delete job.error;
    this.persist();
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(JOBS_PATH), { recursive: true });
      const temp = `${JOBS_PATH}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(temp, JSON.stringify([...this.jobs.values()].slice(-200), null, 2), { mode: 0o600 });
      fs.renameSync(temp, JOBS_PATH);
    } catch { /* status persistence must not lose exports */ }
  }
}

export const stemJobManager = new StemJobManager();
