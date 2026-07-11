import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

/*
 * Per-source AI metadata sidecar. One JSON file per pool source, named by the
 * source's pool id (sha1 of abs path). Pool sources never get rewritten by
 * Clipper Cowboy, so AI tagging info lives alongside the source rather than
 * embedded in the file. Same shape as a `Partial<SourceMeta>` PATCH.
 *
 * Distinct from `clip-meta/` (per-export sidecars) and the entity catalogs
 * (`scenes.json`, `objects.json`, `characters/`).
 */

export interface NamedRef {
  id: string;
  name: string;
}

export interface ProposedNewEntities {
  characters: string[];
  scenes: string[];
  objects: string[];
}

export interface SourceMeta {
  id: string;
  characters: NamedRef[];
  scenes: NamedRef[];
  objects: NamedRef[];
  tags: string[];
  mood: string;
  notes: string;
  analyzedAt: number;
  sourceMtimeMs: number;
  framesUsed: number;
  model: string;
  /**
   * GPT-4o-proposed entity names that didn't match the user's catalog. Lives
   * here so the AI organize panel can surface "Create entity?" prompts across
   * all sources. Cleared per-name on Create or Dismiss.
   */
  proposedNew: ProposedNewEntities;
}

export function defaultSourceMeta(id: string): SourceMeta {
  return {
    id,
    characters: [],
    scenes: [],
    objects: [],
    tags: [],
    mood: "",
    notes: "",
    analyzedAt: 0,
    sourceMtimeMs: 0,
    framesUsed: 0,
    model: "",
    proposedNew: { characters: [], scenes: [], objects: [] },
  };
}

function filePath(id: string): string {
  // Validate id shape (pool ids are 16 hex chars). Refuse anything that could
  // escape the source-meta dir.
  if (!/^[a-f0-9]+$/i.test(id)) {
    throw new Error("invalid source id");
  }
  return path.join(config.sourceMetaDir, `${id}.json`);
}

export function readSourceMeta(id: string): SourceMeta {
  const p = filePath(id);
  if (!fs.existsSync(p)) return defaultSourceMeta(id);
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<SourceMeta>;
    const base = defaultSourceMeta(id);
    // Spread carefully so proposedNew always has all three keys even when
    // an old sidecar predates the field (or only persisted a subset).
    const merged: SourceMeta = { ...base, ...raw, id };
    merged.proposedNew = {
      ...base.proposedNew,
      ...(raw.proposedNew ?? {}),
    };
    return merged;
  } catch {
    return defaultSourceMeta(id);
  }
}

export type SourceMetaPatch = Partial<Omit<SourceMeta, "proposedNew">> & {
  proposedNew?: Partial<ProposedNewEntities>;
};

export function writeSourceMeta(
  id: string,
  patch: SourceMetaPatch
): SourceMeta {
  fs.mkdirSync(config.sourceMetaDir, { recursive: true });
  const cur = readSourceMeta(id);
  const next: SourceMeta = {
    ...cur,
    ...patch,
    // id is identity-only — never let a patch overwrite it.
    id,
    // proposedNew is nested; merge per-kind so a patch can update one bucket
    // (e.g. just the dismissed characters list) without wiping the others.
    proposedNew: {
      ...cur.proposedNew,
      ...(patch.proposedNew ?? {}),
    },
  };
  fs.writeFileSync(filePath(id), JSON.stringify(next, null, 2));
  return next;
}

export function existsSourceMeta(id: string): boolean {
  try {
    return fs.existsSync(filePath(id));
  } catch {
    return false;
  }
}

/** List ids of every source-meta sidecar currently on disk. */
export function listAnalyzedIds(): string[] {
  if (!fs.existsSync(config.sourceMetaDir)) return [];
  return fs
    .readdirSync(config.sourceMetaDir)
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.slice(0, -".json".length));
}
