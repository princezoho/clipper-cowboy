import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { resolvePoolId } from "./pool.js";

const router = Router();

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
};

router.get("/video/:id", (req, res) => {
  const file = resolvePoolId(req.params.id);
  if (!file || !fs.existsSync(file)) {
    res.status(404).end("not found");
    return;
  }
  const stat = fs.statSync(file);
  const ext = path.extname(file).toLowerCase();
  const mime = MIME[ext] ?? "application/octet-stream";

  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (!m) {
      res.status(416).end();
      return;
    }
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Number(m[2]) : stat.size - 1;
    if (start >= stat.size || end >= stat.size) {
      res.status(416).setHeader("Content-Range", `bytes */${stat.size}`).end();
      return;
    }
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", String(end - start + 1));
    res.setHeader("Content-Type", mime);
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Content-Type", mime);
    res.setHeader("Accept-Ranges", "bytes");
    fs.createReadStream(file).pipe(res);
  }
});

export default router;
