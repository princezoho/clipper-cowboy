import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { config } from "../config.js";
import { FFMPEG_PATH, probeFile, run } from "../ffmpeg.js";
import { appendRoundupLineage } from "../util/roundup.js";
import {
  createTrackableCopyIdentity,
  ensureTrackable,
} from "../util/roundupTags.js";
import {
  refreshUniversalPackageArtifacts,
  STEM_ROLES,
  type ClipSheetStem,
  type StemRole,
} from "../util/universalClipper.js";
import {
  findUniversalPackage,
  writeUniversalSheet,
  type PackageLocation,
  type StoredUniversalSheet,
  type UniversalStemExecution,
} from "../util/universalPackageStore.js";
import {
  StemMcpClient,
  buildStemMcpEnvironment,
  type McpToolDefinition,
  type StemMcpConfig,
} from "./mcpClient.js";
import {
  hasMatchingLiveFixtureVerification,
  resolveConfiguredStemMcp,
  type ResolvedStemMcpConfiguration,
} from "./connectorSettings.js";

export type UniversalStemQuality = "high" | "max";
export type UniversalStemConnectorState =
  | "not_configured"
  | "unavailable"
  | "setup_required"
  | "ready"
  | "live_fixture_verified";
export type UniversalStemJobStatus =
  | "queued"
  | "checking_setup"
  | "running"
  | "validating"
  | "ready"
  | "setup_required"
  | "cancelled"
  | "interrupted"
  | "error";

export interface UniversalStemJob {
  id: string;
  packageId: string;
  quality: UniversalStemQuality;
  status: UniversalStemJobStatus;
  stage: string;
  percent: number;
  message: string;
  externalJobId?: string;
  createdAt: number;
  updatedAt: number;
}

interface StoredStemJob extends UniversalStemJob {
  cancelRequested: boolean;
  outputRoot?: string;
  diagnostic?: string;
}

