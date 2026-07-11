import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { config, isSupportedVideo, RESERVED_PROJECT_DIRS } from "../config.js";
import { pathToId } from "../util/id.js";
import { resolvePoolId } from "./pool.js";
import { getDuration } from "../ffmpeg.js";
import { listCharacters } from "../util/characters.js";
import { listEntities } from "../util/entities.js";
import {
  NamedRef,
  SourceMeta,
  defaultSourceMeta,
  readSourceMeta,
  writeSourceMeta,
} from "../util/sourceMeta.js";
import { analyzeSource } from "../ai/poolAnalyze.js";
import { appendActivity } from "../util/activity.js";
import { getOpenAIClientError, sendOpenAIClientError } from "../openai.js";

/*
 * Routes that drive AI-powered source-level tagging:
 *   GET  /api/pool/:id/meta            → current SourceMeta (default if absent)
 *   PATCH /api/pool/:id/meta           → user-side edits (chips, mood, notes)
 *   POST /api/pool/:id/analyze         → run vision once, persist sidecar
 *   POST /api/pool/analyze-batch       → enqueue many; returns jobId
 *   GET  /api/pool/analyze-batch/:job  → poll progress / errors
 *
 * Job state lives in-memory only (V1) — process restart drops in-flight jobs;
 * the user can re-trigger the batch from the UI.
 */

const BATCH_HARD_CAP = 200;
const BATCH_CONCURRENCY = 3;

const router = Router();

// ---- Helpers --------------------------------------------------------------

function fetchCatalogs() {
  const characters: NamedRef[] = listCharacters().map((c) => ({
    id: c.id,
    name: c.name,
  }));
  const scenes: NamedRef[] = listEntities("scenes").map((s) => ({
    id: s.id,
    name: s.name,
  }));
  const objects: NamedRef[] = listEntities("objects").map((o) => ({
    id: o.id,
    name: o.name,
  }));
  return { characters, scenes, objects };
}

async function runAnalyzeOne(
  id: string,
  force: boolean
): Promise<SourceMeta> {
  const file = resolvePoolId(id);
  if (!file) throw new Error("source not found");
  const stat = fs.statSync(file);
  const cur = readSourceMeta(id);
  if (
    !force &&
    cur.analyzedAt > 0 &&
    cur.sourceMtimeMs === stat.mtimeMs &&
    cur.framesUsed > 0
  ) {
    return cur;
  }
  const duration = await getDuration(file);
  const result = await analyzeSource(file, duration, fetchCatalogs());
  const next = writeSourceMeta(id, {
    characters: result.characters,
    scenes: result.scenes,
    objects: result.objects,
    tags: result.tags,
    mood: result.mood,
    analyzedAt: Date.now(),
    sourceMtimeMs: stat.mtimeMs,
    framesUsed: result.framesUsed,
    model: result.model,
    // Persist the AI's "proposed new" suggestions so the AI organize panel
    // can surface them across all analyzed sources after the job ends.
    proposedNew: result.proposedNew,
  });
  appendActivity("source_analyzed", {
    id,
    framesUsed: result.framesUsed,
    matched: {
      characters: result.characters.length,
      scenes: result.scenes.length,
      objects: result.objects.length,
    },
    proposedNew: result.proposedNew,
  });
  return next;
}

// ---- Per-source meta GET / PATCH -----------------------------------------

