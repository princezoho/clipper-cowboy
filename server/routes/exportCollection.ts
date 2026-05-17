import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { z } from "zod";
import { config } from "../config.js";
import { listCharacters } from "../util/characters.js";
import { appendActivity } from "../util/activity.js";

/*
 * "Export collection" — the user filters the Library down (search + characters
 * + scenes + objects + tags), then exports the matching clip files into a
 * clean folder ready to drop into Premiere.
 *
 * - Folder lives at <projectDir>/exports/<name>/
 * - Files are placed via fs.linkSync (hardlinks) when possible, falling back
 *   to fs.copyFileSync on EXDEV. Hardlinks avoid duplicating bytes when the
 *   project + exports live on the same volume.
 * - Optional zip via /usr/bin/zip -r (always present on macOS).
 * - Optional reveal in Finder via `open` / `open -R`.
 */

const router = Router();

interface LibraryMeta {
  id: string;
  name: string;
  description: string;
  tags: string[];
  characters?: { id: string; name: string }[];
  scenes?: { id: string; name: string }[];
  objects?: { id: string; name: string }[];
  filename: string;
  path: string;
  created: number;
}

function listMetas(): LibraryMeta[] {
  if (!fs.existsSync(config.clipMetaDir)) return [];
  const out: LibraryMeta[] = [];
  for (const name of fs.readdirSync(config.clipMetaDir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const data = JSON.parse(
        fs.readFileSync(path.join(config.clipMetaDir, name), "utf8")
      ) as LibraryMeta;
      if (data && fs.existsSync(data.path)) out.push(data);
    } catch {
      // skip malformed
    }
  }
  return out;
}

