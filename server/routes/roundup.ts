import { Router } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  appendRoundupEvent,
  isAllowlistedWatchPath,
  isRoundupMediaPath,
  lookupRoundup,
  normalizeApprovedRootReason,
  readRoundupSettings,
  readRoundupTail,
  writeRoundupSettings,
  type RoundupEntityType,
  type RoundupKind,
  type RoundupTriggeredBy,
  type RoundupWatchRootId,
} from "../util/roundup.js";
import {
  ensureTrackable,
  findTagForPath,
  getTag,
  listTags,
  setTrackable,
  setTrackableByPath,
} from "../util/roundupTags.js";
import {
  revealAllowlistedPath,
  roundupWatcher,
} from "../util/roundupWatcher.js";
import { publicError } from "../util/publicError.js";
import {
  copyRoundupMedia,
  prepareStemHandoff,
  previewRoundupMedia,
  roundupInventory,
} from "../util/roundupInventory.js";

const router = Router();

const ROOT_ID = z.string().min(1).max(200);

router.get("/roundup", async (req, res) => {
  const raw = req.query.limit;
  const parsed = typeof raw === "string" ? Number(raw) : 50;
  const limit =
    Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : 50;
  try {
    const events = await readRoundupTail(limit);
    res.json({ events });
  } catch (err) {
    res.status(500).json({ error: publicError(err, "roundup:tail") });
  }
});

router.get("/roundup/lookup", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : undefined;
  const pathQ = typeof req.query.path === "string" ? req.query.path : undefined;
  const basename =
    typeof req.query.basename === "string" ? req.query.basename : undefined;
  const sizeRaw = typeof req.query.size === "string" ? Number(req.query.size) : NaN;
  const mtimeRaw =
    typeof req.query.mtimeMs === "string" ? Number(req.query.mtimeMs) : NaN;
  const inoRaw = typeof req.query.ino === "string" ? Number(req.query.ino) : NaN;
  const devRaw = typeof req.query.dev === "string" ? Number(req.query.dev) : NaN;
  const limitRaw =
    typeof req.query.limit === "string" ? Number(req.query.limit) : 20;

  if (!q && !pathQ && !basename && !(Number.isFinite(sizeRaw) && Number.isFinite(mtimeRaw))) {
    res.status(400).json({
      error: "provide q, path, basename, or size+mtimeMs",
    });
    return;
  }

  try {
    const candidates = await lookupRoundup({
      query: q,
      path: pathQ,
      basename,
      ...(Number.isFinite(sizeRaw) ? { size: sizeRaw } : {}),
      ...(Number.isFinite(mtimeRaw) ? { mtimeMs: mtimeRaw } : {}),
      ...(Number.isFinite(inoRaw) ? { ino: inoRaw } : {}),
      ...(Number.isFinite(devRaw) ? { dev: devRaw } : {}),
      limit: Number.isFinite(limitRaw) ? limitRaw : 20,
    });
    res.json({ candidates });
  } catch (err) {
    res.status(500).json({ error: publicError(err, "roundup:lookup") });
  }
});

router.get("/roundup/watcher", (_req, res) => {
  res.json(roundupWatcher.status());
});

const WatcherBody = z.object({
  enabled: z.boolean().optional(),
  /** Convenience: set one root on/off without rewriting the full list. */
  root: z
    .object({
      id: ROOT_ID,
      enabled: z.boolean(),
    })
    .optional(),
});

const ApproveRootBody = z.object({
  path: z.string().min(1).max(4096),
  label: z.string().trim().min(1).max(120),
  // The two legacy spellings stay accepted so older clients and scripts keep
  // working; normalizeApprovedRootReason maps them to the current names below.
  reason: z
    .enum([
      "seedance",
      "droplet",
      "generator_cloud",
      "generator_local",
      "gunslinger_dropbox",
      "gunslinger_seedance",
    ])
    .transform((value) => normalizeApprovedRootReason(value)!),
  approved: z.literal(true),
});

