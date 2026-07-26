export interface PoolItem {
  id: string;
  filename: string;
  path: string;
  /** POSIX-separated relative folder under PROJECT_DIR; "" for root. */
  folder: string;
  size: number;
  mtime: number;
  duration: number;
  thumbUrl: string;
  clipCount: number;
}

export interface SceneSegment {
  start: number;
  end: number;
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

export type StemQuality = "fast" | "high";

export interface AudioEngineStatus {
  ready: boolean;
  installing: boolean;
  pythonAvailable: boolean;
  recommendedQuality?: StemQuality;
  installedQualities: StemQuality[];
  message: string;
}

export interface StemJobSummary {
  id: string;
  clipId: string;
  clipName: string;
  quality: StemQuality;
  status:
    | "queued"
    | "running"
    | "done"
    | "error"
    | "cancelled"
    | "interrupted";
  stage?: string;
  percent: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface NamedRef {
  id: string;
  name: string;
}

/** Lightweight catalog entry for Scenes / Objects. */
export interface Entity {
  id: string;
  name: string;
  description: string;
  created: number;
  updated: number;
}

export type EntityKind = "scenes" | "objects";

export interface LibraryItem {
  id: string;
  name: string;
  description: string;
  tags: string[];
  characters?: MatchedCharacter[];
  scenes?: NamedRef[];
  objects?: NamedRef[];
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
  missing?: boolean;
}

export interface OrphanFile {
  filename: string;
  size: number;
  mtime: number;
  path: string;
}

export interface HealthResponse {
  ok: boolean;
  service?: "clipper-cowboy";
  apiVersion?: number;
  projectDir: string;
  clipsDir: string;
  charactersDir: string;
  imagesDir?: string;
  derivedDir?: string;
  stemsDir?: string;
  shotlistMd: string;
  shotlistCsv: string;
  hasOpenAIKey: boolean;
  /** False on first run — UI renders the onboarding wizard when false. */
  projectDirConfigured: boolean;
}

export interface ApiErrorShape {
  code?: string;
  message?: string;
  billingUrl?: string;
}

export class ApiError extends Error {
  readonly code?: string;
  readonly billingUrl?: string;

  constructor(message: string, shape?: ApiErrorShape) {
    super(message);
    this.name = "ApiError";
    this.code = shape?.code;
    this.billingUrl = shape?.billingUrl;
  }
}

export const OPENAI_BILLING_URL =
  "https://platform.openai.com/settings/organization/billing/overview";

export function isOpenAIQuotaError(err: unknown): err is ApiError {
  return err instanceof ApiError && err.code === "openai_quota";
}

export interface FsCheckResponse {
  expanded: string;
  exists: boolean;
  isDir: boolean;
  canCreate: boolean;
}

export async function checkFsPath(p: string): Promise<FsCheckResponse> {
  return jsonOrThrow(
    await fetch(`/api/fs/check?path=${encodeURIComponent(p)}`)
  );
}

export async function saveSettings(input: {
  projectDir?: string;
  openaiApiKey?: string;
}): Promise<{ ok: boolean; note?: string }> {
  return jsonOrThrow(
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
  );
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    let apiError: ApiErrorShape | undefined;
    try {
      const body = await res.json();
      if (body?.error) {
        if (typeof body.error === "string") {
          msg = body.error;
        } else if (typeof body.error === "object") {
          apiError = body.error as ApiErrorShape;
          msg =
            typeof apiError.message === "string"
              ? apiError.message
              : JSON.stringify(body.error);
        }
      }
    } catch {
      // ignore
    }
    throw new ApiError(msg, apiError);
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
  missingCount: number;
  orphans: OrphanFile[];
}> {
  return jsonOrThrow(await fetch("/api/library"));
}

export interface RepairMissingResult {
  repaired: number;
  errors: { id: string; error: string }[];
}

export async function repairMissingLibrary(): Promise<RepairMissingResult> {
  return jsonOrThrow(
    await fetch("/api/library/repair-missing", { method: "POST" })
  );
}

export async function adoptOrphans(
  paths: string[]
): Promise<{ adopted: number; ids: string[] }> {
  return jsonOrThrow(
    await fetch("/api/library/orphans/adopt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths }),
    })
  );
}

export async function trashOrphans(
  paths: string[]
): Promise<{ trashed: number }> {
  return jsonOrThrow(
    await fetch("/api/library/orphans/trash", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths }),
    })
  );
}