router.get("/pool/:id/meta", (req, res) => {
  try {
    const file = resolvePoolId(req.params.id);
    if (!file) {
      // Even when the source pool registry doesn't yet know this id (e.g.
      // the user hasn't loaded /api/pool yet), serve a defaulted shape so
      // the frontend can render an empty state without 404 noise.
      res.json(defaultSourceMeta(req.params.id));
      return;
    }
    res.json(readSourceMeta(req.params.id));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const PatchSchema = z.object({
  characters: z
    .array(z.object({ id: z.string(), name: z.string() }))
    .optional(),
  scenes: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
  objects: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
  tags: z.array(z.string()).optional(),
  mood: z.string().max(400).optional(),
  notes: z.string().max(4000).optional(),
  // Used by the AI organize panel's Create/Dismiss flow to strip proposed-new
  // entries from each source's sidecar after the user actions them.
  proposedNew: z
    .object({
      characters: z.array(z.string()).max(32).optional(),
      scenes: z.array(z.string()).max(32).optional(),
      objects: z.array(z.string()).max(32).optional(),
    })
    .optional(),
});

router.patch("/pool/:id/meta", (req, res) => {
  const parsed = PatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const next = writeSourceMeta(req.params.id, parsed.data);
    res.json(next);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---- Single-source analyze -----------------------------------------------

router.post("/pool/:id/analyze", async (req, res) => {
  const Schema = z.object({ force: z.boolean().optional() });
  const parsed = Schema.safeParse(req.body ?? {});
  const force = parsed.success ? Boolean(parsed.data.force) : false;
  try {
    const meta = await runAnalyzeOne(req.params.id, force);
    res.json(meta);
  } catch (err) {
    if (sendOpenAIClientError(res, err)) return;
    res.status(500).json({ error: String(err) });
  }
});

// ---- Batch job tracking --------------------------------------------------

interface BatchJob {
  id: string;
  total: number;
  done: number;
  startedAt: number;
  finishedAt: number;
  errors: { id: string; error: string }[];
  items: { id: string; ok: boolean }[];
  cancelled: boolean;
}

const jobs = new Map<string, BatchJob>();

function newJobId(): string {
  return crypto.randomBytes(6).toString("hex");
}

async function pLimitAll<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }
  );
  await Promise.all(workers);
  return out;
}

const BatchSchema = z.object({
  ids: z.array(z.string()).optional(),
  force: z.boolean().optional(),
});

router.post("/pool/analyze-batch", (req, res) => {
  const parsed = BatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const force = Boolean(parsed.data.force);

  // Omit `ids` → batch entire pool. Explicit `ids: []` is rejected so probes
  // and buggy clients can't accidentally fire vision on every source.
  if (Array.isArray(parsed.data.ids) && parsed.data.ids.length === 0) {
    res.status(400).json({
      error:
        "ids must be a non-empty array, or omit the field to batch all sources",
    });
    return;
  }

  let ids: string[] = parsed.data.ids ?? [];
  if (parsed.data.ids === undefined) {
    // Re-list the pool dir directly (mirrors listPoolFiles in routes/pool.ts)
    // so a fresh server hasn't-yet-loaded /api/pool case still works.
    try {
      const entries = fs.readdirSync(config.poolDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && RESERVED_PROJECT_DIRS.has(e.name)) continue;
        if (e.isFile() && !e.name.startsWith(".") && isSupportedVideo(e.name)) {
          ids.push(pathToId(path.join(config.poolDir, e.name)));
        }
      }
    } catch {
      // fall through with empty
    }
  }

  if (ids.length === 0) {
    res.status(400).json({ error: "no sources to analyze" });
    return;
  }

  if (ids.length > BATCH_HARD_CAP) {
    res.status(400).json({
      error: `batch too large, split into chunks of ${BATCH_HARD_CAP}`,
    });
    return;
  }

  const job: BatchJob = {
    id: newJobId(),
    total: ids.length,
    done: 0,
    startedAt: Date.now(),
    finishedAt: 0,
    errors: [],
    items: [],
    cancelled: false,
  };
  jobs.set(job.id, job);
  appendActivity("source_batch_started", {
    jobId: job.id,
    total: job.total,
    force,
  });
  console.log(
    `[poolAnalyze] batch starting: ${ids.length} sources, force=${force}`
  );

  // Fire-and-forget; client polls /pool/analyze-batch/:jobId.
  void (async () => {
    await pLimitAll(ids, BATCH_CONCURRENCY, async (id) => {
      if (job.cancelled) return;
      try {
        await runAnalyzeOne(id, force);
        job.items.push({ id, ok: true });
      } catch (err) {
        const openAIError = getOpenAIClientError(err);
        const msg = openAIError?.message ?? (err instanceof Error ? err.message : String(err));
        job.errors.push({ id, error: msg });
        job.items.push({ id, ok: false });
      } finally {
        job.done += 1;
      }
    });
    job.finishedAt = Date.now();
    // GC completed jobs after 10 min so progress polls don't pile up forever.
    setTimeout(
      () => {
        jobs.delete(job.id);
      },
      10 * 60 * 1000
    );
  })().catch(() => {
    // Errors per-item are captured; this catch is just defensive.
    job.finishedAt = Date.now();
  });

  res.json({ jobId: job.id, total: job.total });
});

router.get("/pool/analyze-batch/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "job not found" });
    return;
  }
  res.json({
    jobId: job.id,
    total: job.total,
    done: job.done,
    finished: job.finishedAt > 0,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    errors: job.errors,
    items: job.items,
  });
});

export default router;
