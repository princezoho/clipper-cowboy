import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function expandHome(p: string): string {
  if (!p) return p;
  if (p === "~" || p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/**
 * Resolve the project folder. Priority:
 *   1. PROJECT_DIR (new — preferred)
 *   2. POOL_DIR    (legacy fallback so existing .env files keep working)
 *   3. ~/ClipCataloger
 */
function resolveProjectDir(): string {
  const candidates = [
    process.env.PROJECT_DIR,
    process.env.POOL_DIR,
  ]
    .map((v) => (v ?? "").trim())
    .filter(Boolean);
  const raw = candidates[0];
  const resolved = raw
    ? path.resolve(expandHome(raw))
    : path.resolve(os.homedir(), "ClipCataloger");
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

const projectDir = resolveProjectDir();
const clipsDir = path.join(projectDir, "clips");
const charactersDir = path.join(projectDir, "characters");
const exportsDir = path.join(projectDir, "exports");
const imagesDir = path.join(projectDir, "images");
const derivedDir = path.join(projectDir, "derived");
const stemsDir = path.join(derivedDir, "stems");
const internalDir = path.join(projectDir, ".clipcataloger");

const clipMetaDir = path.join(internalDir, "clip-meta");
const thumbCacheDir = path.join(internalDir, "thumbs");
const captionTmpDir = path.join(internalDir, "caption-tmp");
const durationsPath = path.join(internalDir, "durations.json");
const imageMetaDir = path.join(internalDir, "image-meta");
const imageThumbsDir = path.join(internalDir, "image-thumbs");
const sourceMetaDir = path.join(internalDir, "source-meta");
const stemStudioConfigPath = path.join(internalDir, "stem-studio.json");

export class StemStudioConfigError extends Error {
  constructor(
    message: string,
    readonly code: "stem_studio_config_repair_required"
  ) {
    super(message);
    this.name = "StemStudioConfigError";
  }
}

function optionalAbsoluteEnv(name: string): string | undefined {
  const value = (process.env[name] ?? "").trim();
  return value ? path.resolve(expandHome(value)) : undefined;
}

function readSavedStemStudioRoot(): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(stemStudioConfigPath, "utf8")) as {
      root?: unknown;
    };
    return typeof parsed.root === "string" && parsed.root.trim()
      ? path.resolve(expandHome(parsed.root.trim()))
      : undefined;
  } catch {
    return undefined;
  }
}

const stemStudioRoot =
  readSavedStemStudioRoot() || optionalAbsoluteEnv("CLIPPER_STEM_STUDIO_ROOT");
const explicitStemPython = optionalAbsoluteEnv("CLIPPER_STEM_STUDIO_PYTHON");
const explicitStemCache = optionalAbsoluteEnv("CLIPPER_STEM_STUDIO_CACHE");
const macStemSupportDir = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "stem-studio"
);
const macStemPython = path.join(macStemSupportDir, "venv", "bin", "python");
const macStemCache = path.join(macStemSupportDir, "models");
const stemStudioPython =
  explicitStemPython ||
  (process.platform === "darwin" && fs.existsSync(macStemPython)
    ? macStemPython
    : undefined);
const stemStudioCache =
  explicitStemCache ||
  (process.platform === "darwin" && fs.existsSync(macStemCache)
    ? macStemCache
    : undefined);
const rawStemTimeout = Number(process.env.CLIPPER_STEMS_TIMEOUT_MINUTES ?? 360);

const shotlistMdPath = path.join(projectDir, "shotlist.md");
const shotlistCsvPath = path.join(projectDir, "shotlist.csv");

for (const d of [
  clipsDir,
  charactersDir,
  exportsDir,
  imagesDir,
  derivedDir,
  stemsDir,
  internalDir,
  clipMetaDir,
  thumbCacheDir,
  captionTmpDir,
  imageMetaDir,
  imageThumbsDir,
  sourceMetaDir,
]) {
  fs.mkdirSync(d, { recursive: true });
}