router.post("/roundup/roots/approve", async (req, res) => {
  const parsed = ApproveRootBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    if (!path.isAbsolute(parsed.data.path)) {
      res.status(400).json({ error: "absolute folder path required" });
      return;
    }
    const canonical = fs.realpathSync(parsed.data.path);
    if (
      !fs.statSync(canonical).isDirectory() ||
      !isAllowlistedWatchPath(canonical)
    ) {
      res.status(403).json({ error: "folder is outside the existing safe root policy" });
      return;
    }
    const cur = readRoundupSettings();
    const existing = cur.approvedRoots.find((root) => root.path === canonical);
    if (!existing) {
      const id = `${parsed.data.reason}:${crypto.randomUUID()}`;
      cur.approvedRoots.push({
        id,
        label: parsed.data.label,
        path: canonical,
        reason: parsed.data.reason,
      });
      cur.watchedRootIds = [...new Set([...cur.watchedRootIds, id])];
      writeRoundupSettings(cur);
    }
    res.json(await roundupWatcher.restart().then(() => roundupWatcher.status()));
  } catch {
    res.status(400).json({ error: "approved folder must already exist and be readable" });
  }
});

router.post("/roundup/watcher", async (req, res) => {
  const parsed = WatcherBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const cur = readRoundupSettings();
    let watchedRootIds = cur.watchedRootIds;
    let disabledRoots = cur.disabledRoots;
    if (parsed.data.root) {
      const set = new Set<RoundupWatchRootId>(watchedRootIds);
      const legacyDisabled = new Set<RoundupWatchRootId>(disabledRoots);
      if (parsed.data.root.enabled) {
        set.add(parsed.data.root.id);
        legacyDisabled.delete(parsed.data.root.id);
      } else {
        set.delete(parsed.data.root.id);
        legacyDisabled.add(parsed.data.root.id);
      }
      watchedRootIds = [...set];
      disabledRoots = [...legacyDisabled];
    }
    const status = await roundupWatcher.applySettings({
      enabled: parsed.data.enabled,
      disabledRoots,
      watchedRootIds,
    });
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: publicError(err, "roundup:watcher") });
  }
});

router.post("/roundup/reveal", (req, res) => {
  const Schema = z.object({ path: z.string().min(1) });
  const candidate =
    typeof req.body?.path === "string"
      ? req.body.path
      : typeof req.query.path === "string"
        ? (req.query.path as string)
        : "";
  const parsed = Schema.safeParse({ path: candidate });
  if (!parsed.success) {
    res.status(400).json({ error: "path required" });
    return;
  }
  const result = revealAllowlistedPath(parsed.data.path);
  if ("error" in result) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({ ok: true });
});

router.get("/roundup/tags", (req, res) => {
  const raw = req.query.limit;
  const parsed = typeof raw === "string" ? Number(raw) : 100;
  const limit =
    Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : 100;
  try {
    res.json({ tags: listTags(limit) });
  } catch (err) {
    res.status(500).json({ error: publicError(err, "roundup:tags") });
  }
});

router.get("/roundup/tags/by-path", (req, res) => {
  const p = typeof req.query.path === "string" ? req.query.path : "";
  if (!p) {
    res.status(400).json({ error: "path required" });
    return;
  }
  const tag = findTagForPath(p);
  res.json({ tag: tag ?? null });
});

const TrackBody = z.object({
  trackable: z.boolean(),
  id: z.string().uuid().optional(),
  path: z.string().min(1).optional(),
});

/** Lasso / untag — toggle AirTag tracking for a file identity. */
router.post("/roundup/track", (req, res) => {
  const parsed = TrackBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    let tag = null;
    if (parsed.data.id) {
      if (parsed.data.trackable) {
        const existing = getTag(parsed.data.id);
        if (!existing) {
          res.status(404).json({ error: "tag not found" });
          return;
        }
        tag = setTrackable(parsed.data.id, true);
        if (tag) ensureTrackable(tag.currentPath, { forceTrackable: true });
      } else {
        tag = setTrackable(parsed.data.id, false);
      }
    } else if (parsed.data.path) {
      tag = setTrackableByPath(parsed.data.path, parsed.data.trackable);
    } else {
      res.status(400).json({ error: "id or path required" });
      return;
    }
    if (!tag) {
      res.status(404).json({ error: "could not update trackable state" });
      return;
    }
    res.json({ tag });
  } catch (err) {
    res.status(500).json({ error: publicError(err, "roundup:track") });
  }
});

