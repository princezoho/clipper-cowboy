import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import {
  fingerprintFile,
  fingerprintKey,
  isAllowlistedWatchPath,
  isRoundupMediaPath,
  type RoundupFingerprint,
} from "./roundup.js";

/*
 * Roundup "AirTag" identities — stable UUIDs for media files that survive
 * rename/move. Stored in `.clipcataloger/roundup-tags.json`.
 *
 * Default-on: media under allowlisted roots / Clipper mutations get a tag
 * the first time Roundup sees them (lazy — not a full Music-library seed).
 * Opt-out: set trackable=false; watcher + auto-updates skip that identity.
 */

export interface RoundupTag {
  id: string;
  /** When false, Roundup keeps the record but stops following moves. */
  trackable: boolean;
  currentPath: string;
  fingerprint?: RoundupFingerprint;
  createdAt: number;
  updatedAt: number;
  /** Paths this identity has been seen at (oldest → newest, capped). */
  paths: string[];
}

interface TagStore {
  version: 1;
  tags: RoundupTag[];
}

const TAGS_PATH = path.join(config.internalDir, "roundup-tags.json");
const MAX_PATHS = 40;

let cache: TagStore | null = null;
let dirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let pathIndex = new Map<string, RoundupTag>();
let currentPathIndex = new Map<string, RoundupTag>();
let fingerprintIndex = new Map<string, RoundupTag>();

function emptyStore(): TagStore {
  return { version: 1, tags: [] };
}

function preferNewest(
  index: Map<string, RoundupTag>,
  key: string,
  tag: RoundupTag
): void {
  const current = index.get(key);
  if (!current || tag.updatedAt > current.updatedAt) index.set(key, tag);
}

function indexTag(tag: RoundupTag): void {
  const currentPath = path.resolve(tag.currentPath);
  preferNewest(pathIndex, currentPath, tag);
  preferNewest(currentPathIndex, currentPath, tag);
  for (const seenPath of tag.paths) {
    preferNewest(pathIndex, path.resolve(seenPath), tag);
  }
  if (tag.fingerprint) {
    preferNewest(fingerprintIndex, fingerprintKey(tag.fingerprint), tag);
  }
}

function rebuildIndexes(store: TagStore): void {
  pathIndex = new Map();
  currentPathIndex = new Map();
  fingerprintIndex = new Map();
  for (const tag of store.tags) indexTag(tag);
}

function loadStore(): TagStore {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(TAGS_PATH, "utf8")) as TagStore;
    if (!raw || !Array.isArray(raw.tags)) {
      cache = emptyStore();
    } else {
      cache = { version: 1, tags: raw.tags.filter((t) => t && typeof t.id === "string") };
    }
  } catch {
    cache = emptyStore();
  }
  rebuildIndexes(cache);
  return cache;
}

function scheduleFlush(): void {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushTagsSync();
  }, 250);
  if (typeof flushTimer === "object" && "unref" in flushTimer) {
    flushTimer.unref();
  }
}

