import express from "express";
import cors from "cors";
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
import {
  cleanSuppressedTagsInSidecars,
  migrateLegacyLibrary,
} from "./util/migrate.js";
import { rebuildShotlistNow } from "./util/shotlist.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

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
    projectDir: config.projectDir,
    clipsDir: config.clipsDir,
    charactersDir: config.charactersDir,
    imagesDir: config.imagesDir,
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

app.listen(config.port, () => {
  console.log(`[clipper-cowboy] listening on :${config.port}`);
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
