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

function resolveDir(envValue: string | undefined, fallbackName: string): string {
  const raw = (envValue ?? "").trim();
  const resolved = raw
    ? path.resolve(expandHome(raw))
    : path.resolve(os.homedir(), "ClipCataloger", fallbackName);
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

export const config = {
  port: Number(process.env.PORT ?? 5174),
  poolDir: resolveDir(process.env.POOL_DIR, "pool"),
  libraryDir: resolveDir(process.env.LIBRARY_DIR, "library"),
  openaiApiKey: (process.env.OPENAI_API_KEY ?? "").trim(),
};

export const POOL_CACHE_DIR = path.join(config.poolDir, ".cache");
export const LIBRARY_META_DIR = path.join(config.libraryDir, ".meta");
export const LIBRARY_CACHE_DIR = path.join(config.libraryDir, ".cache");

fs.mkdirSync(POOL_CACHE_DIR, { recursive: true });
fs.mkdirSync(LIBRARY_META_DIR, { recursive: true });
fs.mkdirSync(LIBRARY_CACHE_DIR, { recursive: true });

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