export function flushTagsSync(): void {
  if (!dirty || !cache) return;
  try {
    fs.mkdirSync(path.dirname(TAGS_PATH), { recursive: true });
    const tmp = TAGS_PATH + `.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, TAGS_PATH);
    dirty = false;
  } catch {
    // observational — never block callers
  }
}

function pushPath(tag: RoundupTag, abs: string): void {
  const resolved = path.resolve(abs);
  if (tag.paths[tag.paths.length - 1] === resolved) return;
  tag.paths.push(resolved);
  preferNewest(pathIndex, resolved, tag);
  if (tag.paths.length > MAX_PATHS) {
    tag.paths = tag.paths.slice(-MAX_PATHS);
  }
}

function findByPath(store: TagStore, abs: string): RoundupTag | undefined {
  void store;
  return pathIndex.get(path.resolve(abs));
}

function findByFingerprint(
  store: TagStore,
  fp: RoundupFingerprint
): RoundupTag | undefined {
  void store;
  return fingerprintIndex.get(fingerprintKey(fp));
}

export function getTag(id: string): RoundupTag | undefined {
  return loadStore().tags.find((t) => t.id === id);
}

export function listTags(limit = 200): RoundupTag[] {
  const n = Math.max(1, Math.min(2000, Math.floor(limit)));
  return [...loadStore().tags]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, n);
}

export function findTagForPath(absPath: string): RoundupTag | undefined {
  return findByPath(loadStore(), absPath);
}

/**
 * Resolve or create a trackable identity for a media file.
 * Returns null when the path isn't Roundup media, isn't allowlisted, or the
 * existing tag was opted out and createIfMissing would re-activate tracking
 * (createIfMissing=false for pure lookups).
 */
export function ensureTrackable(
  absPath: string,
  opts?: {
    fingerprint?: RoundupFingerprint;
    /** When false, never create — only return existing. Default true. */
    createIfMissing?: boolean;
    /** Force re-enable an opted-out tag. */
    forceTrackable?: boolean;
  }
): RoundupTag | null {
  try {
    const resolved = path.resolve(absPath);
    if (!isRoundupMediaPath(resolved)) return null;
    if (!isAllowlistedWatchPath(resolved)) return null;

    const store = loadStore();
    const fp = opts?.fingerprint ?? fingerprintFile(resolved);
    let tag =
      currentPathIndex.get(resolved) ??
      (fp ? findByFingerprint(store, fp) : undefined);

    if (tag) {
      if (!tag.trackable && !opts?.forceTrackable) {
        return tag; // opted out — return as-is, caller checks .trackable
      }
      const fingerprintChanged =
        Boolean(fp) &&
        (!tag.fingerprint ||
          fingerprintKey(tag.fingerprint) !== fingerprintKey(fp!));
      const pathChanged = path.resolve(tag.currentPath) !== resolved;
      const trackableChanged = Boolean(opts?.forceTrackable && !tag.trackable);
      if (!fingerprintChanged && !pathChanged && !trackableChanged) {
        return tag;
      }
      if (trackableChanged) tag.trackable = true;
      if (pathChanged && currentPathIndex.get(path.resolve(tag.currentPath)) === tag) {
        currentPathIndex.delete(path.resolve(tag.currentPath));
      }
      tag.currentPath = resolved;
      if (fingerprintChanged && fp) tag.fingerprint = fp;
      tag.updatedAt = Date.now();
      pushPath(tag, resolved);
      indexTag(tag);
      scheduleFlush();
      return tag;
    }

    if (opts?.createIfMissing === false) return null;

    tag = {
      id: crypto.randomUUID(),
      trackable: true,
      currentPath: resolved,
      ...(fp ? { fingerprint: fp } : {}),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      paths: [resolved],
    };
    store.tags.push(tag);
    indexTag(tag);
    scheduleFlush();
    return tag;
  } catch {
    return null;
  }
}

/**
 * Allocate a distinct AirTag for a newly materialized copy. Copies can have an
 * identical fingerprint to their source, so normal fingerprint matching would
 * incorrectly advance the source identity to the derived file.
 */
export function createTrackableCopyIdentity(absPath: string): RoundupTag | null {
  try {
    const resolved = path.resolve(absPath);
    if (!isRoundupMediaPath(resolved) || !isAllowlistedWatchPath(resolved)) {
      return null;
    }
    const existingAtPath = findByPath(loadStore(), resolved);
    if (existingAtPath && path.resolve(existingAtPath.currentPath) === resolved) {
      return existingAtPath;
    }
    const now = Date.now();
    const fingerprint = fingerprintFile(resolved);
    const tag: RoundupTag = {
      id: crypto.randomUUID(),
      trackable: true,
      currentPath: resolved,
      ...(fingerprint ? { fingerprint } : {}),
      createdAt: now,
      updatedAt: now,
      paths: [resolved],
    };
    loadStore().tags.push(tag);
    indexTag(tag);
    scheduleFlush();
    return tag;
  } catch {
    return null;
  }
}

/** Record a rename/move onto an existing (or newly created) trackable tag. */
export function followTrackableMove(
  oldPath: string,
  newPath: string,
  fingerprint?: RoundupFingerprint
): RoundupTag | null {
  try {
    const oldAbs = path.resolve(oldPath);
    const newAbs = path.resolve(newPath);
    const store = loadStore();
    const fp = fingerprint ?? fingerprintFile(newAbs) ?? fingerprintFile(oldAbs);

    let tag =
      findByPath(store, oldAbs) ??
      findByPath(store, newAbs) ??
      (fp ? findByFingerprint(store, fp) : undefined);

    if (tag && !tag.trackable) {
      // Opted out — do not follow.
      return tag;
    }

    if (!tag) {
      // Default-on: create at the new location (or old if new isn't media yet).
      const seed = isRoundupMediaPath(newAbs) ? newAbs : oldAbs;
      const created = ensureTrackable(seed, { fingerprint: fp ?? undefined });
      if (created) {
        // The initial watcher hop must retain both endpoints, not only the
        // destination where the UUID was first allocated.
        created.paths = [];
        pushPath(created, oldAbs);
        pushPath(created, newAbs);
        if (currentPathIndex.get(path.resolve(created.currentPath)) === created) {
          currentPathIndex.delete(path.resolve(created.currentPath));
        }
        created.currentPath = newAbs;
        indexTag(created);
        scheduleFlush();
      }
      return created;
    }

    pushPath(tag, oldAbs);
    pushPath(tag, newAbs);
    if (currentPathIndex.get(path.resolve(tag.currentPath)) === tag) {
      currentPathIndex.delete(path.resolve(tag.currentPath));
    }
    tag.currentPath = newAbs;
    if (fp) tag.fingerprint = fp;
    tag.updatedAt = Date.now();
    indexTag(tag);
    scheduleFlush();
    return tag;
  } catch {
    return null;
  }
}

export function setTrackable(
  id: string,
  trackable: boolean
): RoundupTag | null {
  const store = loadStore();
  const tag = store.tags.find((t) => t.id === id);
  if (!tag) return null;
  tag.trackable = trackable;
  tag.updatedAt = Date.now();
  scheduleFlush();
  flushTagsSync();
  return tag;
}

export function setTrackableByPath(
  absPath: string,
  trackable: boolean
): RoundupTag | null {
  const resolved = path.resolve(absPath);
  if (trackable) {
    return ensureTrackable(resolved, { forceTrackable: true, createIfMissing: true });
  }
  const existing =
    findTagForPath(resolved) ??
    ensureTrackable(resolved, { createIfMissing: true });
  if (!existing) return null;
  return setTrackable(existing.id, false);
}

export const ROUNDUP_TAGS_PATH = TAGS_PATH;
