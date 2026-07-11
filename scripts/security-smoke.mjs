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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "clipper-security-smoke-"));
const project = path.join(temp, "project");
const home = path.join(temp, "home");
const victim = path.join(temp, "outside-victim.mp4");
const token = "security-smoke-capability";
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(victim, "must survive");
const ffmpeg = require("ffmpeg-static");
const generated = spawnSync(ffmpeg, [
  "-y", "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "color=c=red:s=160x120:d=2",
  "-c:v", "libx264", "-pix_fmt", "yuv420p",
  path.join(project, "source.mp4"),
], { encoding: "utf8" });
if (generated.status !== 0) throw new Error(`Could not create security fixture: ${generated.stderr}`);

const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.unref();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    const selected = typeof address === "object" && address ? address.port : 0;
    probe.close((error) => error ? reject(error) : resolve(selected));
  });
});

const child = spawn(process.execPath, ["--import", "tsx", path.join(root, "server", "index.ts")], {
  cwd: root,
  env: {
    ...process.env,
    HOME: home,
    PROJECT_DIR: project,
    PORT: String(port),
    OPENAI_API_KEY: "",
    CLIPPER_API_TOKEN: token,
  },
  stdio: ["ignore", "pipe", "pipe"],
  detached: process.platform !== "win32",
});
let logs = "";
child.stdout.on("data", (chunk) => { logs += String(chunk); });
child.stderr.on("data", (chunk) => { logs += String(chunk); });
const headers = {
  Accept: "application/json",
  "Content-Type": "application/json",
  "x-clipper-api-token": token,
};

function stop() {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    // already stopped
  }
}

try {
  let healthy = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { headers, redirect: "error" });
      if (response.ok) { healthy = true; break; }
    } catch {
      // starting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!healthy) throw new Error(`Security smoke server failed to start: ${logs.slice(-500)}`);

  const id = "0123456789abcdef";
  const sidecarDir = path.join(project, ".clipcataloger", "clip-meta");
  fs.mkdirSync(sidecarDir, { recursive: true });
  fs.writeFileSync(path.join(sidecarDir, `${id}.json`), JSON.stringify({
    id,
    name: "Malicious sidecar",
    description: "",
    tags: [],
    filename: path.basename(victim),
    path: victim,
    created: Date.now(),
  }));

  const deletion = await fetch(`http://127.0.0.1:${port}/api/library/${id}`, {
    method: "DELETE", headers, redirect: "error",
  });
  if (deletion.status !== 409 || !fs.existsSync(victim)) {
    throw new Error("A malicious sidecar escaped the clips directory during delete");
  }

  const trash = await fetch(`http://127.0.0.1:${port}/api/library/orphans/trash`, {
    method: "POST", headers, redirect: "error", body: JSON.stringify({ paths: [victim] }),
  });
  const trashBody = await trash.json();
  if (!trash.ok || trashBody.trashed !== 0 || !fs.existsSync(victim)) {
    throw new Error("Orphan trash accepted a path outside clips/");
  }

  const reveal = await fetch(`http://127.0.0.1:${port}/api/reveal`, {
    method: "POST", headers, redirect: "error", body: JSON.stringify({ path: victim }),
  });
  if (reveal.status !== 410) throw new Error("Reveal accepted a path outside the project");

  const noToken = await fetch(`http://127.0.0.1:${port}/api/health`, { redirect: "error" });
  if (noToken.status !== 401) throw new Error("Capability token was not enforced");

  const poolResponse = await fetch(`http://127.0.0.1:${port}/api/pool`, { headers, redirect: "error" });
  const pool = await poolResponse.json();
  const sourceId = pool.items.find((item) => item.filename === "source.mp4")?.id;
  if (!sourceId) throw new Error("Security fixture source was not indexed");
  const exportBody = JSON.stringify({
    sourceId, in: 0, out: 1, name: "Concurrent Export", description: "",
    tags: [], characters: [], scenes: [], objects: [], mode: "clip",
  });
  const [firstExport, secondExport] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/api/export`, { method: "POST", headers, body: exportBody, redirect: "error" }),
    fetch(`http://127.0.0.1:${port}/api/export`, { method: "POST", headers, body: exportBody, redirect: "error" }),
  ]);
  if (!firstExport.ok || !secondExport.ok) throw new Error("Concurrent export request failed");
  const [firstMeta, secondMeta] = await Promise.all([firstExport.json(), secondExport.json()]);
  if (firstMeta.path === secondMeta.path || !fs.existsSync(firstMeta.path) || !fs.existsSync(secondMeta.path)) {
    throw new Error("Concurrent exports did not reserve distinct output files");
  }
  process.stdout.write("Security smoke passed: capability auth, path containment, and atomic export collisions.\n");
} finally {
  stop();
  fs.rmSync(temp, { recursive: true, force: true });
}
