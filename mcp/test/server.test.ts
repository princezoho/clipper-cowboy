import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import type { ClipperService, Health } from "../src/service.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function connectedBundle(env: NodeJS.ProcessEnv, service: ClipperService) {
  const bundle = createServer(env, { service });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await bundle.server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return { bundle, client };
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  const block = content[0];
  return block?.type === "text" ? (block.text ?? "") : "";
}

describe("Clipper Cowboy MCP server", () => {
  it("registers the complete agent tool surface", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipper-mcp-root-"));
    cleanup.push(root);
    const fake = { status: async () => null, shutdown: () => {} } as unknown as ClipperService;
    const { client } = await connectedBundle({ CLIPPER_ROOT: root, CLIPPER_AUTOSTART: "false" }, fake);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "setup_status",
      "setup_environment",
      "project_summary",
      "list_sources",
      "get_source",
      "list_clips",
      "get_clip",
      "list_metadata_catalogs",
      "export_clip",
      "update_clip_metadata",
      "analyze_source_with_openai",
      "check_job",
    ]);
  });

  it("never returns a secret contained in an internal status error", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipper-mcp-root-"));
    cleanup.push(root);
    const sentinel = "unit-test-secret-sentinel";
    const fake = {
      status: async () => { throw new Error(`provider failed with ${sentinel}`); },
      shutdown: () => {},
    } as unknown as ClipperService;
    const { client } = await connectedBundle({
      CLIPPER_ROOT: root,
      CLIPPER_AUTOSTART: "false",
      OPENAI_API_KEY: sentinel,
    }, fake);
    const result = await client.callTool({ name: "setup_status", arguments: {} });
    expect(text(result)).not.toContain(sentinel);
    expect(text(result)).toContain("[REDACTED]");
  });

  it("exports by ID and returns a Stem Studio handoff without accepting paths", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "clipper-mcp-export-"));
    cleanup.push(base);
    const project = path.join(base, "project");
    const clips = path.join(project, "clips");
    const stems = path.join(project, "derived", "stems");
    fs.mkdirSync(clips, { recursive: true });
    fs.mkdirSync(stems, { recursive: true });
    const sourcePath = path.join(project, "source.mov");
    const outputPath = path.join(clips, "Scene_2.mov");
    fs.writeFileSync(sourcePath, "source");
    const health: Health = {
      ok: true,
      service: "clipper-cowboy",
      apiVersion: 1,
      projectDir: project,
      clipsDir: clips,
      charactersDir: path.join(project, "characters"),
      derivedDir: path.join(project, "derived"),
      stemsDir: stems,
      shotlistMd: path.join(project, "shotlist.md"),
      shotlistCsv: path.join(project, "shotlist.csv"),
      hasOpenAIKey: false,
      projectDirConfigured: true,
    };
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const fake = {
      ensure: async () => health,
      status: async () => health,
      shutdown: () => {},
      request: async (requestPath: string, init?: RequestInit) => {
        requests.push({ path: requestPath, init });
        if (requestPath === "/api/pool") return { items: [{
          id: "0123456789abcdef", filename: "source.mov", path: sourcePath,
          folder: "", size: 6, mtime: 1, duration: 10, clipCount: 0,
        }], poolDir: project };
        if (["/api/characters", "/api/scenes", "/api/objects"].includes(requestPath)) return { items: [] };
        if (requestPath === "/api/export") {
          fs.writeFileSync(outputPath, "clip");
          return {
            id: "fedcba9876543210", name: "Scene", description: "metadata-secret-sentinel", tags: [],
            filename: "Scene_2.mov", path: outputPath, sourceId: "0123456789abcdef",
            in: 1, out: 3, duration: 2, created: 1, exportMode: "clip",
          };
        }
        throw new Error(`unexpected request ${requestPath}`);
      },
    } as unknown as ClipperService;
    const { client } = await connectedBundle({
      CLIPPER_ROOT: base,
      OPENAI_API_KEY: "metadata-secret-sentinel",
    }, fake);
    const result = await client.callTool({ name: "export_clip", arguments: {
      source_id: "0123456789abcdef",
      in_seconds: 1,
      out_seconds: 3,
      name: "Scene",
      wait: false,
    } });
    const started = JSON.parse(text(result));
    expect(started.status).toBe("queued");
    let payload: any;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const checked = await client.callTool({ name: "check_job", arguments: { job_id: started.job_id } });
      payload = JSON.parse(text(checked));
      if (payload.status === "done") break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(payload.status).toBe("done");
    expect(JSON.stringify(payload)).not.toContain("metadata-secret-sentinel");
    expect(payload.result.handoff.input_path).toBe(fs.realpathSync(outputPath));
    expect(payload.result.handoff.suggested_stem_output_dir).toBe(
      path.join(fs.realpathSync(stems), "Scene_2")
    );
    const body = JSON.parse(String(requests.find((request) => request.path === "/api/export")?.init?.body));
    expect(body.mode).toBe("clip");
    expect(body).not.toHaveProperty("output_dir");
    expect(body).not.toHaveProperty("api_key");
  });

  it("normalizes legacy clip sidecars before search", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "clipper-mcp-legacy-"));
    cleanup.push(base);
    const project = path.join(base, "project");
    const clips = path.join(project, "clips");
    const output = path.join(clips, "legacy.mov");
    fs.mkdirSync(path.join(project, "derived", "stems"), { recursive: true });
    fs.mkdirSync(path.join(project, "characters"), { recursive: true });
    fs.mkdirSync(clips, { recursive: true });
    fs.writeFileSync(output, "clip");
    const health = {
      ok: true, service: "clipper-cowboy", apiVersion: 1,
      projectDir: project, clipsDir: clips, charactersDir: path.join(project, "characters"),
      derivedDir: path.join(project, "derived"), stemsDir: path.join(project, "derived", "stems"),
      shotlistMd: path.join(project, "shotlist.md"), shotlistCsv: path.join(project, "shotlist.csv"),
      hasOpenAIKey: false, projectDirConfigured: true,
    } as Health;
    const fake = {
      ensure: async () => health,
      status: async () => health,
      shutdown: async () => {},
      request: async (requestPath: string) => {
        if (requestPath === "/api/library") return {
          items: [{
            id: "0123456789abcdef", name: "Legacy Clip", filename: "legacy.mov",
            path: output, created: 1, characters: [null],
          }],
          libraryDir: clips, missingCount: 0, orphans: [],
        };
        throw new Error(`unexpected request ${requestPath}`);
      },
    } as unknown as ClipperService;
    const { client } = await connectedBundle({ CLIPPER_ROOT: base }, fake);
    const result = await client.callTool({ name: "list_clips", arguments: { query: "legacy" } });
    const payload = JSON.parse(text(result));
    expect(payload.total).toBe(1);
    expect(payload.items[0].description).toBe("");
    expect(payload.items[0].tags).toEqual([]);
    expect(payload.items[0].characters).toEqual([]);
  });
});
