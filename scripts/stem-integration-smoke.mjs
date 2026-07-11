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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "clipper-stem-smoke-"));
const project = path.join(temp, "project");
const home = path.join(temp, "home");
const fakeRoot = path.join(temp, "stem-studio");
const fakeEntry = path.join(fakeRoot, "mcp", "dist", "index.js");
const capability = "stem-smoke-capability";

fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(path.dirname(fakeEntry), { recursive: true });
fs.writeFileSync(
  path.join(fakeRoot, "package.json"),
  JSON.stringify({ name: "stem-studio", private: true })
);
fs.writeFileSync(
  path.join(fakeRoot, "mcp", "package.json"),
  JSON.stringify({ name: "stem-studio-mcp", type: "module", private: true })
);
fs.copyFileSync(path.join(root, "scripts", "fixtures", "fake-stem-mcp.mjs"), fakeEntry);

const ffmpeg = require("ffmpeg-static");
const fixture = path.join(project, "source.mp4");
const generated = spawnSync(
  ffmpeg,
  [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=160x120:d=2",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
    "-shortest",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    fixture,
  ],
  { encoding: "utf8" }
);
if (generated.status !== 0) {
  throw new Error(`Could not create stem smoke fixture: ${generated.stderr}`);
}

const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.unref();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    const selected = typeof address === "object" && address ? address.port : 0;
    probe.close((error) => (error ? reject(error) : resolve(selected)));
  });
});

const server = spawn(
  process.execPath,
  ["--import", "tsx", path.join(root, "server", "index.ts")],
  {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      PROJECT_DIR: project,
      PORT: String(port),
      OPENAI_API_KEY: "stem-smoke-openai-sentinel",
      CLIPPER_API_TOKEN: capability,
      CLIPPER_STEM_STUDIO_ROOT: fakeRoot,
      CLIPPER_STEM_STUDIO_PYTHON: "",
      CLIPPER_STEM_STUDIO_CACHE: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  }
);
let logs = "";
server.stdout.on("data", (chunk) => {
  logs += String(chunk);
});
server.stderr.on("data", (chunk) => {
  logs += String(chunk);
});

const headers = {
  Accept: "application/json",
  "Content-Type": "application/json",
  "x-clipper-api-token": capability,
};

function stop() {
  try {
    if (process.platform !== "win32" && server.pid) {
      process.kill(-server.pid, "SIGTERM");
    } else {
      server.kill("SIGTERM");
    }
  } catch {
    // already stopped
  }
}

try {
  let healthy = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        headers,
      });
      if (response.ok) {
        healthy = true;
        break;
      }
    } catch {
      // starting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!healthy) throw new Error(`Smoke server did not start: ${logs.slice(-500)}`);

  const poolResponse = await fetch(`http://127.0.0.1:${port}/api/pool`, { headers });
  const pool = await poolResponse.json();
  const sourceId = pool.items?.find((item) => item.filename === "source.mp4")?.id;
  if (!sourceId) throw new Error("Stem smoke source was not indexed");

  const startedAt = Date.now();
  const exportedResponse = await fetch(`http://127.0.0.1:${port}/api/export`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      sourceId,
      in: 0,
      out: 1,
      name: "Background Stem Smoke",
      description: "",
      tags: [],
      characters: [],
      scenes: [],
      objects: [],
      mode: "clip",
      stems: { quality: "fast" },
    }),
  });
  const elapsed = Date.now() - startedAt;
  const exported = await exportedResponse.json();
  if (!exportedResponse.ok || !exported.stemJob?.id) {
    throw new Error(`Export did not queue stems: ${JSON.stringify(exported)}`);
  }
  if (elapsed >= 2_500) {
    throw new Error(`Export waited for the background setup (${elapsed}ms)`);
  }
  if (!fs.existsSync(exported.path)) throw new Error("Exported clip is missing");

  let job;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/stem-jobs/${exported.stemJob.id}`,
      { headers }
    );
    job = await response.json();
    if (job.status === "done" || job.status === "error") break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (job?.status !== "done") {
    throw new Error(`Stem job did not complete: ${JSON.stringify(job)}`);
  }
  const realStems = fs.realpathSync(path.join(project, "derived", "stems"));
  const realOutput = fs.realpathSync(job.outputDir);
  const relative = path.relative(realStems, realOutput);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Published stem folder escaped derived/stems");
  }
  const entries = fs.readdirSync(realOutput).sort();
  const expectedSuffixes = [
    "_DIALOGUE.wav",
    "_MARRIED.wav",
    "_MUSIC.wav",
    "_SFX.wav",
    "_STEMS.mov",
  ];
  for (const suffix of expectedSuffixes) {
    const match = entries.find((entry) => entry.endsWith(suffix));
    if (!match || fs.statSync(path.join(realOutput, match)).size <= 0) {
      throw new Error(`Missing published ${suffix}`);
    }
  }
  if (!entries.includes("manifest.json")) throw new Error("Stem manifest is missing");
  if (fs.existsSync(path.join(realStems, ".jobs", exported.stemJob.id))) {
    throw new Error("Private staging directory was not cleaned up");
  }
  const listedResponse = await fetch(`http://127.0.0.1:${port}/api/stem-jobs`, {
    headers,
  });
  const listed = await listedResponse.json();
  if (!listed.items?.some((item) => item.id === job.id && item.status === "done")) {
    throw new Error("Completed stem job was not listed");
  }
  process.stdout.write(
    `Stem integration smoke passed: export returned in ${elapsed}ms; isolated background job published 5 media files.\n`
  );
} finally {
  stop();
  await new Promise((resolve) => {
    if (server.exitCode !== null || server.signalCode !== null) resolve();
    else {
      const timer = setTimeout(resolve, 2_000);
      server.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    }
  });
  fs.rmSync(temp, { recursive: true, force: true });
}
