import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import {
  UNIVERSAL_CLIPPER_SCHEMA,
  type ClipSheet,
  type ClipSheetStem,
} from "./universalClipper.js";

const PACKAGE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PACKAGES = 250;

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

export interface UniversalStemExecution {
  status: UniversalStemExecutionStatus;
  quality: "high" | "max" | null;
  jobId: string | null;
  externalJobId?: string;
  stage: string;
  percent: number;
  message: string;
  updatedAt: string;
}

export interface StoredUniversalSheet extends ClipSheet {
  incomplete?: boolean;
}

export interface PremierePackageAsset {
  assetId: string;
  groupId: string;
  kind: "full-source" | "clip" | "stem";
  sourceId: string;
  clipId: string | null;
  stemRole: ClipSheetStem["stemRole"] | null;
  filename: string;
  mediaPath: string | null;
  airTagId: string | null;
  status: "ready" | "pending" | "invalid";
  relationship:
    | "source-video"
    | "source-stem"
    | "clip-video"
    | "clip-stem";
}

export interface PremierePackageGroup {
  groupId: string;
  sourceId: string;
  clipId: string | null;
  label: string;
  airTagId: string | null;
  sourceInSeconds: number | null;
  sourceOutSeconds: number | null;
  assets: PremierePackageAsset[];
}

export interface PremierePackageManifest {
  schema: "clipper-cowboy/premiere-package@1";
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
  minimumPremiereVersion: "25.6.0";
  metadataSupport: "clipper-local-mapping";
  metadataNote: string;
  timelineSupport: "explicit-uxp-action";
  stemExecution: UniversalStemExecution;
  groups: PremierePackageGroup[];
  counts: {
    groups: number;
    assets: number;
    ready: number;
    pending: number;
    invalid: number;
  };
}

export interface PackageLocation {
  folder: string;
  mediaDir: string;
  manifestPath: string;
  sheet: StoredUniversalSheet;
}

interface ImportAckEntry {
  assetId: string;
  projectItemId: string;
  status: "existing" | "imported";
  acknowledgedAt: string;
}

interface ImportAckStore {
  version: 1;
  packageId: string;
  projects: Record<
    string,
    {
      projectGuid: string;
      updatedAt: string;
      entries: ImportAckEntry[];
    }
  >;
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function packageRoot(): string {
  return path.join(config.derivedDir, "universal-clipper");
}

function canonicalRegularFile(root: string, candidate: string): string | null {
  try {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1) return null;
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(candidate);
    return real !== realRoot && contained(realRoot, real) ? real : null;
  } catch {
    return null;
  }
}

function readSheet(folder: string): PackageLocation | null {
  try {
    const root = fs.realpathSync(packageRoot());
    const folderStat = fs.lstatSync(folder);
    if (folderStat.isSymbolicLink() || !folderStat.isDirectory()) return null;
    const realFolder = fs.realpathSync(folder);
    if (realFolder === root || !contained(root, realFolder)) return null;
    const mediaDir = fs.realpathSync(path.join(realFolder, "media"));
    if (mediaDir === realFolder || !contained(realFolder, mediaDir)) return null;
    const manifestPath = path.join(realFolder, "clip-sheet.json");
    const manifestStat = fs.lstatSync(manifestPath);
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) return null;
    const sheet = JSON.parse(
      fs.readFileSync(manifestPath, "utf8")
    ) as StoredUniversalSheet;
    if (
      sheet?.schema !== UNIVERSAL_CLIPPER_SCHEMA ||
      !PACKAGE_ID_RE.test(sheet.packageId) ||
      !Array.isArray(sheet.sources) ||
      !Array.isArray(sheet.clips)
    ) {
      return null;
    }
    return { folder: realFolder, mediaDir, manifestPath, sheet };
  } catch {
    return null;
  }
}

export function listUniversalPackages(limit = 50): PackageLocation[] {
  const count = Math.max(1, Math.min(MAX_PACKAGES, Math.floor(limit)));
  let root: string;
  try {
    root = fs.realpathSync(packageRoot());
  } catch {
    return [];
  }
  const packages: PackageLocation[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const found = readSheet(path.join(root, entry.name));
    if (found) packages.push(found);
  }
  packages.sort((a, b) =>
    String(b.sheet.createdAt).localeCompare(String(a.sheet.createdAt))
  );
  return packages.slice(0, count);
}

