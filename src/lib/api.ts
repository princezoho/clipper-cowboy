export interface PoolItem {
  id: string;
  filename: string;
  path: string;
  size: number;
  mtime: number;
  duration: number;
  thumbUrl: string;
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

export interface ClipCaption {
  name: string;
  description: string;
  tags: string[];
}

export interface LibraryItem {
  id: string;
  name: string;
  description: string;
  tags: string[];
  filename: string;
  path: string;
  source?: string;
  sourcePath?: string;
  sourceId?: string;
  in?: number;
  out?: number;
  duration?: number;
  mode?: string;
  details?: string;
  created: number;
  thumbUrl: string;
  videoUrl: string;
}

export interface HealthResponse {
  ok: boolean;
  poolDir: string;
  libraryDir: string;
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
  patch: Partial<Pick<LibraryItem, "name" | "description" | "tags">>
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