export async function patchLibraryItem(
  id: string,
  patch: Partial<
    Pick<
      LibraryItem,
      "name" | "description" | "tags" | "characters" | "scenes" | "objects"
    >
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

export interface ClipboardCopyResult {
  ok: true;
  count: number;
  paths: string[];
  missing?: string[];
}

export async function copyLibraryToClipboard(
  ids: string[]
): Promise<ClipboardCopyResult> {
  return jsonOrThrow(
    await fetch("/api/library/clipboard-copy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    })
  );
}

export async function revealLibrarySelectionInFinder(
  ids: string[]
): Promise<{ ok: true; count: number; missing?: string[] }> {
  return jsonOrThrow(
    await fetch("/api/library/reveal-many", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    })
  );
}

export async function renameLibraryItem(
  id: string,
  name: string
): Promise<{ ok: true; item: LibraryItem }> {
  return jsonOrThrow(
    await fetch(`/api/library/${id}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    })
  );
}

export async function sendLibraryToPremiere(
  ids: string[]
): Promise<{ ok: true; count: number; paths: string[]; missing?: string[] }> {
  return jsonOrThrow(
    await fetch("/api/library/send-to-premiere", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    })
  );
}

export type UniversalStemRole = "DIALOGUE" | "MUSIC" | "SFX" | "MARRIED";

export interface UniversalPlannedStem {
  groupId: string;
  sourceId: string;
  clipId: string | null;
  stemRole: UniversalStemRole;
  inSeconds: number;
  outSeconds: number | null;
  filename: string;
  status: "existing-if-validated" | "planned-handoff";
}

export interface UniversalPlan {
  schema: string;
  packageName: string;
  destinationRoot: string;
  selectedClipCount: number;
  sourceCount: number;
  mediaDirectory: "media";
  expectedAssetCount: number;
  sources: {
    sourceId: string;
    sourceFilename: string;
    fullSourceFilename: string;
    groupId: string;
    stems: UniversalPlannedStem[];
    clips: {
      clipId: string;
      name: string;
      inSeconds: number;
      outSeconds: number;
      durationSeconds: number;
      outputFilename: string;
      groupId: string;
      stems: UniversalPlannedStem[];
      qualityMethod: "adaptive-smart-cut";
      qualityNote: string;
    }[];
  }[];
  stemExecution: {
    roles: UniversalStemRole[];
    behavior: string;
    confirmationRequired: true;
  };
}

export interface UniversalPackageJob {
  id: string;
  status: "queued" | "running" | "done" | "cancelled" | "error";
  stage: string;
  percent: number;
  completed: number;
  total: number;
  plan: UniversalPlan;
  folder?: string;
  manifestPath?: string;
  packageId?: string;
  error?: string;
}

export type UniversalStemQuality = "high" | "max";
export type UniversalStemExecutionStatus =
  | "not_requested"
  | "queued"
  | "checking_setup"
  | "running"
  | "validating"
  | "ready"
  | "setup_required"
  | "cancelled"
  | "interrupted"
  | "error";

export interface UniversalStemJob {
  id: string;
  packageId: string;
  quality: UniversalStemQuality;
  status: Exclude<UniversalStemExecutionStatus, "not_requested">;
  stage: string;
  percent: number;
  message: string;
  externalJobId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface UniversalStemConnectorStatus {
  state:
    | "not_configured"
    | "unavailable"
    | "setup_required"
    | "ready"
    | "live_fixture_verified";
  configured: boolean;
  connected: boolean;
  ready: boolean;
  setupRequired: boolean;
  liveFixtureVerified: boolean;
  message: string;
  entry: string | null;
  version: string | null;
  configuredBy: "settings" | "environment" | null;
  qualities: UniversalStemQuality[];
  setupAutomatic: false;
}

export interface UniversalPackageSummary {
  packageId: string;
  packageName: string;
  createdAt: string;
  packageStatus:
    | "preparing"
    | "stems_pending"
    | "setup_required"
    | "stem_error"
    | "ready";
  premiereReady: boolean;
  stemExecution: {
    status: UniversalStemExecutionStatus;
    quality: UniversalStemQuality | null;
    jobId: string | null;
    stage: string;
    percent: number;
    message: string;
    updatedAt: string;
  };
  counts: {
    groups: number;
    assets: number;
    ready: number;
    pending: number;
    invalid: number;
  };
}

export async function previewUniversalPackage(
  ids: string[],
  name: string
): Promise<UniversalPlan> {
  return jsonOrThrow(
    await fetch("/api/universal-clipper/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, name }),
    })
  );
}

export async function prepareUniversalPackage(
  ids: string[],
  name: string
): Promise<UniversalPackageJob> {
  return jsonOrThrow(
    await fetch("/api/universal-clipper/packages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, name }),
    })
  );
}

export async function fetchUniversalPackageJob(
  id: string
): Promise<UniversalPackageJob> {
  return jsonOrThrow(
    await fetch(`/api/universal-clipper/jobs/${encodeURIComponent(id)}`)
  );
}

export async function cancelUniversalPackageJob(
  id: string
): Promise<UniversalPackageJob> {
  return jsonOrThrow(
    await fetch(`/api/universal-clipper/jobs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    })
  );
}

