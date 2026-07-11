import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CAPTION_TMP_DIR, SUPPRESSED_TAGS } from "../config.js";
import { extractFrameJpeg } from "../ffmpeg.js";
import { getOpenAI } from "../openai.js";

/*
 * Source-level vision analysis. Runs GPT-4o over 3 representative frames
 * extracted from a pool source (10% / 50% / 90% of duration) and asks the
 * model to match against the user's existing entity catalogs rather than
 * inventing new names.
 *
 * Returns a partial SourceMeta the caller persists via `writeSourceMeta`,
 * plus a `proposedNew` field surfacing any visually-novel entities that
 * didn't match the catalog (frontend can offer "Create entity?" prompts —
 * we deliberately do NOT auto-create catalog entries from the backend).
 */

const MODEL = "gpt-4o";

export interface NamedRef {
  id: string;
  name: string;
}

export interface AnalyzeCatalogs {
  characters: NamedRef[];
  scenes: NamedRef[];
  objects: NamedRef[];
}

export interface AnalyzeResult {
  characters: NamedRef[];
  scenes: NamedRef[];
  objects: NamedRef[];
  tags: string[];
  mood: string;
  framesUsed: number;
  model: string;
  proposedNew: {
    characters: string[];
    scenes: string[];
    objects: string[];
  };
}

function fileToDataUrl(p: string): string {
  const buf = fs.readFileSync(p);
  const mime = p.endsWith(".png") ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/** Sample times at 10% / 50% / 90%, clamped for very short clips. */
function pickFrameTimes(durationSec: number): number[] {
  const d = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  if (d <= 0.5) return [0];
  if (d < 2) return [d * 0.5];
  if (d < 6) return [d * 0.1, d * 0.5, d * 0.9];
  return [d * 0.1, d * 0.5, d * 0.9];
}

const SYSTEM_PROMPT = `You are tagging a source video clip for a personal cataloger. The user already has a fixed catalog of characters, scenes, and objects — you will be given those catalogs as JSON arrays of names. Match against those catalogs by name; don't invent new ones unless the visual clearly contains an entity not in the catalog (then list it under new_characters / new_scenes / new_objects). Do NOT include style-of-art tags like "animation", "cartoon", "illustration" — the entire library shares one art style. Tags should describe what is happening, mood, or notable visual elements — short lowercase phrases.

Return strict JSON ONLY with this shape:
{
  "characters": string[],
  "scenes": string[],
  "objects": string[],
  "tags": string[],
  "mood": string,
  "new_characters": string[],
  "new_scenes": string[],
  "new_objects": string[]
}

"characters" / "scenes" / "objects" must be names that EXIST in the corresponding catalog input. Use empty arrays freely. The new_* arrays surface entities you genuinely saw that aren't in the catalog — be conservative.`;

function caseInsensitiveMatch(
  names: string[],
  catalog: NamedRef[]
): { matched: NamedRef[]; unmatched: string[] } {
  const byName = new Map<string, NamedRef>();
  for (const c of catalog) byName.set(c.name.toLowerCase(), c);
  const matched: NamedRef[] = [];
  const unmatched: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const n = String(raw ?? "").trim();
    if (!n) continue;
    const hit = byName.get(n.toLowerCase());
    if (hit) {
      if (!seen.has(hit.id)) {
        matched.push(hit);
        seen.add(hit.id);
      }
    } else {
      unmatched.push(n);
    }
  }
  return { matched, unmatched };
}

export async function analyzeSource(
  absPath: string,
  durationSec: number,
  catalogs: AnalyzeCatalogs
): Promise<AnalyzeResult> {
  const ai = getOpenAI();

  const times = pickFrameTimes(durationSec);
  const cacheKey = crypto.randomBytes(8).toString("hex");
  const tmpDir = path.join(CAPTION_TMP_DIR, `srcmeta-${cacheKey}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const framePaths: string[] = [];
  try {
    for (let i = 0; i < times.length; i += 1) {
      const out = path.join(tmpDir, `f${i}.jpg`);
      await extractFrameJpeg(absPath, times[i], out, 768);
      framePaths.push(out);
    }

    const frameImages = framePaths.map((p) => ({
      type: "image_url" as const,
      image_url: { url: fileToDataUrl(p), detail: "low" as const },
    }));

    const catalogText = JSON.stringify(
      {
        characters: catalogs.characters.map((c) => c.name),
        scenes: catalogs.scenes.map((c) => c.name),
        objects: catalogs.objects.map((c) => c.name),
      },
      null,
      0
    );

    const response = await ai.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "EXISTING CATALOGS (use these names verbatim when matching):\n" +
                catalogText,
            },
            { type: "text", text: "CANDIDATE FRAMES (10%, 50%, 90% of clip):" },
            ...frameImages,
          ],
        },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    let parsed: any = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }

    const charsRes = caseInsensitiveMatch(
      Array.isArray(parsed.characters) ? parsed.characters : [],
      catalogs.characters
    );
    const scenesRes = caseInsensitiveMatch(
      Array.isArray(parsed.scenes) ? parsed.scenes : [],
      catalogs.scenes
    );
    const objectsRes = caseInsensitiveMatch(
      Array.isArray(parsed.objects) ? parsed.objects : [],
      catalogs.objects
    );

    const tags: string[] = Array.isArray(parsed.tags)
      ? parsed.tags
          .map((t: unknown) => String(t).toLowerCase().trim())
          .filter((t: string) => t && !SUPPRESSED_TAGS.has(t))
          .slice(0, 12)
      : [];

    const newChars = mergeProposedNew(
      Array.isArray(parsed.new_characters) ? parsed.new_characters : [],
      charsRes.unmatched
    );
    const newScenes = mergeProposedNew(
      Array.isArray(parsed.new_scenes) ? parsed.new_scenes : [],
      scenesRes.unmatched
    );
    const newObjects = mergeProposedNew(
      Array.isArray(parsed.new_objects) ? parsed.new_objects : [],
      objectsRes.unmatched
    );

    return {
      characters: charsRes.matched,
      scenes: scenesRes.matched,
      objects: objectsRes.matched,
      tags,
      mood: typeof parsed.mood === "string" ? parsed.mood.slice(0, 200) : "",
      framesUsed: framePaths.length,
      model: MODEL,
      proposedNew: {
        characters: newChars,
        scenes: newScenes,
        objects: newObjects,
      },
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; tmp dir collision is harmless
    }
  }
}

function mergeProposedNew(declared: unknown[], unmatched: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (s: unknown) => {
    const v = String(s ?? "").trim();
    if (!v) return;
    const key = v.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(v);
  };
  for (const d of declared) push(d);
  for (const u of unmatched) push(u);
  return out.slice(0, 8);
}
