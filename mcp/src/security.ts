import fs from "node:fs";
import path from "node:path";

export const ID_RE = /^[a-f0-9]{16}$/;

export class PublicError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly remediation?: string
  ) {
    super(message);
  }
}

export function requireId(value: string, label: string): string {
  if (!ID_RE.test(value)) {
    throw new PublicError(
      "INVALID_ID",
      `${label} must be a 16-character lowercase hexadecimal ID.`,
      `Call the relevant list tool to obtain a valid ${label}.`
    );
  }
  return value;
}

export function isContainedPath(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== "" && !rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel);
}

export function requireContainedFile(root: string, candidate: string): string {
  if (!path.isAbsolute(candidate)) {
    throw new PublicError("UNSAFE_PATH", "Catalog contains a non-absolute media path.");
  }
  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = fs.realpathSync(root);
    realCandidate = fs.realpathSync(candidate);
  } catch {
    throw new PublicError("MEDIA_MISSING", "Catalogued media file does not exist.");
  }
  if (!isContainedPath(realRoot, realCandidate)) {
    throw new PublicError(
      "UNSAFE_PATH",
      "Catalogued media resolves outside its allowed project directory."
    );
  }
  if (!fs.statSync(realCandidate).isFile()) {
    throw new PublicError("NOT_A_FILE", "Catalogued media path is not a file.");
  }
  return realCandidate;
}

/**
 * Derive a non-existing Stem Studio output folder without trusting a clip
 * basename such as "." or "..". The clip ID is the deterministic fallback.
 */
export function safeStemOutputDir(
  stemsRoot: string,
  clipPath: string,
  clipId: string
): string {
  const realRoot = fs.realpathSync(stemsRoot);
  const ext = path.extname(clipPath);
  const raw = path.basename(clipPath, ext);
  const safe = raw
    .normalize("NFKC")
    .replace(/[\\/\0]/g, "_")
    .replace(/^\.+$/, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 160);
  const folder = safe || `clip-${requireId(clipId, "clip_id")}`;
  const candidate = path.resolve(realRoot, folder);
  if (!isContainedPath(realRoot, candidate)) {
    throw new PublicError("UNSAFE_PATH", "Could not derive a safe stem output folder.");
  }
  return candidate;
}

const TOKEN_PATTERNS = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /gh[pousr]_[A-Za-z0-9_]{12,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /Bearer\s+[A-Za-z0-9._-]{12,}/gi,
];

export function makeRedactor(env: NodeJS.ProcessEnv): (value: unknown) => string {
  const explicit = Object.entries(env)
    .filter(([key, value]) => /(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(key) && (value?.length ?? 0) >= 6)
    .map(([, value]) => value as string);
  return (value: unknown): string => {
    let text = value instanceof Error ? value.message : String(value);
    for (const secret of explicit) {
      text = text.split(secret).join("[REDACTED]");
      const jsonEscaped = JSON.stringify(secret).slice(1, -1);
      text = text.split(jsonEscaped).join("[REDACTED]");
    }
    for (const pattern of TOKEN_PATTERNS) text = text.replace(pattern, "[REDACTED]");
    return text;
  };
}
