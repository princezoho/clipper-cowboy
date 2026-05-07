import express from "express";
import cors from "cors";
import { config } from "./config.js";
import poolRouter from "./routes/pool.js";
import videoRouter from "./routes/video.js";
import scenesRouter from "./routes/scenes.js";
import captionRouter from "./routes/caption.js";
import exportRouter from "./routes/export.js";
import libraryRouter from "./routes/library.js";
import settingsRouter from "./routes/settings.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    poolDir: config.poolDir,
    libraryDir: config.libraryDir,
    hasOpenAIKey: Boolean(config.openaiApiKey),
  });
});

app.use("/api", poolRouter);
app.use("/api", videoRouter);
app.use("/api", scenesRouter);
app.use("/api", captionRouter);
app.use("/api", exportRouter);
app.use("/api", libraryRouter);
app.use("/api", settingsRouter);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: String(err) });
});

app.listen(config.port, () => {
  console.log(`[clip-cataloger] api on :${config.port}`);
  console.log(`  POOL_DIR    = ${config.poolDir}`);
  console.log(`  LIBRARY_DIR = ${config.libraryDir}`);
  console.log(`  OpenAI key  = ${config.openaiApiKey ? "set" : "(missing)"}`);
});
