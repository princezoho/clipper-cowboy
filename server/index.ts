import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import poolRouter from "./routes/pool.js";
import videoRouter from "./routes/video.js";
import captionRouter from "./routes/caption.js";
import exportRouter from "./routes/export.js";
import libraryRouter from "./routes/library.js";
import settingsRouter from "./routes/settings.js";
import charactersRouter from "./routes/characters.js";
import { scenesRouter, objectsRouter } from "./routes/entities.js";
import exportCollectionRouter from "./routes/exportCollection.js";
import draftsRouter from "./routes/drafts.js";
import activityRouter from "./routes/activity.js";
import imagesRouter from "./routes/images.js";
import poolAnalyzeRouter from "./routes/poolAnalyze.js";
import poolOrganizeRouter from "./routes/poolOrganize.js";
import stemsRouter from "./routes/stems.js";
import {
  cleanSuppressedTagsInSidecars,
  migrateLegacyLibrary,
} from "./util/migrate.js";
import { rebuildShotlistNow } from "./util/shotlist.js";
import { stemJobManager } from "./stems/manager.js";

const app = express();

const allowedOrigins = new Set([
  `http://127.0.0.1:${config.port}`,
  `http://localhost:${config.port}`,
  "http://127.0.0.1:5173",
  "http://localhost:5173",
]);

app.use(
  cors({
    origin(origin, callback) {
      // Requests without Origin are local clients such as curl and desktop
      // launchers. Browser requests must come from this app's own UI.
      callback(null, !origin || allowedOrigins.has(origin));
    },
  })
);
app.use(express.json({ limit: "1mb" }));

// MCP-managed servers receive a random capability token. Normal interactive
// launches omit it and retain the browser UI flow. This prevents unrelated
// local processes from invoking broad filesystem/AI routes on a headless
// server that an agent started automatically.
const apiToken = (process.env.CLIPPER_API_TOKEN ?? "").trim();
if (apiToken) {
  app.use("/api", (req, res, next) => {
    const provided = req.get("x-clipper-api-token") ?? "";
    const expectedBytes = Buffer.from(apiToken);
    const providedBytes = Buffer.from(provided);
    if (
      expectedBytes.length !== providedBytes.length ||
      !crypto.timingSafeEqual(expectedBytes, providedBytes)
    ) {
      res.status(401).json({ error: "unauthorized local API client" });
      return;
    }
    next();
  });
}

app.get("/api/health", (_req, res) => {
  // `projectDirConfigured` is true iff the user has explicitly pointed the
  // app at a folder (PROJECT_DIR / POOL_DIR set in .env). When false, the UI
  // renders the first-run onboarding screen instead of the empty pool grid.
  const projectDirConfigured = Boolean(
    (process.env.PROJECT_DIR ?? "").trim() ||
      (process.env.POOL_DIR ?? "").trim()
  );
  res.json({
    ok: true,
    service: "clipper-cowboy",
    apiVersion: 1,
    projectDir: config.projectDir,
    clipsDir: config.clipsDir,
    charactersDir: config.charactersDir,
    imagesDir: config.imagesDir,
    derivedDir: config.derivedDir,
    stemsDir: config.stemsDir,
    shotlistMd: config.shotlistMdPath,
    shotlistCsv: config.shotlistCsvPath,
    hasOpenAIKey: Boolean(config.openaiApiKey),
    projectDirConfigured,
  });
});

app.use("/api", poolRouter);
app.use("/api", videoRouter);
app.use("/api", captionRouter);
app.use("/api", exportRouter);
app.use("/api", libraryRouter);
app.use("/api", settingsRouter);
app.use("/api", charactersRouter);
app.use("/api", scenesRouter);
app.use("/api", objectsRouter);
app.use("/api", exportCollectionRouter);
app.use("/api", draftsRouter);
app.use("/api", activityRouter);
app.use("/api", imagesRouter);
app.use("/api", poolAnalyzeRouter);
app.use("/api", poolOrganizeRouter);
app.use("/api", stemsRouter);

// In production, serve the built React UI from dist/ on the same port as the
// API. Lets `npm start` run the whole app as one process — no Vite needed.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, "..", "dist");
const hasBuiltUI = fs.existsSync(path.join(distDir, "index.html"));

if (hasBuiltUI) {
  app.use(express.static(distDir, { index: false, maxAge: "1h" }));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
}

app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
);

const httpServer = app.listen(config.port, config.host, () => {
  console.log(
    `[clipper-cowboy] listening on http://${config.host}:${config.port}`
  );
  if (hasBuiltUI) {
    console.log(`  open http://localhost:${config.port}`);
  } else {
    console.log(`  api only — run \`npm run dev\` for the UI on :5173`);
  }
  console.log(`  PROJECT_DIR = ${config.projectDir}`);
  console.log(`  clips/      = ${config.clipsDir}`);
  console.log(`  characters/ = ${config.charactersDir}`);
  console.log(`  images/     = ${config.imagesDir}`);
  console.log(`  OpenAI key  = ${config.openaiApiKey ? "set" : "(missing)"}`);

  try {
    migrateLegacyLibrary();
  } catch (err) {
    console.error("[migrate] failed:", err);
  }
  try {
    cleanSuppressedTagsInSidecars();
  } catch (err) {
    console.error("[migrate] tag cleanup failed:", err);
  }
  try {
    rebuildShotlistNow();
  } catch (err) {
    console.error("[shotlist] initial build failed:", err);
  }
});

let stopping = false;
function stop(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  void stemJobManager.shutdown().finally(() => {
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1_000).unref();
  });
  console.log(`[clipper-cowboy] stopping after ${signal}`);
}
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
