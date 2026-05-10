import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { detectScenes, extractFrameJpeg, getDuration } from "../ffmpeg.js";
import {
  CharacterContext,
  ClipCaption,
  captionFromFrames,
} from "../openai.js";
import { listCharacters, listRefs } from "./characters.js";

const AUTOCUT_DIR = path.join(config.internalDir, "auto-cuts");
fs.mkdirSync(AUTOCUT_DIR, { recursive: true });

const PARALLEL_CAPTIONS = 4;
const MIN_SCENE_LEN = 0.6;
const FRAMES_PER_CAPTION = 3;

// Single-take sources (no hard scene cuts) would otherwise produce just one
// long candidate. Anything longer than MAX_SEGMENT_LEN gets split into chunks
// of ~TARGET_SUBDIVISION_LEN so the queue still has multiple useful clips.
const MAX_SEGMENT_LEN = 8.0;
const TARGET_SUBDIVISION_LEN = 5.0;

export interface Candidate {
  id: string;
  in: number;
  out: number;
  duration: number;
  caption?: ClipCaption;
  cacheKey?: string;
  error?: string;
}

export type AutoCutStatus =
  | "idle"
  | "detecting"
  | "captioning"
  | "complete"
  | "error";

export interface AutoCutState {
  sourceId: string;
  status: AutoCutStatus;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  total: number;
  done: number;
  candidates: Candidate[];
  skipped: string[];
}

function statePath(sourceId: string): string {
  return path.join(AUTOCUT_DIR, `${sourceId}.json`);
}

function emptyState(sourceId: string): AutoCutState {
  return {
    sourceId,
    status: "idle",
    total: 0,
    done: 0,
    candidates: [],
    skipped: [],
  };
}

export function loadState(sourceId: string): AutoCutState {
  const p = statePath(sourceId);
  if (!fs.existsSync(p)) return emptyState(sourceId);
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8")) as AutoCutState;
    return { ...emptyState(sourceId), ...data };
  } catch {
    return emptyState(sourceId);
  }
}

function saveState(state: AutoCutState) {
  fs.writeFileSync(statePath(state.sourceId), JSON.stringify(state, null, 2));
}

const inflight = new Map<string, Promise<void>>();

export function clearState(sourceId: string) {
  try {
    fs.unlinkSync(statePath(sourceId));
  } catch {
    // ignore
  }
  inflight.delete(sourceId);
}

export function setSkipped(
  sourceId: string,
  candidateId: string,
  skipped: boolean
): AutoCutState {
  const state = loadState(sourceId);
  const has = state.skipped.includes(candidateId);
  if (skipped && !has) state.skipped.push(candidateId);
  else if (!skipped && has)
    state.skipped = state.skipped.filter((id) => id !== candidateId);
  saveState(state);
  return state;
}

function loadCharacterContext(): CharacterContext[] {
  const out: CharacterContext[] = [];
  for (const c of listCharacters()) {
    const refs = listRefs(c.id);
    if (refs.length === 0) continue;
    out.push({
      id: c.id,
      name: c.name,
      refPaths: refs.map((r) => r.path),
    });
  }
  return out;
}

function makeCandidateId(inT: number, outT: number): string {
  return `${Math.round(inT * 1000)}-${Math.round(outT * 1000)}`;
}

function subdivideLong(
  segs: { in: number; out: number }[]
): { in: number; out: number }[] {
  const out: { in: number; out: number }[] = [];
  for (const s of segs) {
    const len = s.out - s.in;
    if (len <= MAX_SEGMENT_LEN) {
      out.push(s);
      continue;
    }
    const n = Math.max(2, Math.round(len / TARGET_SUBDIVISION_LEN));
    const chunkLen = len / n;
    for (let i = 0; i < n; i += 1) {
      out.push({
        in: s.in + i * chunkLen,
        out: s.in + (i + 1) * chunkLen,
      });
    }
  }
  return out;
}

