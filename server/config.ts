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
const internalDir = path.join(projectDir, ".clipcataloger");

const clipMetaDir = path.join(internalDir, "clip-meta");
const sceneCacheDir = path.join(internalDir, "scenes");
const thumbCacheDir = path.join(internalDir, "thumbs");
const captionTmpDir = path.join(internalDir, "caption-tmp");
const durationsPath = path.join(internalDir, "durations.json");

const shotlistMdPath = path.join(projectDir, "shotlist.md");
const shotlistCsvPath = path.join(projectDir, "shotlist.csv");

for (const d of [
  clipsDir,
  charactersDir,
  internalDir,
  clipMetaDir,
  sceneCacheDir,
  thumbCacheDir,
  captionTmpDir,
]) {
  fs.mkdirSync(d, { recursive: true });
}

export const config = {
  port: Number(process.env.PORT ?? 47474),
  projectDir,
  // poolDir == projectDir (sources live at the project root)
  poolDir: projectDir,
  clipsDir,
  charactersDir,
  internalDir,
  clipMetaDir,
  sceneCacheDir,
  thumbCacheDir,
  captionTmpDir,
  durationsPath,
  shotlistMdPath,
  shotlistCsvPath,
  openaiApiKey: (process.env.OPENAI_API_KEY ?? "").trim(),
};

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
  ".clipcataloger",
]);

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
