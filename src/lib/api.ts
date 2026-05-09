export type AutoCutStatus =
  | "idle"
  | "detecting"
  | "captioning"
  | "complete"
  | "error";

export interface PoolItem {
  id: string;
  filename: string;
  path: string;
  size: number;
  mtime: number;
  duration: number;
  thumbUrl: string;
  clipCount: number;
  autoCutStatus: AutoCutStatus;
  autoCutDone: number;
  autoCutTotal: number;
}

export interface SceneSegment {
  start: number;
  end: number;
}

export interface ScenesResponse {
  duration: number;
  segments: SceneSegment[];
  threshold: number;
  cachedAt: number;
}

export interface MatchedCharacter {
  id: string;
  name: string;
}

export interface UnknownPerson {
  description: string;
  frameIndex: number;
}

export interface SampleFrame {
  url: string;
  index: number;
  t: number;
}

export interface ClipCaption {
  name: string;
  description: string;
  tags: string[];
  characters: MatchedCharacter[];
  unknownPeople: UnknownPerson[];
  sampleFrames: SampleFrame[];
  cacheKey: string;
}

export interface CharacterRef {
  name: string;
  url: string;
}

export interface Character {
  id: string;
  name: string;
  aliases: string[];
  description: string;
  refCount: number;
  folder: string;
  created: number;
  updated: number;
  refs: CharacterRef[];
  thumbUrl?: string;
}

export type ExportMode = "clip" | "source" | "bundle";

export interface LibraryItem {
  id: string;
  name: string;
  description: string;
  tags: string[];
  characters?: MatchedCharacter[];
  filename: string;
  path: string;
  source?: string;
  sourcePath?: string;
  sourceId?: string;
  sourceCopyPath?: string;
  in?: number;
  out?: number;
  duration?: number;
  mode?: string;
  exportMode?: ExportMode;
  details?: string;
  created: number;
  thumbUrl: string;
  videoUrl: string;
  sourceVideoUrl?: string;
  sourceAvailable?: boolean;
}

export interface HealthResponse {
  ok: boolean;
  projectDir: string;
  clipsDir: string;
  charactersDir: string;
  shotlistMd: string;
  shotlistCsv: string;
  hasOpenAIKey: boolean;
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) {
        msg = typeof body.error === "string" ? body.error : JSON.stringify(body.error);
      }
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export async function fetchHealth(): Promise<HealthResponse> {
  return jsonOrThrow(await fetch("/api/health"));
}

export async function fetchPool(): Promise<{ items: PoolItem[]; poolDir: string }> {
  return jsonOrThrow(await fetch("/api/pool"));
}

export async function fetchLibrary(): Promise<{
  items: LibraryItem[];
  libraryDir: string;
}> {
  return jsonOrThrow(await fetch("/api/library"));
}

export async function patchLibraryItem(
  id: string,
  patch: Partial<
    Pick<LibraryItem, "name" | "description" | "tags" | "characters">
  >
): Promise<LibraryItem> {
  return jsonOrThrow(
    await fetch(`/api/library/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })
  );
}

export async function deleteLibraryItem(id: string): Promise<void> {
  await jsonOrThrow(
    await fetch(`/api/library/${id}`, { method: "DELETE" })
  );
}

export async function fetchScenes(id: string): Promise<ScenesResponse | null> {
  const res = await fetch(`/api/scenes/${id}`);
  if (res.status === 404) return null;
  return jsonOrThrow(res);
}

export async function detectScenes(
  id: string,
  threshold = 0.4
): Promise<ScenesResponse> {
  return jsonOrThrow(
    await fetch(`/api/scenes/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threshold }),
    })
  );
}

export async function captionClip(
  sourceId: string,
  inT: number,
  outT: number
): Promise<ClipCaption> {
  return jsonOrThrow(
    await fetch("/api/caption", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId, in: inT, out: outT }),
    })
  );
}

export interface ExportPayload {
  sourceId: string;
  in: number;
  out: number;
  name: string;
  description: string;
  tags: string[];
  characters: MatchedCharacter[];
  mode: ExportMode;
}

export async function exportClip(payload: ExportPayload): Promise<LibraryItem> {
  return jsonOrThrow(
    await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  );
}

export interface AutoCutCandidate {
  id: string;
  in: number;
  out: number;
  duration: number;
  caption?: ClipCaption;
  cacheKey?: string;
  error?: string;
}

export interface AutoCutState {
  sourceId: string;
  status: AutoCutStatus;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  total: number;
  done: number;
  candidates: AutoCutCandidate[];
  skipped: string[];
}

export async function fetchAutoCut(sourceId: string): Promise<AutoCutState> {
  return jsonOrThrow(await fetch(`/api/auto-cut/${sourceId}`));
}

export async function startAutoCut(sourceId: string): Promise<AutoCutState> {
  return jsonOrThrow(
    await fetch(`/api/auto-cut/${sourceId}`, { method: "POST" })
  );
}

export async function clearAutoCut(sourceId: string): Promise<void> {
  await jsonOrThrow(
    await fetch(`/api/auto-cut/${sourceId}`, { method: "DELETE" })
  );
}

export async function setAutoCutSkipped(
  sourceId: string,
  candidateId: string,
  skipped = true
): Promise<AutoCutState> {
  return jsonOrThrow(
    await fetch(`/api/auto-cut/${sourceId}/skip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateId, skipped }),
    })
  );
}

export async function fetchCharacters(): Promise<{ items: Character[] }> {
  return jsonOrThrow(await fetch("/api/characters"));
}

export async function createCharacter(input: {
  name: string;
  description?: string;
  aliases?: string[];
}): Promise<Character> {
  return jsonOrThrow(
    await fetch("/api/characters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
  );
}

export async function patchCharacter(
  id: string,
  patch: Partial<Pick<Character, "name" | "description" | "aliases">>
): Promise<Character> {
  return jsonOrThrow(
    await fetch(`/api/characters/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })
  );
}

export async function deleteCharacter(id: string): Promise<void> {
  await jsonOrThrow(
    await fetch(`/api/characters/${id}`, { method: "DELETE" })
  );
}

export async function deleteCharacterRef(
  id: string,
  refName: string
): Promise<void> {
  await jsonOrThrow(
    await fetch(
      `/api/characters/${id}/refs/${encodeURIComponent(refName)}`,
      { method: "DELETE" }
    )
  );
}

export type AddCharacterRefInput =
  | { sourceId: string; t: number }
  | { cacheKey: string; frameIndex: number };

export async function addCharacterRef(
  id: string,
  input: AddCharacterRefInput
): Promise<Character & { addedRef: CharacterRef }> {
  return jsonOrThrow(
    await fetch(`/api/characters/${id}/refs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
  );
}

export function formatTime(t: number): string {
  if (!Number.isFinite(t) || t < 0) return "0:00.000";
  const mm = Math.floor(t / 60);
  const ss = Math.floor(t % 60);
  const ms = Math.floor((t - Math.floor(t)) * 1000);
  return `${mm}:${String(ss).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

export function formatDuration(t: number): string {
  if (!Number.isFinite(t) || t < 0) return "0:00";
  const mm = Math.floor(t / 60);
  const ss = Math.floor(t % 60);
  return `${mm}:${String(ss).padStart(2, "0")}`;
}
