#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "clipper-audio-smoke-"));
const project = path.join(temp, "project");
const fakePython = path.join(temp, "fake-python");
fs.mkdirSync(project, { recursive: true });

// Test-only injected executable: mirrors the upstream worker's output contract
// without downloading Python packages or models.
fs.writeFileSync(fakePython, `#!/bin/sh
if [ "$1" != "-m" ] || [ "$2" != "stemstudio_worker.separate" ]; then exit 64; fi
out=""
input=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--outdir" ]; then out="$2"; shift 2; continue; fi
  if [ "$1" = "--input" ]; then input="$2"; shift 2; continue; fi
  shift
done
mkdir -p "$out"
ffmpeg -y -hide_banner -loglevel error -i "$input" -vn -c:a pcm_s16le "$out/dialogue.wav"
cp "$out/dialogue.wav" "$out/music.wav"
cp "$out/dialogue.wav" "$out/effects.wav"
`);
fs.chmodSync(fakePython, 0o755);

const ffmpeg = require("ffmpeg-static");
const fixture = path.join(project, "source.mp4");
const generated = spawnSync(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x120:d=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", fixture]);
if (generated.status !== 0) throw new Error("Could not create audio smoke fixture.");

const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    probe.close(() => resolve(address.port));
  });
});
const token = "audio-smoke-token";
const server = spawn(process.execPath, ["--import", "tsx", path.join(root, "server", "index.ts")], {
  cwd: root,
  env: { ...process.env, NODE_ENV: "test", PROJECT_DIR: project, PORT: String(port), CLIPPER_API_TOKEN: token, CLIPPER_AUDIO_ENGINE_TEST_PYTHON: fakePython },
  stdio: "ignore",
});
const headers = { "Content-Type": "application/json", "x-clipper-api-token": token };
const url = (pathname) => `http://127.0.0.1:${port}/api${pathname}`;
try {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(url("/health"), { headers })).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const status = await (await fetch(url("/audio-engine/status"), { headers })).json();
  if (!status.ready) throw new Error("Injected managed audio engine was not ready.");
  const pool = await (await fetch(url("/pool"), { headers })).json();
  const sourceId = pool.items?.find((item) => item.filename === "source.mp4")?.id;
  if (!sourceId) throw new Error("Fixture was not indexed.");
  const exported = await (await fetch(url("/export"), {
    method: "POST", headers,
    body: JSON.stringify({ sourceId, in: 0, out: 0.8, name: "Audio Smoke", description: "", tags: [], characters: [], scenes: [], objects: [], mode: "clip", stems: { quality: "fast" } }),
  })).json();
  if (!exported.stemJob?.id) throw new Error("Export did not queue audio splitting.");
  let job;
  for (let i = 0; i < 80; i++) {
    job = await (await fetch(url(`/stem-jobs/${exported.stemJob.id}`), { headers })).json();
    if (job.status === "done" || job.status === "error") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (job?.status !== "done") throw new Error(`Audio job failed: ${job?.error ?? "unknown"}`);
  const entries = fs.readdirSync(job.outputDir);
  for (const suffix of ["_DIALOGUE.wav", "_MUSIC.wav", "_SFX.wav", "_MARRIED.wav"]) {
    if (!entries.some((entry) => entry.endsWith(suffix))) throw new Error(`Missing ${suffix}`);
  }
  process.stdout.write("Managed audio engine smoke passed.\n");
} finally {
  server.kill("SIGTERM");
  fs.rmSync(temp, { recursive: true, force: true });
}
