import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";
import { ffmpeg } from "../ffmpeg.js";

/*
 * Layout (human-named folders, browsable in Finder):
 *
 *   <project>/characters/
 *     Buck/
 *       character.json   ← { id, name, aliases, description, created, updated }
 *       refs/
 *         001.jpg
 *         002.jpg
 *     Marshall_Roy/
 *       character.json
 *       refs/...
 *
 * The folder name is derived from the character name (slugified). Renaming
 * a character renames the folder. The stable `id` lives inside character.json
 * and never changes — frontend always references characters by id.
 */

export interface CharacterMeta {
  id: string;
  name: string;
  aliases: string[];
  description: string;
  refCount: number;
  created: number;
  updated: number;
  folder: string; // basename of the character's folder, for debugging
}

interface CharacterFile {
  id: string;
  name: string;
  aliases?: string[];
  description?: string;
  created: number;
  updated?: number;
}

function slugifyName(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 64);
  return base || "Character";
}

function ensureRoot() {
  fs.mkdirSync(config.charactersDir, { recursive: true });
}

function listCharacterDirs(): string[] {
  ensureRoot();
  return fs
    .readdirSync(config.charactersDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => path.join(config.charactersDir, e.name));
}

function readMetaIn(dir: string): CharacterFile | null {
  const p = path.join(dir, "character.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as CharacterFile;
  } catch {
    return null;
  }
}

function writeMetaIn(dir: string, file: CharacterFile) {
  fs.writeFileSync(
    path.join(dir, "character.json"),
    JSON.stringify(file, null, 2)
  );
}

function refsDirIn(dir: string): string {
  return path.join(dir, "refs");
}

function listRefFiles(dir: string): string[] {
  const refs = refsDirIn(dir);
  if (!fs.existsSync(refs)) return [];
  return fs
    .readdirSync(refs)
    .filter((n) => n.endsWith(".jpg") || n.endsWith(".jpeg"))
    .sort();
}

function dirById(id: string): string | null {
  for (const dir of listCharacterDirs()) {
    const file = readMetaIn(dir);
    if (file?.id === id) return dir;
  }
  return null;
}

function uniqueDirPath(name: string, exceptDir?: string): string {
  const slug = slugifyName(name);
  let candidate = path.join(config.charactersDir, slug);
  let n = 2;
  while (fs.existsSync(candidate) && candidate !== exceptDir) {
    candidate = path.join(config.charactersDir, `${slug}_${n}`);
    n += 1;
  }
  return candidate;
}

function toMeta(file: CharacterFile, dir: string): CharacterMeta {
  return {
    id: file.id,
    name: file.name,
    aliases: file.aliases ?? [],
    description: file.description ?? "",
    refCount: listRefFiles(dir).length,
    created: file.created,
    updated: file.updated ?? file.created,
    folder: path.basename(dir),
  };
}

export function listCharacters(): CharacterMeta[] {
  const out: CharacterMeta[] = [];
  for (const dir of listCharacterDirs()) {
    const file = readMetaIn(dir);
    if (file) out.push(toMeta(file, dir));
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function getCharacter(id: string): CharacterMeta | null {
  const dir = dirById(id);
  if (!dir) return null;
  const file = readMetaIn(dir);
  return file ? toMeta(file, dir) : null;
}

export function createCharacter(input: {
  name: string;
  description?: string;
  aliases?: string[];
}): CharacterMeta {
  ensureRoot();
  const id = crypto.randomBytes(8).toString("hex");
  const now = Date.now();
  const dir = uniqueDirPath(input.name);
  fs.mkdirSync(refsDirIn(dir), { recursive: true });
  const file: CharacterFile = {
    id,
    name: input.name.trim(),
    aliases: (input.aliases ?? []).map((a) => a.trim()).filter(Boolean),
    description: (input.description ?? "").trim(),
    created: now,
    updated: now,
  };
  writeMetaIn(dir, file);
  return toMeta(file, dir);
}

export function updateCharacter(
  id: string,
  patch: { name?: string; description?: string; aliases?: string[] }
): CharacterMeta | null {
  const dir = dirById(id);
  if (!dir) return null;
  const file = readMetaIn(dir);
  if (!file) return null;

  let currentDir = dir;
  if (patch.name !== undefined && patch.name.trim() !== file.name) {
    file.name = patch.name.trim();
    const newDir = uniqueDirPath(file.name, dir);
    if (newDir !== dir) {
      fs.renameSync(dir, newDir);
      currentDir = newDir;
    }
  }
  if (patch.description !== undefined) file.description = patch.description.trim();
  if (patch.aliases !== undefined)
    file.aliases = patch.aliases.map((a) => a.trim()).filter(Boolean);
  file.updated = Date.now();
  writeMetaIn(currentDir, file);
  return toMeta(file, currentDir);
}

export function deleteCharacter(id: string): boolean {
  const dir = dirById(id);
  if (!dir) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

export function listRefs(id: string): { name: string; path: string }[] {
  const dir = dirById(id);
  if (!dir) return [];
  return listRefFiles(dir).map((n) => ({
    name: n,
    path: path.join(refsDirIn(dir), n),
  }));
}

export function refPath(id: string, refName: string): string | null {
  const safe = path.basename(refName);
  if (!/^[\w.\- ]+$/.test(safe)) return null;
  const dir = dirById(id);
  if (!dir) return null;
  const p = path.join(refsDirIn(dir), safe);
  return fs.existsSync(p) ? p : null;
}

/**
 * Add a reference image by re-encoding an existing JPEG (e.g. a video frame)
 * at face-friendly size. Returns the new ref filename.
 */
export async function addRefFromJpeg(
  id: string,
  sourceJpeg: string
): Promise<string> {
  const dir = dirById(id);
  if (!dir) throw new Error("character not found");
  const refs = refsDirIn(dir);
  fs.mkdirSync(refs, { recursive: true });
  const seq = nextSequentialName(refs);
  const outPath = path.join(refs, seq);
  const r = await ffmpeg([
    "-i",
    sourceJpeg,
    "-vf",
    "scale='min(512,iw)':-2",
    "-q:v",
    "3",
    outPath,
  ]);
  if (r.code !== 0) throw new Error(`add ref failed: ${r.stderr}`);

  const file = readMetaIn(dir);
  if (file) {
    file.updated = Date.now();
    writeMetaIn(dir, file);
  }
  return path.basename(outPath);
}

function nextSequentialName(refsDir: string): string {
  const existing = fs
    .readdirSync(refsDir)
    .map((n) => /^(\d+)\.jpg$/i.exec(n)?.[1])
    .filter(Boolean)
    .map((n) => Number(n));
  const next = existing.length ? Math.max(...existing) + 1 : 1;
  return `${String(next).padStart(3, "0")}.jpg`;
}

export function deleteRef(id: string, refName: string): boolean {
  const p = refPath(id, refName);
  if (!p) return false;
  fs.unlinkSync(p);
  const dir = dirById(id);
  if (dir) {
    const file = readMetaIn(dir);
    if (file) {
      file.updated = Date.now();
      writeMetaIn(dir, file);
    }
  }
  return true;
}
