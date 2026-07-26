#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
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

/**
 * `fetch` refuses to override Host, so drive the socket directly. That is the
 * only way to replay what a DNS-rebound page sends: attacker hostname in Host,
 * loopback address on the wire.
 */
function rawRequest(extraHeaders) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/health",
        method: "GET",
        headers: { Accept: "application/json", ...extraHeaders },
        setHost: false,
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      }
    );
    request.on("error", reject);
    request.end();
  });
}

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
  const noTokenPackages = await fetch(
    `http://127.0.0.1:${port}/api/universal-clipper/packages`,
    { redirect: "error" }
  );
  if (noTokenPackages.status !== 401) {
    throw new Error("Universal package APIs bypassed capability auth");
  }
  const traversalPackage = await fetch(
    `http://127.0.0.1:${port}/api/universal-clipper/packages/${encodeURIComponent("../../outside")}`,
    { headers, redirect: "error" }
  );
  if (traversalPackage.status !== 400 && traversalPackage.status !== 404) {
    throw new Error("Universal package API accepted a traversal-shaped package ID");
  }

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
  // A raw Node fs error stringifies with the absolute path it failed on, and
  // that path names the user and their folder layout once it reaches the UI.
  // Provoke a genuine ENOTDIR by asking for a subfolder of a regular file;
  // this only ever touches the smoke fixture, never real project media.
  const blockerDir = path.join(project, "images");
  fs.mkdirSync(blockerDir, { recursive: true });
  fs.writeFileSync(path.join(blockerDir, "blocker"), "not a directory");
  const fsError = await fetch(`http://127.0.0.1:${port}/api/images/folders`, {
    method: "POST", headers, redirect: "error",
    body: JSON.stringify({ path: "blocker/child" }),
  });
  const fsErrorBody = await fsError.text();
  if (fsError.status !== 500) {
    throw new Error(`Expected a filesystem failure, got status ${fsError.status}`);
  }
  if (fsErrorBody.includes("/Users/") || fsErrorBody.includes(project)) {
    throw new Error("An fs error leaked an absolute filesystem path to the client");
  }
  if (!fsErrorBody.includes("child")) {
    throw new Error("Redaction stripped the actionable part of the fs error");
  }

  // DNS rebinding: a page on attacker.test whose DNS points at 127.0.0.1 is
  // same-origin to the browser, so it sends no Origin and CORS never runs.
  // Host is the only header it cannot control.
  const rebound = await rawRequest({
    Host: "attacker.test",
    "x-clipper-api-token": token,
  });
  if (rebound !== 403) {
    throw new Error(`DNS-rebound Host was accepted (status ${rebound})`);
  }
  const foreignOrigin = await rawRequest({
    Host: `127.0.0.1:${port}`,
    Origin: "http://evil.example",
    "x-clipper-api-token": token,
  });
  if (foreignOrigin !== 403) {
    throw new Error(`Cross-site Origin was accepted (status ${foreignOrigin})`);
  }
  // The guard must not cost us the supported local callers: direct loopback,
  // the `localhost` name used by the Vite proxy's changeOrigin rewrite, and
  // that proxy's forwarded browser Origin.
  for (const [label, extra] of [
    ["loopback IP", { Host: `127.0.0.1:${port}` }],
    ["localhost name", { Host: `localhost:${port}` }],
    ["vite dev proxy", { Host: `localhost:${port}`, Origin: "http://localhost:5173" }],
  ]) {
    const status = await rawRequest({ ...extra, "x-clipper-api-token": token });
    if (status !== 200) {
      throw new Error(`Host guard broke a supported local client (${label}: ${status})`);
    }
  }

  process.stdout.write("Security smoke passed: capability auth, package/path containment, atomic export collisions, redacted filesystem errors, and DNS-rebinding/Origin rejection.\n");
} finally {
  stop();
  fs.rmSync(temp, { recursive: true, force: true });
}
