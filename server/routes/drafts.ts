import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { config } from "../config.js";

/**
 * Drafts: per-source unsaved editor state. Mid-edit work (IN/OUT + name +
 * description + tags + characters/scenes/objects) is autosaved here so closing
 * the editor — or even quitting the app — doesn't lose progress.
 *
 * Stored as a single JSON map at `<projectDir>/.clipcataloger/drafts.json`,
 * sibling of the per-clip sidecars in `clip-meta/`. Reads on every request
 * (drafts are tiny); writes via temp+rename for crash safety.
 */

const NamedRefSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
});

const DraftBodySchema = z
  .object({
    in: z.number().min(0),
    out: z.number(),
    name: z.string().max(500),
    description: z.string().max(5000),
    tags: z.array(z.string().max(120)).max(50),
    characters: z.array(NamedRefSchema).max(50),
    scenes: z.array(NamedRefSchema).max(50),
    objects: z.array(NamedRefSchema).max(50),
  })
  .refine((d) => d.out > d.in, {
    message: "out must be greater than in",
    path: ["out"],
  });

export interface Draft {
  in: number;
  out: number;
  name: string;
  description: string;
  tags: string[];
  characters: { id: string; name: string }[];
  scenes: { id: string; name: string }[];
  objects: { id: string; name: string }[];
  updatedAt: number;
}

export const DRAFTS_PATH = path.join(config.internalDir, "drafts.json");

function readDraftsFile(): Record<string, Draft> {
  try {
    if (!fs.existsSync(DRAFTS_PATH)) return {};
    const raw = fs.readFileSync(DRAFTS_PATH, "utf8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, Draft>;
    }
    return {};
  } catch {
    return {};
  }
}

function writeDraftsFile(map: Record<string, Draft>): void {
  fs.mkdirSync(path.dirname(DRAFTS_PATH), { recursive: true });
  const tmp = `${DRAFTS_PATH}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
  fs.renameSync(tmp, DRAFTS_PATH);
}

/** Public so other routes (pool/clips-summary) can fold drafts into responses. */
export function loadAllDrafts(): Record<string, Draft> {
  return readDraftsFile();
}

const router = Router();

router.get("/drafts", (_req, res) => {
  res.json(readDraftsFile());
});

router.get("/drafts/:sourceId", (req, res) => {
  const all = readDraftsFile();
  const d = all[req.params.sourceId];
  if (!d) {
    res.status(404).json({ error: "no draft for this source" });
    return;
  }
  res.json(d);
});

router.put("/drafts/:sourceId", (req, res) => {
  const parsed = DraftBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const all = readDraftsFile();
  const draft: Draft = { ...parsed.data, updatedAt: Date.now() };
  all[req.params.sourceId] = draft;
  try {
    writeDraftsFile(all);
  } catch (err) {
    res.status(500).json({ error: String(err) });
    return;
  }
  res.json(draft);
});

router.delete("/drafts/:sourceId", (req, res) => {
  const all = readDraftsFile();
  if (!(req.params.sourceId in all)) {
    res.status(204).end();
    return;
  }
  delete all[req.params.sourceId];
  try {
    writeDraftsFile(all);
  } catch (err) {
    res.status(500).json({ error: String(err) });
    return;
  }
  res.status(204).end();
});

export default router;