export function findUniversalPackage(packageId: string): PackageLocation | null {
  if (!PACKAGE_ID_RE.test(packageId)) return null;
  return (
    listUniversalPackages(MAX_PACKAGES).find(
      (item) => item.sheet.packageId === packageId
    ) ?? null
  );
}

function stemExecution(sheet: StoredUniversalSheet): UniversalStemExecution {
  return (
    sheet.stemExecution ?? {
      status: "not_requested",
      quality: null,
      jobId: null,
      stage: "Media prepared; stems have not been requested",
      percent: 0,
      message: "Choose Separate stems in Clipper Cowboy to complete this package.",
      updatedAt: sheet.createdAt,
    }
  );
}

function assetPath(
  location: PackageLocation,
  filename: string,
  included: boolean
): { path: string | null; status: PremierePackageAsset["status"] } {
  if (!included || path.basename(filename) !== filename) {
    return { path: null, status: included ? "invalid" : "pending" };
  }
  const candidate = canonicalRegularFile(
    location.mediaDir,
    path.join(location.mediaDir, filename)
  );
  return candidate
    ? { path: candidate, status: "ready" }
    : { path: null, status: "invalid" };
}

function stemAsset(
  location: PackageLocation,
  stem: ClipSheetStem,
  relationship: "source-stem" | "clip-stem"
): PremierePackageAsset {
  const resolved = assetPath(location, stem.filename, stem.status === "included");
  return {
    assetId: `${stem.groupId}:stem:${stem.stemRole}`,
    groupId: stem.groupId,
    kind: "stem",
    sourceId: stem.sourceId,
    clipId: stem.clipId,
    stemRole: stem.stemRole,
    filename: stem.filename,
    mediaPath: resolved.path,
    airTagId:
      "airTagId" in stem && typeof stem.airTagId === "string"
        ? stem.airTagId
        : null,
    status: resolved.status,
    relationship,
  };
}

export function buildPremierePackageManifest(
  location: PackageLocation
): PremierePackageManifest {
  const groups: PremierePackageGroup[] = [];
  for (const source of location.sheet.sources) {
    const video = assetPath(location, source.fullSourceFilename, true);
    groups.push({
      groupId: source.groupId,
      sourceId: source.sourceId,
      clipId: null,
      label: source.fullSourceFilename,
      airTagId: source.fullSourceAirTagId,
      sourceInSeconds: 0,
      sourceOutSeconds: null,
      assets: [
        {
          assetId: `${source.groupId}:video`,
          groupId: source.groupId,
          kind: "full-source",
          sourceId: source.sourceId,
          clipId: null,
          stemRole: null,
          filename: source.fullSourceFilename,
          mediaPath: video.path,
          airTagId: source.fullSourceAirTagId,
          status: video.status,
          relationship: "source-video",
        },
        ...source.stems.map((stem) =>
          stemAsset(location, stem, "source-stem")
        ),
      ],
    });
  }
  for (const clip of location.sheet.clips) {
    const video = assetPath(location, clip.outputFilename, true);
    groups.push({
      groupId: clip.groupId,
      sourceId: clip.sourceId,
      clipId: clip.clipId,
      label: clip.name,
      airTagId: clip.outputAirTagId,
      sourceInSeconds: clip.sourceInSeconds,
      sourceOutSeconds: clip.sourceOutSeconds,
      assets: [
        {
          assetId: `${clip.groupId}:video`,
          groupId: clip.groupId,
          kind: "clip",
          sourceId: clip.sourceId,
          clipId: clip.clipId,
          stemRole: null,
          filename: clip.outputFilename,
          mediaPath: video.path,
          airTagId: clip.outputAirTagId,
          status: video.status,
          relationship: "clip-video",
        },
        ...clip.stems.map((stem) => stemAsset(location, stem, "clip-stem")),
      ],
    });
  }
  const assets = groups.flatMap((group) => group.assets);
  const execution = stemExecution(location.sheet);
  const invalid = assets.filter((asset) => asset.status === "invalid").length;
  const pending = assets.filter((asset) => asset.status === "pending").length;
  const ready = assets.length - invalid - pending;
  const premiereReady =
    location.sheet.incomplete !== true &&
    execution.status === "ready" &&
    invalid === 0 &&
    pending === 0;
  const packageStatus: PremierePackageManifest["packageStatus"] = premiereReady
    ? "ready"
    : location.sheet.incomplete
      ? "preparing"
      : execution.status === "setup_required"
        ? "setup_required"
        : execution.status === "error" || execution.status === "interrupted"
          ? "stem_error"
          : "stems_pending";
  return {
    schema: "clipper-cowboy/premiere-package@1",
    packageId: location.sheet.packageId,
    packageName: location.sheet.packageName,
    createdAt: location.sheet.createdAt,
    packageStatus,
    premiereReady,
    minimumPremiereVersion: "25.6.0",
    metadataSupport: "clipper-local-mapping",
    metadataNote:
      "Premiere UXP 25.6 exposes media-path import and project-item IDs but no documented project-item comment/XMP writer. AirTag and group mappings remain in Clipper metadata.",
    timelineSupport: "explicit-uxp-action",
    stemExecution: execution,
    groups,
    counts: {
      groups: groups.length,
      assets: assets.length,
      ready,
      pending,
      invalid,
    },
  };
}

