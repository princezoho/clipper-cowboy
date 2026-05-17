import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { config } from "../config.js";

const router = Router();

const ENV_PATH = path.resolve(process.cwd(), ".env");

const Body = z.object({
  projectDir: z.string().optional(),
  openaiApiKey: z.string().optional(),
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
  const known = ["OPENAI_API_KEY", "PROJECT_DIR", "PORT"];
  const lines: string[] = [];
  for (const k of known) {
    if (k in values) lines.push(`${k}=${values[k] ?? ""}`);
  }
  for (const k of Object.keys(values)) {
    if (!known.includes(k)) lines.push(`${k}=${values[k] ?? ""}`);
  }
  fs.writeFileSync(ENV_PATH, lines.join("\n") + "\n");
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
  writeEnvFile(env);

  res.json({
    ok: true,
    note: "Saved. Restart the dev server (Ctrl+C, npm run dev) to apply.",
    current: {
      projectDir: config.projectDir,
      hasOpenAIKey: Boolean(config.openaiApiKey),
    },
  });
});

export default router;
