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
 * Which env var, if any, explicitly points at a project folder. Priority:
 *   1. PROJECT_DIR (new — preferred)
 *   2. POOL_DIR    (legacy fallback so existing .env files keep working)
 * Returns "" when neither is set, meaning we fall back to ~/ClipCataloger and
 * the first-run wizard still owes us an answer.
 */
function configuredProjectDir(): string {
  return [process.env.PROJECT_DIR, process.env.POOL_DIR]
    .map((v) => (v ?? "").trim())
    .find(Boolean) ?? "";
}

export interface AppConfig {
  host: string;
  port: number;
  projectDir: string;
  /** False until the user explicitly picks a folder (first-run wizard). */
  projectDirConfigured: boolean;
  poolDir: string;
  clipsDir: string;
  charactersDir: string;
  exportsDir: string;
  imagesDir: string;
  derivedDir: string;
  stemsDir: string;
  internalDir: string;
  clipMetaDir: string;
  thumbCacheDir: string;
  captionTmpDir: string;
  durationsPath: string;
  imageMetaDir: string;
  imageThumbsDir: string;
  sourceMetaDir: string;
  shotlistMdPath: string;
  shotlistCsvPath: string;
  openaiApiKey: string;
}

/**
 * Derive every path from the current environment and create the folders. Pure
 * apart from those mkdirs: it returns a fresh object rather than mutating the
 * live `config`, so a failure (unwritable volume, say) leaves the running
 * process pointed at the directory it was already using.
 */
function buildConfig(port: number): AppConfig {
  const raw = configuredProjectDir();
  const projectDir = raw
    ? path.resolve(expandHome(raw))
    : path.resolve(os.homedir(), "ClipCataloger");
  const derivedDir = path.join(projectDir, "derived");
  const internalDir = path.join(projectDir, ".clipcataloger");

  const next: AppConfig = {
    // This app can read and mutate local media and credentials. Keep it on the
    // loopback interface unless a future authenticated deployment mode is added.
    host: "127.0.0.1",
    port,
    projectDir,
    projectDirConfigured: Boolean(raw),
    // poolDir == projectDir (sources live at the project root)
    poolDir: projectDir,
    clipsDir: path.join(projectDir, "clips"),
    charactersDir: path.join(projectDir, "characters"),
    exportsDir: path.join(projectDir, "exports"),
    imagesDir: path.join(projectDir, "images"),
    derivedDir,
    stemsDir: path.join(derivedDir, "stems"),
    internalDir,
    clipMetaDir: path.join(internalDir, "clip-meta"),
    thumbCacheDir: path.join(internalDir, "thumbs"),
    captionTmpDir: path.join(internalDir, "caption-tmp"),
    durationsPath: path.join(internalDir, "durations.json"),
    imageMetaDir: path.join(internalDir, "image-meta"),
    imageThumbsDir: path.join(internalDir, "image-thumbs"),
    sourceMetaDir: path.join(internalDir, "source-meta"),
    shotlistMdPath: path.join(projectDir, "shotlist.md"),
    shotlistCsvPath: path.join(projectDir, "shotlist.csv"),
    openaiApiKey: (process.env.OPENAI_API_KEY ?? "").trim(),
  };

  for (const d of [
    next.projectDir,
    next.clipsDir,
    next.charactersDir,
    next.exportsDir,
    next.imagesDir,
    next.derivedDir,
    next.stemsDir,
    next.internalDir,
    next.clipMetaDir,
    next.thumbCacheDir,
    next.captionTmpDir,
    next.imageMetaDir,
    next.imageThumbsDir,
    next.sourceMetaDir,
  ]) {
    fs.mkdirSync(d, { recursive: true });
  }
  return next;
}

export const config: AppConfig = buildConfig(Number(process.env.PORT ?? 47474));

/**
 * Modules that cannot read `config` lazily — because they derive a path or an
 * index once at import time — register here so `reloadConfig()` can bring them
 * along. Without this, a runtime PROJECT_DIR change would leave some consumers
 * writing to the old folder, which is worse than not reloading at all.
 */
export interface ConfigReloadHooks {
  /** Persist state that belongs to the outgoing folder. Runs before the swap. */
  flush?: () => void;
  /** Recompute derived paths and drop caches. Runs after the swap. */
  apply: () => void;
}

const reloadHooks: ConfigReloadHooks[] = [];

export function onConfigReload(hooks: ConfigReloadHooks): void {
  reloadHooks.push(hooks);
}

/**
 * Re-derive the whole config from `process.env` in place, so that every
 * `config.x` read and every registered consumer sees the new project folder
 * within the same process. Callers must update `process.env` first.
 *
 * Throws if the new folder cannot be created, having changed nothing.
 */
export function reloadConfig(): void {
  // The HTTP listener is already bound, so the port stays put for the lifetime
  // of the process even if PORT changes in .env.
  const next = buildConfig(config.port);
  for (const hook of reloadHooks) {
    try {
      hook.flush?.();
    } catch {
      // Flushes are observational. Never let one block the swap — that would
      // strand the caller on the old folder with no way to say so.
      console.error("[config] a reload flush hook failed");
    }
  }
  Object.assign(config, next);
  for (const hook of reloadHooks) {
    hook.apply();
  }
}

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