/** Mirror of the AND-filter logic the LibraryView uses on the frontend. */
function applyFilter(
  items: LibraryMeta[],
  filter: {
    q?: string;
    characterIds?: string[];
    sceneIds?: string[];
    objectIds?: string[];
    tagNames?: string[];
    ids?: string[];
  }
): LibraryMeta[] {
  // Explicit-id mode: caller passed the exact set of clips (multi-select in
  // the Library). Bypass the AND filter — preserve the caller's order so the
  // export folder layout matches what the user picked.
  if (filter.ids && filter.ids.length > 0) {
    const wanted = new Set(filter.ids);
    const byId = new Map(items.map((it) => [it.id, it]));
    const out: LibraryMeta[] = [];
    for (const id of filter.ids) {
      if (!wanted.has(id)) continue;
      const m = byId.get(id);
      if (m) out.push(m);
    }
    return out;
  }
  const q = (filter.q ?? "").trim().toLowerCase();
  const characterIds = new Set(filter.characterIds ?? []);
  const sceneIds = new Set(filter.sceneIds ?? []);
  const objectIds = new Set(filter.objectIds ?? []);
  const tagNames = new Set(
    (filter.tagNames ?? []).map((t) => t.toLowerCase())
  );

  // Resolve character ids → names so we can reproduce the frontend's
  // tag-name fallback for clips that pre-date the explicit character link.
  const charNameById = new Map<string, string>();
  if (characterIds.size > 0) {
    for (const c of listCharacters()) charNameById.set(c.id, c.name);
  }

  return items.filter((it) => {
    for (const id of characterIds) {
      if (it.characters?.some((c) => c.id === id)) continue;
      const name = charNameById.get(id);
      if (name) {
        const target = name.toLowerCase().replace(/\s+/g, "");
        const has = (it.tags ?? []).some(
          (t) => t.toLowerCase().replace(/\s+/g, "") === target
        );
        if (has) continue;
      }
      return false;
    }
    for (const id of sceneIds) {
      if (!it.scenes?.some((s) => s.id === id)) return false;
    }
    for (const id of objectIds) {
      if (!it.objects?.some((o) => o.id === id)) return false;
    }
    for (const t of tagNames) {
      const has = (it.tags ?? []).some((x) => x.toLowerCase() === t);
      if (!has) return false;
    }
    if (q) {
      const hay = [
        it.name,
        it.description,
        ...(it.tags ?? []),
        ...((it.characters ?? []).map((c) => c.name)),
        ...((it.scenes ?? []).map((s) => s.name)),
        ...((it.objects ?? []).map((o) => o.name)),
      ]
        .filter(Boolean)
        .join(" \u0001 ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** Sanitize a user-supplied folder name into something safe for disk + zip. */
function safeFolderName(raw: string): string {
  const cleaned = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 80);
  return cleaned || "export";
}

function uniqueDir(parent: string, base: string): string {
  let candidate = path.join(parent, base);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(parent, `${base}_${n}`);
    n += 1;
  }
  return candidate;
}

function placeFile(src: string, dest: string): { method: "link" | "copy" } {
  try {
    fs.linkSync(src, dest);
    return { method: "link" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EXDEV = different filesystems, EPERM/ENOSYS = permissions / unsupported.
    if (code === "EXDEV" || code === "EPERM" || code === "ENOSYS") {
      fs.copyFileSync(src, dest);
      return { method: "copy" };
    }
    throw err;
  }
}

function dirSize(dir: string): number {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    total += st.isDirectory() ? dirSize(p) : st.size;
  }
  return total;
}

function zipFolder(folderPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parent = path.dirname(folderPath);
    const base = path.basename(folderPath);
    const zipPath = path.join(parent, `${base}.zip`);
    // Run from the parent so the zip stores relative paths (`<base>/foo.mp4`).
    const child = spawn("/usr/bin/zip", ["-r", "-q", zipPath, base], {
      cwd: parent,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(zipPath);
      else reject(new Error(`zip failed (${code}): ${stderr.trim()}`));
    });
  });
}

function reveal(target: string, isZip: boolean) {
  // `open -R <file>` reveals the file in Finder (selected). `open <dir>`
  // opens the directory in a new Finder window. spawnSync so we don't keep
  // a child process alive in the request lifecycle.
  try {
    spawnSync("/usr/bin/open", isZip ? ["-R", target] : [target], {
      stdio: "ignore",
    });
  } catch {
    // Best-effort — not worth failing the request.
  }
}

const Body = z.object({
  name: z.string().min(1),
  zip: z.boolean().default(false),
  reveal: z.boolean().default(false),
  filter: z
    .object({
      q: z.string().optional(),
      characterIds: z.array(z.string()).optional(),
      sceneIds: z.array(z.string()).optional(),
      objectIds: z.array(z.string()).optional(),
      tagNames: z.array(z.string()).optional(),
      ids: z.array(z.string()).optional(),
    })
    .default({}),
});

router.post("/export-collection", async (req, res) => {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { name, zip, reveal: doReveal, filter } = parsed.data;

  const items = listMetas();
  const matched = applyFilter(items, filter);
  if (matched.length === 0) {
    res.status(400).json({ error: "no clips match this filter" });
    return;
  }

  fs.mkdirSync(config.exportsDir, { recursive: true });
  const folder = uniqueDir(config.exportsDir, safeFolderName(name));
  fs.mkdirSync(folder, { recursive: true });

  let copies = 0;
  let links = 0;
  try {
    for (const it of matched) {
      // Avoid clobbering when two clips share a basename.
      const ext = path.extname(it.filename) || path.extname(it.path);
      const base = path.basename(it.filename, ext) || it.id;
      let dest = path.join(folder, `${base}${ext}`);
      let n = 2;
      while (fs.existsSync(dest)) {
        dest = path.join(folder, `${base}_${n}${ext}`);
        n += 1;
      }
      const { method } = placeFile(it.path, dest);
      if (method === "link") links += 1;
      else copies += 1;
    }
  } catch (err) {
    // Roll back the folder if mid-export fails so we don't leave a
    // half-populated directory behind.
    try {
      fs.rmSync(folder, { recursive: true, force: true });
    } catch {
      // ignore
    }
    res.status(500).json({ error: String(err) });
    return;
  }

  let zipPath: string | undefined;
  if (zip) {
    try {
      zipPath = await zipFolder(folder);
    } catch (err) {
      res
        .status(500)
        .json({ error: String(err), folder, fileCount: matched.length });
      return;
    }
  }

  const bytes = dirSize(folder);

  if (doReveal) reveal(zipPath ?? folder, Boolean(zipPath));

  appendActivity("collection_exported", {
    name,
    fileCount: matched.length,
    bytes,
    zipPath,
  });

  res.json({
    folder,
    fileCount: matched.length,
    bytes,
    links,
    copies,
    zipPath,
  });
});

export default router;