async function detectSegments(
  file: string
): Promise<{ in: number; out: number }[]> {
  const cuts = await detectScenes(file, 0.4);
  const duration = await getDuration(file);
  const boundaries = [0, ...cuts.map((c) => c.time), duration]
    .filter((t, i, a) => i === 0 || t > a[i - 1] + 0.05)
    .sort((a, b) => a - b);

  const raw: { in: number; out: number }[] = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const inT = boundaries[i];
    const outT = boundaries[i + 1];
    if (outT - inT >= MIN_SCENE_LEN) raw.push({ in: inT, out: outT });
  }
  if (raw.length === 0 && duration > 0) {
    raw.push({ in: 0, out: duration });
  }
  return subdivideLong(raw);
}

async function captionSegment(
  sourceFile: string,
  sourceId: string,
  seg: { in: number; out: number },
  characters: CharacterContext[]
): Promise<{ caption: ClipCaption; cacheKey: string }> {
  const span = seg.out - seg.in;
  const sampleTimes = [
    seg.in + span * 0.1,
    seg.in + span * 0.5,
    seg.in + span * 0.9,
  ].slice(0, FRAMES_PER_CAPTION);

  const cacheKey = `frames-${sourceId}-${Math.round(seg.in * 1000)}-${Math.round(
    seg.out * 1000
  )}`;
  const dir = path.join(config.captionTmpDir, cacheKey);
  fs.mkdirSync(dir, { recursive: true });

  const framePaths: string[] = [];
  for (let i = 0; i < sampleTimes.length; i += 1) {
    const out = path.join(dir, `f${i}.jpg`);
    await extractFrameJpeg(sourceFile, sampleTimes[i], out, 512);
    framePaths.push(out);
  }

  const caption = await captionFromFrames(framePaths, characters);
  return { caption, cacheKey };
}

async function pLimitAll<T>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<void>
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        await fn(items[i], i);
      }
    }
  );
  await Promise.all(workers);
}

export function startAnalysis(
  sourceId: string,
  sourceFile: string
): AutoCutState {
  const existing = loadState(sourceId);

  if (existing.status === "complete" && existing.candidates.length > 0) {
    return existing;
  }
  if (inflight.has(sourceId)) {
    return existing;
  }

  const initial: AutoCutState = {
    sourceId,
    status: "detecting",
    startedAt: Date.now(),
    total: 0,
    done: 0,
    candidates: [],
    skipped: existing.skipped,
  };
  saveState(initial);

  const job = (async () => {
    try {
      const segs = await detectSegments(sourceFile);
      const characters = loadCharacterContext();

      const candidates: Candidate[] = segs.map((s) => ({
        id: makeCandidateId(s.in, s.out),
        in: s.in,
        out: s.out,
        duration: s.out - s.in,
      }));
      const state: AutoCutState = {
        ...initial,
        status: "captioning",
        total: candidates.length,
        done: 0,
        candidates,
      };
      saveState(state);

      await pLimitAll(candidates, PARALLEL_CAPTIONS, async (c, idx) => {
        try {
          const r = await captionSegment(sourceFile, sourceId, c, characters);
          c.caption = r.caption;
          c.cacheKey = r.cacheKey;
        } catch (err) {
          c.error = String(err);
        }
        const cur = loadState(sourceId);
        cur.candidates[idx] = c;
        cur.done = cur.candidates.filter((x) => x.caption || x.error).length;
        cur.status = "captioning";
        saveState(cur);
      });

      const final = loadState(sourceId);
      final.status = "complete";
      final.completedAt = Date.now();
      saveState(final);
    } catch (err) {
      const e = loadState(sourceId);
      e.status = "error";
      e.error = String(err);
      saveState(e);
    } finally {
      inflight.delete(sourceId);
    }
  })();

  inflight.set(sourceId, job);
  return loadState(sourceId);
}