export const config = {
  // This app can read and mutate local media and credentials. Keep it on the
  // loopback interface unless a future authenticated deployment mode is added.
  host: "127.0.0.1",
  port: Number(process.env.PORT ?? 47474),
  projectDir,
  // poolDir == projectDir (sources live at the project root)
  poolDir: projectDir,
  clipsDir,
  charactersDir,
  exportsDir,
  imagesDir,
  derivedDir,
  stemsDir,
  internalDir,
  clipMetaDir,
  thumbCacheDir,
  captionTmpDir,
  durationsPath,
  imageMetaDir,
  imageThumbsDir,
  sourceMetaDir,
  shotlistMdPath,
  shotlistCsvPath,
  openaiApiKey: (process.env.OPENAI_API_KEY ?? "").trim(),
  stemStudioRoot,
  stemStudioPython,
  stemStudioCache,
  stemStudioConfigured: Boolean(stemStudioRoot),
  stemTimeoutMinutes:
    Number.isFinite(rawStemTimeout) && rawStemTimeout >= 1
      ? Math.min(rawStemTimeout, 24 * 60)
      : 360,
};

function artifactBackupPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${stemStudioConfigPath}.bad-dir-${stamp}`;
}

function moveConfigDirectoryToBackup(allowNonEmpty: boolean): void {
  fs.mkdirSync(internalDir, { recursive: true, mode: 0o700 });
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(stemStudioConfigPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isDirectory()) {
    if (stat.isSymbolicLink()) {
      throw new StemStudioConfigError(
        "Clipper found an old Stem Studio setup artifact that needs repair before it can connect.",
        "stem_studio_config_repair_required"
      );
    }
    return;
  }
  const entries = fs.readdirSync(stemStudioConfigPath);
  const onlySafeTemporaryArtifacts = entries.every((entry) =>
    /^stem-studio\.json\.tmp-\d+-\d+$/.test(entry)
  );
  if (entries.length > 0 && !onlySafeTemporaryArtifacts && !allowNonEmpty) {
    throw new StemStudioConfigError(
      "Clipper found an old Stem Studio setup artifact. Select Repair old setup to back it up safely, then connect again.",
      "stem_studio_config_repair_required"
    );
  }
  fs.renameSync(stemStudioConfigPath, artifactBackupPath());
}

/** Backs up an old directory artifact without deleting its contents. */
export function repairStemStudioConfigArtifact(): void {
  moveConfigDirectoryToBackup(true);
}

/** Persist the user-selected, trusted Stem Studio checkout without modifying .env. */
export function setStemStudioRoot(root: string): void {
  const resolved = path.resolve(expandHome(root));
  moveConfigDirectoryToBackup(false);
  const temp = `${stemStudioConfigPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temp, JSON.stringify({ root: resolved }, null, 2) + "\n", {
      mode: 0o600,
    });
    fs.renameSync(temp, stemStudioConfigPath);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // The original error is more useful; a later save can clean its temp file.
    }
    throw error;
  }
  config.stemStudioRoot = resolved;
  config.stemStudioConfigured = true;
}

export const POOL_CACHE_DIR = thumbCacheDir; // legacy alias (still used by some routes)
export const LIBRARY_META_DIR = clipMetaDir;
export const LIBRARY_CACHE_DIR = thumbCacheDir;
export const CHARACTERS_REFS_DIR = charactersDir;
export const CAPTION_TMP_DIR = captionTmpDir;

export const SUPPORTED_VIDEO_EXTS = new Set([
  ".mp4",
  ".mov",
  ".mkv",
  ".webm",
  ".m4v",
  ".avi",
]);

export function isSupportedVideo(filename: string): boolean {
  return SUPPORTED_VIDEO_EXTS.has(path.extname(filename).toLowerCase());
}

/**
 * Folder names at the project root that are NOT pool sources, even if they
 * happen to contain video files.
 */
export const RESERVED_PROJECT_DIRS = new Set([
  "clips",
  "characters",
  "exports",
  "images",
  "derived",
  ".clipcataloger",
]);

export const SUPPORTED_IMAGE_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
]);

export function isSupportedImage(filename: string): boolean {
  return SUPPORTED_IMAGE_EXTS.has(path.extname(filename).toLowerCase());
}

// Tags the AI captioner often emits that are noise for a single-style project.
export const SUPPRESSED_TAGS = new Set<string>([
  "animation",
  "animated",
  "cartoon",
  "cartoons",
  "cartoon character",
  "cartoon characters",
  "drawing",
  "drawn",
  "illustration",
  "illustrated",
  "2d",
  "2d animation",
  "style",
  "comic",
  "comic book",
  "graphic novel",
  "graphic",
  "art",
  "artwork",
  "digital art",
  "digital",
  "rendering",
  "rendered",
]);