export function writeUniversalSheet(
  location: PackageLocation,
  sheet: StoredUniversalSheet
): void {
  if (sheet.packageId !== location.sheet.packageId) {
    throw new Error("package identity cannot change");
  }
  const temp = `${location.manifestPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(sheet, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  fs.renameSync(temp, location.manifestPath);
  location.sheet = sheet;
}

function ackPath(packageId: string): string {
  return path.join(
    config.internalDir,
    "premiere-imports",
    `${packageId}.json`
  );
}

function readAckStore(packageId: string): ImportAckStore {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(ackPath(packageId), "utf8")
    ) as ImportAckStore;
    if (
      parsed?.version === 1 &&
      parsed.packageId === packageId &&
      parsed.projects &&
      typeof parsed.projects === "object"
    ) {
      return parsed;
    }
  } catch {
    // First import for this package.
  }
  return { version: 1, packageId, projects: {} };
}

export function readPremiereImportAcknowledgement(
  packageId: string,
  projectGuid: string
): ImportAckEntry[] {
  if (!PACKAGE_ID_RE.test(packageId) || !projectGuid.trim()) return [];
  return readAckStore(packageId).projects[projectGuid]?.entries ?? [];
}

export function writePremiereImportAcknowledgement(
  packageId: string,
  projectGuid: string,
  entries: {
    assetId: string;
    projectItemId: string;
    status: "existing" | "imported";
  }[]
): ImportAckEntry[] {
  const location = findUniversalPackage(packageId);
  if (!location) throw new Error("package not found");
  const manifest = buildPremierePackageManifest(location);
  const validIds = new Set(
    manifest.groups.flatMap((group) => group.assets.map((asset) => asset.assetId))
  );
  if (!projectGuid.trim() || projectGuid.length > 256) {
    throw new Error("invalid Premiere project identity");
  }
  if (entries.length > 1_000) throw new Error("too many import mappings");
  const now = new Date().toISOString();
  const cleaned = entries.map((entry) => {
    if (
      !validIds.has(entry.assetId) ||
      !entry.projectItemId ||
      entry.projectItemId.length > 512
    ) {
      throw new Error("invalid import mapping");
    }
    return { ...entry, acknowledgedAt: now };
  });
  const store = readAckStore(packageId);
  store.projects[projectGuid] = {
    projectGuid,
    updatedAt: now,
    entries: cleaned,
  };
  const destination = ackPath(packageId);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temp = `${destination}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(store, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  fs.renameSync(temp, destination);
  return cleaned;
}

export const universalPackageStoreTestHelpers = {
  PACKAGE_ID_RE,
  canonicalRegularFile,
  contained,
  readSheet,
};
