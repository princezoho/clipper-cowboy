/*
 * Error text that leaves the local API and lands in the browser UI — and from
 * there in screenshots and bug reports — must not carry the user's absolute
 * filesystem paths or anything key-shaped. A raw Node fs error stringifies to
 * `ENOENT: no such file or directory, open '/Users/someone/Videos/a.mp4'`,
 * which names the person and their folder layout.
 *
 * The redaction mirrors `makeRedactor` in mcp/src/security.ts and
 * `safeDiagnostic` in server/stems/mcpClient.ts, with one deliberate
 * difference: paths collapse to their basename instead of `<path>`, because
 * "which file" is usually the only actionable part of the message.
 */

const PRESERVED_CODES = new Set([
  "EACCES",
  "EBUSY",
  "EEXIST",
  "EISDIR",
  "EMFILE",
  "ENOENT",
  "ENOSPC",
  "ENOTDIR",
  "ENOTEMPTY",
  "EPERM",
  "EROFS",
  "EXDEV",
]);

const TOKEN_PATTERNS = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /\b(?:sk|rk|pk)_[A-Za-z0-9_-]{8,}\b/g,
  /gh[pousr]_[A-Za-z0-9_]{12,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /Bearer\s+[A-Za-z0-9._-]{12,}/gi,
];

const ENV_ASSIGNMENT_RE =
  /\b(OPENAI_API_KEY|CLIPPER_API_TOKEN|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)\s*=\s*\S+/gi;

/**
 * http(s) URLs are held aside during path collapsing so an OpenAI or connector
 * endpoint stays readable. Query strings are dropped because that is where a
 * signed URL or `?api_key=` would hide.
 */
const HTTP_URL_RE = /\bhttps?:\/\/[^\s'"<>)\]]+/gi;

// The lookbehind keeps a relative path such as `.clipcataloger/clip-meta/x.json`
// intact; only a slash that actually starts a path segment is a candidate.
const POSIX_PATH_RE = /(?<![\w.~-])(?:\/[^\s:'"`,;)\]>]+)+\/?/g;
const WINDOWS_PATH_RE = /\b[A-Za-z]:\\[^\s:'"`,;)\]>]*/g;

const MAX_LENGTH = 500;

function rawMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value && typeof value === "object") {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return String(value ?? "");
}

function errorCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" && PRESERVED_CODES.has(code) ? code : undefined;
}

function stripSecrets(text: string): string {
  let out = text;
  for (const [key, value] of Object.entries(process.env)) {
    if (!/(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(key)) continue;
    if (!value || value.length < 6) continue;
    out = out.split(value).join("[REDACTED]");
    out = out.split(JSON.stringify(value).slice(1, -1)).join("[REDACTED]");
  }
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, "[REDACTED]");
  return out.replace(ENV_ASSIGNMENT_RE, "$1=[REDACTED]");
}

function basenameOf(match: string): string {
  const segments = match.replace(/[/\\]+$/, "").split(/[/\\]/).filter(Boolean);
  const base = segments[segments.length - 1];
  if (!base || base === "." || base === "..") return "<path>";
  return base;
}

function stripPaths(text: string): string {
  const urls: string[] = [];
  const withoutUrls = text.replace(HTTP_URL_RE, (url) => {
    urls.push(url.split(/[?#]/)[0]);
    return `\u0000${urls.length - 1}\u0000`;
  });
  const collapsed = withoutUrls
    .replace(WINDOWS_PATH_RE, basenameOf)
    .replace(POSIX_PATH_RE, basenameOf);
  return collapsed.replace(/\u0000(\d+)\u0000/g, (_all, index) => urls[Number(index)]);
}

/**
 * Redact a thrown value into something safe to put in an HTTP response body.
 * Exported for tests and for the rare caller that has already logged the full
 * error itself; route handlers should use `publicError`.
 */
export function redactErrorMessage(error: unknown): string {
  const code = errorCode(error);
  let text = stripPaths(stripSecrets(rawMessage(error)))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LENGTH);
  if (!text) text = code ? `${code} error` : "unexpected server error";
  if (code && !text.includes(code)) text = `${code}: ${text}`;
  return text;
}

/**
 * Log the untouched error to stderr under `context`, then return a message the
 * browser may safely display. The full path, stack, and cause stay local.
 */
export function publicError(error: unknown, context: string): string {
  console.error(`[${context}]`, error);
  return redactErrorMessage(error);
}
