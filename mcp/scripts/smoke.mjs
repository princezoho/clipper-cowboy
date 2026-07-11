#!/usr/bin/env node
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mcpDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = path.resolve(mcpDir, "..");
const entry = path.join(mcpDir, "dist", "index.js");
const secret = "clipper-smoke-secret-sentinel";
const child = spawn(process.execPath, [entry], {
  cwd: os.tmpdir(),
  env: {
    ...process.env,
    CLIPPER_ROOT: rootDir,
    CLIPPER_AUTOSTART: "false",
    OPENAI_API_KEY: secret,
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
let nextId = 1;
let parseFailure;
const pending = new Map();

function fail(message) {
  parseFailure = parseFailure ?? new Error(message);
  for (const { reject } of pending.values()) reject(parseFailure);
  pending.clear();
}

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
  const lines = stdout.split(/\r?\n/);
  stdout = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail(`Non-JSON text appeared on MCP stdout: ${line.slice(0, 200)}`);
      child.kill("SIGTERM");
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    }
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });
child.once("error", fail);
child.once("exit", (code) => {
  if (code && !parseFailure) fail(`MCP process exited early with ${code}: ${stderr.slice(-500)}`);
});

function send(method, params = {}) {
  if (parseFailure) return Promise.reject(parseFailure);
  const id = nextId++;
  const message = { jsonrpc: "2.0", id, method, params };
  child.stdin.write(`${JSON.stringify(message)}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, 10_000);
    pending.set(id, {
      resolve: (result) => { clearTimeout(timer); resolve(result); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
  });
}

function notify(method, params = {}) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

try {
  await send("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "clipper-smoke", version: "1.0.0" },
  });
  notify("notifications/initialized");
  const listed = await send("tools/list");
  const names = listed.tools.map((tool) => tool.name);
  const required = [
    "setup_status", "setup_environment", "project_summary", "list_sources",
    "get_source", "list_clips", "get_clip", "list_metadata_catalogs",
    "export_clip", "update_clip_metadata", "analyze_source_with_openai", "check_job",
  ];
  if (JSON.stringify(names) !== JSON.stringify(required)) {
    throw new Error(`Unexpected tool list: ${names.join(", ")}`);
  }
  const status = await send("tools/call", { name: "setup_status", arguments: {} });
  const invalid = await send("tools/call", {
    name: "get_source",
    arguments: { source_id: "../../.env" },
  });
  if (!invalid.isError) throw new Error("Traversal-shaped source ID was not rejected");
  const transcript = `${JSON.stringify(status)}\n${JSON.stringify(invalid)}\n${stderr}`;
  if (transcript.includes(secret)) throw new Error("Secret sentinel leaked into the MCP transcript");
  if (stdout.trim()) throw new Error(`Partial non-terminated MCP stdout remained: ${stdout.slice(0, 200)}`);
  process.stdout.write(`MCP smoke passed: ${names.length} tools, clean stdio, traversal rejected, secret redacted.\n`);
} finally {
  child.stdin.end();
  child.kill("SIGTERM");
}