interface StemMcpSession {
  start(): Promise<void>;
  listTools(): Promise<McpToolDefinition[]>;
  callTool<T = unknown>(
    name: string,
    args: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<T>;
  close(): Promise<void>;
  diagnostic(): string | undefined;
}

interface UniversalStemManagerOptions {
  configResolver?: () => StemMcpConfig | null;
  sessionFactory?: (config: StemMcpConfig) => StemMcpSession;
  pollMs?: number;
}

interface StemToolResult {
  status?: string;
  job_id?: string;
  stage?: string;
  percent?: number;
  error?: string;
  message?: string;
  result?: StemDelivery;
  stems?: StemDelivery["stems"];
  married?: string;
  multitrack_video?: string;
}

interface StemDelivery {
  output_dir?: string;
  stems?: {
    dialogue?: string;
    music?: string;
    sfx?: string;
  };
  married?: string;
  multitrack_video?: string;
}

interface AudioShape {
  durationSeconds: number;
  sampleRate: number;
  channels: number;
}

interface PreparedStem {
  stem: ClipSheetStem;
  stagingPath: string;
  sourceLineagePath: string;
  validation: ClipSheetStem["validation"];
  alignment: string;
}

const JOBS_PATH = path.join(config.internalDir, "universal-stem-jobs.json");
const TERMINAL = new Set<UniversalStemJobStatus>([
  "ready",
  "setup_required",
  "cancelled",
  "interrupted",
  "error",
]);
const REQUIRED_TOOLS = [
  "setup_status",
  "separate_stems",
  "check_job",
  "cancel_job",
];

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function publicJob(job: StoredStemJob): UniversalStemJob {
  const {
    cancelRequested: _cancel,
    outputRoot: _output,
    diagnostic: _diagnostic,
    ...result
  } = job;
  return result;
}

function readJobs(): StoredStemJob[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(JOBS_PATH, "utf8")) as StoredStemJob[];
    return Array.isArray(parsed)
      ? parsed.filter(
          (job) =>
            job &&
            typeof job.id === "string" &&
            typeof job.packageId === "string"
        )
      : [];
  } catch {
    return [];
  }
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/\b(?:sk|rk|pk)_[A-Za-z0-9_-]{8,}\b/g, "<redacted>")
    .replace(/(?:\/[^\s:'"]+)+/g, "<path>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function setupMessage(status: unknown): string {
  if (!status || typeof status !== "object") {
    return "Stem Studio setup status was not understood.";
  }
  const value = status as {
    message?: unknown;
    pythonExists?: unknown;
    depsImportable?: unknown;
    modelCachePresent?: unknown;
  };
  if (value.pythonExists === false) {
    return "Stem Studio's Python environment is missing. Open Stem Studio and complete its setup, then retry here.";
  }
  if (value.depsImportable === false) {
    return "Stem Studio's worker dependencies are incomplete. Finish setup in Stem Studio, then retry here.";
  }
  if (value.modelCachePresent === false) {
    return "Stem Studio's selected model is not available. Prepare it in Stem Studio; Clipper will not download models.";
  }
  if (typeof value.message === "string" && value.message.trim()) {
    return safeError(value.message);
  }
  return "Stem Studio is not ready. Finish setup in Stem Studio, then retry.";
}

function asReadyStatus(status: unknown): boolean {
  if (!status || typeof status !== "object") return false;
  const value = status as {
    ready?: unknown;
    pythonExists?: unknown;
    depsImportable?: unknown;
    modelCachePresent?: unknown;
  };
  return (
    value.ready === true &&
    value.pythonExists === true &&
    value.depsImportable === true &&
    value.modelCachePresent === true
  );
}

function deliveryFromResult(result: StemToolResult): StemDelivery | null {
  if (result.result && typeof result.result === "object") return result.result;
  if (result.stems || result.married) {
    return {
      stems: result.stems,
      married: result.married,
      multitrack_video: result.multitrack_video,
    };
  }
  return null;
}

function deliveryPaths(delivery: StemDelivery): Record<StemRole, string> {
  const paths: Partial<Record<StemRole, string>> = {
    DIALOGUE: delivery.stems?.dialogue,
    MUSIC: delivery.stems?.music,
    SFX: delivery.stems?.sfx,
    MARRIED: delivery.married,
  };
  for (const role of STEM_ROLES) {
    if (typeof paths[role] !== "string" || !path.isAbsolute(paths[role]!)) {
      throw new Error(`Stem Studio did not return a ${role} output path.`);
    }
  }
  return paths as Record<StemRole, string>;
}

function canonicalReturnedFile(outputRoot: string, candidate: string): string {
  const root = fs.realpathSync(outputRoot);
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1) {
    throw new Error("Stem Studio returned a non-regular or empty output.");
  }
  const real = fs.realpathSync(candidate);
  if (real === root || !contained(root, real)) {
    throw new Error("Stem Studio returned an output outside its fixed job directory.");
  }
  return real;
}

async function audioShape(file: string): Promise<AudioShape> {
  const probe = await probeFile(file);
  const stream = probe.streams.find((item) => item.codec_type === "audio");
  const durationSeconds = Number(probe.format.duration ?? 0);
  const sampleRate = Number(stream?.sample_rate ?? 0);
  const channels = Number(stream?.channels ?? 0);
  if (
    !stream ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    !Number.isInteger(sampleRate) ||
    sampleRate < 8_000 ||
    !Number.isInteger(channels) ||
    channels < 1
  ) {
    throw new Error("Stem output has invalid audio metadata.");
  }
  return { durationSeconds, sampleRate, channels };
}

function alignmentTolerance(sampleRate: number): number {
  return Math.max(0.05, 2 / sampleRate);
}

function allocateUniqueDirectory(root: string, preferred: string): string {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const realRoot = fs.realpathSync(root);
  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    const name = suffix === 1 ? preferred : `${preferred}_${suffix}`;
    const candidate = path.join(realRoot, name);
    if (!contained(realRoot, candidate) || candidate === realRoot) {
      throw new Error("unsafe derived stems destination");
    }
    try {
      fs.mkdirSync(candidate, { mode: 0o700 });
      return fs.realpathSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("could not allocate a unique stems destination");
}

function copyExclusive(source: string, destination: string): void {
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
}

async function trimStemExact(
  input: string,
  output: string,
  startSeconds: number,
  endSeconds: number,
  shape: AudioShape
): Promise<AudioShape> {
  const startSample = Math.round(startSeconds * shape.sampleRate);
  const endSample = Math.round(endSeconds * shape.sampleRate);
  if (endSample <= startSample) throw new Error("clip stem range is empty");
  const result = await run(FFMPEG_PATH, [
    "-n",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    input,
    "-map",
    "0:a:0",
    "-af",
    `atrim=start_sample=${startSample}:end_sample=${endSample},asetpts=PTS-STARTPTS`,
    "-ar",
    String(shape.sampleRate),
    "-ac",
    String(shape.channels),
    "-c:a",
    "pcm_s24le",
    output,
  ]);
  if (result.code !== 0) {
    throw new Error("Could not derive an exact clip-aligned stem.");
  }
  const derived = await audioShape(output);
  const expected = (endSample - startSample) / shape.sampleRate;
  if (
    derived.sampleRate !== shape.sampleRate ||
    derived.channels !== shape.channels ||
    Math.abs(derived.durationSeconds - expected) >
      alignmentTolerance(shape.sampleRate)
  ) {
    throw new Error("Derived clip stem failed sample alignment validation.");
  }
  return derived;
}

async function prepareSourceOutputs(
  location: PackageLocation,
  source: StoredUniversalSheet["sources"][number],
  delivery: StemDelivery,
  sourceOutputRoot: string,
  flatStage: string
): Promise<PreparedStem[]> {
  const fullSource = path.join(location.mediaDir, source.fullSourceFilename);
  const sourceProbe = await probeFile(fullSource);
  const sourceAudio = sourceProbe.streams.find(
    (stream) => stream.codec_type === "audio"
  );
  const sourceDuration = Number(sourceProbe.format.duration ?? 0);
  if (!sourceAudio || !Number.isFinite(sourceDuration) || sourceDuration <= 0) {
    throw new Error("Prepared full source does not contain valid audio.");
  }

  const returned = deliveryPaths(delivery);
  const canonical = {} as Record<StemRole, string>;
  const shapes = {} as Record<StemRole, AudioShape>;
  for (const role of STEM_ROLES) {
    canonical[role] = canonicalReturnedFile(sourceOutputRoot, returned[role]);
    shapes[role] = await audioShape(canonical[role]);
  }
  const reference = shapes.DIALOGUE;
  const tolerance = alignmentTolerance(reference.sampleRate);
  for (const role of STEM_ROLES) {
    const shape = shapes[role];
    if (
      shape.sampleRate !== reference.sampleRate ||
      shape.channels !== reference.channels ||
      Math.abs(shape.durationSeconds - reference.durationSeconds) > tolerance ||
      Math.abs(shape.durationSeconds - sourceDuration) > 0.25
    ) {
      throw new Error(
        `${role} stem sample rate, channels, or duration does not align with the full source.`
      );
    }
  }

  const prepared: PreparedStem[] = [];
  for (const stem of source.stems) {
    if (stem.status === "included") continue;
    const sourceStem = canonical[stem.stemRole];
    const stagingPath = path.join(flatStage, stem.filename);
    copyExclusive(sourceStem, stagingPath);
    prepared.push({
      stem,
      stagingPath,
      sourceLineagePath: sourceStem,
      validation: {
        ...shapes[stem.stemRole],
        alignmentToleranceSeconds: tolerance,
      },
      alignment:
        "Official Stem Studio full-source output validated at source time 0 with matching duration, sample rate, and channel count.",
    });
  }

  const clips = location.sheet.clips.filter(
    (clip) => clip.sourceId === source.sourceId
  );
  for (const clip of clips) {
    for (const stem of clip.stems) {
      if (stem.status === "included") continue;
      const fullStem = canonical[stem.stemRole];
      const stagingPath = path.join(flatStage, stem.filename);
      const derived = await trimStemExact(
        fullStem,
        stagingPath,
        clip.sourceInSeconds,
        clip.sourceOutSeconds,
        shapes[stem.stemRole]
      );
      prepared.push({
        stem,
        stagingPath,
        sourceLineagePath: fullStem,
        validation: {
          ...derived,
          alignmentToleranceSeconds: alignmentTolerance(derived.sampleRate),
        },
        alignment:
          "Derived from the validated full-source stem using the clip sheet's exact source in/out sample boundaries; clip stem time 0 equals source in.",
      });
    }
  }
  return prepared;
}

function publishPreparedBatch(
  location: PackageLocation,
  prepared: PreparedStem[]
): void {
  const destinations = prepared.map((item) =>
    path.join(location.mediaDir, item.stem.filename)
  );
  if (
    new Set(destinations.map((item) => item.toLowerCase())).size !==
    destinations.length
  ) {
    throw new Error("duplicate flat stem destination");
  }
  for (const destination of destinations) {
    if (
      path.dirname(destination) !== location.mediaDir ||
      fs.existsSync(destination)
    ) {
      throw new Error("flat stem destination is occupied or unsafe");
    }
  }

  const created: string[] = [];
  try {
    for (let index = 0; index < prepared.length; index += 1) {
      copyExclusive(prepared[index].stagingPath, destinations[index]);
      created.push(destinations[index]);
    }
  } catch (error) {
    for (const generated of created) {
      try {
        fs.rmSync(generated);
      } catch {
        // Manifest remains unchanged, so a failed batch is never advertised.
      }
    }
    throw error;
  }

  for (let index = 0; index < prepared.length; index += 1) {
    const item = prepared[index];
    const destination = destinations[index];
    const sourceTag = ensureTrackable(item.sourceLineagePath);
    const outputTag = createTrackableCopyIdentity(destination);
    appendRoundupLineage({
      sourcePath: item.sourceLineagePath,
      outputPath: destination,
      sourceTagId: sourceTag?.id,
      outputTagId: outputTag?.id,
      ...(item.stem.clipId ? { clipId: item.stem.clipId } : {}),
      packageId: location.sheet.packageId,
    });
    item.stem.path = destination;
    item.stem.airTagId = outputTag?.id ?? null;
    item.stem.status = "included";
    item.stem.validation = item.validation;
    item.stem.alignment = item.alignment;
  }
}

function writeStemHandoffStatus(
  location: PackageLocation,
  execution: UniversalStemExecution
): void {
  const handoffPath = path.join(location.folder, "stem-handoff.json");
  let handoff: Record<string, unknown> = {};
  try {
    handoff = JSON.parse(fs.readFileSync(handoffPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    // Package identity and clip sheet remain the source of truth.
  }
  handoff.execution = execution;
  handoff.executionConnector = "official-stem-studio-mcp";
  handoff.setupPolicy =
    "Clipper never invokes setup_environment or downloads models.";
  const temp = `${handoffPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(handoff, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  fs.renameSync(temp, handoffPath);
}

export class UniversalStemManager {
  private jobs = new Map<string, StoredStemJob>();
  private pumping = false;
  private stopping = false;
  private current:
    | {
        job: StoredStemJob;
        session: StemMcpSession;
        externalJobId?: string;
        process?: ChildProcess;
      }
    | undefined;
  private readonly options: Required<
    Pick<UniversalStemManagerOptions, "pollMs">
  > &
    Omit<UniversalStemManagerOptions, "pollMs">;

  constructor(options: UniversalStemManagerOptions = {}) {
    this.options = {
      pollMs: options.pollMs ?? 1_000,
      configResolver: options.configResolver,
      sessionFactory: options.sessionFactory,
    };
    for (const job of readJobs().slice(-200)) {
      if (!TERMINAL.has(job.status)) {
        job.status = "interrupted";
        job.stage = "Interrupted";
        job.message =
          "Clipper stopped during separation. Retry starts a new isolated Stem Studio job; prior generated output is not published.";
        job.updatedAt = Date.now();
      }
      this.jobs.set(job.id, job);
    }
    this.persist();
  }

  list(packageId?: string): UniversalStemJob[] {
    return [...this.jobs.values()]
      .filter((job) => !packageId || job.packageId === packageId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(publicJob);
  }

  get(id: string): UniversalStemJob | undefined {
    const job = this.jobs.get(id);
    return job ? publicJob(job) : undefined;
  }

  async inspectConnector(): Promise<{
    state: UniversalStemConnectorState;
    configured: boolean;
    connected: boolean;
    ready: boolean;
    setupRequired: boolean;
    liveFixtureVerified: boolean;
    message: string;
    entry: string | null;
    version: string | null;
    configuredBy: "settings" | "environment" | null;
    qualities: UniversalStemQuality[];
    setupAutomatic: false;
  }> {
    const resolved = this.resolveConfiguration();
    const configValue = resolved.config;
    if (!configValue) {
      return {
        state: "not_configured",
        configured: false,
        connected: false,
        ready: false,
        setupRequired: false,
        liveFixtureVerified: false,
        message:
          resolved.issue ??
          "Official Stem Studio MCP is not configured. Choose its packaged launcher or built dist/index.js in Settings.",
        entry: null,
        version: null,
        configuredBy: resolved.source,
        qualities: ["high", "max"],
        setupAutomatic: false,
      };
    }
    const session = this.createSession(configValue);
    try {
      await session.start();
      this.assertTools(await session.listTools());
      const status = await session.callTool("setup_status", {}, 10_000);
      const ready = asReadyStatus(status);
      const liveFixtureVerified =
        ready && hasMatchingLiveFixtureVerification(configValue);
      return {
        state: liveFixtureVerified
          ? "live_fixture_verified"
          : ready
            ? "ready"
            : "setup_required",
        configured: true,
        connected: true,
        ready,
        setupRequired: !ready,
        liveFixtureVerified,
        message: liveFixtureVerified
          ? "Official Stem Studio MCP is ready and a generated High-quality fixture was verified."
          : ready
            ? "Official Stem Studio MCP is connected and ready."
            : setupMessage(status),
        entry: configValue.entry,
        version: configValue.version ?? null,
        configuredBy: resolved.source,
        qualities: ["high", "max"],
        setupAutomatic: false,
      };
    } catch (error) {
      return {
        state: "unavailable",
        configured: true,
        connected: false,
        ready: false,
        setupRequired: false,
        liveFixtureVerified: false,
        message: safeError(error) || "Official Stem Studio MCP is unavailable.",
        entry: configValue.entry,
        version: configValue.version ?? null,
        configuredBy: resolved.source,
        qualities: ["high", "max"],
        setupAutomatic: false,
      };
    } finally {
      await session.close();
    }
  }

  enqueue(input: {
    packageId: string;
    quality?: UniversalStemQuality;
    confirmedModelExecution: true;
    confirmedMaxLicense?: true;
  }): UniversalStemJob {
    const quality = input.quality ?? "high";
    if (quality === "max" && input.confirmedMaxLicense !== true) {
      throw new Error(
        "Max requires explicit licensing confirmation; High is the strongest automatic recommendation."
      );
    }
    const location = findUniversalPackage(input.packageId);
    if (!location || location.sheet.incomplete) {
      throw new Error("completed Universal Clipper package not found");
    }
    const existing = [...this.jobs.values()].find(
      (job) => job.packageId === input.packageId && !TERMINAL.has(job.status)
    );
    if (existing) return publicJob(existing);
    const now = Date.now();
    const job: StoredStemJob = {
      id: crypto.randomUUID(),
      packageId: input.packageId,
      quality,
      status: "queued",
      stage: "Waiting for official Stem Studio MCP",
      percent: 0,
      message:
        "Model execution was confirmed. Clipper will check setup without installing or downloading anything.",
      createdAt: now,
      updatedAt: now,
      cancelRequested: false,
    };
    this.jobs.set(job.id, job);
    this.updateSheet(location, job);
    this.persist();
    this.schedule();
    return publicJob(job);
  }

  async cancel(id: string): Promise<UniversalStemJob | undefined> {
    const job = this.jobs.get(id);
    if (!job || TERMINAL.has(job.status)) return job && publicJob(job);
    job.cancelRequested = true;
    if (job.status === "queued") {
      this.update(job, {
        status: "cancelled",
        stage: "Cancelled",
        message: "Separation was cancelled before Stem Studio started.",
      });
      const location = findUniversalPackage(job.packageId);
      if (location) this.updateSheet(location, job);
    } else if (this.current?.job.id === id && this.current.externalJobId) {
      try {
        await this.current.session.callTool(
          "cancel_job",
          { job_id: this.current.externalJobId },
          10_000
        );
      } catch {
        // Closing the MCP session below is the fallback cancellation boundary.
      }
    }
    return publicJob(job);
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.current) {
      await this.cancel(this.current.job.id);
      await this.current.session.close();
    }
  }

  private resolveConfiguration(): ResolvedStemMcpConfiguration {
    if (this.options.configResolver) {
      return {
        config: this.options.configResolver(),
        source: null,
      };
    }
    return resolveConfiguredStemMcp();
  }

  private resolveConfig(): StemMcpConfig | null {
    return this.resolveConfiguration().config;
  }

  private createSession(configValue: StemMcpConfig): StemMcpSession {
    return (
      this.options.sessionFactory?.(configValue) ??
      new StemMcpClient(configValue, buildStemMcpEnvironment())
    );
  }

  private assertTools(tools: McpToolDefinition[]): void {
    const names = new Set(tools.map((tool) => tool.name));
    const missing = REQUIRED_TOOLS.filter((name) => !names.has(name));
    if (missing.length) {
      throw new Error(
        `Official Stem Studio MCP is missing required tools: ${missing.join(", ")}.`
      );
    }
  }

  private schedule(): void {
    if (this.pumping || this.stopping) return;
    this.pumping = true;
    queueMicrotask(() => void this.pump());
  }

  private async pump(): Promise<void> {
    try {
      while (!this.stopping) {
        const next = [...this.jobs.values()].find(
          (job) => job.status === "queued"
        );
        if (!next) return;
        await this.runJob(next);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async runJob(job: StoredStemJob): Promise<void> {
    const location = findUniversalPackage(job.packageId);
    if (!location) {
      this.update(job, {
        status: "error",
        stage: "Package unavailable",
        message: "The package no longer exists.",
      });
      return;
    }
    const configValue = this.resolveConfig();
    if (!configValue) {
      this.update(job, {
        status: "setup_required",
        stage: "Connector not configured",
        message:
          "Choose the official Stem Studio MCP launcher or built dist/index.js in Settings, then retry. No setup was run.",
      });
      this.updateSheet(location, job);
      return;
    }

    const session = this.createSession(configValue);
    this.current = { job, session };
    try {
      this.update(job, {
        status: "checking_setup",
        stage: "Checking Stem Studio",
        percent: 1,
        message: "Checking the official MCP without running setup.",
      });
      this.updateSheet(location, job);
      await session.start();
      this.assertTools(await session.listTools());
      const status = await session.callTool("setup_status", {}, 10_000);
      if (!asReadyStatus(status)) {
        this.update(job, {
          status: "setup_required",
          stage: "Stem Studio setup required",
          message: setupMessage(status),
        });
        this.updateSheet(location, job);
        return;
      }
      if (job.cancelRequested) throw new Error("cancelled");

      const outputRoot = allocateUniqueDirectory(
        config.stemsDir,
        `universal-${job.packageId.slice(0, 8)}`
      );
      job.outputRoot = outputRoot;
      const flatStage = path.join(outputRoot, "package-flat");
      fs.mkdirSync(flatStage, { mode: 0o700 });
      const allPrepared: PreparedStem[] = [];

      for (
        let sourceIndex = 0;
        sourceIndex < location.sheet.sources.length;
        sourceIndex += 1
      ) {
        const source = location.sheet.sources[sourceIndex];
        if (job.cancelRequested) throw new Error("cancelled");
        const sourceOutput = path.join(
          outputRoot,
          `source-${String(sourceIndex + 1).padStart(2, "0")}`
        );
        fs.mkdirSync(sourceOutput, { mode: 0o700 });
        const inputPath = path.join(location.mediaDir, source.fullSourceFilename);
        if (!fs.statSync(inputPath).isFile()) {
          throw new Error("prepared package source is unavailable");
        }
        this.update(job, {
          status: "running",
          stage: `Separating ${source.fullSourceFilename}`,
          percent: Math.round((sourceIndex / location.sheet.sources.length) * 80),
          message: `Official Stem Studio MCP · ${job.quality} quality`,
          externalJobId: undefined,
        });
        this.updateSheet(location, job);
        let result = await session.callTool<StemToolResult>(
          "separate_stems",
          {
            input_path: inputPath,
            output_dir: sourceOutput,
            quality: job.quality,
            multitrack_video: false,
            polish_dialogue: false,
            wait: false,
          },
          20_000
        );
        const externalId = result.job_id;
        if (externalId) {
          job.externalJobId = externalId;
          this.current.externalJobId = externalId;
          this.persist();
        }
        let delivery = deliveryFromResult(result);
        while (!delivery) {
          if (job.cancelRequested) {
            if (externalId) {
              await session.callTool(
                "cancel_job",
                { job_id: externalId },
                10_000
              );
            }
            throw new Error("cancelled");
          }
          if (!externalId) {
            throw new Error("Stem Studio returned neither outputs nor a job ID.");
          }
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(10, this.options.pollMs))
          );
          result = await session.callTool<StemToolResult>(
            "check_job",
            { job_id: externalId },
            20_000
          );
          const statusName = String(result.status ?? "").toLowerCase();
          if (statusName === "error") {
            throw new Error(
              result.error || result.message || "Stem Studio separation failed."
            );
          }
          if (statusName === "cancelled") throw new Error("cancelled");
          const sourceProgress = Math.max(
            0,
            Math.min(100, Number(result.percent ?? 0))
          );
          this.update(job, {
            status: "running",
            stage:
              typeof result.stage === "string"
                ? result.stage
                : `Separating ${source.fullSourceFilename}`,
            percent: Math.round(
              ((sourceIndex + sourceProgress / 100) /
                location.sheet.sources.length) *
                80
            ),
            message: `Official Stem Studio MCP · ${job.quality} quality`,
            externalJobId: externalId,
          });
          this.updateSheet(location, job);
          delivery = deliveryFromResult(result);
          if (statusName === "done" && !delivery) {
            throw new Error("Stem Studio completed without an output manifest.");
          }
        }

        this.update(job, {
          status: "validating",
          stage: `Validating ${source.fullSourceFilename}`,
          percent:
            80 +
            Math.round(
              ((sourceIndex + 0.5) / location.sheet.sources.length) * 15
            ),
          message:
            "Checking containment, duration, sample rate, channels, and clip alignment.",
        });
        this.updateSheet(location, job);
        allPrepared.push(
          ...(await prepareSourceOutputs(
            location,
            source,
            delivery,
            sourceOutput,
            flatStage
          ))
        );
      }

      if (job.cancelRequested) throw new Error("cancelled");
      const remaining = [
        ...location.sheet.sources.flatMap((source) => source.stems),
        ...location.sheet.clips.flatMap((clip) => clip.stems),
      ].filter((stem) => stem.status === "planned").length;
      if (allPrepared.length !== remaining) {
        throw new Error("Stem output set is incomplete or ambiguous.");
      }
      publishPreparedBatch(location, allPrepared);
      this.update(job, {
        status: "ready",
        stage: "Ready for Premiere",
        percent: 100,
        message:
          "All full-source and clip-aligned stems validated and published into the flat package.",
        externalJobId: undefined,
      });
      this.updateSheet(location, job, true);
    } catch (error) {
      const cancelled =
        job.cancelRequested || (error instanceof Error && error.message === "cancelled");
      this.update(job, cancelled
        ? {
            status: "cancelled",
            stage: "Cancelled",
            message:
              "Stem Studio cancellation was requested. Generated job output was not published into the package.",
            externalJobId: undefined,
          }
        : {
            status: "error",
            stage: "Stem separation failed",
            message:
              safeError(error) ||
              "Stem outputs failed validation and were not published.",
            diagnostic: session.diagnostic(),
            externalJobId: undefined,
          });
      this.updateSheet(location, job, true);
    } finally {
      await session.close();
      this.current = undefined;
    }
  }

  private update(
    job: StoredStemJob,
    patch: Partial<
      Pick<
        StoredStemJob,
        | "status"
        | "stage"
        | "percent"
        | "message"
        | "externalJobId"
        | "diagnostic"
      >
    >
  ): void {
    Object.assign(job, patch, { updatedAt: Date.now() });
    if ("externalJobId" in patch && patch.externalJobId === undefined) {
      delete job.externalJobId;
    }
    this.persist();
  }

  private updateSheet(
    location: PackageLocation,
    job: StoredStemJob,
    refreshAll = false
  ): void {
    const execution: UniversalStemExecution = {
      status:
        job.status === "ready"
          ? "ready"
          : job.status,
      quality: job.quality,
      jobId: job.id,
      ...(job.externalJobId ? { externalJobId: job.externalJobId } : {}),
      stage: job.stage,
      percent: job.percent,
      message: job.message,
      updatedAt: new Date(job.updatedAt).toISOString(),
    };
    location.sheet.stemExecution = execution;
    if (refreshAll) {
      refreshUniversalPackageArtifacts(location.folder, location.sheet);
    } else {
      writeUniversalSheet(location, location.sheet);
    }
    writeStemHandoffStatus(location, execution);
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(JOBS_PATH), { recursive: true, mode: 0o700 });
      const temp = `${JOBS_PATH}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(
        temp,
        JSON.stringify([...this.jobs.values()].slice(-200), null, 2) + "\n",
        { flag: "wx", mode: 0o600 }
      );
      fs.renameSync(temp, JOBS_PATH);
    } catch {
      // Package manifests remain authoritative if job history cannot persist.
    }
  }
}

export const universalStemManager = new UniversalStemManager();

export const universalStemTestHelpers = {
  alignmentTolerance,
  asReadyStatus,
  audioShape,
  canonicalReturnedFile,
  deliveryFromResult,
  deliveryPaths,
  prepareSourceOutputs,
  publishPreparedBatch,
  setupMessage,
  trimStemExact,
};