export async function revealUniversalPackage(
  id: string
): Promise<{ ok: true; folder: string }> {
  return jsonOrThrow(
    await fetch(`/api/universal-clipper/jobs/${encodeURIComponent(id)}/reveal`, {
      method: "POST",
    })
  );
}

export async function fetchUniversalStemConnectorStatus(): Promise<UniversalStemConnectorStatus> {
  return jsonOrThrow(
    await fetch("/api/universal-clipper/stem-connector/status")
  );
}

export async function configureUniversalStemConnector(
  entry: string
): Promise<UniversalStemConnectorStatus> {
  return jsonOrThrow(
    await fetch("/api/universal-clipper/stem-connector/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entry }),
    })
  );
}

export async function clearUniversalStemConnector(): Promise<UniversalStemConnectorStatus> {
  return jsonOrThrow(
    await fetch("/api/universal-clipper/stem-connector/config", {
      method: "DELETE",
    })
  );
}

export async function separateUniversalPackageStems(
  packageId: string,
  quality: UniversalStemQuality,
  confirmedMaxLicense = false
): Promise<UniversalStemJob> {
  return jsonOrThrow(
    await fetch(
      `/api/universal-clipper/packages/${encodeURIComponent(packageId)}/stems`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quality,
          confirmedModelExecution: true,
          ...(quality === "max" && confirmedMaxLicense
            ? { confirmedMaxLicense: true }
            : {}),
        }),
      }
    )
  );
}

export async function fetchUniversalStemJob(
  id: string
): Promise<UniversalStemJob> {
  return jsonOrThrow(
    await fetch(
      `/api/universal-clipper/stem-jobs/${encodeURIComponent(id)}`
    )
  );
}

export async function cancelUniversalStemJob(
  id: string
): Promise<UniversalStemJob> {
  return jsonOrThrow(
    await fetch(
      `/api/universal-clipper/stem-jobs/${encodeURIComponent(id)}/cancel`,
      { method: "POST" }
    )
  );
}

export async function listUniversalPackages(): Promise<{
  items: UniversalPackageSummary[];
}> {
  return jsonOrThrow(await fetch("/api/universal-clipper/packages"));
}

// ---- Images library -------------------------------------------------------

export type ImageCategory =
  | ""
  | "storyboard"
  | "shot"
  | "character-ref"
  | "object-ref"
  | "background";

export type NonEmptyImageCategory = Exclude<ImageCategory, "">;

