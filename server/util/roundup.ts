import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { config, SUPPORTED_IMAGE_EXTS, SUPPORTED_VIDEO_EXTS } from "../config.js";
import {
  findTagForPath,
  followTrackableMove,
  getTag,
  listTags,
  type RoundupTag,
} from "./roundupTags.js";
import {
  presentRoundupEvent,
  type RoundupEventClassification,
  type RoundupEventPresentation,
} from "./roundupEventPresentation.js";

/*
 * Clipper Roundup — local rename/move life history for media files.
 *
 * Persistence:
 *   `<projectDir>/.clipcataloger/roundup.log.jsonl`   — append-only events
 *   `<projectDir>/.clipcataloger/roundup-settings.json` — watcher toggles
 *   `<projectDir>/.clipcataloger/roundup-tags.json`    — AirTag identities
 *
 * Identity strategy:
 *   0. Trackable tag (UUID) — default-on "AirTag" for media; survives rename.
 *   1. Path chain — each event records oldPath → newPath (+ optional tagId).
 *   2. Basename fallback — when only a filename is known.
 *   3. Soft fingerprint — size + mtimeMs (+ inode when available).
 *
 * Watch roots (allowlist only — never `/`, `/System`, other users' homes):
 *   See listAllowlistedWatchRoots(). Defaults ON for every existing root.
 *
 * Cloud (Dropbox/Drive) watchers remain TODO — see TODO(roundup-cloud).
 */

/** Audio extensions Roundup tracks in addition to video + image. */
export const SUPPORTED_AUDIO_EXTS = new Set([
  ".wav",
  ".mp3",
  ".aiff",
  ".aif",
  ".m4a",
  ".flac",
  ".ogg",
  ".aac",
]);

export function isRoundupMediaPath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return (
    SUPPORTED_VIDEO_EXTS.has(ext) ||
    SUPPORTED_IMAGE_EXTS.has(ext) ||
    SUPPORTED_AUDIO_EXTS.has(ext)
  );
}

export type RoundupEntityType = "pool" | "library" | "image" | "other";

export type RoundupKind =
  | "pool_move"
  | "library_rename"
  | "image_move"
  | "clip_restore"
  | "orphan_trash"
  | "manual"
  | "external_detected";

export type RoundupTriggeredBy =
  | "user"
  | "auto_organize"
  | "migration"
  | "restore"
  | "orphan_trash"
  | "manual"
  | "scan"
  | "watcher";

/** Soft file identity — not a content hash. */
export interface RoundupFingerprint {
  size: number;
  mtimeMs: number;
  /** POSIX inode when available; omitted on platforms without it. */
  ino?: number;
  dev?: number;
}

export interface RoundupEvent {
  ts: number;
  kind: RoundupKind;
  entityType: RoundupEntityType;
  oldPath: string;
  newPath: string;
  oldName?: string;
  newName?: string;
  oldId?: string;
  newId?: string;
  /** Stable AirTag identity when the file is (or was) trackable. */
  tagId?: string;
  triggeredBy: RoundupTriggeredBy;
  fingerprint?: RoundupFingerprint;
  /** True when newPath still exists at read time (filled by lookup/list). */
  exists?: boolean;
  /** Read-time classification; absent only on raw legacy JSONL records. */
  classification?: RoundupEventClassification;
  /** Derived display fields. Raw paths above remain unchanged. */
  presentation?: RoundupEventPresentation;
}

export interface RoundupCandidate {
  event: RoundupEvent;
  /** How the query matched this event. */
  match: "exact_path" | "path_prefix" | "basename" | "fingerprint" | "tag";
  /** Latest known path after following the rename chain from this event. */
  currentPath: string;
  currentExists: boolean;
  score: number;
  /** Chronological life history for this identity (oldest → newest). */
  history: RoundupEvent[];
  /** Distinct paths in appearance order along the life trail. */
  trail: string[];
  /** AirTag identity when known. */
  tag?: RoundupTag;
}

// ---------------------------------------------------------------------------
// Watch-root allowlist
// ---------------------------------------------------------------------------

