import crypto from "node:crypto";
import path from "node:path";

export function pathToId(filePath: string): string {
  return crypto.createHash("sha1").update(path.resolve(filePath)).digest("hex").slice(0, 16);
}

export function safeFilename(name: string): string {
  return name
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 80) || "clip";
}
