#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const mcpDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = path.resolve(mcpDir, "..");
const require = createRequire(path.join(rootDir, "package.json"));
const ffmpeg = require("ffmpeg-static");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "clipper-mcp-e2e-"));
const project = path.join(temp, "project");
const fakeHome = path.join(temp, "home");
const secret = "clipper-e2e-secret-sentinel";
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(fakeHome, { recursive: true });

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

const generated = spawnSync(ffmpeg, [
  "-y", "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=4",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
  path.join(project, "source.mp4"),
], { encoding: "utf8" });
if (generated.status !== 0) {
  throw new Error(`Could not generate smoke fixture: ${generated.stderr}`);
}

const port = await freePort();
const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === "string"));
Object.assign(env, {
  HOME: fakeHome,
  CLIPPER_ROOT: rootDir,
  CLIPPER_PROJECT_DIR: project,
  CLIPPER_PORT: String(port),
  CLIPPER_AUTOSTART: "true",
  OPENAI_API_KEY: "",
  CLIPPER_E2E_SECRET_TOKEN: secret,
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(mcpDir, "dist", "index.js")],
  env,
  cwd: temp,
  stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
const client = new Client({ name: "clipper-e2e-smoke", version: "1.0.0" });
const transcript = [];
const resultText = (result) => {
  const block = result.content.find((item) => item.type === "text");
  if (!block) throw new Error("Tool returned no text result");
  transcript.push(block.text);
  return JSON.parse(block.text);
};

try {
  await client.connect(transport);
  const before = resultText(await client.callTool({ name: "setup_status", arguments: {} }));
  if (before.service.online) throw new Error("setup_status unexpectedly started the service");

  const summary = resultText(await client.callTool({ name: "project_summary", arguments: {} }));
  if (summary.source_count !== 1) throw new Error(`Expected one source, got ${summary.source_count}`);
  if (summary.openai_configured !== false) throw new Error("Smoke environment unexpectedly loaded an OpenAI key");
  const unauthorized = await fetch(`http://127.0.0.1:${port}/api/health`, { redirect: "error" });
  if (unauthorized.status !== 401) throw new Error("Managed API did not enforce its capability token");

  const derivedVideo = path.join(project, "derived", "stems", "should_not_import_STEMS.mov");
  fs.copyFileSync(path.join(project, "source.mp4"), derivedVideo);

  const sources = resultText(await client.callTool({ name: "list_sources", arguments: {} }));
  if (sources.total !== 1) throw new Error("derived/stems media was incorrectly re-imported as a source");
  const sourceId = sources.items[0]?.source_id;
  if (!sourceId) throw new Error("Source listing did not return an ID");
  const source = resultText(await client.callTool({ name: "get_source", arguments: { source_id: sourceId } }));
  if (source.duration_seconds < 3.9) throw new Error(`Unexpected source duration: ${source.duration_seconds}`);

  const exported = resultText(await client.callTool({ name: "export_clip", arguments: {
    source_id: sourceId,
    in_seconds: 0.5,
    out_seconds: 2.5,
    name: "MCP Smoke Clip",
    tags: ["smoke-test"],
  } }));
  const outputPath = exported.result?.handoff?.input_path;
  const stemsDir = exported.result?.handoff?.suggested_stem_output_dir;
  if (!outputPath || !fs.existsSync(outputPath)) throw new Error("Exported clip was not created");
  // macOS exposes /var as a symlink to /private/var. Resolve the existing
  // project root before constructing this suggested (and not-yet-created) path.
  const expectedStemsDir = path.join(
    fs.realpathSync(project),
    "derived",
    "stems",
    "MCP_Smoke_Clip",
  );
  if (stemsDir !== expectedStemsDir) {
    throw new Error(`Unexpected Stem Studio handoff: ${stemsDir}`);
  }

  const clips = resultText(await client.callTool({ name: "list_clips", arguments: {} }));
  if (clips.total !== 1 || clips.items[0]?.output_path !== outputPath) {
    throw new Error("Exported clip was not returned by list_clips");
  }
  if (`${transcript.join("\n")}\n${stderr}`.includes(secret)) throw new Error("Secret leaked to MCP output");
  process.stdout.write("MCP E2E passed: auto-start, probe, smart-cut, catalog, and Stem Studio handoff.\n");
} finally {
  await client.close().catch(() => {});
  fs.rmSync(temp, { recursive: true, force: true });
}
