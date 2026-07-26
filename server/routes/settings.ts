import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { config, reloadConfig } from "../config.js";
import { publicError } from "../util/publicError.js";
import { bootstrapProjectDir } from "../util/projectBootstrap.js";
import { roundupInventory } from "../util/roundupInventory.js";
import { roundupWatcher } from "../util/roundupWatcher.js";
import { universalStemManager } from "../stems/universalManager.js";

const router = Router();
const ENV_PATH = path.resolve(process.cwd(), ".env");

/** Exact wording of the manual fallback, so the UI never has to guess. */
const RESTART_NOTE =
  "Saved to .env. Stop the app in its terminal with Ctrl+C and start it again " +
  "(`npm start`) to use the new project folder.";

const Body = z.object({
  projectDir: z.string().max(4096).refine((v) => !/[\r\n]/.test(v), {
    message: "projectDir must be a single line",
  }).optional(),
  openaiApiKey: z.string().max(4096).refine((v) => !/[\r\n]/.test(v), {
    message: "openaiApiKey must be a single line",
  }).optional(),
});

function expandHome(p: string): string {
  if (!p) return p;
  if (p === "~" || p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

function readEnvFile(): Record<string, string> {
  if (!fs.existsSync(ENV_PATH)) return {};
  const content = fs.readFileSync(ENV_PATH, "utf8");
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function writeEnvFile(values: Record<string, string>) {
  const known = [
    "OPENAI_API_KEY",
    "PROJECT_DIR",
    "PORT",
  ];
  const lines: string[] = [];
  for (const k of known) {
    if (k in values) lines.push(`${k}=${values[k] ?? ""}`);
  }
  for (const k of Object.keys(values)) {
    if (!known.includes(k)) lines.push(`${k}=${values[k] ?? ""}`);
  }
  fs.writeFileSync(ENV_PATH, lines.join("\n") + "\n", { mode: 0o600 });
  // Existing files keep their previous mode when overwritten, so enforce it.
  fs.chmodSync(ENV_PATH, 0o600);
}

/**
 * Validate a filesystem path from the first-run wizard. Returns:
 *   - expanded:  the path after ~ expansion (so the UI can echo it back)
 *   - exists:    does anything live there right now?
 *   - isDir:     if it exists, is it a directory?
 *   - canCreate: if it doesn't exist, would mkdir -p succeed? (parent is
 *                a writable existing directory)
 */
router.get("/fs/check", (req, res) => {
  const raw = String(req.query.path ?? "").trim();
  if (!raw) {
    res.status(400).json({ error: "missing path" });
    return;
  }
  const expanded = path.resolve(expandHome(raw));
  let exists = false;
  let isDir = false;
  let canCreate = false;
  try {
    const st = fs.statSync(expanded);
    exists = true;
    isDir = st.isDirectory();
  } catch {
    // Doesn't exist — check whether the nearest existing ancestor is writable.
    let cursor = path.dirname(expanded);
    // Walk up to find the first existing ancestor.
    while (cursor && cursor !== path.dirname(cursor)) {
      try {
        const st = fs.statSync(cursor);
        if (st.isDirectory()) {
          try {
            fs.accessSync(cursor, fs.constants.W_OK);
            canCreate = true;
          } catch {
            canCreate = false;
          }
          break;
        }
        break;
      } catch {
        cursor = path.dirname(cursor);
      }
    }
  }
  res.json({ expanded, exists, isDir, canCreate });
});

/**
 * Whether the running process can safely adopt `nextProjectDir` without a
 * restart. `null` means PROJECT_DIR is being cleared, which sends the process
 * back to the built-in default — still a folder move.
 *
 * Moving the project folder retargets every path the server derives from it, so
 * it is only allowed while nothing can be pointing at the old one: the first-run
 * transition, before any folder was configured and before any job could have
 * started. Anything else keeps the current folder and gets the explicit restart
 * instruction instead.
 */
function canAdoptProjectDir(nextProjectDir: string | null): boolean {
  if (nextProjectDir !== null && nextProjectDir === config.projectDir) return true;
  if (nextProjectDir === null && !config.projectDirConfigured) return true;
  if (config.projectDirConfigured) return false;
  return !roundupInventory.hasActiveJobs() && !universalStemManager.hasActiveJobs();
}

/**
 * Re-point `process.env` at the requested values and rebuild the derived config
 * in place, so /api/health and every route agree immediately. Returns false when
 * nothing could be applied, leaving the process exactly as it was.
 *
 * Only what the caller passes is applied. In particular a key-only save must not
 * pick up a PROJECT_DIR that is sitting in .env awaiting a restart, which would
 * move the project folder behind the gate's back.
 */
function applyInProcess(patch: {
  PROJECT_DIR?: string;
  OPENAI_API_KEY?: string;
}): boolean {
  const previous = {
    PROJECT_DIR: process.env.PROJECT_DIR,
    POOL_DIR: process.env.POOL_DIR,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  if (patch.PROJECT_DIR !== undefined) {
    process.env.PROJECT_DIR = patch.PROJECT_DIR;
    // A stale legacy value must not be able to win a later resolution pass.
    delete process.env.POOL_DIR;
  }
  if (patch.OPENAI_API_KEY !== undefined) {
    process.env.OPENAI_API_KEY = patch.OPENAI_API_KEY;
  }
  try {
    reloadConfig();
    return true;
  } catch {
    // The new folder could not be prepared. Put the environment back so the
    // process keeps serving the folder it already had.
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return false;
  }
}

router.get("/settings", (_req, res) => {
  // `savedProjectDir` is what .env holds, which is what the first-run wizard
  // should echo back rather than falling back to the built-in default. The key
  // itself is never returned.
  const env = readEnvFile();
  res.json({
    projectDir: config.projectDir,
    projectDirConfigured: config.projectDirConfigured,
    savedProjectDir: (env.PROJECT_DIR ?? env.POOL_DIR ?? "").trim() || null,
    hasOpenAIKey: Boolean(config.openaiApiKey),
  });
});

router.post("/settings", async (req, res) => {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const env = readEnvFile();
  const patch: { PROJECT_DIR?: string; OPENAI_API_KEY?: string } = {};
  let requestedProjectDir: string | null = null;
  if (parsed.data.projectDir !== undefined) {
    const p = expandHome(parsed.data.projectDir.trim());
    if (p) {
      try {
        fs.mkdirSync(p, { recursive: true });
      } catch (err) {
        res.status(400).json({
          error: `Could not create PROJECT_DIR: ${publicError(err, "settings:mkdir")}`,
        });
        return;
      }
      requestedProjectDir = path.resolve(p);
    }
    env.PROJECT_DIR = p;
    patch.PROJECT_DIR = p;
    // Drop legacy keys so they don't override on next boot.
    delete env.POOL_DIR;
    delete env.LIBRARY_DIR;
    delete env.CHARACTERS_DIR;
  }
  if (parsed.data.openaiApiKey !== undefined) {
    env.OPENAI_API_KEY = parsed.data.openaiApiKey.trim();
    patch.OPENAI_API_KEY = env.OPENAI_API_KEY;
  }
  writeEnvFile(env);

  const previousProjectDir = config.projectDir;
  const movingProjectDir =
    patch.PROJECT_DIR !== undefined && requestedProjectDir !== previousProjectDir;
  let applied = false;
  if (patch.PROJECT_DIR === undefined || canAdoptProjectDir(requestedProjectDir)) {
    applied = applyInProcess(patch);
  }

  if (applied && config.projectDir !== previousProjectDir) {
    // Give the newly adopted folder the same treatment a restart would.
    bootstrapProjectDir();
    // The watcher holds chokidar handles on the old roots; a restart rebinds it
    // to the new project folder and re-reads that folder's own approvals.
    try {
      await roundupWatcher.restart();
    } catch (err) {
      console.error("[roundup-watcher] restart after settings save failed:", err);
    }
  }

  res.json({
    ok: true,
    applied,
    ...(applied
      ? {}
      : {
          note: RESTART_NOTE,
          restartRequired: true,
          ...(movingProjectDir ? { pendingProjectDir: env.PROJECT_DIR } : {}),
        }),
    current: {
      projectDir: config.projectDir,
      projectDirConfigured: config.projectDirConfigured,
      hasOpenAIKey: Boolean(config.openaiApiKey),
    },
  });
});

export default router;