const InventoryStartBody = z.object({
  rootIds: z.array(ROOT_ID).max(50).default([]),
  limit: z.number().int().min(1).max(5_000).default(1_000),
});

router.post("/roundup/inventory", (req, res) => {
  const parsed = InventoryStartBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    res.status(202).json(roundupInventory.start(parsed.data.rootIds, parsed.data.limit));
  } catch (error) {
    res.status(409).json({ error: publicError(error, "roundup:inventory-start") });
  }
});

router.get("/roundup/inventory/:id", (req, res) => {
  const job = roundupInventory.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "inventory job not found" });
    return;
  }
  res.json(job);
});

router.post("/roundup/inventory/:id/cancel", (req, res) => {
  const job = roundupInventory.cancel(req.params.id);
  if (!job) {
    res.status(404).json({ error: "inventory job not found" });
    return;
  }
  res.json(job);
});

router.post("/roundup/inventory/:id/pause", (req, res) => {
  const job = roundupInventory.pause(req.params.id);
  if (!job) {
    res.status(404).json({ error: "inventory job not found" });
    return;
  }
  res.json(job);
});

router.post("/roundup/inventory/:id/resume", (req, res) => {
  const job = roundupInventory.resume(req.params.id);
  if (!job) {
    res.status(404).json({ error: "inventory job not found" });
    return;
  }
  res.status(job.status === "error" ? 409 : 202).json(job);
});

const MediaPathBody = z.object({ path: z.string().min(1).max(4096) });

router.post("/roundup/export-preview", (req, res) => {
  const parsed = MediaPathBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    res.json({ item: previewRoundupMedia(parsed.data.path) });
  } catch (error) {
    res.status(409).json({ error: publicError(error, "roundup:export-preview") });
  }
});

router.post("/roundup/export-copy", (req, res) => {
  const parsed = MediaPathBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    res.status(201).json(copyRoundupMedia(parsed.data.path));
  } catch (error) {
    res.status(409).json({ error: publicError(error, "roundup:export-copy") });
  }
});

const StemHandoffBody = MediaPathBody.extend({
  confirmedExternalProcessing: z.literal(true),
});

router.post("/roundup/stems-handoff", (req, res) => {
  const parsed = StemHandoffBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "path and explicit external-processing confirmation are required",
    });
    return;
  }
  try {
    res.status(201).json(
      prepareStemHandoff(
        parsed.data.path,
        parsed.data.confirmedExternalProcessing
      )
    );
  } catch (error) {
    res.status(409).json({ error: publicError(error, "roundup:stems-handoff") });
  }
});

const RecordBody = z.object({
  kind: z
    .enum([
      "pool_move",
      "library_rename",
      "image_move",
      "clip_restore",
      "orphan_trash",
      "manual",
      "external_detected",
    ])
    .default("manual"),
  entityType: z
    .enum(["pool", "library", "image", "other"])
    .default("other"),
  oldPath: z.string().min(1),
  newPath: z.string().min(1),
  oldName: z.string().optional(),
  newName: z.string().optional(),
  oldId: z.string().optional(),
  newId: z.string().optional(),
  triggeredBy: z
    .enum([
      "user",
      "auto_organize",
      "migration",
      "restore",
      "orphan_trash",
      "manual",
      "scan",
      "watcher",
    ])
    .default("manual"),
});

router.post("/roundup/record", (req, res) => {
  const parsed = RecordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const body = parsed.data;
  if (!isRoundupMediaPath(body.oldPath) && !isRoundupMediaPath(body.newPath)) {
    res.status(400).json({
      error: "paths must use a supported media extension (video, image, or audio)",
    });
    return;
  }
  appendRoundupEvent({
    kind: body.kind as RoundupKind,
    entityType: body.entityType as RoundupEntityType,
    oldPath: body.oldPath,
    newPath: body.newPath,
    oldName: body.oldName,
    newName: body.newName,
    oldId: body.oldId,
    newId: body.newId,
    triggeredBy: body.triggeredBy as RoundupTriggeredBy,
  });
  res.json({ ok: true });
});

export default router;
