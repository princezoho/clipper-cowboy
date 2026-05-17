import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";

/*
 * Lightweight catalogs for tag categories that don't carry reference images
 * (Scenes, Objects). Persisted as a single JSON file per kind under
 * `<projectDir>/.clipcataloger/<kind>.json`. Mirrors the Characters API shape
 * (id, name, description, created, updated) so the frontend can reuse the
 * same card pattern.
 */

export type EntityKind = "scenes" | "objects";

export interface EntityRecord {
  id: string;
  name: string;
  description: string;
  created: number;
  updated: number;
}

interface EntityFile {
  items: EntityRecord[];
}

function filePath(kind: EntityKind): string {
  return path.join(config.internalDir, `${kind}.json`);
}

function readFile(kind: EntityKind): EntityFile {
  const p = filePath(kind);
  if (!fs.existsSync(p)) return { items: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as EntityFile;
    if (!raw || !Array.isArray(raw.items)) return { items: [] };
    return raw;
  } catch {
    return { items: [] };
  }
}

function writeFile(kind: EntityKind, file: EntityFile) {
  fs.mkdirSync(config.internalDir, { recursive: true });
  fs.writeFileSync(filePath(kind), JSON.stringify(file, null, 2));
}

export function listEntities(kind: EntityKind): EntityRecord[] {
  const f = readFile(kind);
  return [...f.items].sort((a, b) => a.name.localeCompare(b.name));
}

export function getEntity(kind: EntityKind, id: string): EntityRecord | null {
  return readFile(kind).items.find((e) => e.id === id) ?? null;
}

export function createEntity(
  kind: EntityKind,
  input: { name: string; description?: string }
): EntityRecord {
  const f = readFile(kind);
  const name = input.name.trim();
  if (!name) throw new Error("name is required");
  // De-dupe by case-insensitive name; if a match exists, return it instead of
  // creating a noisy duplicate (the UI calls this from "+ create new" pickers).
  const existing = f.items.find(
    (e) => e.name.toLowerCase() === name.toLowerCase()
  );
  if (existing) return existing;
  const now = Date.now();
  const rec: EntityRecord = {
    id: crypto.randomBytes(8).toString("hex"),
    name,
    description: (input.description ?? "").trim(),
    created: now,
    updated: now,
  };
  f.items.push(rec);
  writeFile(kind, f);
  return rec;
}

export function updateEntity(
  kind: EntityKind,
  id: string,
  patch: { name?: string; description?: string }
): EntityRecord | null {
  const f = readFile(kind);
  const i = f.items.findIndex((e) => e.id === id);
  if (i < 0) return null;
  const cur = f.items[i];
  const next: EntityRecord = {
    ...cur,
    name: patch.name !== undefined ? patch.name.trim() || cur.name : cur.name,
    description:
      patch.description !== undefined ? patch.description.trim() : cur.description,
    updated: Date.now(),
  };
  f.items[i] = next;
  writeFile(kind, f);
  return next;
}

export function deleteEntity(kind: EntityKind, id: string): boolean {
  const f = readFile(kind);
  const before = f.items.length;
  f.items = f.items.filter((e) => e.id !== id);
  if (f.items.length === before) return false;
  writeFile(kind, f);
  return true;
}
