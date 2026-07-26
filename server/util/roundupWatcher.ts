import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import chokidar, { type FSWatcher } from "chokidar";
import {
  ROUNDUP_SKIP_DIR_NAMES,
  appendRoundupEvent,
  dedupeRoundupWatchRoots,
  fingerprintFile,
  fingerprintKey,
  isAllowlistedWatchPath,
  isRoundupMediaPath,
  listAllowlistedWatchRoots,
  readRoundupSettings,
  wasRecentlyRecorded,
  writeRoundupSettings,
  type RoundupFingerprint,
  type RoundupSettings,
  type RoundupWatchRoot,
  type RoundupWatchRootId,
} from "./roundup.js";
import { publicError } from "./publicError.js";
import { ensureTrackable, findTagForPath } from "./roundupTags.js";

/*
 * Local Roundup watcher — chokidar (FSEvents on macOS) over the allowlisted
 * media roots. Media extensions only. Pairs recent unlink + add via soft
 * fingerprint (prefer inode) to record renames/moves as life-history hops.
 *
 * Performance guards:
 *   - ignoreInitial: true (no flood on boot)
 *   - skip hidden / Library / .clipcataloger / node_modules
 *   - media-extension filter before any fingerprint work
 *   - debounce pairing window for unlink→add
 *   - depth soft-limit via ignored callback for pathological trees
 *   - no symlink following
 *   - dedupe against Clipper mutation hooks (wasRecentlyRecorded)
 */

const UNLINK_TTL_MS = 45_000;
const MAX_PENDING_UNLINKS = 2_000;
/** Soft max path depth under a watch root (segments). */
const MAX_DEPTH = 12;
const require = createRequire(import.meta.url);
const HAS_FSEVENTS =
  process.platform === "darwin" &&
  (() => {
    try {
      require.resolve("fsevents");
      return true;
    } catch {
      return false;
    }
  })();

interface PendingUnlink {
  path: string;
  fingerprint: RoundupFingerprint;
  ts: number;
}

export interface RoundupWatcherStatus {
  state: "off" | "starting" | "watched" | "degraded";
  running: boolean;
  enabled: boolean;
  roots: RoundupWatchRoot[];
  watching: string[];
  coveredRootIds: RoundupWatchRootId[];
  backend: "fsevents" | "fs.watch";
  cachedPaths: number;
  pendingUnlinks: number;
  eventsRecordedSession: number;
  lastError: string | null;
  lastEventAt: number | null;
}

type WatchFactory = (
  roots: string[],
  options: Parameters<typeof chokidar.watch>[1]
) => FSWatcher;

export class RoundupWatcher {
  private watcher: FSWatcher | null = null;
  private pendingByKey = new Map<string, PendingUnlink>();
  private pathCache = new Map<string, RoundupFingerprint>();
  private priming = false;
  private eventsRecordedSession = 0;
  private lastError: string | null = null;
  private lastEventAt: number | null = null;
  private state: RoundupWatcherStatus["state"] = "off";
  private operation: Promise<void> = Promise.resolve();
  private watchRoots: string[] = [];
  private coveredRootIds: RoundupWatchRootId[] = [];
  private generation = 0;

  private static readonly PATH_CACHE_MAX = 100_000;
  private static readonly READY_TIMEOUT_MS = 15_000;

  constructor(
    private readonly watchFactory: WatchFactory = (roots, options) =>
      chokidar.watch(roots, options)
  ) {}

  status(): RoundupWatcherStatus {
    const settings = readRoundupSettings();
    const roots = listAllowlistedWatchRoots(settings);
    return {
      state: this.state,
      running: this.state === "watched",
      enabled: settings.enabled,
      roots,
      watching: [...this.watchRoots],
      coveredRootIds: [...this.coveredRootIds],
      backend: HAS_FSEVENTS ? "fsevents" : "fs.watch",
      cachedPaths: this.pathCache.size,
      pendingUnlinks: this.pendingByKey.size,
      eventsRecordedSession: this.eventsRecordedSession,
      lastError: this.lastError,
      lastEventAt: this.lastEventAt,
    };
  }

  async applySettings(patch: Partial<RoundupSettings>): Promise<RoundupWatcherStatus> {
    const cur = readRoundupSettings();
    const next = writeRoundupSettings({
      enabled: patch.enabled ?? cur.enabled,
      disabledRoots: patch.disabledRoots ?? cur.disabledRoots,
      watchedRootIds: patch.watchedRootIds ?? cur.watchedRootIds,
      approvedRoots: patch.approvedRoots ?? cur.approvedRoots,
    });
    if (next.enabled) {
      await this.restart();
    } else {
      await this.stop();
    }
    return this.status();
  }