export const IMAGE_CATEGORIES: NonEmptyImageCategory[] = [
  "storyboard",
  "shot",
  "character-ref",
  "object-ref",
  "background",
];

export interface ImageItem {
  id: string;
  name: string;
  description: string;
  prompt: string;
  category: ImageCategory;
  tags: string[];
  characters: NamedRef[];
  scenes: NamedRef[];
  objects: NamedRef[];
  filename: string;
  /** POSIX-separated relative folder under IMAGES_DIR, "" for root. */
  folder: string;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
  width?: number;
  height?: number;
  created: number;
  updated: number;
  thumbUrl: string;
  fullUrl: string;
}

export async function fetchImages(): Promise<{
  items: ImageItem[];
  imagesDir: string;
}> {
  return jsonOrThrow(await fetch("/api/images"));
}

export type ImagePatch = Partial<
  Pick<
    ImageItem,
    | "name"
    | "description"
    | "prompt"
    | "category"
    | "tags"
    | "characters"
    | "scenes"
    | "objects"
  >
>;

export async function patchImage(
  id: string,
  patch: ImagePatch
): Promise<ImageItem> {
  return jsonOrThrow(
    await fetch(`/api/images/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })
  );
}

export async function fetchImageFolders(): Promise<{ folders: string[] }> {
  return jsonOrThrow(await fetch("/api/images/folders"));
}

export async function createImageFolder(
  folderPath: string
): Promise<{ ok: boolean; folder: string }> {
  return jsonOrThrow(
    await fetch("/api/images/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: folderPath }),
    })
  );
}

export async function deleteImageFolder(
  folderPath: string
): Promise<{ ok: boolean }> {
  return jsonOrThrow(
    await fetch("/api/images/folders", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: folderPath }),
    })
  );
}

export interface ImageUploadResult {
  items: ImageItem[];
  rejected?: { name: string; reason: string }[];
}

export async function uploadImages(
  folderPath: string,
  files: File[],
  onProgress?: (percent: number) => void
): Promise<ImageUploadResult> {
  const fd = new FormData();
  fd.append("folder", folderPath);
  for (const f of files) fd.append("files", f, f.name);
  return new Promise<ImageUploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/images/upload");
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
    }
    xhr.onerror = () => reject(new Error("network error"));
    xhr.onload = () => {
      const txt = xhr.responseText || "{}";
      let body: unknown = null;
      try {
        body = JSON.parse(txt);
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as ImageUploadResult);
      } else {
        const errMsg =
          (body && typeof body === "object" && "error" in body
            ? String((body as { error: unknown }).error)
            : "") || `${xhr.status} ${xhr.statusText}`;
        reject(new Error(errMsg));
      }
    };
    xhr.send(fd);
  });
}

export async function moveImage(
  id: string,
  folderPath: string
): Promise<ImageItem> {
  return jsonOrThrow(
    await fetch(`/api/images/${id}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder: folderPath }),
    })
  );
}

