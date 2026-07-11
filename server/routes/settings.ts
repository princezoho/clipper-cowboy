import { Router, type Response } from "express";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { z } from "zod";
import {
  config,
  repairStemStudioConfigArtifact,
  setStemStudioRoot,
  StemStudioConfigError,
} from "../config.js";
import {
  discoverStemStudioInstallations,
  getDiscoveredStemStudioInstallation,
  stemStudioFolderMessage,
  validateStemStudioInstallation,
} from "../stems/installation.js";
import { stemJobManager } from "../stems/manager.js";

const router = Router();
const execFileAsync = promisify(execFile);

const ENV_PATH = path.resolve(process.cwd(), ".env");

const Body = z.object({
  projectDir: z.string().max(4096).refine((v) => !/[\r\n]/.test(v), {
    message: "projectDir must be a single line",
  }).optional(),
  openaiApiKey: z.string().max(4096).refine((v) => !/[\r\n]/.test(v), {
    message: "openaiApiKey must be a single line",
  }).optional(),
  stemStudioRoot: z.string().max(4096).refine((v) => !/[\r\n]/.test(v), {
    message: "stemStudioRoot must be a single line",
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
    "CLIPPER_STEM_STUDIO_ROOT",
    "CLIPPER_STEM_STUDIO_PYTHON",
    "CLIPPER_STEM_STUDIO_CACHE",
    "CLIPPER_STEMS_TIMEOUT_MINUTES",
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
 * The browser cannot reveal an absolute directory selected through a folder
 * input. On macOS, use the native chooser instead, then record only a
 * checkout that has Stem Studio's expected package markers. Selecting a folder
 * is an explicit trust decision; nothing from it is launched here.
 */
router.get("/stem-studio/candidates", (_req, res) => {
  res.json({ candidates: discoverStemStudioInstallations() });
});

function stemStudioSaveError(error: unknown): { code?: string; message: string } {
  if (error instanceof StemStudioConfigError) {
    return { code: error.code, message: error.message };
  }
  return {
    message: "Clipper could not save the Stem Studio setup. Check the folder and try again.",
  };
}

async function saveStemStudioRoot(root: string, res: Response): Promise<void> {
  try {
    setStemStudioRoot(root);
    res.json({ ok: true, status: await stemJobManager.inspectStudio() });
  } catch (error) {
    res.status(409).json({ error: stemStudioSaveError(error) });
  }
}

router.post("/stem-studio/use-candidate", async (req, res) => {
  const parsed = z.object({ id: z.string().min(1).max(128) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Choose a Stem Studio installation to use." });
    return;
  }
  const installation = getDiscoveredStemStudioInstallation(parsed.data.id);
  if (!installation) {
    res.status(400).json({
      error: "That Stem Studio installation is no longer available. Choose its folder again.",
    });
    return;
  }
  await saveStemStudioRoot(installation.root, res);
});

router.post("/stem-studio/repair-config", (_req, res) => {
  try {
    repairStemStudioConfigArtifact();
    res.json({ ok: true });
  } catch {
    res.status(409).json({
      error: {
        message:
          "Clipper could not safely repair the old Stem Studio setup artifact. Review it in the project folder, then try again.",
      },
    });
  }
});

router.post("/stem-studio/select-folder", async (_req, res) => {
  if (process.platform !== "darwin") {
    res.status(501).json({
      error: "Choose the official Stem Studio folder in Audio splitting setup.",
    });
    return;
  }
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", [
      "-e",
      'POSIX path of (choose folder with prompt "Select your trusted Stem Studio folder")',
    ]);
    const root = path.resolve(stdout.trim());
    let installation;
    try {
      installation = validateStemStudioInstallation(root);
    } catch {
      res.status(400).json({ error: stemStudioFolderMessage(root) });
      return;
    }
    await saveStemStudioRoot(installation.root, res);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException & { code?: number }).code;
    if (code === 1) {
      res.status(409).json({ error: "Folder selection was cancelled." });
      return;
    }
    res.status(400).json({ error: stemStudioFolderMessage("") });
  }
});

router.post("/settings", (req, res) => {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const env = readEnvFile();
  if (parsed.data.projectDir !== undefined) {
    const p = expandHome(parsed.data.projectDir.trim());
    if (p) {
      try {
        fs.mkdirSync(p, { recursive: true });
      } catch (err) {
        res.status(400).json({ error: `Could not create PROJECT_DIR: ${err}` });
        return;
      }
    }
    env.PROJECT_DIR = p;
    // Drop legacy keys so they don't override on next boot.
    delete env.POOL_DIR;
    delete env.LIBRARY_DIR;
    delete env.CHARACTERS_DIR;
  }
  if (parsed.data.openaiApiKey !== undefined) {
    env.OPENAI_API_KEY = parsed.data.openaiApiKey.trim();
  }
  if (parsed.data.stemStudioRoot !== undefined) {
    env.CLIPPER_STEM_STUDIO_ROOT = expandHome(
      parsed.data.stemStudioRoot.trim()
    );
  }
  writeEnvFile(env);

  res.json({
    ok: true,
    note: "Saved. Restart the dev server (Ctrl+C, npm run dev) to apply.",
    current: {
      projectDir: config.projectDir,
      hasOpenAIKey: Boolean(config.openaiApiKey),
      stemStudioConfigured: config.stemStudioConfigured,
    },
  });
});

export default router;