/**
 * Stable ids for allowlisted watch roots. Only these (plus PROJECT_DIR) may
 * be watched. Never expand this to `/`, `/System`, `/Users` (all users), or
 * hidden system trees.
 */
export type RoundupWatchRootId =
  | "project"
  | "downloads"
  | "desktop"
  | "documents"
  | "pictures"
  | "movies"
  | "music"
  | string;

export type RoundupRootReason =
  | "project"
  | "seedance"
  | "gunslinger_dropbox"
  | "gunslinger_seedance"
  | "downloads"
  | "desktop"
  | "documents"
  | "pictures"
  | "movies"
  | "music"
  | "droplet";

export interface RoundupWatchRoot {
  id: RoundupWatchRootId;
  label: string;
  path: string;
  reason: RoundupRootReason;
  exists: boolean;
  /** User preference; false when toggled off in settings. */
  enabled: boolean;
  /** Safe to include in explicit, read-only inventory jobs. */
  inventoryEligible: boolean;
  /** Why an eligible root is not currently being watched. */
  watchNote?: "inventory_only" | "covered_by_parent";
  /** True when this root is under the current user's home or is PROJECT_DIR. */
  allowed: boolean;
}

/** Directory names / path segments the watcher must never descend into. */
export const ROUNDUP_SKIP_DIR_NAMES = new Set([
  ".clipcataloger",
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  ".Trash",
  "Library", // under home: caches, Containers, etc. — too noisy / sensitive
  "Application Support",
  "Caches",
  "Containers",
  "Group Containers",
  "System",
  "private",
]);

/** Absolute prefixes that are never watchable. */
const FORBIDDEN_PREFIXES = [
  "/System",
  "/usr",
  "/bin",
  "/sbin",
  "/var",
  "/private",
  "/Library",
  "/Applications",
  "/Volumes/Macintosh HD/System",
];

function isForbiddenPath(abs: string): boolean {
  const resolved = path.resolve(abs);
  if (resolved === "/" || resolved === "/Users") return true;
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (resolved === prefix || resolved.startsWith(prefix + path.sep)) {
      return true;
    }
  }
  // Other users' home directories.
  const home = os.homedir();
  const usersRoot = path.resolve("/Users");
  if (resolved.startsWith(usersRoot + path.sep)) {
    const rel = path.relative(usersRoot, resolved);
    const top = rel.split(path.sep)[0];
    if (top && top !== path.basename(home) && top !== "Shared") {
      return true;
    }
  }
  return false;
}

/**
 * True if `abs` is under the current user's home OR equals/is under PROJECT_DIR
 * (so an external-drive catalog still works), and is not forbidden.
 */
export function isAllowlistedWatchPath(abs: string): boolean {
  const resolved = path.resolve(abs);
  if (isForbiddenPath(resolved)) return false;
  const home = path.resolve(os.homedir());
  const project = path.resolve(config.projectDir);
  if (resolved === home || resolved.startsWith(home + path.sep)) return true;
  if (resolved === project || resolved.startsWith(project + path.sep)) return true;
  return false;
}