  async start(): Promise<void> {
    return this.enqueue(() => this.startNow());
  }

  private async startNow(): Promise<void> {
    const settings = readRoundupSettings();
    if (!settings.enabled) {
      await this.stopNow();
      return;
    }
    const selected = dedupeRoundupWatchRoots(listAllowlistedWatchRoots(settings));
    const roots = selected.roots.map((root) => root.path);
    if (roots.length === 0) {
      await this.stopNow();
      return;
    }
    await this.stopNow();
    const generation = ++this.generation;
    this.state = "starting";
    this.lastError = null;
    this.watchRoots = roots;
    this.coveredRootIds = selected.coveredIds;
    this.priming = true;

    let candidate: FSWatcher;
    try {
      candidate = this.watchFactory(roots, {
        // Initial scan primes the fingerprint cache so later Finder renames
        // of already-present media can be paired. Events are not recorded
        // until chokidar's "ready" (see onAdd).
        ignoreInitial: false,
        persistent: true,
        ignorePermissionErrors: true,
        followSymlinks: false,
        usePolling: process.env.ROUNDUP_WATCHER_TEST_POLLING === "1",
        interval: 100,
        depth: MAX_DEPTH,
        awaitWriteFinish: {
          stabilityThreshold: 400,
          pollInterval: 100,
        },
        ignored: (watchPath: string) => this.shouldIgnore(watchPath),
      });
    } catch (error) {
      this.markDegraded(error);
      return;
    }
    this.watcher = candidate;
    candidate.on("add", (p) => this.onAdd(p));
    candidate.on("unlink", (p) => this.onUnlink(p));

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        this.markDegraded(
          new Error("watcher startup timed out before filesystem readiness"),
          candidate,
          generation
        );
        finish();
      }, RoundupWatcher.READY_TIMEOUT_MS);
      timeout.unref();

      candidate.on("ready", () => {
        if (this.watcher !== candidate || this.generation !== generation) {
          finish();
          return;
        }
        this.priming = false;
        this.state = "watched";
        console.log(
          `[roundup-watcher] primed ${this.pathCache.size} media path(s); live`
        );
        finish();
      });
      candidate.on("error", (error) => {
        this.markDegraded(error, candidate, generation);
        finish();
      });
    });
    console.log(
      `[roundup-watcher] selected ${roots.length} root(s): ${roots
        .map((r) => path.basename(r))
        .join(", ")}`
    );
  }

  async restart(): Promise<void> {
    return this.start();
  }

  async stop(): Promise<void> {
    return this.enqueue(() => this.stopNow());
  }

  private async stopNow(): Promise<void> {
    this.generation += 1;
    const w = this.watcher;
    this.watcher = null;
    this.state = "off";
    this.watchRoots = [];
    this.coveredRootIds = [];
    this.priming = false;
    this.pendingByKey.clear();
    this.pathCache.clear();
    if (!w) return;
    try {
      await w.close();
    } catch {
      // ignore
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.operation.then(operation, operation);
    this.operation = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private markDegraded(
    error: unknown,
    candidate?: FSWatcher,
    generation?: number
  ): void {
    if (
      candidate &&
      (this.watcher !== candidate || this.generation !== generation)
    ) {
      return;
    }
    // `lastError` is surfaced verbatim by GET /roundup/watcher, and chokidar
    // names the offending directory in its errors.
    this.lastError = publicError(error, "roundup-watcher");
    this.state = "degraded";
    this.priming = false;
    this.watchRoots = [];
    this.coveredRootIds = [];
    const current = candidate ?? this.watcher;
    if (!candidate || this.watcher === candidate) this.watcher = null;
    if (current) {
      void current.close().catch(() => {});
    }
  }

  private shouldIgnore(watchPath: string, stats?: fs.Stats): boolean {
    const abs = path.resolve(watchPath);
    if (!isAllowlistedWatchPath(abs)) return true;

    const relative = this.watchRoots
      .map((root) => path.relative(root, abs))
      .find((candidate) => candidate === "" || !candidate.startsWith(".."));
    if (relative === undefined) return true;
    const parts = relative.split(path.sep).filter(Boolean);
    for (const part of parts) {
      if (part.startsWith(".") && part !== ".") return true;
      if (ROUNDUP_SKIP_DIR_NAMES.has(part)) return true;
    }

    // Soft depth cap — pathological trees under Documents etc.
    if (parts.length > MAX_DEPTH) return true;

    let knownStats = stats;
    if (!knownStats) {
      try {
        knownStats = fs.lstatSync(abs);
      } catch {
        // Removed paths have no stats; extension filtering below is sufficient.
      }
    }
    if (knownStats?.isDirectory()) return false;

    // Files: only media extensions. During directory walks stats may be undefined.
    if (knownStats?.isFile() || path.extname(abs)) {
      return !isRoundupMediaPath(abs);
    }
    return false;
  }

  private prunePending(): void {
    const now = Date.now();
    for (const [k, v] of this.pendingByKey) {
      if (now - v.ts > UNLINK_TTL_MS) this.pendingByKey.delete(k);
    }
    while (this.pendingByKey.size > MAX_PENDING_UNLINKS) {
      const first = this.pendingByKey.keys().next().value;
      if (first === undefined) break;
      this.pendingByKey.delete(first);
    }
  }

  private rememberPath(abs: string, fp: RoundupFingerprint): void {
    this.pathCache.set(abs, fp);
    if (this.pathCache.size > RoundupWatcher.PATH_CACHE_MAX) {
      const drop = Math.floor(RoundupWatcher.PATH_CACHE_MAX / 4);
      let i = 0;
      for (const k of this.pathCache.keys()) {
        this.pathCache.delete(k);
        if (++i >= drop) break;
      }
    }
  }

  private onUnlink(filePath: string): void {
    try {
      if (this.priming) return;
      const abs = path.resolve(filePath);
      if (!isRoundupMediaPath(abs)) return;
      if (!isAllowlistedWatchPath(abs)) return;
      const existing = findTagForPath(abs);
      if (existing && !existing.trackable) return;
      const cached = this.pathCache.get(abs);
      this.pathCache.delete(abs);
      if (!cached) return;
      this.prunePending();
      const key = fingerprintKey(cached);
      this.pendingByKey.set(key, {
        path: abs,
        fingerprint: cached,
        ts: Date.now(),
      });
    } catch {
      // ignore
    }
  }

  private onAdd(filePath: string): void {
    try {
      const abs = path.resolve(filePath);
      if (!isRoundupMediaPath(abs)) return;
      if (!isAllowlistedWatchPath(abs)) return;
      const fp = fingerprintFile(abs);
      if (!fp) return;
      this.rememberPath(abs, fp);

      // During initial scan we only prime the cache (no tags flood).
      if (this.priming) return;

      const existing = findTagForPath(abs);
      if (existing && !existing.trackable) return;

      this.prunePending();
      const key = fingerprintKey(fp);
      const pending = this.pendingByKey.get(key);
      if (pending) {
        if (path.resolve(pending.path) === abs) {
          this.pendingByKey.delete(key);
          return;
        }
        this.pendingByKey.delete(key);
        if (wasRecentlyRecorded(pending.path, abs)) return;

        appendRoundupEvent({
          kind: "external_detected",
          entityType: "other",
          oldPath: pending.path,
          newPath: abs,
          oldName: path.basename(pending.path),
          newName: path.basename(abs),
          triggeredBy: "watcher",
          fingerprint: fp,
        });
        this.eventsRecordedSession += 1;
        this.lastEventAt = Date.now();
        return;
      }

      // New media entering a watched root after boot → default-on AirTag.
      ensureTrackable(abs, { fingerprint: fp, createIfMissing: true });
    } catch {
      // ignore
    }
  }
}

export const roundupWatcher = new RoundupWatcher();

/** Reveal a path if it sits under an allowlisted root (project or home media). */
export function revealAllowlistedPath(absPath: string): { ok: true } | { error: string; status: number } {
  if (!path.isAbsolute(absPath)) {
    return { error: "absolute path required", status: 400 };
  }
  const resolved = path.resolve(absPath);
  if (!isAllowlistedWatchPath(resolved)) {
    return { error: "path is outside Roundup allowlisted roots", status: 403 };
  }
  let target: string;
  try {
    target = fs.realpathSync(resolved);
  } catch {
    return { error: "path not found", status: 410 };
  }
  if (!isAllowlistedWatchPath(target)) {
    return { error: "path is outside Roundup allowlisted roots", status: 403 };
  }
  try {
    const st = fs.statSync(target);
    if (!st.isFile() && !st.isDirectory()) {
      return { error: "path not found", status: 410 };
    }
  } catch {
    return { error: "path not found", status: 410 };
  }
  const child = spawn("open", ["-R", target], {
    stdio: "ignore",
    detached: true,
  });
  child.on("error", () => {});
  child.unref();
  return { ok: true };
}

export type { RoundupWatchRootId, RoundupSettings };
