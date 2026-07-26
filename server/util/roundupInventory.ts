import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  config,
  onConfigReload,
  SUPPORTED_IMAGE_EXTS,
  SUPPORTED_VIDEO_EXTS,
} from "../config.js";
import {
  ROUNDUP_SKIP_DIR_NAMES,
  SUPPORTED_AUDIO_EXTS,
  fingerprintFile,
  isRoundupMediaPath,
  listAllowlistedWatchRoots,
  type RoundupWatchRoot,
} from "./roundup.js";
import { publicError } from "./publicError.js";
import {
  ensureTrackable,
  findTagForPath,
  flushTagsSync,
} from "./roundupTags.js";

export type RoundupMediaKind = "video" | "image" | "audio";

export interface RoundupManifestItem {
  source: string;
  identity: string;
  mediaKind: RoundupMediaKind;
  intendedExportDestination: string;
  sourcePolicy: "read-only-preserve";
  collisionPolicy: "allocate-unique-never-overwrite";
  destructiveActionPolicy: "none";
  stemsEligible: boolean;
  sourceRootId: string;
  sourceRootReason: RoundupWatchRoot["reason"];
  size: number;
  mtimeMs: number;
}

export interface RoundupInventoryJob {
  id: string;
  status: "queued" | "running" | "paused" | "done" | "cancelled" | "error";
  scanned: number;
  mediaCandidates: number;
  discovered: number;
  tagged: number;
  alreadyTagged: number;
  totalBytes: number;
  skipped: number;
  placeholderSkips: number;
  errors: number;
  complete: boolean;
  capped: boolean;
  limit: number;
  rootIds: string[];
  items: RoundupManifestItem[];
  startedAt: number;
  updatedAt: number;
  checkpoint: RoundupInventoryCheckpoint;
  error?: string;
}

export interface RoundupInventoryCheckpoint {
  rootIndex: number;
  directories: { relativeDir: string; afterName: string | null }[];
}

// `let`, not `const`: export/handoff destinations and the job checkpoint all
// live inside the project folder, which the first-run wizard can change while
// the process is running. See the onConfigReload hook at the bottom.
let OUTPUT_DIR = path.join(config.derivedDir, "roundup");
let HANDOFF_DIR = path.join(config.stemsDir, "handoffs");
const MAX_JOB_ITEMS = 5_000;
const MAX_RETAINED_ITEMS = 100;
let JOBS_PATH = path.join(config.internalDir, "roundup-inventory-jobs.json");
/** Darwin UF_OFFLINE: data is not resident and reading may trigger hydration. */
const DARWIN_UF_OFFLINE = 0x40000000;