export async function moveImages(
  ids: string[],
  folderPath: string
): Promise<{ items: ImageItem[]; errors: { id: string; error: string }[] }> {
  return jsonOrThrow(
    await fetch("/api/images/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, folder: folderPath }),
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
  scenes: NamedRef[];
  objects: NamedRef[];
  mode: ExportMode;
  stems?: { quality: StemQuality };
}

export interface ExportResult extends LibraryItem {
  stemJob?: StemJobSummary;
}

export async function exportClip(payload: ExportPayload): Promise<ExportResult> {
  return jsonOrThrow(
    await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  );
}

export async function fetchAudioEngineStatus(): Promise<AudioEngineStatus> {
  return jsonOrThrow(await fetch("/api/audio-engine/status"));
}

export interface StemSetupJob {
  status: "queued" | "running" | "complete" | "error";
  stage?: "dependencies" | "building" | "validating";
  message: string;
  technicalDetails?: string;
  updatedAt: number;
}

export async function installAudioEngine(): Promise<StemSetupJob> {
  return jsonOrThrow(await fetch("/api/audio-engine/install", { method: "POST" }));
}

export async function fetchAudioEngineInstall(): Promise<StemSetupJob> {
  return jsonOrThrow(await fetch("/api/audio-engine/install"));
}

export async function fetchStemJobs(): Promise<{ items: StemJobSummary[] }> {
  return jsonOrThrow(await fetch("/api/stem-jobs"));
}

export async function cancelStemJob(id: string): Promise<StemJobSummary> {
  return jsonOrThrow(
    await fetch(`/api/stem-jobs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    })
  );
}

export async function revealStemJob(id: string): Promise<{ ok: true }> {
  return jsonOrThrow(
    await fetch(`/api/stem-jobs/${encodeURIComponent(id)}/reveal`, {
      method: "POST",
    })
  );
}

export async function revealStemsRoot(): Promise<{ ok: true }> {
  return jsonOrThrow(await fetch("/api/stem-jobs/reveal-root", { method: "POST" }));
}

export interface ExistingPoolClip {
  id: string;
  name: string;
  in: number;
  out: number;
  duration: number;
}

export async function fetchPoolClips(
  sourceId: string
): Promise<{ items: ExistingPoolClip[] }> {
  return jsonOrThrow(await fetch(`/api/pool/${sourceId}/clips`));
}

export interface PoolClipsSummaryEntry {
  clips: { id: string; name: string; in: number; out: number }[];
  coveredSec: number;
  draft?: { in: number; out: number; updatedAt: number };
}

/** Batch index of every source's clip ranges + merged-coverage seconds. */
export async function fetchPoolClipsSummary(): Promise<
  Record<string, PoolClipsSummaryEntry>
> {
  return jsonOrThrow(await fetch("/api/pool/clips-summary"));
}

// ---- Pool folders + move + auto-organize ---------------------------------

export async function fetchPoolFolders(): Promise<{ folders: string[] }> {
  return jsonOrThrow(await fetch("/api/pool/folders"));
}

export async function createPoolFolder(
  folderPath: string
): Promise<{ ok: boolean; folder: string }> {
  return jsonOrThrow(
    await fetch("/api/pool/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: folderPath }),
    })
  );
}

export async function deletePoolFolder(
  folderPath: string
): Promise<{ ok: boolean }> {
  return jsonOrThrow(
    await fetch("/api/pool/folders", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: folderPath }),
    })
  );
}

export interface PoolMoveResult {
  oldId: string;
  newId: string;
  oldPath: string;
  newPath: string;
  folder: string;
  filename: string;
  sidecarsUpdated: number;
  draftsRekeyed: number;
}

export async function movePoolSource(
  id: string,
  folderPath: string
): Promise<PoolMoveResult> {
  return jsonOrThrow(
    await fetch(`/api/pool/${id}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder: folderPath }),
    })
  );
}

export async function movePoolSources(
  ids: string[],
  folderPath: string
): Promise<{
  items: PoolMoveResult[];
  errors: { id: string; error: string }[];
}> {
  return jsonOrThrow(
    await fetch("/api/pool/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, folder: folderPath }),
    })
  );
}

export async function revealPoolFolder(
  folderPath: string
): Promise<{ ok: boolean; path: string }> {
  return jsonOrThrow(
    await fetch("/api/pool/reveal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder: folderPath }),
    })
  );
}

export interface PoolFolderSuggestion {
  folder: string;
  setting: string;
  timeOfDay: string;
  characters: string[];
  confidence: "low" | "med" | "high";
}

export interface PoolAnalyzeRow {
  id: string;
  filename: string;
  currentFolder: string;
  duration: number;
  suggested: PoolFolderSuggestion | null;
  error?: string;
}

export async function analyzePoolContent(
  ids: string[]
): Promise<{ suggestions: PoolAnalyzeRow[] }> {
  return jsonOrThrow(
    await fetch("/api/pool/analyze-content", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    })
  );
}

export interface ReexportPayload {
  in: number;
  out: number;
  name: string;
  description: string;
  tags: string[];
  characters: MatchedCharacter[];
  scenes: NamedRef[];
  objects: NamedRef[];
  stems?: { quality: StemQuality };
}

