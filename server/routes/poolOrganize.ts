import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { CAPTION_TMP_DIR, config } from "../config.js";
import { extractFrameJpeg, getDuration } from "../ffmpeg.js";
import { getOpenAI } from "../openai.js";
import { resolvePoolId } from "./pool.js";
import { listCharacters } from "../util/characters.js";
import { listEntities } from "../util/entities.js";
import { appendActivity } from "../util/activity.js";

/*
 * Folder-suggestion vision pass for the Pool tab's Auto-organize wizard.
 * Given a list of pool ids, sample 3 frames per source (10/50/90% of duration)
 * and ask GPT-4o for a setting + suggested folder name. Returns a flat list
 * the frontend uses to populate the review table.
 *
 * Distinct from /pool/:id/analyze (entity tagging) — this one is purely about
 * "where should this video live on disk".
 */

const MODEL = "gpt-4o";
const MAX_BATCH = 100;
const CONCURRENCY = 4;

const router = Router();

interface Suggestion {
  folder: string;
  setting: string;
  timeOfDay: string;
  characters: string[];
  confidence: "low" | "med" | "high";
}

interface SuggestionRow {
  id: string;
  filename: string;
  currentFolder: string;
  duration: number;
  suggested: Suggestion | null;
  error?: string;
}

const SYSTEM_PROMPT = `You are sorting raw AI-generated video clips into themed
on-disk folders for a film cataloger. You will see 3 frames sampled from a
single short video at 10 / 50 / 90% of its duration. Your job is to suggest
ONE short, kebab-case folder name that groups visually-similar clips together
(by location and rough vibe).

Return strict JSON ONLY with this shape:
{
  "setting": string,           // e.g. "saloon interior", "desert exterior", "town street"
  "timeOfDay": string,         // one of: "day" | "night" | "golden hour" | "unknown"
  "characters": string[],      // best-guess names from the supplied catalog, or "unknown person"
  "folder": string,            // kebab-case, 1-3 words, e.g. "saloon-scenes", "desert-rides"
  "confidence": string         // "low" | "med" | "high"
}

Rules:
- "folder" must be lowercase letters, digits, or hyphens — no spaces, no
  underscores, no slashes, no path separators.
- Prefer a SHARED folder across visually-similar clips (e.g. all desert vistas
  → "desert-rides", all saloon interiors → "saloon-scenes"). Re-use names you'd
  expect to apply to similar footage.
- Use "characters" only when you can match a name from the catalog; otherwise
  list "unknown person" once for any unidentified figure.`;

function fileToDataUrl(p: string): string {
  const buf = fs.readFileSync(p);
  const mime = p.endsWith(".png") ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function pickFrameTimes(durationSec: number): number[] {
  const d = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  if (d <= 0.5) return [0];
  if (d < 2) return [d * 0.5];
  return [d * 0.1, d * 0.5, d * 0.9];
}

function sanitizeFolderName(raw: unknown): string {
  const s = String(raw ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return s;
}

function sanitizeConfidence(raw: unknown): "low" | "med" | "high" {
  const s = String(raw ?? "").toLowerCase().trim();
  if (s === "high") return "high";
  if (s === "low") return "low";
  return "med";
}

function sanitizeTimeOfDay(raw: unknown): string {
  const s = String(raw ?? "").toLowerCase().trim();
  if (s === "day" || s === "night" || s === "golden hour") return s;
  return "unknown";
}

async function pLimitAll<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, Math.max(1, items.length)) },
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

function relFolder(absoluteFile: string): string {
  const rel = path.relative(config.poolDir, path.dirname(absoluteFile));
  if (!rel || rel === ".") return "";
  return rel.split(path.sep).join("/");
}