export function listAllowlistedWatchRoots(
  settings?: RoundupSettings
): RoundupWatchRoot[] {
  const s = settings ?? readRoundupSettings();
  const home = os.homedir();
  const defs: {
    id: RoundupWatchRootId;
    label: string;
    path: string;
    reason: RoundupRootReason;
  }[] = [
    { id: "project", label: "Project", path: config.projectDir, reason: "project" },
    { id: "downloads", label: "Downloads", path: path.join(home, "Downloads"), reason: "downloads" },
    { id: "desktop", label: "Desktop", path: path.join(home, "Desktop"), reason: "desktop" },
    { id: "documents", label: "Documents", path: path.join(home, "Documents"), reason: "documents" },
    { id: "pictures", label: "Pictures", path: path.join(home, "Pictures"), reason: "pictures" },
    { id: "movies", label: "Movies", path: path.join(home, "Movies"), reason: "movies" },
    { id: "music", label: "Music", path: path.join(home, "Music"), reason: "music" },
  ];
  // Explicit approvals take display/status precedence when they canonicalize to
  // a built-in root (for example PROJECT_DIR reached through a Desktop symlink).
  // Canonical de-duplication below then exposes the user's specific label/reason.
  defs.unshift(
    ...s.approvedRoots.map((approved) => ({
      id: approved.id,
      label: approved.label,
      path: approved.path,
      reason: approved.reason,
    }))
  );

  // Known project-local locations may be discovered without guessing anywhere
  // else on the machine. Duplicate/canonical paths are collapsed below.
  const knownSeedance = [
    path.join(config.projectDir, "Seedance"),
    path.join(config.projectDir, "Gunslinger"),
    path.join(config.projectDir, "Gunslinger", "Seedance"),
  ];
  for (const candidate of knownSeedance) {
    try {
      if (!fs.statSync(candidate).isDirectory()) continue;
      defs.push({
        id: `seedance:${cryptoSafeRootId(candidate)}`,
        label: path.basename(candidate) === "Gunslinger" ? "Gunslinger" : "Seedance",
        path: candidate,
        reason: "seedance",
      });
    } catch {
      // Missing known path: the approval UI remains available.
    }
  }
  const watched = new Set(s.watchedRootIds);
  const seen = new Set<string>();
  return defs.flatMap((d) => {
    const abs = path.resolve(d.path);
    const allowed = isAllowlistedWatchPath(abs);
    let exists = false;
    let canonical = abs;
    try {
      canonical = allowed ? fs.realpathSync(abs) : abs;
      exists =
        allowed &&
        isAllowlistedWatchPath(canonical) &&
        fs.statSync(canonical).isDirectory();
    } catch {
      exists = false;
    }
    if (seen.has(canonical)) return [];
    seen.add(canonical);
    return [{
      id: d.id,
      label: d.label,
      path: canonical,
      reason: d.reason,
      exists,
      allowed: allowed && isAllowlistedWatchPath(canonical),
      inventoryEligible: allowed && exists && isAllowlistedWatchPath(canonical),
      enabled:
        allowed &&
        exists &&
        s.enabled &&
        watched.has(d.id) &&
        !s.disabledRoots.includes(d.id),
      ...(!watched.has(d.id) ? { watchNote: "inventory_only" as const } : {}),
    }];
  });
}

/**
 * Collapse canonical roots covered by an already-selected parent. This avoids
 * duplicate recursive traversal when, for example, a droplet folder beneath
 * Desktop is also explicitly approved.
 */