export async function reexportLibraryItem(
  id: string,
  payload: ReexportPayload
): Promise<ExportResult> {
  return jsonOrThrow(
    await fetch(`/api/library/${id}/reexport`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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

// ---- Entity catalogs (Scenes, Objects) ------------------------------------

export async function fetchEntities(
  kind: EntityKind
): Promise<{ items: Entity[] }> {
  return jsonOrThrow(await fetch(`/api/${kind}`));
}

export async function createEntity(
  kind: EntityKind,
  input: { name: string; description?: string }
): Promise<Entity> {
  return jsonOrThrow(
    await fetch(`/api/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
  );
}

export async function patchEntity(
  kind: EntityKind,
  id: string,
  patch: Partial<Pick<Entity, "name" | "description">>
): Promise<Entity> {
  return jsonOrThrow(
    await fetch(`/api/${kind}/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })
  );
}

export async function deleteEntity(
  kind: EntityKind,
  id: string
): Promise<void> {
  await jsonOrThrow(await fetch(`/api/${kind}/${id}`, { method: "DELETE" }));
}

// ---- Collection export ----------------------------------------------------

export interface ExportCollectionFilter {
  q?: string;
  characterIds?: string[];
  sceneIds?: string[];
  objectIds?: string[];
  tagNames?: string[];
  /** Explicit clip ids (multi-select in Library). Bypasses other filters. */
  ids?: string[];
}

export interface ExportCollectionPayload {
  name: string;
  zip: boolean;
  reveal: boolean;
  filter: ExportCollectionFilter;
}

export interface ExportCollectionResult {
  folder: string;
  fileCount: number;
  bytes: number;
  links: number;
  copies: number;
  zipPath?: string;
}

export async function exportCollection(
  payload: ExportCollectionPayload
): Promise<ExportCollectionResult> {
  return jsonOrThrow(
    await fetch("/api/export-collection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  );
}

// ---- Drafts ---------------------------------------------------------------

export interface Draft {
  in: number;
  out: number;
  name: string;
  description: string;
  tags: string[];
  characters: NamedRef[];
  scenes: NamedRef[];
  objects: NamedRef[];
  updatedAt: number;
}

export type DraftInput = Omit<Draft, "updatedAt">;

export async function fetchDraft(sourceId: string): Promise<Draft | null> {
  const res = await fetch(`/api/drafts/${encodeURIComponent(sourceId)}`);
  if (res.status === 404) return null;
  return jsonOrThrow<Draft>(res);
}

export async function putDraft(
  sourceId: string,
  draft: DraftInput
): Promise<Draft> {
  return jsonOrThrow(
    await fetch(`/api/drafts/${encodeURIComponent(sourceId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    })
  );
}

export async function deleteDraft(sourceId: string): Promise<void> {
  const res = await fetch(`/api/drafts/${encodeURIComponent(sourceId)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
}

// ---- Activity log ---------------------------------------------------------

export type ActivityKind =
  | "clip_exported"
  | "clip_reexported"
  | "clip_deleted"
  | "clip_restored"
  | "scene_created"
  | "scene_deleted"
  | "character_created"
  | "character_deleted"
  | "object_created"
  | "object_deleted"
  | "collection_exported"
  | "missing_repaired"
  | "orphans_adopted"
  | "orphans_trashed"
  | "clips_copied"
  | "clip_renamed"
  | "clips_sent_to_premiere"
  | "source_analyzed"
  | "source_batch_started"
  | "pool_source_moved"
  | "pool_organize_analyzed"
  | "universal_package_created";

export interface ActivityEvent {
  ts: number;
  kind: ActivityKind;
  payload: Record<string, unknown>;
}

export async function fetchActivity(
  limit = 10
): Promise<{ events: ActivityEvent[] }> {
  return jsonOrThrow(await fetch(`/api/activity?limit=${limit}`));
}

// ---- Clipper Roundup (rename/move history) --------------------------------

export type RoundupEntityType = "pool" | "library" | "image" | "other";

export type RoundupKind =
  | "pool_move"
  | "library_rename"
  | "image_move"
  | "clip_restore"
  | "orphan_trash"
  | "manual"
  | "external_detected";

export interface RoundupFingerprint {
  size: number;
  mtimeMs: number;
  ino?: number;
  dev?: number;
}

export type RoundupEventClassification =
  | "renamed_and_moved"
  | "renamed"
  | "moved"
  | "derived_copy"
  | "unknown";

export interface RoundupEventPresentation {
  classification: RoundupEventClassification;
  oldName: string | null;
  newName: string | null;
  oldFolder: string | null;
  newFolder: string | null;
  nameChanged: boolean;
  folderChanged: boolean;
  extensionChanged: boolean;
}

export interface RoundupEvent {
  ts: number;
  kind: RoundupKind;
  entityType: RoundupEntityType;
  oldPath: string;
  newPath: string;
  oldName?: string;
  newName?: string;
  oldId?: string;
  newId?: string;
  tagId?: string;
  triggeredBy: string;
  fingerprint?: RoundupFingerprint;
  exists?: boolean;
  classification?: RoundupEventClassification;
  presentation?: RoundupEventPresentation;
}

export interface RoundupTag {
  id: string;
  trackable: boolean;
  currentPath: string;
  fingerprint?: RoundupFingerprint;
  createdAt: number;
  updatedAt: number;
  paths: string[];
}

export interface RoundupCandidate {
  event: RoundupEvent;
  match: "exact_path" | "path_prefix" | "basename" | "fingerprint" | "tag";
  currentPath: string;
  currentExists: boolean;
  score: number;
  history: RoundupEvent[];
  trail: string[];
  tag?: RoundupTag;
}

export type RoundupWatchRootId = string;

export type RoundupRootReason =
  | "project"
  | "seedance"
  | "gunslinger_dropbox"
  | "gunslinger_seedance"
  | "downloads"
  | "desktop"
  | "documents"
  | "pictures"
  | "movies"
  | "music"
  | "droplet";

export interface RoundupWatchRoot {
  id: RoundupWatchRootId;
  label: string;
  path: string;
  reason: RoundupRootReason;
  exists: boolean;
  enabled: boolean;
  allowed: boolean;
  inventoryEligible: boolean;
  watchNote?: "inventory_only" | "covered_by_parent";
}

export interface RoundupWatcherStatus {
  state: "off" | "starting" | "watched" | "degraded";
  running: boolean;
  enabled: boolean;
  roots: RoundupWatchRoot[];
  watching: string[];
  coveredRootIds: RoundupWatchRootId[];
  backend: "fsevents" | "fs.watch";
  cachedPaths: number;
  pendingUnlinks: number;
  eventsRecordedSession: number;
  lastError: string | null;
  lastEventAt: number | null;
}

export async function fetchRoundup(
  limit = 50
): Promise<{ events: RoundupEvent[] }> {
  return jsonOrThrow(await fetch(`/api/roundup?limit=${limit}`));
}

export async function lookupRoundup(input: {
  q?: string;
  path?: string;
  basename?: string;
  limit?: number;
}): Promise<{ candidates: RoundupCandidate[] }> {
  const params = new URLSearchParams();
  if (input.q) params.set("q", input.q);
  if (input.path) params.set("path", input.path);
  if (input.basename) params.set("basename", input.basename);
  if (input.limit) params.set("limit", String(input.limit));
  return jsonOrThrow(await fetch(`/api/roundup/lookup?${params}`));
}

export async function fetchRoundupWatcher(): Promise<RoundupWatcherStatus> {
  return jsonOrThrow(await fetch("/api/roundup/watcher"));
}

export async function updateRoundupWatcher(input: {
  enabled?: boolean;
  root?: { id: RoundupWatchRootId; enabled: boolean };
}): Promise<RoundupWatcherStatus> {
  return jsonOrThrow(
    await fetch("/api/roundup/watcher", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
  );
}

export async function approveRoundupRoot(input: {
  path: string;
  label: string;
  reason: "seedance" | "droplet" | "gunslinger_dropbox" | "gunslinger_seedance";
  approved: true;
}): Promise<RoundupWatcherStatus> {
  return jsonOrThrow(
    await fetch("/api/roundup/roots/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
  );
}

export interface RoundupManifestItem {
  source: string;
  identity: string;
  mediaKind: "video" | "image" | "audio";
  intendedExportDestination: string;
  collisionPolicy: "allocate-unique-never-overwrite";
  stemsEligible: boolean;
  sourceRootId: string;
  sourceRootReason: RoundupRootReason;
  size: number;
  mtimeMs: number;
}

export interface RoundupInventoryJob {
  id: string;
  status: "queued" | "running" | "paused" | "done" | "cancelled" | "error";
  scanned: number;
  mediaCandidates: number;
  discovered: number;
  tagged: number;
  alreadyTagged: number;
  totalBytes: number;
  skipped: number;
  placeholderSkips: number;
  errors: number;
  complete: boolean;
  capped: boolean;
  limit: number;
  rootIds: string[];
  items: RoundupManifestItem[];
  startedAt: number;
  updatedAt: number;
  checkpoint: {
    rootIndex: number;
    directories: { relativeDir: string; afterName: string | null }[];
  };
  error?: string;
}

export async function startRoundupInventory(input: {
  rootIds: string[];
  limit: number;
}): Promise<RoundupInventoryJob> {
  return jsonOrThrow(
    await fetch("/api/roundup/inventory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
  );
}

export async function fetchRoundupInventory(id: string): Promise<RoundupInventoryJob> {
  return jsonOrThrow(await fetch(`/api/roundup/inventory/${encodeURIComponent(id)}`));
}

export async function cancelRoundupInventory(id: string): Promise<RoundupInventoryJob> {
  return jsonOrThrow(
    await fetch(`/api/roundup/inventory/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    })
  );
}

export async function pauseRoundupInventory(id: string): Promise<RoundupInventoryJob> {
  return jsonOrThrow(
    await fetch(`/api/roundup/inventory/${encodeURIComponent(id)}/pause`, {
      method: "POST",
    })
  );
}

export async function resumeRoundupInventory(id: string): Promise<RoundupInventoryJob> {
  return jsonOrThrow(
    await fetch(`/api/roundup/inventory/${encodeURIComponent(id)}/resume`, {
      method: "POST",
    })
  );
}

export async function exportRoundupCopy(
  sourcePath: string
): Promise<{ manifest: RoundupManifestItem; outputPath: string }> {
  return jsonOrThrow(
    await fetch("/api/roundup/export-copy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: sourcePath }),
    })
  );
}

export async function prepareRoundupStemHandoff(
  sourcePath: string
): Promise<{ manifestPath: string }> {
  return jsonOrThrow(
    await fetch("/api/roundup/stems-handoff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: sourcePath,
        confirmedExternalProcessing: true,
      }),
    })
  );
}

export async function recordRoundupEvent(input: {
  oldPath: string;
  newPath: string;
  oldName?: string;
  newName?: string;
  kind?: RoundupKind;
  entityType?: RoundupEntityType;
}): Promise<{ ok: true }> {
  return jsonOrThrow(
    await fetch("/api/roundup/record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
  );
}

export async function revealPathInFinder(
  absPath: string
): Promise<{ ok: true }> {
  return jsonOrThrow(
    await fetch("/api/roundup/reveal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: absPath }),
    })
  );
}

export async function setRoundupTrackable(input: {
  trackable: boolean;
  id?: string;
  path?: string;
}): Promise<{ tag: RoundupTag }> {
  return jsonOrThrow(
    await fetch("/api/roundup/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
  );
}

export async function fetchRoundupTags(
  limit = 100
): Promise<{ tags: RoundupTag[] }> {
  return jsonOrThrow(await fetch(`/api/roundup/tags?limit=${limit}`));
}

export function formatBytes(b: number): string {
  if (!Number.isFinite(b) || b < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = b;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
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
