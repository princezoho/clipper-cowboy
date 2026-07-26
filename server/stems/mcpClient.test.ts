import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  StemMcpClient,
  buildStemMcpEnvironment,
  resolveStemMcpConfig,
  validateStemMcpEntry,
} from "./mcpClient.js";

const root = process.cwd();
const fake = path.join(root, "scripts", "fixtures", "fake-stem-mcp.mjs");
const bad = path.join(root, "scripts", "fixtures", "fake-stem-mcp-bad.mjs");
const fixture = fs.mkdtempSync(
  path.join(os.tmpdir(), "clipper-stem-client-test-")
);

test.after(() => {
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("builds a fixed child environment without credentials or proxies", () => {
  const env = buildStemMcpEnvironment({
    PATH: "/bin",
    HOME: "/tmp/home",
    STEMSTUDIO_CACHE: "/tmp/cache",
    OPENAI_API_KEY: "sk_should_never_escape",
    CLIPPER_API_TOKEN: "local-secret",
    HTTP_PROXY: "http://proxy.invalid",
    HTTPS_PROXY: "http://proxy.invalid",
    ALL_PROXY: "socks://proxy.invalid",
  });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/tmp/home");
  assert.equal(env.STEMSTUDIO_CACHE, "/tmp/cache");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CLIPPER_API_TOKEN, undefined);
  assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.ALL_PROXY, undefined);
  assert.equal(env.HF_HUB_OFFLINE, "1");
  assert.equal(env.TRANSFORMERS_OFFLINE, "1");
});

test("resolves only a package-identified official source MCP entry", () => {
  const mcpRoot = path.join(fixture, "stem-studio", "mcp");
  const dist = path.join(mcpRoot, "dist");
  const entry = path.join(dist, "index.js");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(entry, "// fixture entry\n");
  fs.writeFileSync(
    path.join(mcpRoot, "package.json"),
    JSON.stringify({
      name: "stem-studio-mcp",
      version: "1.1.0",
      type: "module",
      main: "./dist/index.js",
      bin: { "stem-studio-mcp": "./dist/index.js" },
    })
  );
  assert.equal(resolveStemMcpConfig({ STEMSTUDIO_MCP_ENTRY: "../fake.mjs" }), null);
  assert.equal(resolveStemMcpConfig({ STEMSTUDIO_MCP_ENTRY: fake }), null);
  const resolved = resolveStemMcpConfig({ STEMSTUDIO_MCP_ENTRY: entry });
  assert.ok(resolved);
  assert.equal(resolved.command, process.execPath);
  assert.deepEqual(resolved.args, [fs.realpathSync(entry)]);
  assert.equal(resolved.kind, "source-module");
  assert.equal(resolved.version, "1.1.0");
  assert.match(validateStemMcpEntry(entry).message, /Verified official/);
});

test("drives official MCP-shaped status, job polling, and cancellation", async () => {
  const output = path.join(fixture, "delivery");
  const client = new StemMcpClient(
    { command: process.execPath, args: [fake], entry: fake },
    buildStemMcpEnvironment({
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      OPENAI_API_KEY: "sk_not_forwarded",
      CLIPPER_API_TOKEN: "not-forwarded",
    })
  );
  await client.start();
  try {
    const tools = await client.listTools();
    assert.equal(tools.some((tool) => tool.name === "setup_environment"), false);
    assert.equal(tools.some((tool) => tool.name === "separate_stems"), true);
    const setup = await client.callTool<{ ready: boolean }>("setup_status", {});
    assert.equal(setup.ready, true);
    const started = await client.callTool<{ job_id: string; status: string }>(
      "separate_stems",
      {
        input_path: path.join(fixture, "prepared.mov"),
        output_dir: output,
        quality: "high",
        multitrack_video: false,
        wait: false,
      }
    );
    assert.equal(started.status, "running");
    const running = await client.callTool<{ status: string; percent: number }>(
      "check_job",
      { job_id: started.job_id }
    );
    assert.equal(running.status, "running");
    assert.equal(running.percent, 50);
    const done = await client.callTool<{
      status: string;
      result: { stems: { dialogue: string } };
    }>("check_job", { job_id: started.job_id });
    assert.equal(done.status, "done");
    assert.equal(done.result.stems.dialogue.startsWith(output), true);
    const cancelled = await client.callTool<{ status: string }>("cancel_job", {
      job_id: started.job_id,
    });
    assert.equal(cancelled.status, "cancelled");
  } finally {
    await client.close();
  }
});

test("surfaces setup-required without invoking setup_environment", async () => {
  const client = new StemMcpClient(
    {
      command: process.execPath,
      args: [fake, "--setup-required"],
      entry: fake,
    },
    buildStemMcpEnvironment()
  );
  await client.start();
  try {
    const status = await client.callTool<{
      ready: boolean;
      pythonExists: boolean;
    }>("setup_status", {});
    assert.equal(status.ready, false);
    assert.equal(status.pythonExists, false);
  } finally {
    await client.close();
  }
});

test("rejects non-JSON stdout instead of accepting mixed diagnostics", async () => {
  const client = new StemMcpClient(
    { command: process.execPath, args: [bad], entry: bad },
    buildStemMcpEnvironment()
  );
  await assert.rejects(
    client.start(),
    /non-JSON data to stdout|exited/
  );
  await client.close();
});