export function dedupeRoundupWatchRoots(
  roots: RoundupWatchRoot[]
): { roots: RoundupWatchRoot[]; coveredIds: RoundupWatchRootId[] } {
  const selected = roots
    .filter((root) => root.enabled && root.allowed && root.exists)
    .sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
  const kept: RoundupWatchRoot[] = [];
  const coveredIds: RoundupWatchRootId[] = [];
  for (const root of selected) {
    const covered = kept.some(
      (parent) =>
        root.path === parent.path ||
        root.path.startsWith(parent.path + path.sep)
    );
    if (covered) coveredIds.push(root.id);
    else kept.push(root);
  }
  return { roots: kept, coveredIds };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface RoundupSettings {
  /** Master switch for the local filesystem watcher. Default true. */
  enabled: boolean;
  /** Root ids the user has toggled off (subset of allowlist). */
  disabledRoots: RoundupWatchRootId[];
  /**
   * Roots actively watched for external moves. Inventory approval is separate:
   * every allowed/existing root remains eligible for explicit read-only scans.
   */
  watchedRootIds: RoundupWatchRootId[];
  /** Explicit user-approved Seedance/Gunslinger or droplet destinations. */
  approvedRoots: RoundupApprovedRoot[];
}

export interface RoundupApprovedRoot {
  id: string;
  label: string;
  path: string;
  reason: "seedance" | "droplet" | "gunslinger_dropbox" | "gunslinger_seedance";
}

const APPROVED_ROOT_REASONS = new Set<RoundupApprovedRoot["reason"]>([
  "seedance",
  "droplet",
  "gunslinger_dropbox",
  "gunslinger_seedance",
]);

function isApprovedRootReason(value: unknown): value is RoundupApprovedRoot["reason"] {
  return typeof value === "string" &&
    APPROVED_ROOT_REASONS.has(value as RoundupApprovedRoot["reason"]);
}

const SETTINGS_PATH = path.join(config.internalDir, "roundup-settings.json");
const ROUNDUP_PATH = path.join(config.internalDir, "roundup.log.jsonl");
const ROUNDUP_LINEAGE_PATH = path.join(config.internalDir, "roundup-lineage.jsonl");

const DEFAULT_SETTINGS: RoundupSettings = {
  enabled: true,
  disabledRoots: [],
  // Broad home folders are inventory-only until explicitly enabled.
  watchedRootIds: ["project"],
  approvedRoots: [],
};

function cryptoSafeRootId(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function readRoundupSettings(): RoundupSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) as Partial<RoundupSettings>;
    const disabled = Array.isArray(raw.disabledRoots)
      ? raw.disabledRoots.filter((id): id is RoundupWatchRootId => typeof id === "string")
      : [];
    const approvedRoots = Array.isArray(raw.approvedRoots)
      ? raw.approvedRoots.filter(
          (root): root is RoundupApprovedRoot =>
            Boolean(root) &&
            typeof root.id === "string" &&
            typeof root.label === "string" &&
            typeof root.path === "string" &&
            isApprovedRootReason(root.reason)
        )
      : [];
    const watchedRootIds = Array.isArray(raw.watchedRootIds)
      ? raw.watchedRootIds.filter(
          (id): id is RoundupWatchRootId => typeof id === "string"
        )
      : [
          "project",
          // Existing explicit approvals represent intentional tracking scope.
          ...approvedRoots.map((root) => root.id),
        ];
    return {
      enabled: raw.enabled !== false,
      disabledRoots: disabled,
      watchedRootIds: [...new Set(watchedRootIds)],
      approvedRoots,
    };
  } catch {
    return {
      ...DEFAULT_SETTINGS,
      disabledRoots: [],
      watchedRootIds: [...DEFAULT_SETTINGS.watchedRootIds],
      approvedRoots: [],
    };
  }
}