function contained(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function mediaKind(filePath: string): RoundupMediaKind | null {
  const ext = path.extname(filePath).toLowerCase();
  if (SUPPORTED_VIDEO_EXTS.has(ext)) return "video";
  if (SUPPORTED_IMAGE_EXTS.has(ext)) return "image";
  if (SUPPORTED_AUDIO_EXTS.has(ext)) return "audio";
  return null;
}

function isUnavailablePlaceholder(stat: fs.Stats): boolean {
  const flags = (stat as fs.Stats & { flags?: number }).flags ?? 0;
  if ((flags & DARWIN_UF_OFFLINE) !== 0) return true;
  // File Provider/Dropbox placeholders commonly expose logical size with no
  // allocated blocks. Conservatively skip them instead of risking hydration.
  return stat.size > 0 && stat.blocks === 0;
}

function safeBasename(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const stem = path
    .basename(filePath, path.extname(filePath))
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 160);
  return `${stem || "media"}${ext}`;
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let offset = 0;
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

function nextAvailablePreview(dir: string, filename: string): string {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}_${n}${ext}`);
    n += 1;
  }
  return candidate;
}

function registeredSource(filePath: string): {
  canonical: string;
  stat: fs.Stats;
  root: RoundupWatchRoot;
} {
  if (!path.isAbsolute(filePath) || !isRoundupMediaPath(filePath)) {
    throw new Error("source must be an absolute supported media path");
  }
  const sourceStat = fs.lstatSync(filePath);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    throw new Error("source must be a regular non-symlink media file");
  }
  const canonical = fs.realpathSync(filePath);
  const root = listAllowlistedWatchRoots().find(
    (candidate) =>
      candidate.allowed &&
      candidate.exists &&
      (canonical === candidate.path || contained(candidate.path, canonical))
  );
  if (!root) throw new Error("source is outside approved Roundup roots");
  return { canonical, stat: fs.statSync(canonical), root };
}

export function previewRoundupMedia(filePath: string): RoundupManifestItem {
  const { canonical, stat, root } = registeredSource(filePath);
  const kind = mediaKind(canonical);
  if (!kind) throw new Error("unsupported media type");
  const fingerprint = fingerprintFile(canonical);
  const tag = ensureTrackable(canonical, { fingerprint, createIfMissing: true });
  if (!tag) throw new Error("could not assign a Roundup identity");
  const after = fs.statSync(canonical);
  if (
    stat.size !== after.size ||
    stat.mtimeMs !== after.mtimeMs ||
    stat.ino !== after.ino
  ) {
    throw new Error("source changed during inventory; try again");
  }
  return {
    source: canonical,
    identity: tag.id,
    mediaKind: kind,
    intendedExportDestination: nextAvailablePreview(
      OUTPUT_DIR,
      safeBasename(canonical)
    ),
    sourcePolicy: "read-only-preserve",
    collisionPolicy: "allocate-unique-never-overwrite",
    destructiveActionPolicy: "none",
    stemsEligible: kind === "video" || kind === "audio",
    sourceRootId: root.id,
    sourceRootReason: root.reason,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

export function copyRoundupMedia(filePath: string): {
  manifest: RoundupManifestItem;
  outputPath: string;
} {
  const manifest = previewRoundupMedia(filePath);
  const before = fs.statSync(manifest.source);
  const sourceDigestBefore = sha256File(manifest.source);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true, mode: 0o700 });
  const filename = safeBasename(manifest.source);
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let outputPath = path.join(OUTPUT_DIR, filename);
  let n = 2;
  while (true) {
    try {
      fs.copyFileSync(manifest.source, outputPath, fs.constants.COPYFILE_EXCL);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      outputPath = path.join(OUTPUT_DIR, `${base}_${n}${ext}`);
      n += 1;
    }
  }
  const after = fs.statSync(manifest.source);
  const sourceDigestAfter = sha256File(manifest.source);
  const outputDigest = sha256File(outputPath);
  if (
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ino !== after.ino ||
    sourceDigestBefore !== sourceDigestAfter ||
    outputDigest !== sourceDigestAfter
  ) {
    throw new Error(
      `source changed or copy verification failed; source was not modified by Clipper and output was retained for review at ${outputPath}`
    );
  }
  return {
    manifest: { ...manifest, intendedExportDestination: outputPath },
    outputPath,
  };
}

export function prepareStemHandoff(
  filePath: string,
  confirmedExternalProcessing: boolean
): { manifestPath: string; manifest: Record<string, unknown> } {
  if (!confirmedExternalProcessing) {
    throw new Error("explicit external-processing confirmation is required");
  }
  const item = previewRoundupMedia(filePath);
  if (!item.stemsEligible) throw new Error("this media type is not stems eligible");
  const before = fs.statSync(item.source);
  const sourceSha256 = sha256File(item.source);
  const after = fs.statSync(item.source);
  if (
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ino !== after.ino
  ) {
    throw new Error("source changed while preparing stems handoff; try again");
  }
  fs.mkdirSync(HANDOFF_DIR, { recursive: true, mode: 0o700 });
  const manifest = {
    version: 1,
    kind: "stem-studio-mcp-handoff",
    processingStarted: false,
    explicitExternalProcessingConfirmation: true,
    source: item.source,
    sourceSnapshot: {
      size: after.size,
      mtimeMs: after.mtimeMs,
      sha256: sourceSha256,
    },
    roundupIdentity: item.identity,
    publishRoot: config.stemsDir,
    sourcePolicy: "read-only-preserve",
    outputPolicy: "allocate-unique-never-overwrite",
    destructiveActionPolicy: "explicit-confirmation-required",
    environmentPolicy: {
      inheritParentEnvironment: false,
      explicitlyAllowedVariables: [],
      forbiddenVariables: [
        "OPENAI_API_KEY",
        "CLIPPER_API_TOKEN",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
      ],
    },
    createdAt: Date.now(),
    note: "Preparation only. Use the official Stem Studio MCP; no model or setup was invoked.",
  };
  let manifestPath = path.join(HANDOFF_DIR, `${item.identity}.json`);
  let n = 2;
  while (true) {
    try {
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      manifestPath = path.join(HANDOFF_DIR, `${item.identity}_${n}.json`);
      n += 1;
    }
  }
  return { manifestPath, manifest };
}

interface PersistedInventoryStore {
  version: 1;
  jobs: RoundupInventoryJob[];
}

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class RoundupInventoryManager {
  private jobs = new Map<string, RoundupInventoryJob>();
  private cancelled = new Set<string>();
  private paused = new Set<string>();
  /** Tests pin a fixture file; the singleton follows the live project folder. */
  private readonly pinnedJobsPath?: string;

  constructor(jobsPath?: string) {
    this.pinnedJobsPath = jobsPath;
    this.load();
  }

  private get jobsPath(): string {
    return this.pinnedJobsPath ?? JOBS_PATH;
  }

  /** Re-read the checkpoint after the project folder changed underneath us. */
  reloadFromProjectDir(): void {
    this.jobs.clear();
    this.cancelled.clear();
    this.paused.clear();
    this.load();
  }

  /** True while a scan could still write to the current project folder. */
  hasActiveJobs(): boolean {
    for (const job of this.jobs.values()) {
      if (job.status === "running" || job.status === "queued") return true;
    }
    return false;
  }

  private load(): void {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.jobsPath, "utf8")
      ) as PersistedInventoryStore;
      if (!parsed || !Array.isArray(parsed.jobs)) return;
      for (const raw of parsed.jobs) {
        if (!raw || typeof raw.id !== "string" || !raw.checkpoint) continue;
        const job: RoundupInventoryJob = {
          ...raw,
          status:
            raw.status === "running" || raw.status === "queued"
              ? "paused"
              : raw.status,
          tagged: Number(raw.tagged ?? 0),
          alreadyTagged: Number(raw.alreadyTagged ?? raw.discovered ?? 0),
          items: Array.isArray(raw.items)
            ? raw.items.slice(-MAX_RETAINED_ITEMS)
            : [],
          updatedAt: Date.now(),
        };
        this.jobs.set(job.id, job);
      }
      this.persist();
    } catch {
      // No prior jobs, or a corrupt observational checkpoint. Start empty.
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.jobsPath), { recursive: true, mode: 0o700 });
    const tmp = `${this.jobsPath}.${process.pid}.tmp`;
    const store: PersistedInventoryStore = {
      version: 1,
      jobs: [...this.jobs.values()].slice(-20),
    };
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.jobsPath);
  }

  start(rootIds: string[], requestedLimit: number): RoundupInventoryJob {
    const roots = listAllowlistedWatchRoots().filter(
      (root) =>
        root.inventoryEligible &&
        (rootIds.length === 0 || rootIds.includes(root.id))
    );
    if (roots.length === 0) throw new Error("no inventory-eligible roots selected");
    const limit = Math.max(1, Math.min(MAX_JOB_ITEMS, Math.floor(requestedLimit)));
    const now = Date.now();
    const job: RoundupInventoryJob = {
      id: crypto.randomUUID(),
      status: "queued",
      scanned: 0,
      mediaCandidates: 0,
      discovered: 0,
      tagged: 0,
      alreadyTagged: 0,
      totalBytes: 0,
      skipped: 0,
      placeholderSkips: 0,
      errors: 0,
      complete: false,
      capped: false,
      limit,
      rootIds: roots.map((root) => root.id),
      items: [],
      startedAt: now,
      updatedAt: now,
      checkpoint: {
        rootIndex: 0,
        directories: [{ relativeDir: "", afterName: null }],
      },
    };
    this.jobs.set(job.id, job);
    this.persist();
    queueMicrotask(() => void this.run(job, roots));
    return job;
  }

  get(id: string): RoundupInventoryJob | undefined {
    return this.jobs.get(id);
  }

  cancel(id: string): RoundupInventoryJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.status === "queued" || job.status === "running") this.cancelled.add(id);
    if (job.status === "paused") {
      job.status = "cancelled";
      job.updatedAt = Date.now();
      this.persist();
    }
    return job;
  }

  pause(id: string): RoundupInventoryJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.status === "queued" || job.status === "running") this.paused.add(id);
    return job;
  }

  resume(id: string): RoundupInventoryJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.status !== "paused") return job;
    const roots = listAllowlistedWatchRoots().filter(
      (root) => root.inventoryEligible && job.rootIds.includes(root.id)
    );
    if (roots.length !== job.rootIds.length) {
      job.status = "error";
      job.error = "one or more approved inventory roots are no longer available";
      job.updatedAt = Date.now();
      this.persist();
      return job;
    }
    job.status = "queued";
    job.capped = false;
    job.error = undefined;
    job.updatedAt = Date.now();
    this.persist();
    queueMicrotask(() => void this.run(job, roots));
    return job;
  }

  private async run(job: RoundupInventoryJob, roots: RoundupWatchRoot[]) {
    job.status = "running";
    job.updatedAt = Date.now();
    this.persist();
    let processedThisBatch = 0;
    try {
      while (job.checkpoint.rootIndex < roots.length) {
        if (this.cancelled.has(job.id)) {
          job.status = "cancelled";
          return;
        }
        if (this.paused.has(job.id)) {
          job.status = "paused";
          return;
        }
        if (processedThisBatch >= job.limit) {
          job.status = "paused";
          job.capped = true;
          return;
        }

        const root = roots[job.checkpoint.rootIndex];
        const stack = job.checkpoint.directories;
        if (stack.length === 0) {
          job.checkpoint.rootIndex += 1;
          if (job.checkpoint.rootIndex < roots.length) {
            stack.push({ relativeDir: "", afterName: null });
          }
          job.updatedAt = Date.now();
          this.persist();
          continue;
        }

        const frame = stack[stack.length - 1];
        const currentDir = path.join(root.path, frame.relativeDir);
        let entries: fs.Dirent[];
        try {
          const canonicalDir = fs.realpathSync(currentDir);
          if (!contained(root.path, canonicalDir)) {
            throw new Error("directory escaped approved root");
          }
          entries = fs
            .readdirSync(canonicalDir, { withFileTypes: true })
            .sort((a, b) => compareNames(a.name, b.name));
        } catch {
          job.errors += 1;
          job.skipped += 1;
          stack.pop();
          job.updatedAt = Date.now();
          this.persist();
          continue;
        }

        const entry = entries.find(
          (candidate) =>
            frame.afterName === null ||
            compareNames(candidate.name, frame.afterName) > 0
        );
        if (!entry) {
          stack.pop();
          job.updatedAt = Date.now();
          this.persist();
          continue;
        }

        frame.afterName = entry.name;
        if (entry.isSymbolicLink()) {
          job.skipped += 1;
        } else {
          const candidate = path.join(currentDir, entry.name);
          if (
            entry.isDirectory() &&
            !entry.name.startsWith(".") &&
            !ROUNDUP_SKIP_DIR_NAMES.has(entry.name)
          ) {
            try {
              const stat = fs.lstatSync(candidate);
              const canonical = fs.realpathSync(candidate);
              if (
                !stat.isSymbolicLink() &&
                stat.isDirectory() &&
                contained(root.path, canonical)
              ) {
                stack.push({
                  relativeDir: path.relative(root.path, canonical),
                  afterName: null,
                });
              } else {
                job.skipped += 1;
              }
            } catch {
              job.errors += 1;
              job.skipped += 1;
            }
          } else if (entry.isFile()) {
            job.scanned += 1;
            if (isRoundupMediaPath(candidate)) {
              job.mediaCandidates += 1;
              processedThisBatch += 1;
              try {
                const stat = fs.lstatSync(candidate);
                if (stat.isSymbolicLink() || !stat.isFile()) {
                  job.skipped += 1;
                } else if (isUnavailablePlaceholder(stat)) {
                  job.placeholderSkips += 1;
                  job.skipped += 1;
                } else {
                  const existing = findTagForPath(candidate);
                  const item = previewRoundupMedia(candidate);
                  job.items.push(item);
                  if (job.items.length > MAX_RETAINED_ITEMS) job.items.shift();
                  job.discovered += 1;
                  if (existing?.id === item.identity) job.alreadyTagged += 1;
                  else job.tagged += 1;
                  job.totalBytes += item.size;
                }
              } catch {
                // A file may disappear or fail canonical validation during a scan.
                job.errors += 1;
                job.skipped += 1;
              }
            }
          }
        }
        job.updatedAt = Date.now();
        if (
          processedThisBatch > 0 &&
          (processedThisBatch % 25 === 0 || processedThisBatch >= job.limit)
        ) {
          this.persist();
        }
        if (job.scanned % 50 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      job.capped = false;
      job.complete = true;
      job.status = this.cancelled.has(job.id) ? "cancelled" : "done";
    } catch (error) {
      job.status = "error";
      job.error = `inventory could not complete safely: ${publicError(error, "roundup-inventory")}`;
    } finally {
      job.updatedAt = Date.now();
      this.cancelled.delete(job.id);
      this.paused.delete(job.id);
      flushTagsSync();
      this.persist();
    }
  }
}

export const roundupInventory = new RoundupInventoryManager();

onConfigReload({
  apply: () => {
    OUTPUT_DIR = path.join(config.derivedDir, "roundup");
    HANDOFF_DIR = path.join(config.stemsDir, "handoffs");
    JOBS_PATH = path.join(config.internalDir, "roundup-inventory-jobs.json");
    roundupInventory.reloadFromProjectDir();
  },
});