async function analyzeOne(
  id: string,
  absPath: string,
  catalogText: string
): Promise<SuggestionRow> {
  const filename = path.basename(absPath);
  const currentFolder = relFolder(absPath);

  let duration = 0;
  try {
    duration = await getDuration(absPath);
  } catch {
    // Tolerate ffprobe failure — we can still try to grab a frame at t=0.
  }

  const times = pickFrameTimes(duration);
  const cacheKey = crypto.randomBytes(8).toString("hex");
  const tmpDir = path.join(CAPTION_TMP_DIR, `pool-org-${cacheKey}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const framePaths: string[] = [];
  try {
    for (let i = 0; i < times.length; i += 1) {
      const out = path.join(tmpDir, `f${i}.jpg`);
      try {
        await extractFrameJpeg(absPath, times[i], out, 768);
        framePaths.push(out);
      } catch {
        // skip this frame; if we end with zero frames we'll bail out below
      }
    }
    if (framePaths.length === 0) {
      return {
        id,
        filename,
        currentFolder,
        duration,
        suggested: null,
        error: "no frames extracted",
      };
    }

    const ai = getOpenAI();
    const frameImages = framePaths.map((p) => ({
      type: "image_url" as const,
      image_url: { url: fileToDataUrl(p), detail: "low" as const },
    }));

    const response = await ai.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "CHARACTER CATALOG (use these exact names when matching; otherwise label as \"unknown person\"):\n" +
                catalogText,
            },
            {
              type: "text",
              text:
                "CANDIDATE FRAMES (10%, 50%, 90% of clip — same scene, same video):",
            },
            ...frameImages,
          ],
        },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      parsed = {};
    }

    const folder = sanitizeFolderName(parsed.folder);
    const setting = String(parsed.setting ?? "").trim().slice(0, 120);
    const timeOfDay = sanitizeTimeOfDay(parsed.timeOfDay);
    const confidence = sanitizeConfidence(parsed.confidence);
    const charsArr = Array.isArray(parsed.characters)
      ? parsed.characters
          .map((c) => String(c ?? "").trim())
          .filter((c) => c.length > 0 && c.length < 80)
          .slice(0, 6)
      : [];

    if (!folder) {
      return {
        id,
        filename,
        currentFolder,
        duration,
        suggested: null,
        error: "empty folder suggestion",
      };
    }

    return {
      id,
      filename,
      currentFolder,
      duration,
      suggested: {
        folder,
        setting,
        timeOfDay,
        characters: charsArr,
        confidence,
      },
    };
  } catch (err) {
    return {
      id,
      filename,
      currentFolder,
      duration,
      suggested: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

const BodySchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
});

router.post("/pool/analyze-content", async (req, res) => {
  const parsed = BodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const ids = parsed.data.ids.slice(0, MAX_BATCH);
  if (parsed.data.ids.length > MAX_BATCH) {
    res.status(400).json({
      error: `too many sources — split into batches of ${MAX_BATCH}`,
    });
    return;
  }

  // Snapshot character names so the AI can match against the user's catalog
  // instead of inventing labels.
  let catalogText = "[]";
  try {
    const chars = listCharacters().map((c) => c.name);
    const scenes = listEntities("scenes").map((s) => s.name);
    catalogText = JSON.stringify({ characters: chars, scenes }, null, 0);
  } catch {
    // proceed with empty catalog
  }

  const resolved: { id: string; abs: string | null }[] = ids.map((id) => ({
    id,
    abs: resolvePoolId(id),
  }));
  const missing = resolved.filter((r) => !r.abs).map((r) => r.id);

  const suggestions = await pLimitAll(
    resolved.filter((r) => r.abs),
    CONCURRENCY,
    async (r) => analyzeOne(r.id, r.abs as string, catalogText)
  );

  for (const m of missing) {
    suggestions.push({
      id: m,
      filename: "(missing)",
      currentFolder: "",
      duration: 0,
      suggested: null,
      error: "source not in pool",
    });
  }

  appendActivity("pool_organize_analyzed", {
    requested: ids.length,
    answered: suggestions.filter((s) => s.suggested).length,
    failed: suggestions.filter((s) => !s.suggested).length,
  });

  res.json({ suggestions });
});

export default router;
