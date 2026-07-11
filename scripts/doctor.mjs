#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const checks = [];

function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
check("Node 20+", nodeMajor >= 20, process.versions.node);
check("Repository", fs.existsSync(path.join(root, "server", "index.ts")), root);
check("Root dependencies", fs.existsSync(path.join(root, "node_modules", "tsx", "package.json")), "npm install");
check("UI build", fs.existsSync(path.join(root, "dist", "index.html")), "npm run build");
check("MCP build", fs.existsSync(path.join(root, "mcp", "dist", "index.js")), "npm run mcp:build");

try {
  const ffmpeg = require("ffmpeg-static");
  check("Bundled ffmpeg", typeof ffmpeg === "string" && fs.existsSync(ffmpeg), String(ffmpeg));
} catch {
  check("Bundled ffmpeg", false, "ffmpeg-static could not be resolved");
}
try {
  const ffprobe = require("ffprobe-static");
  check("Bundled ffprobe", typeof ffprobe?.path === "string" && fs.existsSync(ffprobe.path), String(ffprobe?.path));
} catch {
  check("Bundled ffprobe", false, "ffprobe-static could not be resolved");
}

for (const item of checks) {
  process.stdout.write(`${item.ok ? "OK" : "FAIL"}  ${item.name}: ${item.detail}\n`);
}
if (checks.some((item) => !item.ok)) process.exitCode = 1;
else process.stdout.write("Clipper Cowboy is ready for local UI and MCP use.\n");