export function writeRoundupSettings(next: RoundupSettings): RoundupSettings {
  const cleaned: RoundupSettings = {
    enabled: Boolean(next.enabled),
    disabledRoots: (next.disabledRoots ?? []).filter((id) => typeof id === "string"),
    watchedRootIds: [...new Set(next.watchedRootIds ?? ["project"])].filter(
      (id) => typeof id === "string"
    ),
    approvedRoots: (next.approvedRoots ?? []).filter(
      (root) =>
        root &&
        typeof root.id === "string" &&
        typeof root.label === "string" &&
        typeof root.path === "string" &&
        isApprovedRootReason(root.reason)
    ),
  };
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  const tmp = SETTINGS_PATH + `.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cleaned, null, 2));
  fs.renameSync(tmp, SETTINGS_PATH);
  return cleaned;
}

// ---------------------------------------------------------------------------
// Fingerprints + recent-record dedupe (Clipper mutation ↔ watcher)
// ---------------------------------------------------------------------------

export function fingerprintFile(absPath: string): RoundupFingerprint | undefined {
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile()) return undefined;
    const fp: RoundupFingerprint = {
      size: st.size,
      mtimeMs: Math.trunc(st.mtimeMs),
    };
    if (typeof st.ino === "number" && st.ino > 0) fp.ino = st.ino;
    if (typeof st.dev === "number") fp.dev = st.dev;
    return fp;
  } catch {
    return undefined;
  }
}

export function fingerprintKey(fp: RoundupFingerprint): string {
  if (typeof fp.ino === "number" && typeof fp.dev === "number") {
    return `ino:${fp.dev}:${fp.ino}`;
  }
  return `sm:${fp.size}:${fp.mtimeMs}`;
}

export function fingerprintsMatch(
  a: RoundupFingerprint | undefined,
  b: RoundupFingerprint | undefined
): boolean {
  if (!a || !b) return false;
  if (
    typeof a.ino === "number" &&
    typeof b.ino === "number" &&
    typeof a.dev === "number" &&
    typeof b.dev === "number"
  ) {
    return a.ino === b.ino && a.dev === b.dev;
  }
  if (a.size !== b.size) return false;
  // Allow 2s mtime skew for copy tools that touch mtime slightly.
  return Math.abs(a.mtimeMs - b.mtimeMs) <= 2000;
}

/** Short-lived dedupe so Clipper mutations + watcher don't double-log. */
const recentRecordKeys = new Map<string, number>();
const DEDUPE_MS = 8_000;

function recordKey(oldPath: string, newPath: string): string {
  return `${path.resolve(oldPath)}\0${path.resolve(newPath)}`;
}

export function wasRecentlyRecorded(oldPath: string, newPath: string): boolean {
  const key = recordKey(oldPath, newPath);
  const ts = recentRecordKeys.get(key);
  if (ts === undefined) return false;
  if (Date.now() - ts > DEDUPE_MS) {
    recentRecordKeys.delete(key);
    return false;
  }
  return true;
}

function noteRecorded(oldPath: string, newPath: string): void {
  const now = Date.now();
  recentRecordKeys.set(recordKey(oldPath, newPath), now);
  // Opportunistic prune
  if (recentRecordKeys.size > 200) {
    for (const [k, ts] of recentRecordKeys) {
      if (now - ts > DEDUPE_MS) recentRecordKeys.delete(k);
    }
  }
}

export interface AppendRoundupInput {
  kind: RoundupKind;
  entityType: RoundupEntityType;
  oldPath: string;
  newPath: string;
  oldName?: string;
  newName?: string;
  oldId?: string;
  newId?: string;
  triggeredBy?: RoundupTriggeredBy;
  /** Prefer fingerprint of the destination after a successful rename. */
  fingerprint?: RoundupFingerprint;
}

export function appendRoundupEvent(input: AppendRoundupInput): void {
  try {
    const oldPath = path.resolve(input.oldPath);
    const newPath = path.resolve(input.newPath);
    if (oldPath === newPath) return;
    if (wasRecentlyRecorded(oldPath, newPath)) return;

    fs.mkdirSync(path.dirname(ROUNDUP_PATH), { recursive: true });
    const fingerprint =
      input.fingerprint ??
      fingerprintFile(newPath) ??
      fingerprintFile(oldPath);

    // AirTag follow — opted-out tags keep their id on the event for history
    // but followTrackableMove does not advance currentPath.
    const tag = followTrackableMove(oldPath, newPath, fingerprint);

    const event: RoundupEvent = {
      ts: Date.now(),
      kind: input.kind,
      entityType: input.entityType,
      oldPath,
      newPath,
      oldName: input.oldName ?? path.basename(oldPath),
      newName: input.newName ?? path.basename(newPath),
      ...(input.oldId ? { oldId: input.oldId } : {}),
      ...(input.newId ? { newId: input.newId } : {}),
      ...(tag ? { tagId: tag.id } : {}),
      triggeredBy: input.triggeredBy ?? "user",
      ...(fingerprint ? { fingerprint } : {}),
    };
    fs.appendFileSync(ROUNDUP_PATH, JSON.stringify(event) + "\n");
    noteRecorded(oldPath, newPath);
  } catch {
    // Intentionally swallow — Roundup is observational, never a hard dependency.
  }
}

export interface RoundupLineage {
  ts: number;
  relation: "derived-copy";
  sourcePath: string;
  outputPath: string;
  sourceTagId?: string;
  outputTagId?: string;
  clipId?: string;
  packageId?: string;
}

/**
 * Record copy lineage without treating the copy as a rename/move. This must
 * never call followTrackableMove: source and output remain separate identities.
 */
export function appendRoundupLineage(
  input: Omit<RoundupLineage, "ts" | "relation">
): void {
  try {
    const sourcePath = path.resolve(input.sourcePath);
    const outputPath = path.resolve(input.outputPath);
    if (sourcePath === outputPath || !isRoundupMediaPath(outputPath)) return;
    fs.mkdirSync(path.dirname(ROUNDUP_LINEAGE_PATH), { recursive: true });
    const event: RoundupLineage = {
      ts: Date.now(),
      relation: "derived-copy",
      ...input,
      sourcePath,
      outputPath,
    };
    fs.appendFileSync(ROUNDUP_LINEAGE_PATH, JSON.stringify(event) + "\n");
  } catch {
    // Observational metadata must never invalidate a completed media copy.
  }
}

function parseEventLine(line: string): RoundupEvent | null {
  try {
    const parsed = JSON.parse(line) as RoundupEvent;
    if (
      !parsed ||
      typeof parsed.ts !== "number" ||
      typeof parsed.kind !== "string" ||
      typeof parsed.oldPath !== "string" ||
      typeof parsed.newPath !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function readAllRoundupEvents(): Promise<RoundupEvent[]> {
  let raw = "";
  try {
    raw = await fs.promises.readFile(ROUNDUP_PATH, "utf8");
  } catch {
    return [];
  }
  const events: RoundupEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const e = parseEventLine(line);
    if (e) events.push(e);
  }
  return events;
}

function pathExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function withPresentation(event: RoundupEvent): RoundupEvent {
  const presentation = presentRoundupEvent(event);
  return {
    ...event,
    classification: presentation.classification,
    presentation,
  };
}

/**
 * Follow rename/move edges starting from `startPath` to the newest known
 * location. Caps iterations to avoid cycles from bad data.
 */
export function resolveCurrentPath(
  startPath: string,
  eventsOldestFirst: RoundupEvent[]
): string {
  let current = path.resolve(startPath);
  const seen = new Set<string>();
  for (const e of eventsOldestFirst) {
    if (path.resolve(e.oldPath) === current) {
      const next = path.resolve(e.newPath);
      if (seen.has(next)) break;
      seen.add(current);
      current = next;
    }
  }
  return current;
}

/**
 * Collect the connected life history for a seed path: every rename/move event
 * linked by shared path endpoints, the same inode fingerprint, or the same
 * AirTag id.
 */
export function buildLifeHistory(
  seedPath: string,
  eventsOldestFirst: RoundupEvent[],
  seedTagId?: string
): { history: RoundupEvent[]; trail: string[]; currentPath: string } {
  const seed = path.resolve(seedPath);
  if (eventsOldestFirst.length === 0) {
    return { history: [], trail: [seed], currentPath: seed };
  }

  const parent = new Map<string, string>();
  function find(x: string): string {
    let p = parent.get(x) ?? x;
    if (!parent.has(x)) parent.set(x, x);
    while (parent.get(p) !== p) {
      const grand = parent.get(parent.get(p)!)!;
      parent.set(p, grand);
      p = grand;
    }
    return p;
  }
  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const e of eventsOldestFirst) {
    const o = path.resolve(e.oldPath);
    const n = path.resolve(e.newPath);
    union(o, n);
    if (e.fingerprint) {
      const fk = `fp:${fingerprintKey(e.fingerprint)}`;
      union(o, fk);
      union(n, fk);
    }
    if (e.tagId) {
      const tk = `tag:${e.tagId}`;
      union(o, tk);
      union(n, tk);
    }
  }

  const seeds = [seed];
  if (seedTagId) seeds.push(`tag:${seedTagId}`);
  const seedRoots = new Set(seeds.map((s) => find(s)));

  const history = eventsOldestFirst.filter((e) => {
    const o = path.resolve(e.oldPath);
    const n = path.resolve(e.newPath);
    return seedRoots.has(find(o)) || seedRoots.has(find(n));
  });

  if (history.length === 0) {
    return { history: [], trail: [seed], currentPath: seed };
  }

  const trail: string[] = [];
  const seen = new Set<string>();
  function pushPath(p: string) {
    const r = path.resolve(p);
    if (seen.has(r)) return;
    seen.add(r);
    trail.push(r);
  }
  pushPath(history[0].oldPath);
  for (const e of history) {
    pushPath(e.oldPath);
    pushPath(e.newPath);
  }

  // Prefer the AirTag's current path when the tag is still trackable.
  let currentPath = resolveCurrentPath(trail[0] ?? seed, eventsOldestFirst);
  if (seedTagId) {
    const tag = getTag(seedTagId);
    if (tag?.trackable && tag.currentPath) {
      currentPath = path.resolve(tag.currentPath);
    }
  }

  return { history, trail, currentPath };
}

export async function readRoundupTail(limit: number): Promise<RoundupEvent[]> {
  const n = Math.max(1, Math.min(2000, Math.floor(limit)));
  const all = await readAllRoundupEvents();
  const tail = all.slice(Math.max(0, all.length - n));
  tail.reverse(); // newest first
  return tail.map((e) => ({
    ...withPresentation(e),
    exists: pathExists(e.newPath),
  }));
}

function normalizeQuery(q: string): { kind: "path" | "basename"; value: string } {
  const trimmed = q.trim();
  if (!trimmed) return { kind: "basename", value: "" };
  if (
    path.isAbsolute(trimmed) ||
    trimmed.includes("/") ||
    trimmed.includes("\\")
  ) {
    return { kind: "path", value: path.resolve(trimmed) };
  }
  return { kind: "basename", value: path.basename(trimmed) };
}

export interface LookupOptions {
  query?: string;
  path?: string;
  basename?: string;
  size?: number;
  mtimeMs?: number;
  ino?: number;
  dev?: number;
  limit?: number;
}

export async function lookupRoundup(
  opts: LookupOptions
): Promise<RoundupCandidate[]> {
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit ?? 20)));
  const all = await readAllRoundupEvents();

  const oldestFirst = all;
  const newestFirst = [...all].reverse();

  let pathQuery: string | null = null;
  let basenameQuery: string | null = null;

  if (opts.path && opts.path.trim()) {
    pathQuery = path.resolve(opts.path.trim());
  } else if (opts.basename && opts.basename.trim()) {
    basenameQuery = path.basename(opts.basename.trim());
  } else if (opts.query && opts.query.trim()) {
    const n = normalizeQuery(opts.query);
    if (n.kind === "path") pathQuery = n.value;
    else basenameQuery = n.value;
  }

  const fpQuery: RoundupFingerprint | undefined =
    typeof opts.size === "number" && typeof opts.mtimeMs === "number"
      ? {
          size: opts.size,
          mtimeMs: opts.mtimeMs,
          ...(typeof opts.ino === "number" ? { ino: opts.ino } : {}),
          ...(typeof opts.dev === "number" ? { dev: opts.dev } : {}),
        }
      : undefined;

  if (!pathQuery && !basenameQuery && !fpQuery) return [];

  const candidates: RoundupCandidate[] = [];
  const seenCurrent = new Set<string>();

  function pushCandidate(c: RoundupCandidate) {
    if (seenCurrent.has(c.currentPath) && c.match !== "exact_path" && c.match !== "tag") {
      return;
    }
    seenCurrent.add(c.currentPath);
    candidates.push(c);
  }

  // Direct AirTag hit by path (even with no events yet).
  if (pathQuery) {
    const tag = findTagForPath(pathQuery);
    if (tag) {
      const life = buildLifeHistory(pathQuery, oldestFirst, tag.id);
      const currentPath = tag.trackable
        ? path.resolve(tag.currentPath)
        : life.currentPath;
      pushCandidate({
        event: withPresentation({
          ts: tag.updatedAt,
          kind: "manual",
          entityType: "other",
          oldPath: pathQuery,
          newPath: currentPath,
          triggeredBy: "manual",
          tagId: tag.id,
          exists: pathExists(currentPath),
        }),
        match: "tag",
        currentPath,
        currentExists: pathExists(currentPath),
        score: 110,
        history: life.history.map((h) => ({
          ...withPresentation(h),
          exists: pathExists(h.newPath),
        })),
        trail:
          tag.paths.length > 0
            ? [...new Set([...tag.paths, ...life.trail])]
            : life.trail,
        tag,
      });
    }
  }

  for (const e of newestFirst) {
    let match: RoundupCandidate["match"] | null = null;
    let score = 0;
    let seedForHistory = path.resolve(e.newPath);

    if (pathQuery) {
      const oldP = path.resolve(e.oldPath);
      const newP = path.resolve(e.newPath);
      if (oldP === pathQuery || newP === pathQuery) {
        match = "exact_path";
        score = 100;
        seedForHistory = pathQuery;
      } else if (
        oldP.toLowerCase() === pathQuery.toLowerCase() ||
        newP.toLowerCase() === pathQuery.toLowerCase()
      ) {
        match = "exact_path";
        score = 95;
        seedForHistory = pathQuery;
      }
    }

    if (!match && basenameQuery) {
      const needle = basenameQuery.toLowerCase();
      const names = [
        e.oldName,
        e.newName,
        path.basename(e.oldPath),
        path.basename(e.newPath),
      ]
        .filter(Boolean)
        .map((s) => String(s).toLowerCase());
      if (names.includes(needle)) {
        match = "basename";
        score = 70;
        seedForHistory = path.resolve(e.oldPath);
      }
    }

    if (!match && fpQuery && fingerprintsMatch(e.fingerprint, fpQuery)) {
      match = "fingerprint";
      score = 60;
    }

    if (!match) continue;

    const tag = e.tagId ? getTag(e.tagId) : findTagForPath(seedForHistory);
    const life = buildLifeHistory(seedForHistory, oldestFirst, tag?.id);
    let currentPath = life.currentPath;
    if (tag?.trackable && tag.currentPath) {
      currentPath = path.resolve(tag.currentPath);
    }

    const currentExists = pathExists(currentPath);
    if (currentExists) score += 10;
    if (e.entityType === "library" || e.entityType === "pool") score += 2;
    score += Math.min(life.history.length, 5);
    if (tag?.trackable) score += 5;

    pushCandidate({
      event: { ...withPresentation(e), exists: pathExists(e.newPath) },
      match,
      currentPath,
      currentExists,
      score,
      history: life.history.map((h) => ({
        ...withPresentation(h),
        exists: pathExists(h.newPath),
      })),
      trail:
        tag && tag.paths.length > 0
          ? [...new Set([...tag.paths, ...life.trail])]
          : life.trail,
      ...(tag ? { tag } : {}),
    });
  }

  // Basename match against tag path history.
  if (basenameQuery) {
    const needle = basenameQuery.toLowerCase();
    for (const tag of listTags(500)) {
      const hit = tag.paths.some((p) => path.basename(p).toLowerCase() === needle) ||
        path.basename(tag.currentPath).toLowerCase() === needle;
      if (!hit) continue;
      const life = buildLifeHistory(tag.currentPath, oldestFirst, tag.id);
      const currentPath = path.resolve(tag.currentPath);
      pushCandidate({
        event: withPresentation({
          ts: tag.updatedAt,
          kind: "manual",
          entityType: "other",
          oldPath: tag.paths[0] ?? tag.currentPath,
          newPath: currentPath,
          triggeredBy: "manual",
          tagId: tag.id,
          exists: pathExists(currentPath),
        }),
        match: "tag",
        currentPath,
        currentExists: pathExists(currentPath),
        score: tag.trackable ? 85 : 65,
        history: life.history.map((h) => ({
          ...withPresentation(h),
          exists: pathExists(h.newPath),
        })),
        trail: [...new Set([...tag.paths, ...life.trail])],
        tag,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score || b.event.ts - a.event.ts);
  return candidates.slice(0, limit);
}

export const ROUNDUP_LOG_PATH = ROUNDUP_PATH;
export const ROUNDUP_SETTINGS_PATH = SETTINGS_PATH;
export const ROUNDUP_LINEAGE_LOG_PATH = ROUNDUP_LINEAGE_PATH;

/*
 * TODO(roundup-cloud): Dropbox / Google Drive watchers
 *   - Adapter interface beside the local chokidar watcher
 *   - Emit kind "external_detected" with triggeredBy "scan"
 *   - Never forward parent env / API tokens into cloud SDKs
 */
