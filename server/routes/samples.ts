import { Router } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { createCharacter } from "../util/characters.js";
import { createEntity } from "../util/entities.js";
import { pathToId } from "../util/id.js";
import { appendActivity } from "../util/activity.js";
import { scheduleShotlistRebuild } from "../util/shotlist.js";
import { publicError } from "../util/publicError.js";

/*
 * Loads the committed starter project into the user's project folder so a fresh
 * install has something to review instead of an empty grid.
 *
 * Copy-only by design: nothing here deletes, moves, or overwrites user media.
 * Every destination is allocated with an exclusive create, so a name that is
 * already taken gets a numbered sibling rather than clobbering anything.
 */

const router = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The bundled server can run from `server/`, from the esbuild bundle at the
 * repository root, or with an explicit root, so probe rather than assume.
 */
function findSampleRoot(): string | null {
  const candidates = [
    process.env.CLIPPER_ROOT
      ? path.join(process.env.CLIPPER_ROOT, "samples", "starter-project")
      : null,
    path.resolve(__dirname, "..", "..", "samples", "starter-project"),
    path.resolve(__dirname, "..", "samples", "starter-project"),
    path.resolve(process.cwd(), "samples", "starter-project"),
  ].filter((p): p is string => Boolean(p));
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "manifest.json"))) return dir;
  }
  return null;
}

interface SampleManifest {
  version: number;
  title: string;
  description: string;
  characters: { key: string; name: string; description?: string }[];
  scenes: { key: string; name: string; description?: string }[];
  objects: { key: string; name: string; description?: string }[];
  sources: { key: string; file: string }[];
  clips: {
    file: string;
    source: string;
    name: string;
    description?: string;
    tags?: string[];
    characters?: string[];
    scenes?: string[];
    objects?: string[];
    in: number;
    out: number;
  }[];
  images: { file: string }[];
}

function readManifest(root: string): SampleManifest {
  return JSON.parse(
    fs.readFileSync(path.join(root, "manifest.json"), "utf8")
  ) as SampleManifest;
}

function markerPath(): string {
  return path.join(config.internalDir, "sample-project.json");
}

/** Read a file from inside the sample tree, refusing anything that escapes it. */
function sampleFile(root: string, rel: string): string {
  const resolved = path.resolve(root, rel);
  const relToRoot = path.relative(root, resolved);
  if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
    throw new Error("sample manifest referenced a path outside the sample tree");
  }
  if (!fs.statSync(resolved).isFile()) {
    throw new Error(`sample file missing: ${rel}`);
  }
  return resolved;
}

/**
 * Copy into `dir` under `preferred`, never replacing an existing file. Returns
 * the destination actually written. `COPYFILE_EXCL` makes the check and the
 * write one operation, so two concurrent loads cannot land on the same name.
 */
function copyWithoutReplacing(
  source: string,
  dir: string,
  preferred: string
): string {
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(preferred);
  const stem = path.basename(preferred, ext);
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const name = attempt === 1 ? preferred : `${stem}_${attempt}${ext}`;
    const dest = path.join(dir, name);
    try {
      fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL);
      return dest;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
  }
  throw new Error(`could not allocate a free name for ${preferred}`);
}

router.get("/samples/starter", (_req, res) => {
  const root = findSampleRoot();
  if (!root) {
    res.json({ available: false, loaded: false });
    return;
  }
  try {
    const manifest = readManifest(root);
    res.json({
      available: true,
      loaded: fs.existsSync(markerPath()),
      title: manifest.title,
      description: manifest.description,
      sourceCount: manifest.sources.length,
      clipCount: manifest.clips.length,
    });
  } catch (err) {
    res.status(500).json({ error: publicError(err, "sample manifest") });
  }
});

router.post("/samples/starter/load", (_req, res) => {
  if (!config.projectDirConfigured) {
    res.status(400).json({ error: "pick a project folder first" });
    return;
  }
  const root = findSampleRoot();
  if (!root) {
    res.status(404).json({ error: "starter project is not installed" });
    return;
  }

  try {
    const manifest = readManifest(root);

    const characterIds = new Map<string, { id: string; name: string }>();
    for (const c of manifest.characters) {
      const made = createCharacter({
        name: c.name,
        description: c.description ?? "",
      });
      characterIds.set(c.key, { id: made.id, name: made.name });
    }
    const sceneIds = new Map<string, { id: string; name: string }>();
    for (const s of manifest.scenes) {
      const made = createEntity("scenes", {
        name: s.name,
        description: s.description ?? "",
      });
      sceneIds.set(s.key, { id: made.id, name: made.name });
    }
    const objectIds = new Map<string, { id: string; name: string }>();
    for (const o of manifest.objects) {
      const made = createEntity("objects", {
        name: o.name,
        description: o.description ?? "",
      });
      objectIds.set(o.key, { id: made.id, name: made.name });
    }

    const sourcePaths = new Map<string, string>();
    for (const s of manifest.sources) {
      const from = sampleFile(root, s.file);
      const dest = copyWithoutReplacing(
        from,
        config.projectDir,
        path.basename(s.file)
      );
      sourcePaths.set(s.key, dest);
    }

    const now = Date.now();
    let clipsWritten = 0;
    for (const clip of manifest.clips) {
      const sourcePath = sourcePaths.get(clip.source);
      if (!sourcePath) continue;
      const from = sampleFile(root, clip.file);
      const dest = copyWithoutReplacing(
        from,
        config.clipsDir,
        path.basename(clip.file)
      );
      const id = crypto.randomBytes(8).toString("hex");
      const resolve = (
        keys: string[] | undefined,
        table: Map<string, { id: string; name: string }>
      ) => (keys ?? []).map((k) => table.get(k)).filter(Boolean) as {
        id: string;
        name: string;
      }[];
      const meta = {
        id,
        name: clip.name,
        description: clip.description ?? "",
        tags: clip.tags ?? [],
        characters: resolve(clip.characters, characterIds),
        scenes: resolve(clip.scenes, sceneIds),
        objects: resolve(clip.objects, objectIds),
        filename: path.basename(dest),
        path: dest,
        source: path.basename(sourcePath),
        sourcePath,
        sourceId: pathToId(sourcePath),
        in: clip.in,
        out: clip.out,
        duration: Math.max(0, clip.out - clip.in),
        mode: "sample",
        exportMode: "clip" as const,
        details: "Loaded from the bundled starter project.",
        created: now,
      };
      fs.mkdirSync(config.clipMetaDir, { recursive: true });
      fs.writeFileSync(
        path.join(config.clipMetaDir, `${id}.json`),
        JSON.stringify(meta, null, 2)
      );
      clipsWritten += 1;
    }

    let imagesWritten = 0;
    for (const image of manifest.images) {
      const from = sampleFile(root, image.file);
      copyWithoutReplacing(from, config.imagesDir, path.basename(image.file));
      imagesWritten += 1;
    }

    fs.mkdirSync(config.internalDir, { recursive: true });
    fs.writeFileSync(
      markerPath(),
      JSON.stringify(
        {
          version: manifest.version,
          loadedAt: now,
          sources: [...sourcePaths.values()].map((p) => path.basename(p)),
        },
        null,
        2
      )
    );

    scheduleShotlistRebuild();
    appendActivity("sample_project_loaded", {
      sources: sourcePaths.size,
      clips: clipsWritten,
      images: imagesWritten,
    });

    res.json({
      ok: true,
      sources: sourcePaths.size,
      clips: clipsWritten,
      images: imagesWritten,
      characters: characterIds.size,
    });
  } catch (err) {
    res.status(500).json({ error: publicError(err, "sample load") });
  }
});

export default router;
